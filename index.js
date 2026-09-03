// Erato Memory — SillyTavern 第三方扩展
// 为 Erato 预设提供结构化长期记忆：
//   把一段楼层（窗口，默认最多 40 楼）的正文+recap 一次交给副 API，按事件切成若干条记忆，
//   同一次调用顺手更新人物志/物件/主角关系现状 → 存进聊天元数据随聊天文件走
//   → 已总结的旧楼层自动隐藏（可逆），由条目按时间顺序注入回上下文
//
// 扩展跑在打开酒馆页面的浏览器里，手机/电脑都可用；同一酒馆实例两端共享记忆。

(() => {
    const EXT = 'erato-memory';
    const META_KEY = 'eratoMemory';
    const PROMPT_KEY = 'erato_memory';
    const DATA_VERSION = 2;

    // script.js 里的枚举值：extension_prompt_types.IN_CHAT = 1，extension_prompt_roles.SYSTEM = 0
    // getContext() 没有暴露这两个枚举，只能写死
    const IN_CHAT = 1;
    const ROLE_SYSTEM = 0;

    const GRADES = ['S', 'A', 'B', 'C'];
    const TYPES = ['plot', 'emotion', 'intimacy', 'relationship', 'setting'];
    const TYPE_LABEL = { plot: '剧情', emotion: '情绪', intimacy: '亲密', relationship: '关系', setting: '设定' };
    const STATUS_LABEL = { ok: '', pending: '待处理', failed: '失败', refused: '拒答', stale: '过期', orphan: '孤立', archived: '归档' };
    const MAX_ATTEMPTS = 3;
    const GRADE_BASE = { S: Infinity, A: 1, B: 0.6, C: 0.3 };
    const GRADE_HALFLIFE = { S: Infinity, A: 200, B: 60, C: 20 };

    // 人物志 / 物件档案的字段（值带来源楼层号）；主角只记一行「关系现状」，不建档
    // arc = 此人此刻处在什么阶段（一句）；views = 对任意他人的看法（另存 p.views，不在此表）
    const PERSON_FIELDS = ['role', 'age', 'rel_user', 'rel_char', 'look', 'stance', 'status', 'knows', 'arc'];
    const PERSON_LABEL = { role: '身份', age: '年龄', rel_user: '与{{user}}', rel_char: '与{{char}}', look: '外貌', stance: '立场', status: '现状', knows: '知情', arc: '阶段' };
    const ITEM_FIELDS = ['holder', 'note', 'meaning'];   // v0.3.4：原自由文本 status 改名 note（备注），status 让给枚举状态
    const ITEM_LABEL = { holder: '持有者', note: '备注', meaning: '意义' };
    // 点名表档位：按对剧情的影响判，不按是否在场；龙套只留在面板里，不进注入块
    // 档位只升不降（单窗口只看到一个人露一面就降档是错的），面板手改后加锁；龙套/未定进过 S/A 事件或累计露面 ≥3 段自动升配
    const TIERS = ['主', '配', '龙套'];
    const TIER_RANK = { '主': 3, '配': 2, '龙套': 1 };
    const PROMOTE_SEEN = 3;
    // 第二条轴：生命周期。档位=剧情权重（慢变），状态=事件驱动；两轴正交，面板各自可筛
    const PERSON_STATES = ['在场', '离场', '死亡', '下落不明'];
    // 物件：关键性三档对应人物三档（摆设=只是道具，不注入）；状态里「已使用」= 一次性物件完成使命
    const ITEM_TIERS = ['关键', '次要', '摆设'];
    const ITEM_TIER_RANK = { '关键': 3, '次要': 2, '摆设': 1 };
    const ITEM_STATES = ['待用', '在用', '已使用', '已转手', '遗失', '损毁', '封存'];
    const ITEM_SETTLED = ['已使用', '遗失', '损毁', '封存'];   // 终态：仍是要记住的事实，但注入降成一行
    const DORMANT_FLOORS = 100;   // 面板活跃度：超过这么多楼没露面算「沉寂」；「近期」= 最近 npcScanDepth 楼提到（与注入完整卡同一判断）
    const TRENDS = ['破裂', '厌恶', '反感', '陌生', '投缘', '亲密', '交融'];
    const RAW_LOG_MAX = 3;      // 保留最近几次副 API 原始回复供诊断
    const RAW_LOG_CHARS = 6000;
    // 结束哨兵：副模型在 JSON/正文之后另起一行输出它。缺哨兵 = 截断，不管 finish_reason 报什么（供应商会错报）
    const END_MARK = '<END_OF_MEMORY/>';
    const RECAP_CHARS = 400;    // 逐楼 recap 底层每楼存多少字
    const CANON_RESEAL = 5;     // S 集合相对上次压缩变化这么多条就重压
    // 向量源：请求体字段与酒馆 /api/vector/* 的 getSourceSettings 一致；密钥走酒馆同名槽位
    const VEC_SOURCES = {
        siliconflow: { label: '硅基流动（SiliconFlow）', secret: 'api_key_siliconflow', model: 'Qwen/Qwen3-Embedding-0.6B' },
        vllm: { label: '通用 OpenAI 兼容 embeddings（vllm 源）', secret: 'api_key_vllm', model: '' },
        openai: { label: 'OpenAI 官方', secret: 'api_key_openai', model: 'text-embedding-3-small' },
    };
    const RAW_CHUNK_CHARS = 600;   // 原文细节：已总结楼层的 <content> 按这么多字切块、带重叠入向量库
    const RAW_CHUNK_OVERLAP = 80;

    // 面板与设置里的「楼」都按酒馆楼层计（你一条 + AI 一条 = 2 楼）；存储与对账内部仍以 AI 楼为单位，见 floorSpan
    const DEFAULTS = {
        enabled: true,
        floorUnit: 'chat',    // 楼数单位标记：旧设置（AI 楼计）加载时翻倍成酒馆楼层
        autoInterval: 20,     // 攒够这么多新楼自动总结一次；0 = 只手动
        windowFloors: 40,     // 一次副 API 调用最多吃多少楼
        maxCallChars: 60000,  // 一次调用的材料字数上限，超过自动再切一段（防副模型上下文爆掉）
        minEventsPer: 4,      // 事件密度下限：每几个 AI 楼至少 1 条事件，少于此数视为输出不合格走拆半；0 = 不核验
        api: { url: '', key: '', model: '', models: [], temperature: 0.3, maxTokens: 4000, timeoutSec: 120 },
        contentWindow: 6,   // 与预设 6🌸 的 minDepth 一致
        recapWindow: 20,    // 与预设 5🌸 的 minDepth 一致：深度不足此数的楼预设自己还带着 recap，保底不重复注入
        injectDepth: 6,
        maxInjectChars: 9000,
        entityChars: 1500,    // 人物志+物件在注入块里的字数上限
        npcScanDepth: 6,      // 最近几条可见消息里提到的人物出完整档案，其余只列名字
        canonMax: 25,         // S/钉选超过这么多条就压成正典段
        canonChars: 800,      // 正典段字数上限
        outlineChars: 2000,   // 远景层（被裁条目折成的按日骨架）注入预算，超过就把最老的日行再折成时期行
        foldMin: 6,           // 被预算裁掉且未折叠的条目攒够这么多才跑一次折叠
        // 召回：关键词通道零网络默认开；向量走酒馆自带 /api/vector/*，默认关
        recall: { keyword: true, vector: false, source: 'siliconflow', apiUrl: '', model: '', cn: true, raw: true, topK: 8, threshold: 0.4, recallChars: 2000, rawChars: 1200, queryChars: 600, timeoutSec: 4 },
        autoFold: 'batch',    // 治理（远景折叠/正典压缩）何时自动跑：always=每次生成后攒够就跑 / batch=只在总结批次结束后 / manual=只点「现在折叠」
        headerText: '',       // 注入块块首说明，留空用默认
        hideSummarized: true,
        keepVisible: 6,
        ball: { enabled: true, color: '', opacity: 0.4, size: 40, pos: null },
        directive: '',
        systemPrompt: '',
        promptTemplate: '',
        debug: false,
    };

    const getCtx = () => SillyTavern.getContext();

    const ctx0 = getCtx();
    if (!ctx0.extensionSettings[EXT]) ctx0.extensionSettings[EXT] = {};
    const settings = ctx0.extensionSettings[EXT];
    // v0.3.1 及之前的楼数按 AI 楼计；v0.3.2 起按酒馆楼层计，旧值翻倍才等于原来的实际行为
    const legacyFloorUnit = Object.keys(settings).length > 0 && settings.floorUnit === undefined;
    const hadAuto = settings.autoInterval !== undefined, hadWin = settings.windowFloors !== undefined;
    for (const key of Object.keys(DEFAULTS)) {
        if (settings[key] === undefined) settings[key] = structuredClone(DEFAULTS[key]);
    }
    for (const group of ['api', 'ball', 'recall']) {
        if (!settings[group] || typeof settings[group] !== 'object') settings[group] = {};
        for (const key of Object.keys(DEFAULTS[group])) {
            if (settings[group][key] === undefined) settings[group][key] = structuredClone(DEFAULTS[group][key]);
        }
    }
    // v0.2 → v0.3：逐楼开关变间隔；一次调用的回复更长、更慢，旧默认值跟着抬；旧模板占位符已不兼容
    if (settings.autoIngest !== undefined) { if (settings.autoIngest === false) settings.autoInterval = 0; delete settings.autoIngest; }
    delete settings.ingestBatch;
    if (Number(settings.api.maxTokens) <= 900) settings.api.maxTokens = DEFAULTS.api.maxTokens;
    if (Number(settings.api.timeoutSec) === 60) settings.api.timeoutSec = DEFAULTS.api.timeoutSec;
    if (settings.promptTemplate && !settings.promptTemplate.includes('{{material}}')) settings.promptTemplate = '';
    if (legacyFloorUnit) {
        if (hadAuto && Number(settings.autoInterval) > 0) settings.autoInterval = Number(settings.autoInterval) * 2;
        if (hadWin) settings.windowFloors = Math.max(1, Number(settings.windowFloors) || 20) * 2;
        settings.floorUnit = 'chat';
    }
    const saveSettings = () => getCtx().saveSettingsDebounced();

    /* ================= 工具 ================= */

    const log = (...a) => { if (settings.debug) console.log('[EratoMemory]', ...a); };
    const warn = (...a) => console.warn('[EratoMemory]', ...a);
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const uid = p => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    // FNV-1a 32 位，只对抠出的正文做，改状态栏/道具不算改
    function hash(str) {
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h.toString(16).padStart(8, '0');
    }

    function debounce(fn, ms) {
        let t = null;
        return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    }

    function toast(kind, msg) {
        if (window.toastr?.[kind]) window.toastr[kind](msg, 'Erato Memory');
    }

    /* ================= 存储（chat_metadata.eratoMemory） ================= */

    function defaultData() {
        return {
            version: DATA_VERSION,
            entries: [],      // 记忆条目（事件）；自动条目通过 win 挂在窗口下
            windows: [],      // 窗口 = 一次副 API 调用覆盖的楼层段，是入库/对账的单位
            people: [],       // 人物志（配角）
            items: [],        // 物件
            relation: { v: '', idx: null, date: '' },   // {{char}} 对 {{user}} 的关系现状
            archives: [],
            canon: { text: '', builtFrom: [], builtAt: 0 },   // 正典压缩段：S 超过 canonMax 条时由副 API 压成一段，之后新增的 S 逐条附在段后
            outline: { lines: [], pending: [], at: 0 },      // 远景层：被预算裁掉的条目按故事日折成一行；level 2 = 若干日行再折成的时期行
            recaps: {},   // 逐楼底层：send_date → { i, t, n }（预设每楼自带的 recap），失败/未总结楼层的保底与折叠材料
            tombstones: { p: {}, i: {} },   // 面板删掉的人物/物件：norm 名 → { name, at }，副模型再报同名直接忽略
            vec: { entries: {}, raw: {}, source: '', model: '', at: 0 },   // 向量库对账表：条目 id → 数字 hash；楼层 send_date → { h: 正文哈希, hs: [chunk hash] }
            skip: {},
            hidden: {},   // 本插件隐藏过的楼层 send_date → true；只恢复自己藏的
            stats: { lastIngestAt: 0, lastError: '', failStreak: 0 },
            rawLog: [],   // 最近几次副 API 原始回复 { at, win, model, finish, text }，诊断用
        };
    }

    function getData() {
        const ctx = getCtx();
        if (!ctx.chatId || !ctx.chatMetadata) return null;
        let d = ctx.chatMetadata[META_KEY];
        if (!d || typeof d !== 'object') d = ctx.chatMetadata[META_KEY] = defaultData();
        const def = defaultData();
        for (const k of Object.keys(def)) if (d[k] === undefined) d[k] = def[k];
        for (const k of ['entries', 'windows', 'people', 'items']) if (!Array.isArray(d[k])) d[k] = [];
        if (!d.relation || typeof d.relation !== 'object') d.relation = def.relation;
        for (const k of ['canon', 'outline', 'tombstones', 'vec']) if (!d[k] || typeof d[k] !== 'object') d[k] = def[k];
        if (!Array.isArray(d.outline.lines)) d.outline.lines = [];
        if (!Array.isArray(d.outline.pending)) d.outline.pending = [];
        if (!Array.isArray(d.canon.builtFrom)) d.canon.builtFrom = [];
        for (const k of ['p', 'i']) if (!d.tombstones[k] || typeof d.tombstones[k] !== 'object') d.tombstones[k] = {};
        for (const k of ['entries', 'raw']) if (!d.vec[k] || typeof d.vec[k] !== 'object') d.vec[k] = {};
        if (!d.recaps || typeof d.recaps !== 'object') d.recaps = {};
        if ((Number(d.version) || 1) < 2) migrateV1(d);
        // v0.3.4：物件的自由文本 status 改名 note；档位/状态枚举键补空串
        for (const it of d.items) {
            if (!it.f || typeof it.f !== 'object') it.f = {};
            if (it.f.status && !it.f.note) { it.f.note = it.f.status; delete it.f.status; }
            if (it.tier === undefined) it.tier = '';
            if (it.state === undefined) it.state = '';
        }
        for (const p of d.people) if (p.state === undefined) p.state = '';
        return d;
    }

    // v0.2 一楼一条目 → 窗口制：每个自动条目变成单楼窗口，失败/重试状态搬到窗口上；没摘要的占位条目丢掉
    function migrateV1(d) {
        for (const k of ['entries', 'windows', 'people', 'items']) if (!Array.isArray(d[k])) d[k] = [];
        const keep = [];
        for (const e of d.entries) {
            if (e.manual || !e.src?.send_date) { keep.push(e); continue; }
            const idx = e.src.idx ?? 0;
            const w = newWindow([idx], [e.src.send_date], [e.src.hash || ''], !!e.src.fallback);
            w.status = e.status === 'archived' ? 'ok' : (e.status || 'pending');
            w.attempts = e.attempts || 0; w.last_error = e.last_error || ''; w.model = e.model || '';
            d.windows.push(w);
            if (!e.summary) continue;
            e.win = w.id; e.ord = 0;
            e.src = { idx, floors: [idx], dates: [e.src.send_date], fallback: !!e.src.fallback };
            e.status = w.status;
            keep.push(e);
        }
        d.entries = keep;
        d.version = DATA_VERSION;
        log('数据已从 v1 迁移：', d.windows.length, '个单楼窗口');
    }

    const saveData = () => getCtx().saveMetadataDebounced();

    const sortEntries = data => data.entries.sort((a, b) => (a.src?.idx ?? 0) - (b.src?.idx ?? 0) || (a.ord ?? 0) - (b.ord ?? 0) || (a.created_at ?? 0) - (b.created_at ?? 0));
    const sortWindows = data => data.windows.sort((a, b) => (a.floors[0] ?? 0) - (b.floors[0] ?? 0));

    function newWindow(floors, dates, hashes, fallback) {
        return { id: uid('w'), floors, dates, hashes, fallback: !!fallback, status: 'pending', attempts: 0, last_error: '', model: '', created_at: Date.now(), updated_at: Date.now() };
    }
    const winById = (data, id) => data.windows.find(w => w.id === id) || null;
    const winEntries = (data, id) => data.entries.filter(e => e.win === id);
    const winLabel = w => w.floors.length > 1 ? `#${w.floors[0]}–#${w.floors[w.floors.length - 1]}` : `#${w.floors[0] ?? '?'}`;
    // 一个 AI 楼在酒馆里的跨度 = 它自己 + 紧挨着前面那条用户楼（材料就是这么配对的，隐藏也是一起藏）；
    // 开场白、续写出来的连续 AI 回复前面没有用户楼，只算 1。面板上所有「N 楼」都是跨度之和，与酒馆楼号口径一致
    const floorSpan = (chat, idx) => (idx > 0 && chat[idx - 1]?.is_user ? 2 : 1);
    const spanOf = (chat, idxs) => idxs.reduce((n, i) => n + floorSpan(chat, i), 0);
    const winFloors = (ws, chat = getCtx().chat || []) => ws.reduce((n, w) => n + spanOf(chat, w.floors), 0);

    /* ================= 楼层文本抠取 ================= */

    const RX = {
        content: /<content>([\s\S]*?)<\/content>/i,
        thinkBlocks: [
            /<think_format>[\s\S]*?<\/think_format>/gi,
            /<COT_Director>[\s\S]*?<\/COT_Director>/gi,
            /<thinking>[\s\S]*?<\/thinking>/gi,
            /<think>[\s\S]*?<\/think>/gi,
        ],
        details: /<details>[\s\S]*?<\/details>/gi,
        recap: /<recap>([\s\S]*?)<\/recap>/i,
        plot: /<plot_directions>[\s\S]*?<\/plot_directions>/gi,
        prop: /<!--prop-->[\s\S]*?<!--\/prop-->/gi,
        toy: /[‹<]toy:[a-z]+[›>]/gi,
        newspaper: /:::newspaper[\s\S]*?:::/gi,
        contentTags: /<\/?content>/gi,
    };

    const stripCommon = t => t.replace(RX.prop, '').replace(RX.toy, '').replace(RX.newspaper, '');

    // 优先取 <content> 块；缺标签时按已知块逐个剥除，剩下的当正文并标记 fallback
    function extractContent(mes) {
        const text = String(mes || '');
        const m = RX.content.exec(text);
        if (m) return { text: stripCommon(m[1]).trim(), fallback: false };
        let t = text;
        for (const r of RX.thinkBlocks) t = t.replace(r, '');
        const open = t.search(/<content>/i);
        if (open >= 0) t = t.slice(open + '<content>'.length);
        t = t.replace(RX.recap, '').replace(RX.plot, '').replace(RX.details, '').replace(RX.contentTags, '');
        return { text: stripCommon(t).trim(), fallback: true };
    }

    // recap 里的加粗行是「日期 · 时段 · 场景」锚点，其余是叙述
    function extractRecap(mes) {
        const m = RX.recap.exec(String(mes || ''));
        if (!m) return { storyTime: '', narrative: '' };
        let t = m[1].replace(/<summary>[\s\S]*?<\/summary>/gi, '').replace(/<\/?details>/gi, '').trim();
        const b = /\*\*(.+?)\*\*/.exec(t);
        const storyTime = b ? b[1].trim() : '';
        if (b) t = t.replace(b[0], '').trim();
        return { storyTime, narrative: t };
    }

    const cleanUser = mes => stripCommon(String(mes || '')).trim().slice(0, 1500);

    /* ================= 楼层判定 ================= */

    // 酒馆「隐藏消息」= is_system:true，和真正的系统消息（旁白/系统提示，带 extra.type）用同一个标记。
    // 被藏起来的 AI 楼层照常算 AI 楼层，否则旧聊天里藏起来的楼永远不会入库。
    function isAiFloor(m, ctx) {
        if (!m || m.is_user) return false;
        if (!m.is_system) return true;
        if (m.extra?.type) return false;
        return m.name === (ctx || getCtx()).name2 || RX.content.test(String(m.mes || ''));
    }

    // 每层的可见深度：depth[i] = 它后面有几条可见消息（与酒馆正则/注入深度同口径）；隐藏楼层 = -1
    function visibleDepths(chat) {
        const d = new Array(chat.length);
        let n = 0;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!chat[i] || chat[i].is_system) { d[i] = -1; continue; }
            d[i] = n++;
        }
        return d;
    }

    // 条目可注入 = 它的楼层已被隐藏，或可见深度 ≥ 正文窗口（正文已被 6🌸 剥掉）
    const injectable = (e, depths) => {
        const idx = e.src?.idx;
        if (idx === undefined || idx === null || idx >= depths.length) return false;
        const d = depths[idx];
        return d < 0 || d >= (Number(settings.contentWindow) || 6);
    };

    /* ================= 副 API ================= */

    const apiConfigured = () => !!(settings.api.url?.trim() && settings.api.key?.trim());
    const apiBase = () => settings.api.url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');

    // 经酒馆后端转发：openai 源 + reverse_proxy/proxy_password 覆盖目标与密钥，
    // 不受浏览器跨域限制，不碰主模型连接。signal = 外部中止（「停止」按钮）
    async function callApi(messages, maxTokens, signal) {
        const ctx = getCtx();
        const base = apiBase();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(5, Number(settings.api.timeoutSec) || 60) * 1000);
        const onOuter = () => controller.abort();
        if (signal) { if (signal.aborted) onOuter(); else signal.addEventListener('abort', onOuter, { once: true }); }
        let res, text;
        try {
            res = await fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                signal: controller.signal,
                body: JSON.stringify({
                    chat_completion_source: 'openai',
                    reverse_proxy: base,
                    proxy_password: settings.api.key.trim(),
                    model: settings.api.model.trim() || undefined,
                    messages,
                    temperature: Number(settings.api.temperature ?? 0.3),
                    max_tokens: maxTokens || Number(settings.api.maxTokens) || 900,
                    stream: false,
                }),
            });
            text = await res.text();
        } catch (err) {
            if (signal?.aborted) throw Object.assign(new Error('已停止'), { stopped: true });
            throw new Error(controller.signal.aborted ? `超时（${settings.api.timeoutSec}s）` : `网络错误：${err.message}`);
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', onOuter);
        }
        let json;
        try { json = JSON.parse(text); } catch { throw new Error(`后端返回非 JSON：${text.slice(0, 120)}`); }
        if (!res.ok || json.error) {
            const msg = json.error?.message || json.error || json.message || `HTTP ${res.status}`;
            throw new Error(String(msg).slice(0, 200));
        }
        const choice = json.choices?.[0];
        const content = choice?.message?.content;
        const finish = String(choice?.finish_reason || '');
        // 上游安全策略拦截：内容常为空或半截，按拒答处理（会走拆半），不当网络错误
        if (finish === 'content_filter') throw Object.assign(new Error('上游内容过滤（content_filter）'), { refused: true, split: true });
        if (!content || !String(content).trim()) throw new Error('空回复');
        const out = String(content).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        return { text: out, finish };
    }

    // 哨兵：模板/提示词里要求了哨兵才核验；有哨兵即完整（供应商错报 length 也收），缺哨兵即截断（错报 stop 也不收）
    const wantsEndMark = text => String(text || '').includes(END_MARK);
    const hasEndMark = raw => new RegExp(END_MARK.replace(/[/<>]/g, '\\$&') + '\\s*$').test(String(raw || '').trim());
    const stripEndMark = raw => String(raw || '').replace(new RegExp('\\s*' + END_MARK.replace(/[/<>]/g, '\\$&') + '\\s*$'), '').trim();

    // 拉模型列表：与主 API「连接」按钮同一条路，后端拿 reverse_proxy + proxy_password 去请求 {base}/models
    // 上游出错时酒馆后端回 200 + {error:true}，不带原因，只能提示去看后台日志
    async function fetchModels() {
        const ctx = getCtx();
        let res, text;
        try {
            res = await fetch('/api/backends/chat-completions/status', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ chat_completion_source: 'openai', reverse_proxy: apiBase(), proxy_password: settings.api.key.trim() }),
            });
            text = await res.text();
        } catch (err) {
            throw new Error(`网络错误：${err.message}`);
        }
        let json;
        try { json = JSON.parse(text); } catch { throw new Error(`后端返回非 JSON：${text.slice(0, 120)}`); }
        if (json.error === true) throw new Error('上游未返回模型列表：检查地址是否到 /v1、密钥是否正确，或该接口不支持 /models（可手动填模型名）');
        if (!res.ok || json.error) throw new Error(String(json.error?.message || json.error || `HTTP ${res.status}`).slice(0, 200));
        const raw = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : Array.isArray(json) ? json : [];
        const ids = [...new Set(raw.map(m => typeof m === 'string' ? m : (m?.id || m?.name)).filter(Boolean).map(String))].sort();
        if (!ids.length) throw new Error('接口返回了空的模型列表');
        settings.api.models = ids;
        saveSettings();
        return ids;
    }

    const isRefusal = raw =>
        !/"(events|summary)"\s*:/.test(raw) &&
        /无法(协助|提供|生成|完成|继续)|不能(协助|提供|生成)|违反|不适合|抱歉|I can(?:'|’)?t\b|I cannot|I'm unable|not able to|as an AI/i.test(raw);

    /* ---- JSON 修复链：代码块 → 最外层大括号 → 引号/换行修复 → 截断补闭合 ---- */

    function fixJsonString(s) {
        s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
        let out = '', inStr = false, escd = false;
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (inStr) {
                if (escd) { out += ch; escd = false; continue; }
                if (ch === '\\') { out += ch; escd = true; continue; }
                if (ch === '\n') { out += '\\n'; continue; }
                if (ch === '\r') continue;
                if (ch === '\t') { out += '\\t'; continue; }
                if (ch === '"') {
                    const rest = s.slice(i + 1).replace(/^\s*/, '');
                    if (rest === '' || /^[:,}\]]/.test(rest)) { inStr = false; out += ch; }
                    else out += '\\"';
                    continue;
                }
                out += ch;
                continue;
            }
            if (ch === '"') inStr = true;
            out += ch;
        }
        return out.replace(/,\s*([}\]])/g, '$1');
    }

    function repairTruncated(s) {
        const stack = [];
        let inStr = false, escd = false;
        for (const ch of s) {
            if (inStr) {
                if (escd) escd = false;
                else if (ch === '\\') escd = true;
                else if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') inStr = true;
            else if (ch === '{') stack.push('}');
            else if (ch === '[') stack.push(']');
            else if (ch === '}' || ch === ']') stack.pop();
        }
        let out = s;
        if (inStr) out += '"';
        out = out.replace(/,\s*$/, '').replace(/,\s*"[^"]*"\s*:?\s*$/, '');
        while (stack.length) out += stack.pop();
        return out;
    }

    function parseJson(raw) {
        const cands = [];
        const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
        if (fence) cands.push(fence[1]);
        const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
        if (a >= 0 && b > a) cands.push(raw.slice(a, b + 1));
        if (a >= 0) cands.push(raw.slice(a));
        for (const c of cands) {
            for (const fix of [x => x, fixJsonString, x => repairTruncated(fixJsonString(x))]) {
                try {
                    const o = JSON.parse(fix(c));
                    if (o && typeof o === 'object' && !Array.isArray(o)) return o;
                } catch { /* 下一种修复 */ }
            }
        }
        return null;
    }

    /* ================= 摘要提示词 ================= */

    const DEFAULT_SYSTEM_PROMPT =
        '你是成人向互动小说的档案员。你的工作是把一段已发生的剧情整理成若干条结构化记忆，并更新人物与物件档案，供后续写作参考。\n' +
        '只输出 JSON，不输出任何其他文字。用中性、克制、事实性的语言，不渲染不评价，性内容按事实记录不省略。';

    // 可在设置「提示词」里改；占位符：{{name1}} {{name2}} {{roster}} {{relation}} {{context}} {{recent}} {{locked}} {{floor_range}} {{floor_count}} {{material}} {{min_events}} {{max_events}} {{directive}}
    const DEFAULT_USER_TEMPLATE =
`## 已知主角
用户角色：{{name1}}；对手角色：{{name2}}。其余出场者按原文名字记录。
{{name1}} 与 {{name2}} 的亲属、朋友、同事、上司一律作为独立人物建档，即使只在对话、微信、电话或回忆里被提到、从未到场；不要把他们当成主角人设的一部分。

## 已有档案（名字务必与此一致，不要给同一个人起第二个名字）
{{roster}}

## {{name2}} 对 {{name1}} 的关系现状（上次记录）
{{relation}}

## 更早的剧情骨架（远景与已定案的正典，只供承接因果与去重，不要复述）
{{context}}

## 之前的最近三条记忆（供承接因果与去重，不要重复其中已记录的事实）
{{recent}}

## 本段已锁定的记忆（用户钉选或手改过，保留原样；不要重复记录这些事实，本段其余事件照常写）
{{locked}}

## 本段材料（{{floor_range}}，共 {{floor_count}} 楼；每楼以【#楼层号】开头，含用户行动、正文、作者摘要）
{{material}}

## 输出要求
先点名，再写事件，最后更新档案。输出一个 JSON 对象，键的顺序必须是 cast、events、relation、people、items、uncovered：
{
  "cast": [
    {"name": "本段出现过的每一个人，包括只被提到的、包括主角、包括主角的亲属；有正式名用正式名，没有就写『谁的什么人』如 {{name1}}的母亲；宁多勿漏", "aliases": ["原文里对此人的称呼/昵称/别称，如 母亲、老陆、张姐"], "tier": "主 | 配 | 龙套", "role": "一句身份", "seen": [出现或被提到的楼层号]}
  ],
  "events": [
    {
      "floors": [本事件来自哪几楼，只填楼层号数字；本段每一楼都必须被至少一个事件认领，或在 uncovered 里申报],
      "story_time": "沿用该楼作者摘要的『日期 · 时段 · 场景』原文；没有则从正文推断；推断不出写（未知），禁止编造",
      "type": "plot | emotion | intimacy | relationship | setting 之一。setting=新角色登场/世界观揭示/规则确立",
      "title": "≤8字，意象或事件名，不用『之后』『开始』这类空词",
      "summary": "80–200字。以事件为单位写起因→经过→结果，写『为什么』而不只是『做了什么』。必须保留正式人名、原文称呼、地点、关键物件和具体动作；禁止『两人发生冲突』『关系升温』这类不带主语宾语的空话；未来只凭一句口语提法也要能认出这条。可保留1句决定走向的原台词。去掉感官修辞。",
      "characters": ["与本事件有关的人：在场有行动的，以及不在场但影响了走向的（打电话、发消息、被转述、被提醒的人）。只用正式名，不用代词，不用别称"],
      "emotion_shift": "『角色：A→B』格式，一人一句，无变化留空",
      "known_by": ["知道这件事的角色。若是秘密/信息差，只列知情者；全员在场则留空数组"],
      "tags": ["3-6个检索词：人名/地点/物件/情绪/主题"],
      "intimacy": null 或 {"acts": "行为要点，事实性", "consent": "同意状态与主动方", "firsts": "第一次的事项，没有留空", "aftermath": "事后状态与余波"},
      "related_to": ["之前记忆里与本事件有因果关系的 id，没有留空数组"],
      "grade": "S | A | B | C",
      "grade_reason": "≤20字"
    }
  ],
  "relation": "{{name2}} 此刻对 {{name1}} 的态度与关系，一句话 ≤40 字，写现状不写过程；本段没有变化则留空字符串",
  "people": [
    {"name": "与 cast 一致（不含 {{name1}} 与 {{name2}}）", "role": "身份/职业", "age": "", "rel_user": "与{{name1}}的关系", "rel_char": "与{{name2}}的关系", "look": "外貌一句", "stance": "当前立场", "state": "在场 | 离场 | 死亡 | 下落不明", "status": "现状一句：在做什么/处境如何", "knows": "知情范围：知道哪些秘密", "arc": "≤15字，此人此刻处在什么阶段", "views": [{"to": "对象名（任何人，含主角）", "v": "一句态度", "trend": "破裂 | 厌恶 | 反感 | 陌生 | 投缘 | 亲密 | 交融"}], "floor": 该信息来自哪一楼的楼层号}
  ],
  "items": [
    {"name": "物件名", "tier": "关键 | 次要 | 摆设", "state": "待用 | 在用 | 已使用 | 已转手 | 遗失 | 损毁 | 封存", "holder": "现在在谁手里", "note": "现状一句", "meaning": "对剧情或人物的意义", "floor": 楼层号}
  ],
  "uncovered": [
    {"floors": [没有被任何事件认领的楼层号], "why": "≤10字说明为什么无事可记，如 纯氛围 / 重复对话"}
  ]
}
JSON 结束后另起一行输出 ${END_MARK} 作为结束标记。

切分规则：
- 按事件切，不按楼切。同一件事跨多楼（一场争吵、一次亲密、一段对话）合成一条；一楼里有两件独立的事就拆两条。本段 {{floor_count}} 楼，事件应有 {{min_events}}–{{max_events}} 条；宁可多切几条具体的，不要合成一条概括的。
- 楼层覆盖：本段每一楼都要出现在某个事件的 floors 里；确实无事可记的楼放进 uncovered 并给理由。漏楼比多写一条小事更糟。

档案规则：
- cast 是点名表：本段每一个有名字或固定称呼的人都要在，包括只被提到、没到场的。漏一个人比多写十个龙套更糟。
- tier 按对剧情的影响判，不按是否在场：不在场但影响了事件走向的人（打电话提醒、发消息、被反复提起的亲属）算主或配；在场但只提供服务、没有自己意图的人（店员、司机、随从）算龙套。
- people 是更新表：只写本段有新信息的人，字段有则填、没有就不写这个键。没变化的人不必出现在 people 里，但必须出现在 cast 里。
- 已有档案里的人，名字要与档案一模一样；同一个人在原文里的新称呼放进 aliases。若原文给出了档案里某人的真名，name 写真名、aliases 里带上档案里的旧写法。
- views 写此人对他人的看法，对象可以是主角也可以是其他人；只写本段有依据的，没有就不写这个键。
- people 的 state 是生命周期：在场=还在故事里活动；离场=剧情明确离开（出国、断交、调走、被赶走）；死亡；下落不明=失联、不知去向。没变化不写这个键。
- items 只记对剧情或人物有意义的物件。tier 按作用判：关键=推动剧情或承载关系、没了故事会变（证据、信物、解药、钥匙）；次要=有意义但可替代；摆设=只是道具，可以不写。
- items 的 state：待用=登场了还没派上用场；在用=正被使用或持有；已使用=一次性物件完成使命（药喝了、信读了、钱付了、票用了）；已转手=送出/交出/被夺，换了主人；遗失；损毁；封存=主动收起、不再出现但仍存在。物件状态或持有者变了，就要在 items 里更新。

等级标准（按语义重要度，不按篇幅）：
S = 不可逆事实：死亡/告白成立/关系定名/身份揭露/立誓承诺/任何『第一次』。永不遗忘。
A = 关系转折、重大冲突、重要秘密或信息差的建立、角色重大决定。
B = 推动剧情但可被概括的普通事件。
C = 日常、闲聊、氛围、无后果的互动。
拿不准时降一级，不要升级。{{directive}}`;

    // 折叠规则：远景层与正典压缩共用（用户定案原文）
    const FOLD_RULES =
`- 同一剧情日、同一目标连续推进的多个场景合并成一条；只有日期、核心矛盾、目标或关系阶段发生变化才另起一条。
- 压措辞不删事实：人名、日期、关键物件、承诺、决定、伤害/失去/获得必须保留。
- 已有骨架与新增材料合并重写，不是追加；不加材料里没有的事实。
- 第三人称，只写已发生的事，不评价、不预测、不渲染。`;

    const FOLD_SYSTEM_PROMPT = '你是成人向互动小说的档案员。你的工作是把已经被更细的记忆条目覆盖过的旧剧情压成骨架，供后续写作保持时间感。用中性、克制、事实性的语言，性内容按事实记录不省略。只输出要求的格式，不输出任何其他文字。';

    const systemPromptText = () => settings.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
    // 用户模板缺 {{material}} 就不可用，静默退回默认，免得摘要出来全是空
    const userTemplateText = () => {
        const t = settings.promptTemplate || '';
        return t.includes('{{material}}') ? t : DEFAULT_USER_TEMPLATE;
    };

    const fv = (ent, k) => ent?.f?.[k]?.v || '';
    const personLabel = k => PERSON_LABEL[k].replace('{{user}}', getCtx().name1 || '{{user}}').replace('{{char}}', getCtx().name2 || '{{char}}');

    function rosterText(data) {
        const p = data.people.map(x => `${x.name}${x.aliases?.length ? `（${x.aliases.join('/')}）` : ''}${x.tier ? `[${x.tier}]` : ''}${fv(x, 'role') ? `：${fv(x, 'role')}` : ''}`);
        const i = data.items.map(x => `${x.name}${x.tier ? `[${x.tier}]` : ''}${x.state ? `(${x.state})` : ''}`);
        return [p.length ? `人物：${p.join('、')}` : '', i.length ? `物件：${i.join('、')}` : ''].filter(Boolean).join('\n') || '（无）';
    }

    function floorMaterial(f) {
        const parts = [`【#${f.idx}】`, `用户行动（括号内的 OOC 指令不是剧情，忽略）：${f.userText || '（无）'}`, `正文：\n${f.content}`];
        const recap = [f.recap?.storyTime, f.recap?.narrative].filter(Boolean).join('\n');
        if (recap) parts.push(`作者摘要：${recap}`);
        return parts.join('\n');
    }

    // 喂给摘要模型的剧情骨架：远景最近几行 + 正典（压缩段或最近若干条 S 标题），≤1500 字
    function contextText(data, beforeIdx = Infinity) {
        const parts = [];
        const lines = (data.outline?.lines || []).filter(l => l.idx < beforeIdx).slice(-8);
        if (lines.length) parts.push('远景：', ...lines.map(l => `- ${l.key}：${l.text}`));
        const S = data.entries.filter(e => e.status === 'ok' && (e.grade === 'S' || e.pinned) && (e.src?.idx ?? 0) < beforeIdx);
        if (data.canon?.text) parts.push('正典：', data.canon.text);
        const rest = data.canon?.text ? S.filter(e => !data.canon.builtFrom.includes(e.id)) : S;
        if (rest.length) parts.push(...(data.canon?.text ? [] : ['正典（已定案的事）：']), ...rest.slice(-12).map(e => `- ${e.story_time || ''}「${e.title}」${e.summary.slice(0, 60)}`));
        const text = parts.join('\n');
        return text.length > 1500 ? text.slice(text.length - 1500) : text;
    }

    // input = { floors: [{ idx, userText, content, recap }], recent: [Entry], locked: [Entry], data }
    function buildMessages(input) {
        const ctx = getCtx();
        const floors = input.floors || [];
        const n = floors.length;
        const fmtRecent = e => `[${e.id}] ${e.story_time || '（时间未知）'} | ${e.title} | ${e.summary}`;
        const vars = {
            name1: ctx.name1 || '{{user}}',
            name2: ctx.name2 || '{{char}}',
            roster: input.data ? rosterText(input.data) : '（无）',
            relation: input.data?.relation?.v || '（尚无记录）',
            context: (input.data && contextText(input.data, floors[0]?.idx ?? Infinity)) || '（无）',
            recent: input.recent?.length ? input.recent.map(fmtRecent).join('\n') : '（无）',
            locked: input.locked?.length ? input.locked.map(fmtRecent).join('\n') : '（无）',
            floor_range: n ? (n > 1 ? `#${floors[0].idx}–#${floors[n - 1].idx}` : `#${floors[0].idx}`) : '',
            floor_count: String(n),
            material: floors.map(floorMaterial).join('\n\n'),
            min_events: String(minEventsFor(n)),
            max_events: String(clamp(Math.ceil(n / 2), 2, 12)),
            directive: settings.directive?.trim() ? `\n\n## 额外要求\n${settings.directive.trim()}` : '',
        };
        const user = userTemplateText().replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
        return [
            { role: 'system', content: systemPromptText() },
            { role: 'user', content: user },
        ];
    }

    const asArr = v => Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : [];
    const norm = s => String(s || '').trim().toLowerCase();
    // 事件密度下限：每 minEventsPer 个 AI 楼至少 1 条；0 = 不核验
    const minEventsFor = n => { const per = Number(settings.minEventsPer) || 0; return per > 0 ? Math.max(1, Math.ceil(n / per)) : 1; };

    function applyEvent(e, obj, recap, recentIds) {
        e.story_time = String(obj.story_time || '').trim() || recap.storyTime || '';
        if (/^（?未知）?$/.test(e.story_time)) e.story_time = recap.storyTime || '';
        e.type = TYPES.includes(obj.type) ? obj.type : 'plot';
        e.title = String(obj.title || '').trim().slice(0, 12) || '（无题）';
        e.summary = String(obj.summary || '').trim();
        e.characters = asArr(obj.characters);
        e.emotion_shift = String(obj.emotion_shift || '').trim();
        e.known_by = asArr(obj.known_by);
        e.tags = asArr(obj.tags);
        e.related_to = asArr(obj.related_to).filter(id => recentIds.has(id));
        e.grade_reason = String(obj.grade_reason || '').trim();
        if (!e.pinned) e.grade = GRADES.includes(obj.grade) ? obj.grade : 'B';
        if (e.type === 'intimacy' && obj.intimacy && typeof obj.intimacy === 'object') {
            const i = obj.intimacy;
            e.intimacy = {
                acts: String(i.acts || '').trim(),
                consent: String(i.consent || '').trim(),
                firsts: String(i.firsts || '').trim(),
                aftermath: String(i.aftermath || '').trim(),
            };
        } else {
            e.intimacy = null;
        }
    }

    const findPerson = (data, name) => { const n = norm(name); return n ? data.people.find(p => norm(p.name) === n || (p.aliases || []).some(a => norm(a) === n)) || null : null; };
    const findItem = (data, name) => { const n = norm(name); return n ? data.items.find(x => norm(x.name) === n) || null : null; };

    // 人物志/物件/关系现状合并：同实体同字段，新的非空值覆盖旧值并更新来源楼层号；主角不建档，{{char}} 只更新关系行
    // 顺序：cast 点名表（建档 + 档位 + 别称）→ people 字段更新（含 arc / views）→ items → 事件 characters 反哺（漏点名的也建档）
    function mergeEntities(data, obj, w, byIdx, made = []) {
        const ctx = getCtx();
        const lastIdx = w.floors[w.floors.length - 1];
        const floorOf = v => { const n = Number(v); return byIdx.has(n) ? n : lastIdx; };
        const dateOf = i => byIdx.get(i)?.send_date || '';
        const HIST_MAX = 3;
        // 覆盖前把旧值压进 hist（最近 3 版），来源楼被删时能退回上一版；手改过的字段（manual）副模型不覆盖
        const setF = (ent, key, val, idx) => {
            const v = String(val || '').trim();
            if (!v || ent.f[key]?.manual) return;
            const old = ent.f[key];
            if (old?.v === v) { old.idx = idx; old.date = dateOf(idx); return; }
            const hist = old?.v ? [{ v: old.v, idx: old.idx, date: old.date }, ...(old.hist || [])].slice(0, HIST_MAX) : (old?.hist || []);
            ent.f[key] = { v, idx, date: dateOf(idx), hist };
        };
        const me = norm(ctx.name1), them = norm(ctx.name2);
        const isLead = n => n === me || n === them;
        const touch = (ent, idx) => { ent.last_idx = Math.max(ent.last_idx || 0, idx); if (ent.first_idx == null || idx < ent.first_idx) { ent.first_idx = idx; ent.first_date = dateOf(idx); } ent.updated_at = Date.now(); if (ent.lost) delete ent.lost; };
        const addAliases = (ent, list) => { for (const a of list) if (norm(a) !== norm(ent.name) && !ent.aliases.some(x => norm(x) === norm(a)) && !isLead(norm(a))) ent.aliases.push(a); };
        // 找到或新建；若按别称命中且模型明确把档案里的旧名列为别称，则升级为真名（「陆母」→「王秀英」）；墓碑里的名字不建档
        const upsertPerson = (name, aliases, idx) => {
            const n = norm(name);
            if (!n || isLead(n)) return null;
            if (isTomb(data, 'p', name) || aliases.some(a => isTomb(data, 'p', a))) return null;
            let ent = findPerson(data, name);
            if (!ent) {
                for (const a of aliases) { ent = findPerson(data, a); if (ent) break; }
                if (ent) { addAliases(ent, [ent.name]); ent.name = name; }   // 新名字带着旧档案的名字/别称来 → 改名
            }
            if (!ent) {
                ent = { id: uid('p'), name, aliases: [], f: {}, views: {}, tier: '', state: '', seen: 0, first_idx: idx, first_date: dateOf(idx), last_idx: idx, created_at: Date.now(), updated_at: Date.now() };
                data.people.push(ent);
            }
            if (!ent.views || typeof ent.views !== 'object') ent.views = {};
            addAliases(ent, aliases);
            touch(ent, idx);
            return ent;
        };
        const rel = String(obj.relation || '').trim();
        const setRelation = (v, idx) => {
            if (!v || data.relation?.manual) return;
            const old = data.relation || {};
            if (old.v === v) { old.idx = idx; old.date = dateOf(idx); return; }
            const hist = old.v ? [{ v: old.v, idx: old.idx, date: old.date }, ...(old.hist || [])].slice(0, HIST_MAX) : (old.hist || []);
            data.relation = { v, idx, date: dateOf(idx), hist };
        };
        if (rel) setRelation(rel, lastIdx);
        const seenThisWin = new Set();
        for (const c of (Array.isArray(obj.cast) ? obj.cast : [])) {
            const name = String(c?.name || '').trim();
            if (!name) continue;
            const seen = asArr(c.seen).map(Number).filter(i => byIdx.has(i));
            const idx = seen.length ? Math.max(...seen) : lastIdx;
            const ent = upsertPerson(name, asArr(c.aliases), idx);
            if (!ent) continue;
            if (seen.length) { const first = Math.min(...seen); if (first < ent.first_idx) { ent.first_idx = first; ent.first_date = dateOf(first); } }
            const tier = String(c.tier || '').trim();
            raiseTier(ent, tier);
            if (!fv(ent, 'role')) setF(ent, 'role', c.role, idx);
            seenThisWin.add(ent.id);
        }
        for (const p of (Array.isArray(obj.people) ? obj.people : [])) {
            const name = String(p?.name || '').trim();
            if (!name) continue;
            const n = norm(name);
            if (n === them) {
                const r = String(p.rel_user || '').trim();
                if (!rel && r) setRelation(r, floorOf(p.floor));
                continue;
            }
            const idx = floorOf(p.floor);
            const ent = upsertPerson(name, asArr(p.aliases), idx);
            if (!ent) continue;
            for (const k of PERSON_FIELDS) setF(ent, k, p[k], idx);
            setState(ent, p.state, PERSON_STATES, idx, dateOf(idx));
            for (const v of (Array.isArray(p.views) ? p.views : [])) {
                const to = String(v?.to || '').trim(), text = String(v?.v || '').trim();
                if (!to || !text || norm(to) === norm(ent.name) || ent.views[to]?.manual) continue;
                const trend = TRENDS.includes(String(v.trend || '').trim()) ? String(v.trend).trim() : '';
                const old = ent.views[to];
                if (old?.v === text && old.trend === trend) { old.idx = idx; old.date = dateOf(idx); continue; }
                const hist = old?.v ? [{ v: old.v, trend: old.trend, idx: old.idx, date: old.date }, ...(old.hist || [])].slice(0, HIST_MAX) : (old?.hist || []);
                ent.views[to] = { v: text, trend, idx, date: dateOf(idx), hist };
            }
            seenThisWin.add(ent.id);
        }
        for (const it of (Array.isArray(obj.items) ? obj.items : [])) {
            const name = String(it?.name || '').trim();
            if (!name || isTomb(data, 'i', name)) continue;
            const idx = floorOf(it.floor);
            let ent = findItem(data, name);
            if (!ent) {
                ent = { id: uid('i'), name, f: {}, tier: '', state: '', first_idx: idx, first_date: dateOf(idx), last_idx: idx, created_at: Date.now(), updated_at: Date.now() };
                data.items.push(ent);
            }
            for (const k of ITEM_FIELDS) setF(ent, k, it[k], idx);
            if (it.status && !it.note) setF(ent, 'note', it.status, idx);   // 旧模板/自定义模板仍按老键名回
            raiseTier(ent, String(it.tier || '').trim(), ITEM_TIER_RANK);
            setState(ent, it.state, ITEM_STATES, idx, dateOf(idx));
            ent.last_idx = Math.max(ent.last_idx || 0, idx); ent.updated_at = Date.now(); if (ent.lost) delete ent.lost;
        }
        // 事件里点到的人，点名表漏了也建档（只有名字和楼层）；进过 S/A 事件的龙套/未定升配
        for (const e of made) {
            const idx = e.src?.idx ?? lastIdx;
            for (const name of (e.characters || [])) {
                const ent = upsertPerson(name, [], idx);
                if (!ent) continue;
                seenThisWin.add(ent.id);
                if (e.grade === 'S' || e.grade === 'A') promote(ent, '配');
            }
        }
        for (const id of seenThisWin) {
            const ent = data.people.find(p => p.id === id); if (!ent) continue;
            ent.seen = (ent.seen || 0) + 1;
            if (ent.seen >= PROMOTE_SEEN) promote(ent, '配');
        }
    }

    // 档位只升不降；面板手改过（tierLock）的不动
    function raiseTier(ent, tier, rank = TIER_RANK) {
        if (!tier || !(tier in rank) || ent.tierLock) return;
        if ((rank[tier] || 0) > (rank[ent.tier] || 0)) ent.tier = tier;
    }
    // 龙套 / 未定 → 配（不碰主，不碰手改）
    function promote(ent, to) {
        if (ent.tierLock || (TIER_RANK[ent.tier] || 0) >= TIER_RANK[to]) return;
        ent.tier = to;
    }
    // 状态：最新一窗为准；面板手改过（stateLock）的不动；旧状态压进 stateHist（来源楼被删时退回）
    function setState(ent, val, allowed, idx = null, date = '') {
        const s = String(val || '').trim();
        if (!s || !allowed.includes(s) || ent.stateLock) return;
        if (ent.state === s) { if (idx != null) { ent.stateIdx = idx; ent.stateDate = date; } return; }
        if (ent.state) ent.stateHist = [{ s: ent.state, idx: ent.stateIdx ?? null, date: ent.stateDate || '' }, ...(ent.stateHist || [])].slice(0, 3);
        ent.state = s; ent.stateIdx = idx; ent.stateDate = date;
    }

    // 回退：把「来源楼已死」的档案值退回最近一个来源楼还活着的旧版，退无可退就清掉；手改的值不动只标待核。
    // isDead(send_date) 由调用方给：删楼对账 = 不在聊天里；撤销本段 = 落在该窗口里。返回改动数
    function rollbackValues(data, isDead) {
        let n = 0;
        const dead = v => !!(v?.date && isDead(v.date));
        const revert = (holder, key) => {
            const cur = holder[key];
            if (!cur || cur.manual) { if (cur && dead(cur)) cur.stale = true; return; }
            if (!dead(cur)) { delete cur.stale; return; }
            const hist = (cur.hist || []).slice();
            while (hist.length && dead(hist[0])) hist.shift();
            if (hist.length) { const h = hist.shift(); holder[key] = { ...h, hist }; }
            else delete holder[key];
            n++;
        };
        for (const list of [data.people, data.items]) for (const x of list) {
            for (const k of Object.keys(x.f || {})) revert(x.f, k);
            for (const k of Object.keys(x.views || {})) revert(x.views, k);
            if (x.state && !x.stateLock && x.stateDate && isDead(x.stateDate)) {
                const hist = (x.stateHist || []).filter(h => !(h.date && isDead(h.date)));
                if (hist.length) { const h = hist.shift(); x.state = h.s; x.stateIdx = h.idx; x.stateDate = h.date; x.stateHist = hist; }
                else { x.state = ''; x.stateIdx = null; x.stateDate = ''; x.stateHist = []; }
                n++;
            }
            // 来源全失：首见楼没了、且没有任何一个值还活着 → 不注入不删，面板标出；再被提到时 touch 会清掉
            const alive = Object.values(x.f || {}).some(v => v?.v && !dead(v)) || Object.values(x.views || {}).some(v => v?.v && !dead(v));
            const firstDead = !!(x.first_date && isDead(x.first_date));
            if (firstDead && !alive && !x.lost) { x.lost = true; n++; }
        }
        if (data.relation?.v && !data.relation.manual) {
            const r = data.relation;
            if (dead(r)) {
                const hist = (r.hist || []).filter(h => !dead(h));
                data.relation = hist.length ? { ...hist[0], hist: hist.slice(1) } : { v: '', idx: null, date: '', hist: [] };
                n++;
            }
        }
        return n;
    }

    // 墓碑：面板删过的名字，副模型再报就忽略；「恢复」= 从墓碑里移除
    const isTomb = (data, kind, name) => { const n = norm(name); return !!(n && data.tombstones?.[kind]?.[n]); };
    function addTomb(data, kind, ent) {
        const names = [ent.name, ...(ent.aliases || [])];
        for (const nm of names) { const n = norm(nm); if (n) data.tombstones[kind][n] = { name: ent.name, at: Date.now() }; }
    }
    function removeTomb(data, kind, name) {
        const target = String(name || '');
        for (const k of Object.keys(data.tombstones[kind])) if (data.tombstones[kind][k].name === target) delete data.tombstones[kind][k];
    }

    // 零网络补档：把已有事件条目里点到的非主角名字全部建档（老聊天不重跑也能先把名单补齐）
    function backfillPeople() {
        const data = getData(); if (!data) return 0;
        const ctx = getCtx();
        const me = norm(ctx.name1), them = norm(ctx.name2);
        const chat = ctx.chat || [];
        const before = data.people.length;
        for (const e of data.entries) {
            if (e.status !== 'ok') continue;
            const idx = e.src?.idx ?? 0;
            for (const name of (e.characters || [])) {
                const n = norm(name);
                if (!n || n === me || n === them || isTomb(data, 'p', name)) continue;
                let ent = findPerson(data, name);
                if (!ent) {
                    ent = { id: uid('p'), name, aliases: [], f: {}, views: {}, tier: '', state: '', seen: 0, first_idx: idx, first_date: chat[idx]?.send_date || '', last_idx: idx, created_at: Date.now(), updated_at: Date.now() };
                    data.people.push(ent);
                }
                ent.seen = (ent.seen || 0) + 1;
                if (idx < ent.first_idx) ent.first_idx = idx;
                ent.last_idx = Math.max(ent.last_idx || 0, idx);
            }
        }
        return data.people.length - before;
    }

    // 副模型返回的结构核验：事件数、密度下限、楼层覆盖。不合格先纠正式重试（附问题点名），仍不合格才拆半
    function checkResult(obj, inputs) {
        const events = Array.isArray(obj?.events) ? obj.events : Array.isArray(obj?.entries) ? obj.entries : null;
        if (!events || !events.length) return { ok: false, reason: '没有返回事件', fix: '上面的输出里没有 events。重新输出完整 JSON，把本段每一楼发生的事写成事件。' };
        const byIdx = new Set(inputs.map(f => f.idx));
        const good = events.filter(ev => ev && typeof ev === 'object' && String(ev.summary || '').trim().length >= 10);
        if (!good.length) return { ok: false, reason: '事件摘要全部过短', fix: '上面每条事件的 summary 都太短。重新输出完整 JSON，summary 写 80–200 字。' };
        const need = minEventsFor(inputs.length);
        if (good.length < need && inputs.length > 1) {
            return { ok: false, reason: `事件太少（${good.length}/${need}），材料被过度压缩`, fix: `上面只有 ${good.length} 条事件，本段 ${inputs.length} 楼至少要 ${need} 条。重新输出完整 JSON，按楼把事件拆开写，宁可多切几条具体的。` };
        }
        const claimed = new Set();
        for (const ev of good) for (const i of asArr(ev.floors).map(Number)) if (byIdx.has(i)) claimed.add(i);
        const declared = new Set();
        for (const u of (Array.isArray(obj.uncovered) ? obj.uncovered : [])) for (const i of asArr(u?.floors).map(Number)) if (byIdx.has(i)) declared.add(i);
        const missing = inputs.map(f => f.idx).filter(i => !claimed.has(i) && !declared.has(i));
        if (inputs.length >= 3 && missing.length > inputs.length / 3) {
            return { ok: false, reason: `楼层覆盖不足（${missing.length}/${inputs.length} 楼没有事件）`, fix: `以下楼层没有被任何事件认领，也没有在 uncovered 里申报：${missing.map(i => '#' + i).join('、')}。重新输出完整 JSON，为这些楼补上事件；确实无事可记的放进 uncovered 并写理由。` };
        }
        return { ok: true, uncovered: [...new Set([...declared, ...missing])].sort((a, b) => a - b) };
    }

    // 一个窗口的返回：events → 条目（替换该窗口旧条目，钉选/手改过的保留），再合并档案
    function applyWindowResult(w, obj, inputs, recent) {
        const data = getData();
        const check = checkResult(obj, inputs);
        if (!check.ok) throw Object.assign(new Error(check.reason), { split: true });
        const events = Array.isArray(obj.events) ? obj.events : obj.entries;
        const byIdx = new Map(inputs.map(f => [f.idx, f]));
        const recentIds = new Set(recent.map(x => x.id));
        const made = [];
        events.forEach((ev, k) => {
            if (!ev || typeof ev !== 'object' || String(ev.summary || '').trim().length < 10) return;
            let floors = asArr(ev.floors).map(Number).filter(n => byIdx.has(n)).sort((a, b) => a - b);
            if (!floors.length) floors = [w.floors[w.floors.length - 1]];
            const e = newEntry();
            e.win = w.id; e.ord = k;
            e.src = { idx: floors[floors.length - 1], floors, dates: floors.map(i => byIdx.get(i).send_date), fallback: floors.some(i => byIdx.get(i).fallback) };
            applyEvent(e, ev, byIdx.get(floors[0]).recap || {}, recentIds);
            e.status = 'ok'; e.model = settings.api.model;
            made.push(e);
        });
        if (!made.length) throw Object.assign(new Error('事件摘要全部过短'), { split: true });
        // 钉选 / 手改过的条目不被重跑冲掉；来源楼全不在本窗口里的（楼被删了）不再保留
        const kept = data.entries.filter(e => e.win === w.id && (e.pinned || e.locked) && (e.src?.dates || []).some(d => w.dates.includes(d)));
        for (const e of kept) e.status = 'ok';
        data.entries = data.entries.filter(e => e.win !== w.id).concat(kept, made);
        w.uncovered = check.uncovered.map(i => byIdx.get(i)?.send_date).filter(Boolean);   // 按 send_date 记，删楼后仍能对上
        sortEntries(data);
        mergeEntities(data, obj, w, byIdx, made);
        return made;
    }

    /* ================= 入库（窗口切分 / 一次跑到底） ================= */

    const run = { busy: false, again: false, chatId: null, manual: false, stop: false, done: 0, total: 0, failToasted: false };

    function newEntry() {
        return {
            id: uid('em'), win: null, ord: 0, src: {}, story_time: '', type: 'plot', title: '', summary: '',
            characters: [], emotion_shift: '', known_by: [], tags: [], intimacy: null, related_to: [],
            grade: 'B', pinned: false, status: 'pending', model: '', created_at: Date.now(), updated_at: Date.now(),
        };
    }

    // 一楼的材料 = 前一条用户消息 + 正文 + recap
    function floorInput(chat, idx) {
        const m = chat[idx];
        const content = extractContent(m?.mes);
        const prev = chat[idx - 1];
        return { idx, send_date: m?.send_date, userText: prev?.is_user ? cleanUser(prev.mes) : '', content: content.text, fallback: content.fallback, recap: extractRecap(m?.mes), hash: hash(content.text) };
    }

    // 楼层覆盖表：send_date → 窗口（孤立窗口不算覆盖）
    function coverage(data) {
        const map = new Map();
        for (const w of data.windows) { if (w.status === 'orphan') continue; for (const d of w.dates) map.set(d, w); }
        return map;
    }

    // 未入库楼层：AI 楼、未标不入库、不在任何窗口里；all=false 时只取 depth≥2（0/1 还可能被 swipe 或重 roll）
    function uncoveredFloors(chat, data, all = false) {
        const ctx = getCtx();
        const cov = coverage(data);
        const out = [];
        for (let i = 0; i < chat.length; i++) {
            const m = chat[i];
            if (!isAiFloor(m, ctx)) continue;
            if (!all && chat.length - 1 - i < 2) continue;
            if (data.skip[m.send_date] || cov.has(m.send_date)) continue;
            out.push(i);
        }
        return out;
    }

    // 要（重）跑的旧窗口：过期、排队中断的、失败/拒答且未超次数
    const retryWindows = data => data.windows.filter(w => w.status === 'stale' || (['pending', 'failed', 'refused'].includes(w.status) && w.attempts < MAX_ATTEMPTS));

    // 把未入库楼层切成窗口：按顺序、不超 windowFloors 楼（酒馆楼层计）、材料不超 maxCallChars 字；中间隔着已入库楼层就断开。正文为空的楼直接标不入库
    function planWindows(chat, data, floors) {
        const W = Math.max(1, Number(settings.windowFloors) || 40);
        const C = Math.max(2000, Number(settings.maxCallChars) || 60000);
        const cov = coverage(data);
        const ctx = getCtx();
        const wins = [];
        let cur = [], chars = 0, span = 0, last = -1;
        const flush = () => { if (cur.length) wins.push(cur); cur = []; chars = 0; span = 0; };
        for (const idx of floors) {
            const f = floorInput(chat, idx);
            if (!f.content) { data.skip[f.send_date] = true; log('正文为空，不入库', idx); continue; }
            let broken = false;
            for (let j = last + 1; last >= 0 && j < idx; j++) if (isAiFloor(chat[j], ctx) && cov.has(chat[j].send_date)) { broken = true; break; }
            if (broken) flush();
            const n = f.content.length + f.userText.length + (f.recap.narrative?.length || 0) + 40;
            const s = floorSpan(chat, idx);
            if (cur.length && (span + s > W || chars + n > C)) flush();
            cur.push(f); chars += n; span += s; last = idx;
        }
        flush();
        return wins.map(fs => newWindow(fs.map(f => f.idx), fs.map(f => f.send_date), fs.map(f => f.hash), fs.some(f => f.fallback)));
    }

    // 拒答/解析失败时对半切，切到单楼还失败才算真失败；原窗口及其条目删掉（钉选/手改的按楼归到子窗口）
    function splitWindow(data, w) {
        const h = Math.ceil(w.floors.length / 2);
        const mk = (s, e) => newWindow(w.floors.slice(s, e), w.dates.slice(s, e), w.hashes.slice(s, e), w.fallback);
        const a = mk(0, h), b = mk(h, w.floors.length);
        data.windows = data.windows.filter(x => x.id !== w.id).concat(a, b);
        const kept = data.entries.filter(e => e.win === w.id && (e.pinned || e.locked) && (e.src?.dates || []).some(d => w.dates.includes(d)));
        for (const e of kept) e.win = (e.src?.dates || []).some(d => b.dates.includes(d)) && !(e.src?.dates || []).some(d => a.dates.includes(d)) ? b.id : a.id;
        data.entries = data.entries.filter(e => e.win !== w.id);
        sortWindows(data);
        return [a, b];
    }

    async function runWindow(w) {
        const ctx = getCtx();
        const data = getData();
        const chat = ctx.chat || [];
        if (!data) return;
        const byDate = new Map();
        chat.forEach((m, i) => { if (m?.send_date) byDate.set(m.send_date, i); });
        const inputs = [];
        w.dates.forEach(d => { const i = byDate.get(d); if (i !== undefined && chat[i]?.mes) inputs.push(floorInput(chat, i)); });
        w.floors = inputs.map(f => f.idx); w.dates = inputs.map(f => f.send_date); w.hashes = inputs.map(f => f.hash); w.fallback = inputs.some(f => f.fallback);
        w.status = 'pending'; w.split = false; w.updated_at = Date.now();
        if (!inputs.length) { w.status = 'orphan'; w.last_error = '楼层已不存在'; return; }
        if (!inputs.some(f => f.content)) { w.status = 'failed'; w.last_error = '正文为空'; w.attempts = MAX_ATTEMPTS; return; }
        for (const f of inputs) storeRecap(data, f);
        const recent = data.entries.filter(x => x.status === 'ok' && !x.manual && x.src.idx < w.floors[0]).slice(-3);
        const locked = data.entries.filter(x => x.win === w.id && (x.pinned || x.locked));
        // 最近几次原始回复留档，诊断「模型到底返回了什么」
        const keepRaw = (r, note) => {
            if (!Array.isArray(data.rawLog)) data.rawLog = [];
            data.rawLog.unshift({ at: Date.now(), win: winLabel(w), model: settings.api.model, finish: r.finish || '', note: note || '', text: String(r.text || '').slice(0, RAW_LOG_CHARS) });
            data.rawLog.length = Math.min(data.rawLog.length, RAW_LOG_MAX);
        };
        const signal = run.ctrl?.signal;
        const gone = () => getData() !== data;   // 库在调用期间被清空/切换（清空按钮、切聊天）：结果作废，不写进新库
        const split = msg => Object.assign(new Error(msg), { split: true });
        try {
            const messages = buildMessages({ floors: inputs, recent, locked, data });
            const sentinel = wantsEndMark(messages[1].content);
            const truncated = r => r.finish === 'length' || (sentinel && !hasEndMark(r.text));
            let r = await callApi(messages, undefined, signal);
            if (gone()) { w.status = 'pending'; w.last_error = '库已重置，本次结果作废'; return; }
            keepRaw(r);
            if (truncated(r) && !parseJson(stripEndMark(r.text)) && isRefusal(r.text)) throw Object.assign(new Error('疑似拒答：' + r.text.slice(0, 80)), { refused: true, split: true });
            if (truncated(r)) {
                // 输出撞上限（或缺结束哨兵）：先带长度约束重来一次，仍截断再交给拆半
                log('输出被截断，压缩重试', winLabel(w));
                r = await callApi(messages.concat([
                    { role: 'assistant', content: r.text.slice(0, 2000) },
                    { role: 'user', content: `上面的输出被截断了。重新输出完整的 JSON：键的顺序与内容要求不变，每条 summary 压到 100 字以内，cast 一个都不能少；只输出 JSON，JSON 之后另起一行输出 ${END_MARK}。` },
                ]), undefined, signal);
                if (gone()) { w.status = 'pending'; w.last_error = '库已重置，本次结果作废'; return; }
                keepRaw(r, '压缩重试');
                if (truncated(r)) throw split('输出两次被截断（max_tokens 太小或窗口太大）');
            }
            let raw = stripEndMark(r.text);
            let obj = parseJson(raw);
            // 纠正式重试：把上次输出和问题点名附回去重来一次（同温度重跑会复现同一遗漏，点名才会补）；拒答不纠正直接拆半
            let corrected = false;
            const correct = async (note, fix) => {
                if (corrected) return false;
                corrected = true;
                log('纠正重试', note, winLabel(w));
                r = await callApi(messages.concat([
                    { role: 'assistant', content: raw.slice(0, 3000) },
                    { role: 'user', content: `${fix}\n只输出 JSON，JSON 之后另起一行输出 ${END_MARK}。` },
                ]), undefined, signal);
                if (gone()) return null;
                keepRaw(r, '纠正重试：' + note);
                raw = stripEndMark(r.text);
                obj = parseJson(raw);
                return true;
            };
            if (!obj) {
                if (isRefusal(raw)) throw Object.assign(new Error('疑似拒答：' + raw.slice(0, 80)), { refused: true, split: true });
                if (await correct('JSON', '上面的输出不是合法 JSON，无法解析。重新输出完整的 JSON 对象，键的顺序与内容要求不变。') === null) { w.status = 'pending'; w.last_error = '库已重置，本次结果作废'; return; }
                if (!obj) throw split('无法解析 JSON：' + raw.slice(0, 80));
            }
            let check = checkResult(obj, inputs);
            if (!check.ok) {
                const c = await correct(check.reason, check.fix);
                if (c === null) { w.status = 'pending'; w.last_error = '库已重置，本次结果作废'; return; }
                if (!obj) throw split('纠正后仍无法解析 JSON');
                check = checkResult(obj, inputs);
                if (!check.ok) throw split(check.reason);
            }
            const oldIds = winEntries(data, w.id).filter(e => !(e.pinned || e.locked)).map(e => e.id);
            const made = applyWindowResult(w, obj, inputs, recent);
            w.status = 'ok'; w.last_error = ''; w.attempts = 0;
            w.model = settings.api.model; w.updated_at = Date.now();
            data.stats.failStreak = 0;
            log('入库', winLabel(w), winEntries(data, w.id).length, '条');
            vecAfterWindow(data, w, made, inputs, oldIds);
        } catch (err) {
            if (err.stopped) { w.status = 'pending'; w.last_error = '已停止'; return; }
            w.attempts++;
            w.status = err.refused ? 'refused' : 'failed';
            w.last_error = err.message;
            w.split = !!err.split;
            data.stats.failStreak++;
            data.stats.lastError = err.message;
            warn('窗口', winLabel(w), '摘要失败：', err.message);
            if (!run.failToasted && !(w.split && w.floors.length > 1)) { run.failToasted = true; toast('error', `${winLabel(w)} 摘要失败：${err.message.slice(0, 60)}`); }
        }
    }

    // 逐楼 recap 底层：抠取时顺手存；reconcile 补新楼、删失效楼
    function storeRecap(data, f) {
        const t = String(f.recap?.storyTime || '').trim(), n = String(f.recap?.narrative || '').trim();
        if (!f.send_date || (!t && !n)) return false;
        data.recaps[f.send_date] = { i: f.idx, t, n: n.slice(0, RECAP_CHARS) };
        return true;
    }
    function captureRecaps(chat, data) {
        const ctx = getCtx();
        const alive = new Set();
        let n = 0;
        for (let i = 0; i < chat.length; i++) {
            const m = chat[i];
            if (!m?.send_date || !isAiFloor(m, ctx)) continue;
            alive.add(m.send_date);
            const r = data.recaps[m.send_date];
            if (r) { if (r.i !== i) r.i = i; continue; }
            if (storeRecap(data, { idx: i, send_date: m.send_date, recap: extractRecap(m.mes) })) n++;
        }
        for (const d of Object.keys(data.recaps)) if (!alive.has(d)) { delete data.recaps[d]; n++; }
        return n;
    }

    // 停止：队列不再取下一段，在飞的副 API 请求立即中止
    function stopRun() { run.stop = true; try { run.ctrl?.abort(); } catch { /* 已结束 */ } }
    let lastGenEnd = 0;
    const isGenerating = () => { const ctx = getCtx(); try { if (typeof ctx.isGenerating === 'function') return !!ctx.isGenerating(); } catch { /* 旧版 */ } return $('#mes_stop').is(':visible'); };

    // source: auto / chat_changed / again = 攒够 autoInterval 楼才开新窗口，静默；
    // manual = 全部未总结楼层（含最新楼）跑到底；retry = 只重跑旧窗口；后两者带进度与提示，可停
    async function ingest(source = 'auto') {
        if (!settings.enabled) return;
        if (run.busy) { run.again = true; return; }
        const ctx = getCtx();
        const chatId = ctx.chatId;
        const data = getData();
        if (!chatId || !data) return;
        const manual = source === 'manual';
        const verbose = manual || source === 'retry';

        run.busy = true; run.chatId = chatId; run.again = false; run.manual = verbose; run.stop = false; run.done = 0; run.total = 0;
        run.ctrl = new AbortController();
        let okWins = 0, failed = 0, floorsOk = 0, floorsDone = 0, split = 0;
        try {
            // 手动模式含最新楼：刚生成完的楼等 2 秒稳定（流式收尾、其他插件追加内容）再吃
            if (manual && lastGenEnd) { const wait = 2000 - (Date.now() - lastGenEnd); if (wait > 0) await sleep(wait); }
            reconcile();
            const chat = ctx.chat || [];
            const queue = retryWindows(data);
            const fresh = uncoveredFloors(chat, data, manual);
            const N = Math.max(0, Number(settings.autoInterval) || 0);
            if (fresh.length && (manual || (N > 0 && spanOf(chat, fresh) >= N))) {
                for (const w of planWindows(chat, data, fresh)) { data.windows.push(w); queue.push(w); }
                sortWindows(data);
            }
            if (!queue.length) return;
            if (!apiConfigured()) {
                if (verbose) toast('warning', '请先在设置里填写副 API 地址与密钥');
                return;
            }
            run.total = winFloors(queue, chat);
            log('总结', source, queue.length, '个窗口', run.total, '楼');
            refreshStatus();
            while (queue.length) {
                if (run.stop || getCtx().chatId !== chatId || getData() !== data) break;
                const w = queue.shift();
                await runWindow(w);
                if (getData() !== data) break;   // 调用期间库被清空：窗口已作废，不再计数
                const span = spanOf(chat, w.floors);
                if (w.status === 'ok') { okWins++; floorsOk += span; floorsDone += span; }
                else if (w.split && w.floors.length > 1) { queue.unshift(...splitWindow(data, w)); split++; log('拆分重试', winLabel(w)); }
                else { failed++; floorsDone += span; }
                run.done = floorsDone;
                saveData();
                refreshStatus();
                if (verbose && queue.length && okWins && okWins % 5 === 0) toast('info', `正在总结 ${floorsDone}/${run.total} 楼`);
                await sleep(150);
            }
            data.stats.lastIngestAt = Date.now();
            saveData();
        } catch (err) {
            warn('总结中断：', err);
        } finally {
            const stopped = run.stop;
            run.busy = false; run.manual = false; run.stop = false; run.done = 0; run.total = 0; run.ctrl = null;
            if (getCtx().chatId === chatId) {
                const hid = hideSummarized();
                applyInjection(); renderPanel(); refreshStatus();
                if (verbose) {
                    if (!floorsDone && !failed) toast('info', '没有需要总结的楼层');
                    else toast(failed ? 'warning' : 'success',
                        `${stopped ? '已停止，' : ''}已总结 ${floorsOk} 楼 / ${okWins} 次调用${split ? `（拆分 ${split} 次）` : ''}${failed ? `，${failed} 段失败` : ''}${hid ? `，隐藏 ${hid} 条消息` : ''}，注入 ≈ ${lastInject.chars} 字`);
                }
                if (!stopped && settings.autoFold !== 'manual') scheduleGovern(0);
            }
            if (run.again) { run.again = false; setTimeout(() => ingest('again'), 500); }
        }
    }

    // 「总结到当前」入口：确认楼数与调用次数后跑到底
    async function summarizeAll() {
        const data = getData();
        if (!data) return toast('warning', '当前没有打开聊天');
        if (run.busy) { stopRun(); toast('info', '正在停止…'); return; }
        if (!settings.enabled) return toast('warning', '插件已禁用，请先在设置里启用');
        if (!apiConfigured()) { togglePanel(true, 'cfg'); return toast('warning', '请先填写副 API 地址与密钥'); }
        if (isGenerating()) return toast('warning', '正在生成回复，等这一楼写完再总结');
        reconcile();
        const chat = getCtx().chat || [];
        const fresh = spanOf(chat, uncoveredFloors(chat, data, true));
        const retry = retryWindows(data);
        if (!fresh && !retry.length) return toast('info', '没有需要总结的楼层');
        const W = Math.max(1, Number(settings.windowFloors) || 40);
        const calls = Math.ceil(fresh / W) + retry.length;
        const msg = `将总结 ${fresh} 楼${retry.length ? `，另重跑 ${winFloors(retry, chat)} 楼` : ''}，约 ${calls} 次副 API 调用（每次最多 ${W} 楼）。继续？`;
        if (!await confirmBox(msg)) return;
        ingest('manual');
    }

    // 对账：删楼 → 窗口缩到剩下的楼并重跑，全没了 → 孤立；编辑正文 → 过期；条目状态跟着窗口走；手动条目只校正楼层号
    function reconcile() {
        const ctx = getCtx();
        const data = getData();
        if (!data) return;
        const chat = ctx.chat || [];
        const byDate = new Map();
        chat.forEach((m, i) => { if (m && !m.is_user && m.send_date) byDate.set(m.send_date, i); });
        let changed = false;
        for (const w of data.windows) {
            const idxs = [], dates = [], hashes = [];
            let missing = 0, edited = false;
            w.dates.forEach((d, k) => {
                const i = byDate.get(d);
                if (i === undefined) { missing++; return; }
                idxs.push(i); dates.push(d); hashes.push(w.hashes[k] || '');
                if (hash(extractContent(chat[i].mes).text) !== (w.hashes[k] || '')) edited = true;
            });
            if (!idxs.length) { if (w.status !== 'orphan') { w.status = 'orphan'; changed = true; } continue; }
            if (missing) { w.floors = idxs; w.dates = dates; w.hashes = hashes; edited = true; changed = true; }
            else if (idxs.some((i, k) => w.floors[k] !== i)) { w.floors = idxs; changed = true; }
            if (['pending', 'failed', 'refused'].includes(w.status)) continue;
            if (edited) { if (w.status !== 'stale') { w.status = 'stale'; changed = true; } }
            else if (w.status === 'orphan') { w.status = winEntries(data, w.id).length ? 'ok' : 'stale'; changed = true; }
        }
        const max = Math.max(0, chat.length - 1);
        // 窗口已不存在的条目：其楼层若已被别的正常窗口覆盖，就是清空/重跑留下的残影，直接删；否则保留为孤立
        const cov = coverage(data);
        const before = data.entries.length;
        data.entries = data.entries.filter(e => {
            if (e.manual || !e.win || winById(data, e.win)) return true;
            const dates = e.src?.dates || [];
            return !(dates.length && dates.every(d => cov.has(d)));
        });
        if (data.entries.length !== before) { changed = true; log('清理残影条目', before - data.entries.length); }
        for (const e of data.entries) {
            if (e.manual) {
                if ((e.src?.idx ?? 0) > max) { e.src.idx = max; changed = true; }
                continue;
            }
            const w = e.win ? winById(data, e.win) : null;
            const st = !w ? 'orphan' : ['ok', 'stale', 'orphan'].includes(w.status) ? w.status : 'stale';
            if (e.status !== st) { e.status = st; changed = true; }
            const floors = (e.src?.dates || []).map(d => byDate.get(d)).filter(i => i !== undefined).sort((a, b) => a - b);
            if (floors.length && (floors.length !== e.src.floors?.length || floors.some((i, k) => e.src.floors[k] !== i))) {
                e.src.floors = floors; e.src.idx = floors[floors.length - 1]; changed = true;
            }
        }
        if (changed) { sortEntries(data); sortWindows(data); saveData(); }
        if (captureRecaps(chat, data)) saveData();
        if (rollbackOnDelete(chat, data)) saveData();
        // 手动模式没有自动重跑：段落因删楼/改楼过期时提醒一次
        const staleN = data.windows.filter(w => w.status === 'stale').length;
        if (staleN > lastStaleCount && !(Number(settings.autoInterval) > 0)) toast('info', `${staleN} 段记忆已过期（楼层被删或改过），点「总结到当前」重跑`);
        lastStaleCount = staleN;
    }
    let lastStaleCount = 0;

    // 删楼回滚：档案值退回上一版（rollbackValues）；远景日行只要有一楼没了或所在段落过期就作废、条目退回待折叠；正典由 foldCanon 见 lost 即重压
    function rollbackOnDelete(chat, data) {
        const alive = new Set();
        for (const m of chat) if (m?.send_date) alive.add(m.send_date);
        let n = rollbackValues(data, d => !alive.has(d));
        const cov = coverage(data);
        const before = data.outline.lines.length;
        data.outline.lines = data.outline.lines.filter(l => {
            const dates = Array.isArray(l.dates) ? l.dates : [];
            const bad = dates.some(d => !alive.has(d) || (cov.get(d) && cov.get(d).status !== 'ok'));
            if (!bad) return true;
            for (const id of (l.from || [])) {
                const e = data.entries.find(x => x.id === id);
                if (e && e.status === 'ok' && !data.outline.pending.includes(id)) data.outline.pending.push(id);
            }
            return false;
        });
        n += before - data.outline.lines.length;
        return n;
    }

    /* ================= 隐藏已总结楼层（可逆） ================= */

    function setHiddenDom(idx, hidden) {
        const el = document.querySelector(`#chat .mes[mesid="${idx}"]`);
        if (el) el.setAttribute('is_system', String(hidden));
    }

    // 从末尾数 keepVisible 条可见消息保留，之前的楼层：AI 楼已总结成功 → 藏；其前一条用户楼跟着藏。
    // 用户手动取消过隐藏的（data.hidden 里有但当前可见）不再自动藏，直到「取消隐藏」清表。
    function hideSummarized() {
        if (!settings.enabled || !settings.hideSummarized) return 0;
        const ctx = getCtx();
        const data = getData();
        const chat = ctx.chat || [];
        if (!data || !ctx.chatId) return 0;
        const keep = Math.max(2, Number(settings.keepVisible) || 6);
        let seen = 0, cut = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!chat[i] || chat[i].is_system) continue;
            if (++seen > keep) { cut = i; break; }
        }
        if (cut < 0) return 0;
        const okDates = new Set();
        for (const w of data.windows) if (w.status === 'ok') for (const d of w.dates) okDates.add(d);
        let n = 0;
        for (let i = 0; i <= cut; i++) {
            const m = chat[i];
            if (!m || m.is_system || !m.send_date) continue;
            if (data.hidden[m.send_date]) continue;
            let hide;
            if (m.is_user) {
                const next = chat[i + 1];
                hide = i + 1 <= cut && next && !next.is_user && okDates.has(next.send_date);
            } else {
                hide = okDates.has(m.send_date);
            }
            if (!hide) continue;
            m.is_system = true;
            data.hidden[m.send_date] = true;
            setHiddenDom(i, true);
            n++;
        }
        if (n) {
            saveData();
            Promise.resolve(ctx.saveChat?.()).catch(err => warn('保存聊天失败：', err));
            log('隐藏', n, '条已总结消息');
        }
        return n;
    }

    function unhideAll() {
        const ctx = getCtx();
        const data = getData();
        const chat = ctx.chat || [];
        if (!data || !ctx.chatId) return 0;
        let n = 0;
        chat.forEach((m, i) => {
            if (m?.is_system && m.send_date && data.hidden[m.send_date]) { m.is_system = false; setHiddenDom(i, false); n++; }
        });
        data.hidden = {};
        saveData();
        if (n) Promise.resolve(ctx.saveChat?.()).catch(err => warn('保存聊天失败：', err));
        return n;
    }

    /* ================= 注入 ================= */

    let lastInject = { text: '', count: 0, chars: 0, dropped: 0, droppedIds: [], fallback: 0, outline: 0, recalled: 0, raw: 0 };

    function weight(e, len) {
        const age = Math.max(0, len - 1 - (e.src?.idx ?? 0));
        return GRADE_BASE[e.grade] * Math.pow(0.5, age / GRADE_HALFLIFE[e.grade]);
    }
    const weightAt = (grade, idx, len) => GRADE_BASE[grade] * Math.pow(0.5, Math.max(0, len - 1 - idx) / GRADE_HALFLIFE[grade]);

    function fmtEntry(e, withGrade) {
        let line = `- ${e.story_time || '（时间未知）'}「${e.title}」${withGrade ? `(${e.grade}) ` : ''}${e.summary}`;
        const extras = [];
        if (e.emotion_shift) extras.push(`情绪：${e.emotion_shift}`);
        if (e.known_by?.length) extras.push(`知情：${e.known_by.join('、')}`);
        if (extras.length) line += '｜' + extras.join('｜');
        if (e.type === 'intimacy' && e.intimacy) {
            const parts = [e.intimacy.acts, e.intimacy.consent, e.intimacy.firsts, e.intimacy.aftermath].filter(Boolean);
            if (parts.length) line += `\n  亲密：${parts.join('；')}`;
        }
        return line;
    }

    function recentText(chat, n) {
        const out = [];
        let c = 0;
        for (let i = chat.length - 1; i >= 0 && c < n; i--) {
            const m = chat[i];
            if (!m || m.is_system) continue;
            out.push(m.is_user ? String(m.mes || '') : extractContent(m.mes).text);
            c++;
        }
        return out.join('\n').toLowerCase();
    }
    // 激活词：名字、别称、身份（「秘书」「母亲」也能命中；「用户的母亲」取「母亲」）
    const mentionTokens = p => [p.name, ...(p.aliases || []), fv(p, 'role'), fv(p, 'role').replace(/^.+?的/, '')]
        .map(s => String(s || '').trim().toLowerCase()).filter(s => s.length >= 2);
    const mentioned = (p, text) => mentionTokens(p).some(a => text.includes(a));

    function fmtPerson(p, full) {
        const head = `${p.name}${p.aliases?.length ? `（${p.aliases.join('/')}）` : ''}`;
        if (!full) return `${head}${fv(p, 'role') ? `·${fv(p, 'role')}` : ''}${p.state && p.state !== '在场' ? `·${p.state}` : ''}`;
        const parts = [];
        if (p.state && p.state !== '在场') parts.push(`状态：${p.state}`);   // 在场是默认，不占字
        parts.push(...PERSON_FIELDS.filter(k => fv(p, k)).map(k => `${personLabel(k)}：${fv(p, k)}`));
        const views = Object.entries(p.views || {}).filter(([, v]) => v?.v).map(([to, v]) => `对${to}${v.trend ? `·${v.trend}` : ''}·${v.v}`);
        if (views.length) parts.push(`看法：${views.join('；')}`);
        return `- ${head}${parts.length ? '｜' + parts.join('｜') : ''}`;
    }
    // 物件履历：从条目里按名字匹配抠楼号+标题（零 LLM）；只给关键物件，超过 5 条取头 2 尾 3
    function itemHistory(data, it) {
        const n = norm(it.name); if (!n || n.length < 2) return '';
        const hits = data.entries.filter(e => e.status === 'ok' && ((e.tags || []).some(t => norm(t).includes(n)) || norm(`${e.title} ${e.summary}`).includes(n)))
            .sort((a, b) => (a.src?.idx ?? 0) - (b.src?.idx ?? 0));
        if (hits.length < 2) return '';
        const pick = hits.length > 5 ? [...hits.slice(0, 2), ...hits.slice(-3)] : hits;
        return `履历：${pick.map(e => `#${e.src?.idx ?? '?'} ${e.title}`).join(' · ')}${hits.length > pick.length ? `（另 ${hits.length - pick.length} 条）` : ''}`;
    }
    const fmtItem = (it, data) => `- ${it.name}${it.state ? `｜状态：${it.state}` : ''}${ITEM_FIELDS.filter(k => fv(it, k)).map(k => `｜${ITEM_LABEL[k]}：${fv(it, k)}`).join('')}${data && it.tier === '关键' ? (h => h ? `｜${h}` : '')(itemHistory(data, it)) : ''}`;
    const isExtra = p => p.tier === '龙套';
    const isProp = it => it.tier === '摆设';
    const isSettled = it => ITEM_SETTLED.includes(it.state);

    // 关系现状 + 人物志 + 物件：最近几条可见消息里提到的人物出完整卡，其余只列名字；龙套不进注入块
    // 物件：摆设不进；已使用/遗失/损毁/封存的降成一行「已了结」（信烧了是要记住的事实，但不值一张卡）
    // 总字数受 entityChars 约束，放不下的完整卡按最久未露面降为一行
    function entityLines(data, chat) {
        const ctx = getCtx();
        const lines = [];
        if (data.relation?.v) lines.push('', '## 关系现状', `- ${ctx.name2 || '{{char}}'} 对 ${ctx.name1 || '{{user}}'}：${data.relation.v}`);
        const budget = Math.max(200, Number(settings.entityChars) || 1500);
        let used = 0;
        const people = data.people.filter(p => !isExtra(p) && !p.lost);
        if (people.length) {
            const text = recentText(chat, Math.max(1, Number(settings.npcScanDepth) || 6));
            const active = people.filter(p => mentioned(p, text)).sort((a, b) => (b.last_idx || 0) - (a.last_idx || 0));
            const brief = people.filter(p => !mentioned(p, text));
            const full = [];
            for (const p of active) {
                const s = fmtPerson(p, true);
                if (used + s.length <= budget) { full.push(s); used += s.length; } else brief.push(p);
            }
            brief.sort((a, b) => (a.first_idx || 0) - (b.first_idx || 0));
            lines.push('', '## 人物志', ...full);
            if (brief.length) lines.push(`- 其他已登场：${brief.map(p => fmtPerson(p, false)).join('、')}`);
        }
        const items = data.items.filter(it => !isProp(it) && !it.lost);
        if (items.length) {
            const full = [], rest = [], settled = [];
            for (const it of items.slice().sort((a, b) => (b.last_idx || 0) - (a.last_idx || 0))) {
                if (isSettled(it)) { settled.push(`${it.name}（${it.state}${fv(it, 'holder') ? `·${fv(it, 'holder')}` : ''}）`); continue; }
                const s = fmtItem(it, data);
                if (used + s.length <= budget) { full.push(s); used += s.length; } else rest.push(it.name);
            }
            lines.push('', '## 物件', ...full);
            if (rest.length) lines.push(`- 其他：${rest.join('、')}`);
            if (settled.length) lines.push(`- 已了结：${settled.join('、')}`);
        }
        return lines;
    }

    // recap 保底：可见深度 ≥ recapWindow（预设自己不再带 recap）或已隐藏、且未被 ok 窗口覆盖（未总结 / 失败 / 拒答 / 窗口申报未覆盖）的楼，
    // 有 recap 的注入作者摘要一行；没有的合并成区间占位一行，告诉主模型这段不在上下文、不要补写
    function fallbackLines(data, chat, depths) {
        const ctx = getCtx();
        const RW = Number.isFinite(Number(settings.recapWindow)) ? Math.max(0, Number(settings.recapWindow)) : 20;
        const covered = new Set(), holes = new Set();
        for (const w of data.windows) {
            if (w.status !== 'ok') continue;
            for (const d of w.dates) covered.add(d);
            for (const d of (w.uncovered || [])) holes.add(d);
        }
        const out = [];
        let range = null;
        const flush = () => {
            if (!range) return;
            out.push({ idx: range.a, text: range.a === range.b ? `- #${range.a} 楼尚未整理，正文不在上下文，不要补写这楼的细节` : `- #${range.a}–#${range.b} 楼尚未整理，正文不在上下文，不要补写这段的细节` });
            range = null;
        };
        for (let i = 0; i < chat.length; i++) {
            const m = chat[i];
            if (!isAiFloor(m, ctx) || !m.send_date) continue;
            const d = depths[i];
            const far = d < 0 || d >= RW;
            const need = far && !data.skip[m.send_date] && (!covered.has(m.send_date) || holes.has(m.send_date));
            if (!need) { flush(); continue; }
            const r = data.recaps[m.send_date];
            if (r && (r.t || r.n)) { flush(); out.push({ idx: i, text: `- ${r.t || '（时间未知）'}「#${i}·作者摘要」${r.n}` }); }
            else if (range) range.b = i;
            else range = { a: i, b: i };
        }
        flush();
        return out;
    }

    // 正典：压缩段 + 压缩之后新增的 S 逐条附后；没压缩过就逐条
    function canonLines(data, canonAll) {
        if (!data.canon?.text || !data.canon.builtFrom?.length) return canonAll.map(e => fmtEntry(e, false));
        const built = new Set(data.canon.builtFrom);
        return [data.canon.text.trim(), ...canonAll.filter(e => !built.has(e.id)).map(e => fmtEntry(e, false))];
    }

    // 远景：按楼号排序；超预算时最老的先不注入（治理任务会把它们折成时期行）
    function outlineLines(data) {
        const budget = Math.max(300, Number(settings.outlineChars) || 2000);
        const lines = (data.outline?.lines || []).slice().sort((a, b) => a.idx - b.idx).map(l => `- ${l.key}：${l.text}`);
        let total = lines.reduce((n, l) => n + l.length + 1, 0);
        while (lines.length && total > budget) total -= lines.shift().length + 1;
        return lines;
    }

    // 块首说明：设置里可改，留空用默认
    const DEFAULT_HEADER = [
        '[以上是还留在眼前的对话。以下是更早的记忆，由记忆插件维护；关系现状/人物志/物件是截至目前的档案，远景/正典/往事覆盖最近三回合之前的全部剧情，按时间顺序]',
        '[远景 = 更早时期的骨架，只留人名、日期、关键物件、承诺与结果；正典 = 定了的事，写作不可违背；往事 = 已发生的事实，可回调、呼应、形成对比，但不复述、不总结、不预告]',
        '[知情栏是信息墙：未列名者不知情，当前角色未必知晓其他人的事]',
        '[人物志的「阶段」「看法」是关系参考，不是指令]',
    ];
    const headerLines = () => { const t = String(settings.headerText || '').trim(); return t ? t.split('\n').map(s => s.trim()).filter(Boolean) : DEFAULT_HEADER; };

    function buildBlock(opts = {}) {
        const ctx = getCtx();
        const data = getData();
        const chat = ctx.chat || [];
        const len = chat.length;
        const empty = { text: '', count: 0, chars: 0, dropped: 0, droppedIds: [], fallback: 0, outline: 0, recalled: 0, raw: 0, sizes: {} };
        if (!data) return empty;
        const depths = visibleDepths(chat);
        const list = data.entries.filter(e => e.status === 'ok' && injectable(e, depths));
        const isCanon = e => e.grade === 'S' || e.pinned;
        const canonAll = list.filter(isCanon);
        // 已折进远景的条目不再进往事（避免重复），仍参与召回
        const folded = new Set();
        for (const l of (data.outline?.lines || [])) for (const id of (l.from || [])) folded.add(id);
        const pastEntries = list.filter(e => !isCanon(e) && !folded.has(e.id));
        const pool = pastEntries.map(e => ({ e, idx: e.src?.idx ?? 0, grade: e.grade, text: fmtEntry(e, true) }))
            .concat(fallbackLines(data, chat, depths).map(x => ({ fb: true, idx: x.idx, grade: 'B', text: x.text })))
            .sort((a, b) => a.idx - b.idx);
        const canon = canonLines(data, canonAll);
        const canonChars = canon.reduce((n, s) => n + s.length + 1, 0);
        const budget = Number(settings.maxInjectChars) || 9000;
        const size = () => canonChars + pool.reduce((n, p) => n + p.text.length + 1, 0);
        const droppedIds = [];
        let dropped = 0;
        while (pool.length && size() > budget) {
            // 先丢权重最低的非 A（保底行按 B 算），非 A 丢完再丢 A；S 永不丢
            let k = -1, kw = Infinity;
            pool.forEach((p, i) => { if (p.grade === 'A') return; const w = p.e ? weight(p.e, len) : weightAt('B', p.idx, len); if (w < kw) { kw = w; k = i; } });
            if (k < 0) k = pool.findIndex(p => p.grade === 'A');
            if (k < 0) break;
            const [gone] = pool.splice(k, 1);
            dropped++;
            if (gone.e) droppedIds.push(gone.e.id);
        }
        // 被裁掉的条目排进远景待折叠队列（治理任务攒够 foldMin 条跑一次）
        if (!opts.dry && droppedIds.length) {
            let added = false;
            for (const id of droppedIds) if (!data.outline.pending.includes(id)) { data.outline.pending.push(id); added = true; }
            if (added) saveData();
        }
        const ent = entityLines(data, chat);
        const outline = outlineLines(data);
        const rendered = new Set([...canonAll.map(e => e.id), ...pool.filter(p => p.e).map(p => p.e.id)]);
        const recall = recallLines(data, depths, rendered);
        const count = canonAll.length + pool.filter(p => p.e).length;
        if (!count && !ent.length && !outline.length && !recall.entries.length && !pool.length) return { ...empty, dropped, droppedIds };
        const parts = ['<erato_memory>', ...headerLines(), ...ent];
        const sizeOf = arr => arr.reduce((n, s) => n + s.length + 1, 0);
        const sizes = { ent: sizeOf(ent), outline: sizeOf(outline), canon: sizeOf(canon), past: sizeOf(pool.filter(p => p.e).map(p => p.text)), fallback: sizeOf(pool.filter(p => p.fb).map(p => p.text)), recall: sizeOf(recall.entries), raw: sizeOf(recall.raw) };
        if (outline.length) parts.push('', '## 远景', ...outline);
        if (canon.length) parts.push('', '## 正典', ...canon);
        if (pool.length) parts.push('', '## 往事', ...pool.map(p => p.text));
        if (recall.entries.length) parts.push('', '## 相关往事', '[按当下话题从更早的记忆里召回，时间早于上面的往事，同样只作已发生事实]', ...recall.entries);
        if (recall.raw.length) parts.push('', '## 原文细节', '[与当下话题相关的旧楼原文片段，只用来核对细节，不复述]', ...recall.raw);
        parts.push('</erato_memory>');
        const text = parts.join('\n');
        return { text, count, chars: text.length, dropped, droppedIds, fallback: pool.filter(p => p.fb).length, outline: outline.length, recalled: recall.entries.length, raw: recall.raw.length, sizes };
    }

    function applyInjection() {
        const ctx = getCtx();
        const depth = Number(settings.injectDepth) || 6;
        if (!settings.enabled || !ctx.chatId) {
            ctx.setExtensionPrompt(PROMPT_KEY, '', IN_CHAT, depth, false, ROLE_SYSTEM);
            lastInject = { text: '', count: 0, chars: 0, dropped: 0, droppedIds: [], fallback: 0, outline: 0, recalled: 0, raw: 0 };
            return;
        }
        const b = buildBlock();
        lastInject = b;
        ctx.setExtensionPrompt(PROMPT_KEY, b.text, IN_CHAT, depth, false, ROLE_SYSTEM);
        log('注入', b.count, '条', b.chars, '字', b.dropped ? `裁掉 ${b.dropped}` : '', b.recalled ? `召回 ${b.recalled}` : '');
        const data = getData();
        if (data && settings.autoFold === 'always' && data.outline.pending.length >= Math.max(1, Number(settings.foldMin) || 6)) scheduleGovern();
    }

    // 生成前拦截器（manifest.generate_interceptor）：对账 → 等召回（有硬超时，超时就不带召回）→ 格式化；不做副 API 摘要
    window.eratoMemory_intercept = async (chat, contextSize, abort, type) => {
        if (type === 'quiet') return;
        try { reconcile(); await recallForPrompt(); applyInjection(); } catch (err) { warn('拦截器异常：', err); }
    };

    /* ================= 治理：正典压缩 + 远景折叠（副 API；不与总结并发，不阻塞生成） ================= */

    const gov = { busy: false, timer: null, fails: 0 };
    function scheduleGovern(delay = 3000) {
        if (gov.fails >= 3) return;   // 连续失败三次就歇着，下次总结批次结束再试
        clearTimeout(gov.timer);
        gov.timer = setTimeout(() => govern().catch(err => warn('治理失败：', err)), delay);
    }

    // 折叠/压缩调用：纯文本或 JSON 输出，都要求结束哨兵；缺哨兵或撞上限重来一次
    async function callFold(user, maxTokens, note) {
        const data = getData();
        const messages = [{ role: 'system', content: FOLD_SYSTEM_PROMPT }, { role: 'user', content: user }];
        const keep = (r, n) => {
            if (!data) return;
            if (!Array.isArray(data.rawLog)) data.rawLog = [];
            data.rawLog.unshift({ at: Date.now(), win: note || '治理', model: settings.api.model, finish: r.finish || '', note: n || '', text: String(r.text || '').slice(0, RAW_LOG_CHARS) });
            data.rawLog.length = Math.min(data.rawLog.length, RAW_LOG_MAX);
        };
        let r = await callApi(messages, maxTokens);
        keep(r);
        if (r.finish === 'length' || !hasEndMark(r.text)) {
            r = await callApi(messages.concat([{ role: 'assistant', content: r.text.slice(0, 2000) }, { role: 'user', content: `上面的输出被截断了。重新输出，字数压到原要求的一半以内；结束后另起一行输出 ${END_MARK}。` }]), maxTokens);
            keep(r, '压缩重试');
            if (r.finish === 'length' || !hasEndMark(r.text)) throw new Error('输出两次被截断');
        }
        return r;
    }

    // 故事日：story_time 第一个「·」之前的部分，全角数字转半角、汉字数字转阿拉伯（年份保留，长记忆会跨年）；没有日期的按 40 楼一段
    const CN_DIGITS = { '〇': 0, '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    function cnNumber(s) {
        if (!s) return null;
        if (!s.includes('十')) { if ([...s].every(c => c in CN_DIGITS)) return Number([...s].map(c => CN_DIGITS[c]).join('')); return null; }   // 二零二五 → 2025
        const [l, r] = s.split('十');
        const tens = l ? CN_DIGITS[l] : 1, ones = r ? CN_DIGITS[r] : 0;
        return tens === undefined || ones === undefined ? null : tens * 10 + ones;
    }
    function normDate(t) {
        return String(t || '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
            .replace(/([〇零一二两三四五六七八九十]+)(?=[年月日号])/g, (m, s) => { const n = cnNumber(s); return n === null ? m : String(n); })
            .replace(/号/g, '日').replace(/\s+/g, '').trim();
    }
    const dayKey = e => {
        const t = normDate(String(e.story_time || '').split(/[·|｜]/)[0]);
        return t && t.length <= 14 && !/^（?未知/.test(t) ? t : `#${Math.floor((e.src?.idx ?? 0) / 40) * 40} 楼段`;
    };

    async function govern(force = false) {
        if (gov.busy || run.busy || !settings.enabled || !apiConfigured()) return false;
        const data = getData(); if (!data) return false;
        const chatId = getCtx().chatId;
        const alive = () => getData() === data && getCtx().chatId === chatId;
        gov.busy = true;
        const done = [];
        try {
            if (await foldCanon(data, force)) done.push('正典已重压');
            if (alive()) { const n = await foldOutline(data, force); if (n) done.push(`远景折叠 ${n} 组`); }
            let periods = 0;
            for (let i = 0; i < 3 && alive(); i++) { if (!await foldPeriods(data)) break; periods++; }
            if (periods) done.push(`时期合并 ${periods} 次`);
            gov.fails = 0;
        } catch (err) {
            gov.fails++;
            warn('治理失败：', err);
            if (alive()) data.stats.lastError = '治理：' + err.message;
        } finally {
            gov.busy = false;
            if (alive()) { saveData(); if (done.length) { applyInjection(); renderPanel(); if (!force) toast('info', `记忆整理：${done.join('，')}`); } refreshStatus(); }
        }
        return done.length > 0;
    }

    // 正典压缩：S/钉选超过 canonMax 条时压成一段；有 S 被删（builtFrom 里的 id 消失）立刻重压，只新增的攒够 CANON_RESEAL 条再压；手改锁定的不动
    async function foldCanon(data, force) {
        if (data.canon?.manual) return false;
        const S = data.entries.filter(e => e.status === 'ok' && (e.grade === 'S' || e.pinned));
        const max = Math.max(3, Number(settings.canonMax) || 25);
        if (!S.length) { if (data.canon.text) { data.canon = { text: '', builtFrom: [], builtAt: 0 }; return true; } return false; }
        const built = new Set(data.canon.builtFrom || []);
        const fresh = S.filter(e => !built.has(e.id)).length;
        const lost = [...built].filter(id => !S.some(e => e.id === id)).length;
        // S 降回阈值以内（删楼/改等级）就不需要压缩段，逐条注入即可
        if (S.length <= max && !force) { if (data.canon.text) { data.canon = { text: '', builtFrom: [], builtAt: 0 }; return true; } return false; }
        if (data.canon.text && lost === 0 && fresh < CANON_RESEAL && !force) return false;
        const limit = Math.max(200, Number(settings.canonChars) || 800);
        const user = `## 折叠规则\n${FOLD_RULES}\n- 下面每一条都是已定案、不可逆的事实，一条都不能丢，只能压措辞。\n\n## 待压缩的正典条目（按时间顺序）\n${S.map(e => fmtEntry(e, false)).join('\n')}\n\n## 输出\n输出压缩后的正典：Markdown 项目符号，一行一条，按时间顺序，总字数 ≤${limit} 字；不加标题、不解释。正文结束后另起一行输出 ${END_MARK}`;
        const r = await callFold(user, Math.min(4000, Math.max(600, limit * 3)), '正典压缩');
        if (getData() !== data) return false;
        const text = stripEndMark(r.text).trim();
        if (text.length < 20) throw new Error('正典压缩返回为空');
        data.canon = { text: text.slice(0, Math.floor(limit * 1.5)), builtFrom: S.map(e => e.id), builtAt: Date.now() };
        log('正典压缩', S.length, '条 →', text.length, '字');
        return true;
    }

    // 远景折叠：被裁条目按故事日分组，一次调用折完；材料 = 条目 + 所在楼的 recap；已有同日骨架则合并重写（手改过的行不动，另起「·续」行）。返回折了几组
    const outlineTarget = (data, key) => {
        let k = key, n = 1;
        for (;;) {
            const line = data.outline.lines.find(l => l.level === 1 && l.key === k);
            if (!line) return { key: k, line: null };
            if (!line.manual) return { key: k, line };
            k = `${key}·续${n > 1 ? n : ''}`; n++;
        }
    };
    async function foldOutline(data, force) {
        const pending = data.outline.pending.map(id => data.entries.find(e => e.id === id)).filter(e => e && e.status === 'ok');
        data.outline.pending = pending.map(e => e.id);
        const min = Math.max(1, Number(settings.foldMin) || 6);
        if (!pending.length || (pending.length < min && !force)) return 0;
        const groups = new Map();
        for (const e of pending) { const k = outlineTarget(data, dayKey(e)).key; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
        const blocks = [];
        for (const [key, list] of groups) {
            const existing = data.outline.lines.find(l => l.level === 1 && l.key === key && !l.manual);
            const recaps = [...new Set(list.flatMap(e => e.src?.dates || []))].map(d => data.recaps[d]).filter(r => r?.n).slice(0, 3);
            blocks.push(`### ${key}${existing ? `\n现有骨架：${existing.text}` : ''}\n新增材料：\n${list.map(e => fmtEntry(e, true)).join('\n')}${recaps.length ? `\n作者摘要：\n${recaps.map(r => `- ${r.t} ${r.n.slice(0, 200)}`).join('\n')}` : ''}`);
        }
        const user = `## 折叠规则\n${FOLD_RULES}\n- 每个分组输出一条，≤100 字；key 与分组标题一字不差。\n\n## 待折叠（按故事日分组）\n${blocks.join('\n\n')}\n\n## 输出\n{"lines":[{"key":"分组标题","text":"该日骨架"}]}\nJSON 之后另起一行输出 ${END_MARK}`;
        const r = await callFold(user, 3000, '远景折叠');
        if (getData() !== data) return 0;
        const obj = parseJson(stripEndMark(r.text));
        const lines = Array.isArray(obj?.lines) ? obj.lines : null;
        if (!lines) throw new Error('远景折叠返回不是 JSON');
        let n = 0;
        for (const [key, list] of groups) {
            const got = lines.find(l => norm(l?.key) === norm(key)) || (groups.size === 1 ? lines[0] : null);
            const text = String(got?.text || '').trim();
            if (!text) continue;
            const ids = list.map(e => e.id);
            const idxs = list.flatMap(e => e.src?.floors?.length ? e.src.floors : [e.src?.idx ?? 0]);
            const dates = list.flatMap(e => e.src?.dates || []);
            const line = data.outline.lines.find(l => l.level === 1 && l.key === key && !l.manual);
            if (line) { line.text = text; line.from = [...new Set([...line.from, ...ids])]; line.dates = [...new Set([...(line.dates || []), ...dates])]; line.idx = Math.min(line.idx, ...idxs); line.last = Math.max(line.last, ...idxs); line.at = Date.now(); }
            else data.outline.lines.push({ id: uid('o'), key, text, from: ids, dates: [...new Set(dates)], idx: Math.min(...idxs), last: Math.max(...idxs), level: 1, at: Date.now() });
            data.outline.pending = data.outline.pending.filter(id => !ids.includes(id));
            n++;
        }
        data.outline.lines.sort((a, b) => a.idx - b.idx);
        data.outline.at = Date.now();
        log('远景折叠', n, '组');
        return n;
    }

    // 远景超预算：最老的若干日行（≥3，手改的跳过）合成一条「时期」行，直到总量回到预算七成以内
    async function foldPeriods(data) {
        const budget = Math.max(300, Number(settings.outlineChars) || 2000);
        const cost = l => l.key.length + l.text.length + 3;
        let total = data.outline.lines.reduce((n, l) => n + cost(l), 0);
        if (total <= budget) return false;
        const days = data.outline.lines.filter(l => l.level === 1 && !l.manual).sort((a, b) => a.idx - b.idx);
        if (days.length < 3) return false;
        const pick = [];
        for (const l of days) { pick.push(l); total -= cost(l); if (pick.length >= 3 && total <= budget * 0.7) break; }
        const key = `${pick[0].key}～${pick[pick.length - 1].key}`;
        const user = `## 折叠规则\n${FOLD_RULES}\n- 把下面这些按日骨架合并成一条「时期」骨架，≤200 字；按时间顺序写清这段时期发生了什么、谁对谁做了什么、结果如何。\n\n## 待合并（${key}）\n${pick.map(l => `- ${l.key}：${l.text}`).join('\n')}\n\n## 输出\n只输出这一条时期骨架的正文，不加前缀、不加标题；正文结束后另起一行输出 ${END_MARK}`;
        const r = await callFold(user, 1500, '时期折叠');
        if (getData() !== data) return false;
        const text = stripEndMark(r.text).trim().replace(/^[-*•]\s*/, '');
        if (text.length < 10) throw new Error('时期折叠返回为空');
        const ids = new Set(pick.map(l => l.id));
        data.outline.lines = data.outline.lines.filter(l => !ids.has(l.id));
        data.outline.lines.push({ id: uid('o'), key, text: text.slice(0, 400), from: pick.flatMap(l => l.from || []), dates: [...new Set(pick.flatMap(l => l.dates || []))], idx: pick[0].idx, last: Math.max(...pick.map(l => l.last || l.idx)), level: 2, at: Date.now(), merged: pick.length });
        data.outline.lines.sort((a, b) => a.idx - b.idx);
        log('时期折叠', pick.length, '行 →', key);
        return true;
    }

    /* ================= 召回：关键词通道（零网络）+ 向量通道（酒馆 /api/vector/*） ================= */

    const STOP_TERMS = new Set(['这个', '那个', '然后', '已经', '还是', '因为', '所以', '但是', '自己', '我们', '你们', '他们', '她们', '一个', '没有', '不是', '就是', '可以', '什么', '怎么', '这样', '那样', '时候', '现在', '一下', '一点', 'the', 'and', 'that', 'this', 'with', 'from', 'have', 'you', 'are', 'was']);
    function termsOf(text, max = 400) {
        const out = new Set();
        const v = String(text || '').toLowerCase();
        for (const t of v.match(/[a-z0-9_]{3,}/g) || []) if (!STOP_TERMS.has(t)) out.add(t);
        for (const t of v.match(/\d+[㐀-鿿]{1,2}/g) || []) out.add(t);   // 「7号」「3楼」这类数字+汉字的组合是强线索
        for (const seq of v.match(/[㐀-鿿]{2,}/g) || []) {
            const maxGram = Math.min(4, seq.length);
            for (let w = 2; w <= maxGram; w++) {
                for (let i = 0; i + w <= seq.length; i++) {
                    const g = seq.slice(i, i + w);
                    if (STOP_TERMS.has(g) || /^[的了在和与及也都而或把被就又还很是不有我你他她它这那着过]+$/.test(g)) continue;
                    out.add(g);
                    if (out.size >= max) return out;
                }
            }
        }
        return out;
    }
    const entryText = e => `${e.story_time || ''} ${e.title} ${e.summary} ${(e.tags || []).join(' ')} ${(e.characters || []).join(' ')}`;
    const termCache = new Map();
    function entryTerms(e) {
        const k = `${e.id}:${e.updated_at || 0}`;
        let t = termCache.get(k);
        if (!t) { t = termsOf(entryText(e), 600); if (termCache.size > 3000) termCache.clear(); termCache.set(k, t); }
        return t;
    }
    // 关键词打分：查询串 n-gram 与条目 n-gram 的交集，按 IDF 加权，长词加权；至少命中 2 个词、分数不低于最高分三成
    function keywordRecall(query, cands, limit) {
        const q = [...termsOf(query, 300)];
        if (!q.length || !cands.length) return [];
        const sets = cands.map(entryTerms);
        const df = new Map(q.map(t => [t, 0]));
        for (const s of sets) for (const t of q) if (s.has(t)) df.set(t, df.get(t) + 1);
        const N = cands.length;
        const scored = cands.map((e, i) => {
            let score = 0, hits = 0;
            for (const t of q) {
                if (!sets[i].has(t)) continue;
                const f = df.get(t);
                if (f / N > 0.6 && t.length <= 2) continue;
                hits++;
                score += (t.length >= 4 ? 3 : t.length === 3 ? 2 : 1.2) * (Math.log((N + 1) / (f + 1)) + 0.3);
            }
            return { e, score, hits };
        }).filter(x => x.score > 0 && x.hits >= 2).sort((a, b) => b.score - a.score);
        const max = scored[0]?.score || 0;
        return scored.filter(x => x.score >= max * 0.3).slice(0, limit).map(x => ({ id: x.e.id, score: x.score / max, kw: true }));
    }

    // 查询串：最新用户输入（去 OOC 括号）+ 最近一条 AI 楼的 recap 叙述（正文几千字会稀释话题）
    function recallQuery(chat) {
        const visible = (chat || []).filter(m => m && !m.is_system);
        const lastUser = [...visible].reverse().find(m => m.is_user);
        const lastAi = [...visible].reverse().find(m => !m.is_user);
        const u = cleanUser(lastUser?.mes || '').replace(/[（(][^）)]*[）)]/g, ' ').trim();
        const r = lastAi ? extractRecap(lastAi.mes).narrative : '';
        const cap = Math.max(100, Number(settings.recall.queryChars) || 600);
        return `${u}\n${r}`.trim().slice(0, cap);
    }

    const rc = { key: '', promise: null, result: null, at: 0, error: '' };
    const recallEnabled = () => !!(settings.enabled && (settings.recall.keyword || settings.recall.vector));
    const recallSig = () => `${settings.recall.keyword ? 'k' : ''}${settings.recall.vector ? `v:${settings.recall.source}:${settings.recall.model}:${settings.recall.raw ? 'r' : ''}` : ''}`;

    // 预取：用户消息一落地就开始算（向量要走网络），生成前只等剩下的时间
    function prepareRecall(chat = getCtx().chat || []) {
        if (!recallEnabled()) { rc.key = ''; rc.result = null; rc.promise = null; return null; }
        const data = getData(); if (!data) return null;
        const query = recallQuery(chat);
        if (!query) { rc.key = ''; rc.result = null; rc.promise = null; return null; }
        const key = hash(`${getCtx().chatId}|${recallSig()}|${query}`);
        if (rc.key === key && (rc.result || rc.promise)) return rc.promise;
        rc.key = key; rc.result = null; rc.error = ''; rc.at = Date.now();
        const p = doRecall(data, query, key).then(res => { if (rc.key === key) { rc.result = res; rc.promise = null; } return res; })
            .catch(err => { if (rc.key === key) { rc.error = err.message; rc.promise = null; rc.result = { key, entries: [], raw: [], mode: `失败：${err.message}` }; } });
        rc.promise = p;
        return p;
    }

    async function doRecall(data, query, key) {
        const cands = data.entries.filter(e => e.status === 'ok');
        const topK = clamp(Number(settings.recall.topK) || 8, 1, 30);
        const scores = new Map();
        let mode = [];
        if (settings.recall.keyword) {
            for (const h of keywordRecall(query, cands, topK * 2)) scores.set(h.id, { score: h.score * 0.9, kw: true });
            mode.push('关键词');
        }
        let raw = [];
        if (settings.recall.vector) {
            // 向量通道失败（密钥没写、服务超时）只丢向量结果，关键词命中照常给
            try {
                const v = await vecQuery(data, query, topK);
                v.ids.forEach((id, rank) => {
                    const s = Math.max(0.3, 1 - rank * 0.06);
                    const old = scores.get(id);
                    scores.set(id, old ? { score: Math.max(old.score, s) + 0.25, kw: old.kw, vec: true } : { score: s, vec: true });
                });
                raw = v.raw;
                mode.push('向量');
            } catch (err) {
                rc.error = `向量召回失败：${err.message}`;
                mode.push('向量失败');
            }
        }
        const entries = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, topK).map(([id, s]) => ({ id, ...s }));
        return { key, entries, raw, mode: mode.join('+'), at: Date.now() };
    }

    // 生成前：最多等 timeoutSec，超时就不带召回（预取仍会继续跑完，下一轮能用上）
    async function recallForPrompt() {
        if (!recallEnabled()) return;
        const p = prepareRecall();
        if (!p || rc.result) return;
        const ms = Math.max(500, (Number(settings.recall.timeoutSec) || 4) * 1000);
        await Promise.race([p, sleep(ms)]);
        if (!rc.result) rc.error = rc.error || `召回超时（${ms / 1000}s）`;
    }

    // 召回结果进注入块：只捞没被正典/往事渲染的条目，按楼号升序；原文细节独立预算
    function recallLines(data, depths, rendered) {
        const res = rc.result;
        const out = { entries: [], raw: [] };
        if (!res || !recallEnabled()) return out;
        const budget = Math.max(200, Number(settings.recall.recallChars) || 2000);
        let used = 0;
        const picked = [];
        for (const h of res.entries) {
            if (rendered.has(h.id)) continue;
            const e = data.entries.find(x => x.id === h.id);
            if (!e || e.status !== 'ok' || !injectable(e, depths)) continue;
            const text = fmtEntry(e, true);
            if (used + text.length > budget) continue;
            used += text.length;
            picked.push({ idx: e.src?.idx ?? 0, text });
        }
        out.entries = picked.sort((a, b) => a.idx - b.idx).map(p => p.text);
        const rawBudget = Math.max(200, Number(settings.recall.rawChars) || 1200);
        let rawUsed = 0;
        const rawPicked = [];
        for (const r of (res.raw || [])) {
            const i = Number(r.index);
            if (!Number.isFinite(i) || i >= depths.length || (depths[i] >= 0 && depths[i] < (Number(settings.contentWindow) || 6))) continue;   // 还在正文窗口里的楼不重复
            const text = `- #${i}：${String(r.text || '').replace(/\s+/g, ' ').trim()}`;
            if (rawUsed + text.length > rawBudget) continue;
            rawUsed += text.length;
            rawPicked.push({ idx: i, text });
        }
        out.raw = rawPicked.sort((a, b) => a.idx - b.idx).map(p => p.text);
        return out;
    }

    /* ---- 向量库：酒馆自带 /api/vector/*，服务端 vectra 存储，浮点不进聊天文件 ---- */

    const vecOn = () => !!settings.recall.vector;
    const numHash = s => parseInt(hash(String(s)), 16);
    const vecCollection = kind => `erato-${kind}-${hash(String(getCtx().chatId || ''))}`;
    function vecBody() {
        const s = settings.recall;
        const src = VEC_SOURCES[s.source] ? s.source : 'siliconflow';
        const b = { source: src };
        if (src === 'siliconflow') { b.model = s.model?.trim() || VEC_SOURCES.siliconflow.model; b.siliconflow_endpoint = s.cn === false ? 'global' : 'cn'; }
        else if (src === 'vllm') { b.apiUrl = String(s.apiUrl || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, ''); b.model = s.model?.trim() || ''; }
        else b.model = s.model?.trim() || VEC_SOURCES.openai.model;
        return b;
    }
    async function vecCall(route, body, timeoutMs = 60000) {
        const ctx = getCtx();
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), timeoutMs);
        try {
            const res = await fetch(`/api/vector/${route}`, { method: 'POST', headers: ctx.getRequestHeaders(), signal: c.signal, body: JSON.stringify({ ...vecBody(), ...body }) });
            const text = await res.text();
            if (!res.ok) throw new Error(`HTTP ${res.status}${text ? '：' + text.slice(0, 120) : ''}`);
            try { return JSON.parse(text); } catch { return text; }
        } catch (err) {
            throw new Error(c.signal.aborted ? '超时' : err.message);
        } finally { clearTimeout(t); }
    }
    const vecEntryText = e => `${e.story_time || ''}｜${e.title}｜${e.summary}${e.emotion_shift ? `｜情绪：${e.emotion_shift}` : ''}${e.characters?.length ? `｜人物：${e.characters.join('、')}` : ''}`.slice(0, 300);
    const vecEntryHash = e => numHash(`${e.id}|${vecEntryText(e)}`);

    // 原文按约 600 字切块、带重叠，尽量在句末断
    function chunkText(text) {
        const s = String(text || '').replace(/\s+/g, ' ').trim();
        if (!s) return [];
        if (s.length <= RAW_CHUNK_CHARS * 1.3) return [s];
        const out = [];
        let start = 0;
        while (start < s.length) {
            let end = Math.min(s.length, start + RAW_CHUNK_CHARS);
            if (end < s.length) {
                const seg = s.slice(start + Math.floor(RAW_CHUNK_CHARS * 0.6), end);
                const m = seg.lastIndexOf('。') >= 0 ? seg.lastIndexOf('。') : Math.max(seg.lastIndexOf('！'), seg.lastIndexOf('？'), seg.lastIndexOf('\n'));
                if (m >= 0) end = start + Math.floor(RAW_CHUNK_CHARS * 0.6) + m + 1;
            }
            out.push(s.slice(start, end).trim());
            if (end >= s.length) break;
            start = Math.max(start + 1, end - RAW_CHUNK_OVERLAP);
        }
        return out.filter(Boolean);
    }

    async function vecIndexEntries(data, entries) {
        const items = [];
        for (const e of entries) {
            if (!e || e.status !== 'ok') continue;
            const h = vecEntryHash(e);
            if (data.vec.entries[e.id] === h) continue;
            items.push({ e, h });
        }
        if (!items.length) return 0;
        const stale = items.map(x => data.vec.entries[x.e.id]).filter(Number.isFinite);
        if (stale.length) await vecCall('delete', { collectionId: vecCollection('mem'), hashes: stale });
        for (let i = 0; i < items.length; i += 24) {
            const batch = items.slice(i, i + 24);
            await vecCall('insert', { collectionId: vecCollection('mem'), items: batch.map(x => ({ hash: x.h, text: vecEntryText(x.e), index: x.e.src?.idx ?? 0 })) }, 120000);
            for (const x of batch) data.vec.entries[x.e.id] = x.h;
        }
        return items.length;
    }
    async function vecIndexRaw(data, inputs) {
        if (!settings.recall.raw) return 0;
        let n = 0;
        for (const f of inputs) {
            if (!f?.send_date || !f.content) continue;
            const old = data.vec.raw[f.send_date];
            if (old?.h === f.hash) continue;
            if (old?.hs?.length) await vecCall('delete', { collectionId: vecCollection('raw'), hashes: old.hs });
            const chunks = chunkText(f.content);
            const hs = chunks.map((c, k) => numHash(`${f.send_date}|${k}|${f.hash}`));
            for (let i = 0; i < chunks.length; i += 16) {
                await vecCall('insert', { collectionId: vecCollection('raw'), items: chunks.slice(i, i + 16).map((c, k) => ({ hash: hs[i + k], text: c, index: f.idx })) }, 120000);
            }
            data.vec.raw[f.send_date] = { h: f.hash, hs };
            n += chunks.length;
        }
        return n;
    }
    async function vecDeleteEntries(data, ids) {
        const hs = ids.map(id => data.vec.entries[id]).filter(Number.isFinite);
        for (const id of ids) delete data.vec.entries[id];
        if (hs.length) await vecCall('delete', { collectionId: vecCollection('mem'), hashes: hs });
    }
    // 窗口 ok 后同步：失败只记错不影响入库，下次「补向量」或切聊天对账补上
    function vecAfterWindow(data, w, made, inputs, oldIds = []) {
        if (!vecOn()) return;
        (async () => {
            try {
                if (oldIds.length) await vecDeleteEntries(data, oldIds);
                await vecIndexEntries(data, made);
                await vecIndexRaw(data, inputs);
                data.vec.source = settings.recall.source; data.vec.model = vecBody().model || ''; data.vec.at = Date.now(); data.vec.error = '';
                saveData();
            } catch (err) {
                data.vec.error = err.message;
                warn('向量同步失败：', err.message);
                if (!rc.vecToasted) { rc.vecToasted = true; toast('warning', `向量同步失败：${err.message.slice(0, 80)}（不影响总结，可稍后「补向量」）`); }
            }
        })();
    }
    async function vecQuery(data, query, topK) {
        const out = { ids: [], raw: [] };
        const rev = new Map(Object.entries(data.vec.entries).map(([id, h]) => [Number(h), id]));
        if (rev.size) {
            const res = await vecCall('query', { collectionId: vecCollection('mem'), searchText: query, topK, threshold: Number(settings.recall.threshold) || 0 }, 30000);
            for (const m of (res?.metadata || [])) { const id = rev.get(Number(m.hash)); if (id && !out.ids.includes(id)) out.ids.push(id); }
        }
        if (settings.recall.raw && Object.keys(data.vec.raw).length) {
            const res = await vecCall('query', { collectionId: vecCollection('raw'), searchText: query, topK: Math.max(2, Math.min(6, Math.ceil(topK / 2))), threshold: Number(settings.recall.threshold) || 0 }, 30000);
            out.raw = (res?.metadata || []).map(m => ({ index: Number(m.index), text: String(m.text || '') })).filter(r => r.text);
        }
        return out;
    }
    // 对账：库里有本地没有 → 删；本地该有没有 → 补。onProgress(done, total) 给「重建」用
    async function vecSync(data, onProgress) {
        if (!vecOn()) return { entries: 0, raw: 0 };
        const okDates = new Set();
        for (const w of data.windows) if (w.status === 'ok') for (const d of w.dates) okDates.add(d);
        const okEntries = data.entries.filter(e => e.status === 'ok');
        const wantEntry = new Map(okEntries.map(e => [e.id, vecEntryHash(e)]));
        for (const id of Object.keys(data.vec.entries)) if (!wantEntry.has(id) || wantEntry.get(id) !== data.vec.entries[id]) delete data.vec.entries[id];
        const have = new Set((await vecCall('list', { collectionId: vecCollection('mem') }) || []).map(Number));
        const extra = [...have].filter(h => ![...wantEntry.values()].includes(h));
        if (extra.length) await vecCall('delete', { collectionId: vecCollection('mem'), hashes: extra });
        for (const [id, h] of wantEntry) if (have.has(h)) data.vec.entries[id] = h;
        const need = okEntries.filter(e => data.vec.entries[e.id] !== wantEntry.get(e.id));
        const total = need.length + (settings.recall.raw ? okDates.size : 0);
        let done = 0;
        for (let i = 0; i < need.length; i += 24) { await vecIndexEntries(data, need.slice(i, i + 24)); done += Math.min(24, need.length - i); onProgress?.(done, total); }
        let rawN = 0;
        if (settings.recall.raw) {
            const chat = getCtx().chat || [];
            for (const d of Object.keys(data.vec.raw)) if (!okDates.has(d)) { const hs = data.vec.raw[d]?.hs || []; if (hs.length) await vecCall('delete', { collectionId: vecCollection('raw'), hashes: hs }); delete data.vec.raw[d]; }
            const haveRaw = new Set((await vecCall('list', { collectionId: vecCollection('raw') }) || []).map(Number));
            for (const d of Object.keys(data.vec.raw)) if (!(data.vec.raw[d].hs || []).every(h => haveRaw.has(h))) delete data.vec.raw[d];
            const byDate = new Map(); chat.forEach((m, i) => { if (m?.send_date) byDate.set(m.send_date, i); });
            for (const d of okDates) {
                const i = byDate.get(d);
                if (i === undefined) { done++; continue; }
                const f = floorInput(chat, i);
                if (data.vec.raw[d]?.h !== f.hash) rawN += await vecIndexRaw(data, [f]);
                done++; onProgress?.(done, total);
            }
        }
        data.vec.source = settings.recall.source; data.vec.model = vecBody().model || ''; data.vec.at = Date.now(); data.vec.error = '';
        saveData();
        return { entries: need.length, raw: rawN };
    }
    async function vecRebuild(onProgress) {
        const data = getData(); if (!data) return null;
        await vecCall('purge', { collectionId: vecCollection('mem') });
        await vecCall('purge', { collectionId: vecCollection('raw') });
        data.vec = { entries: {}, raw: {}, source: '', model: '', at: 0 };
        return vecSync(data, onProgress);
    }
    async function vecTest() {
        const id = `erato-probe-${hash(String(Date.now()))}`;
        const h = numHash(id);
        await vecCall('insert', { collectionId: id, items: [{ hash: h, text: '探针：记忆插件向量连接测试', index: 0 }] }, 60000);
        const res = await vecCall('query', { collectionId: id, searchText: '向量连接测试', topK: 1, threshold: 0 }, 60000);
        await vecCall('purge', { collectionId: id }).catch(() => {});
        if (!Array.isArray(res?.metadata)) throw new Error('查询没有返回结果');
        return res.metadata.length;
    }
    // 把密钥写进酒馆对应源的槽位（会覆盖同名槽位）
    async function writeVecSecret(value) {
        const src = VEC_SOURCES[settings.recall.source] ? settings.recall.source : 'siliconflow';
        const res = await fetch('/api/secrets/write', { method: 'POST', headers: getCtx().getRequestHeaders(), body: JSON.stringify({ key: VEC_SOURCES[src].secret, value: String(value || ''), label: 'Erato Memory' }) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return VEC_SOURCES[src].secret;
    }

    /* ================= 状态 ================= */

    function counts() {
        const data = getData();
        const c = { events: 0, done: 0, todo: 0, todoAuto: 0, failed: 0, refused: 0, pending: 0, stale: 0, orphan: 0, hidden: 0, people: 0, items: 0 };
        if (!data) return c;
        c.events = data.entries.filter(e => e.status === 'ok').length;
        const chat = getCtx().chat || [];
        for (const w of data.windows) { if (w.status === 'ok') c.done += spanOf(chat, w.floors); else if (c[w.status] !== undefined) c[w.status]++; }
        c.todo = spanOf(chat, uncoveredFloors(chat, data, true)) + winFloors(retryWindows(data), chat);
        c.todoAuto = spanOf(chat, uncoveredFloors(chat, data, false));
        for (const m of chat) if (m?.is_system && m.send_date && data.hidden[m.send_date]) c.hidden++;
        c.people = data.people.length; c.items = data.items.length;
        return c;
    }

    function refreshStatus() {
        const c = counts();
        const bad = c.failed + c.refused;
        const N = Math.max(0, Number(settings.autoInterval) || 0);
        const injectLine = `本轮注入 ${lastInject.count} 条 ≈ ${lastInject.chars} 字${lastInject.dropped ? `（预算裁掉 ${lastInject.dropped}）` : ''}${lastInject.outline ? ` · 远景 ${lastInject.outline} 行` : ''}${lastInject.fallback ? ` · 保底 ${lastInject.fallback}` : ''}${lastInject.recalled || lastInject.raw ? ` · 召回 ${lastInject.recalled}${lastInject.raw ? `+原文 ${lastInject.raw}` : ''}` : ''}${rc.error ? ` · ${rc.error}` : ''}`;
        const autoLine = N ? `自动：每 ${N} 楼总结一次（已攒 ${Math.min(c.todoAuto, N)}/${N}），单次最多 ${Math.max(1, Number(settings.windowFloors) || 40)} 楼` : `自动总结已关：只在点「总结到当前」时总结，单次最多 ${Math.max(1, Number(settings.windowFloors) || 40)} 楼`;
        $('.em-status').text(`已总结 ${c.done} 楼 / ${c.events} 条 · 待总结 ${c.todo} 楼 · 失败 ${bad} 段 · 人物 ${c.people} · 物件 ${c.items} · 已隐藏 ${c.hidden} · ${injectLine}`);

        $('#em_n_ok').text(c.done); $('#em_n_todo').text(c.todo); $('#em_n_hidden').text(c.hidden); $('#em_n_bad').text(bad);
        $('#em_tile_bad').toggle(bad > 0);
        $('#em_inject_line').text(injectLine);
        $('#em_auto_line').text(autoLine);

        const main = $('#em_main');
        if (run.busy && run.manual) main.text(`停止（${run.done}/${run.total}）`).addClass('em-stop');
        else main.text(c.todo ? `总结到当前（${c.todo} 楼）` : '总结到当前').removeClass('em-stop');
        const prog = $('#em_progress');
        if (run.busy && run.total) {
            prog.show().find('.em-bar').css('width', `${Math.round(run.done / run.total * 100)}%`);
            prog.find('.em-prog-txt').text(`正在总结 ${run.done}/${run.total} 楼`);
        } else prog.hide();

        const suffix = run.busy ? ' · 处理中' : bad ? ` · ${bad} 段失败` : '';
        $('#em_wand_txt').text(`记忆面板${suffix}`);
        $('#em_wand_sum_txt').text(run.busy ? `总结到当前 · ${run.done}/${run.total || '?'}` : c.todo ? `总结到当前 · 尚有 ${c.todo} 楼` : '总结到当前 · 已全部总结');
        $('#em_wand, #em_wand_sum').toggle(!!settings.enabled);

        const ball = $('#em_ball');
        if (ball.length) {
            ball.toggleClass('em-busy', run.busy).toggleClass('em-warn', !run.busy && bad > 0).toggleClass('em-has-badge', c.todo > 0 || bad > 0);
            $('#em_ball_badge').text(bad && !run.busy ? bad : c.todo);
            ball.attr('title', `Erato Memory：待总结 ${c.todo}${bad ? `，失败 ${bad}` : ''}`);
        }
        updateBallVisibility();
    }

    /* ================= 悬浮球 ================= */

    const ballSize = () => clamp(Number(settings.ball.size) || 40, 28, 64);

    function applyBallStyle() {
        const el = document.getElementById('em_ball');
        if (!el) return;
        el.style.setProperty('--em-ball-size', `${ballSize()}px`);
        el.style.setProperty('--em-ball-opacity', String(clamp(Number(settings.ball.opacity) || 0.4, 0.1, 1)));
        if (settings.ball.color) el.style.setProperty('--em-ball-color', settings.ball.color);
        else el.style.removeProperty('--em-ball-color');
    }

    // 位置存的是「靠哪边 + 纵向比例」，换屏幕方向也不会跑出视口；没拖过就停在输入框上方靠右
    function positionBall() {
        const el = document.getElementById('em_ball');
        if (!el) return;
        const size = ballSize();
        const H = window.innerHeight;
        let side = 'right', y;
        if (settings.ball.pos && typeof settings.ball.pos.y === 'number') {
            side = settings.ball.pos.side === 'left' ? 'left' : 'right';
            y = settings.ball.pos.y * H;
        } else {
            const form = document.getElementById('send_form');
            const formTop = form ? form.getBoundingClientRect().top : H - 80;
            y = formTop - size * 1.5;
        }
        el.style.top = `${clamp(y, 8, H - size - 8)}px`;
        el.style.left = side === 'left' ? '8px' : 'auto';
        el.style.right = side === 'right' ? '8px' : 'auto';
    }

    function updateBallVisibility() {
        const el = document.getElementById('em_ball');
        if (!el) return;
        el.style.display = (settings.enabled && settings.ball.enabled && !panelOpen) ? 'flex' : 'none';
    }

    function addBall() {
        if (document.getElementById('em_ball')) return;
        const el = document.createElement('div');
        el.id = 'em_ball'; el.className = 'em-ball';
        el.innerHTML = '<i class="fa-solid fa-brain"></i><span class="em-ball-badge" id="em_ball_badge"></span>';
        document.body.appendChild(el);

        let start = null, dragging = false;
        el.addEventListener('pointerdown', ev => {
            if (ev.button) return;
            const r = el.getBoundingClientRect();
            start = { x: ev.clientX, y: ev.clientY, left: r.left, top: r.top };
            dragging = false;
            try { el.setPointerCapture(ev.pointerId); } catch { /* 旧内核 */ }
            ev.preventDefault();
        });
        el.addEventListener('pointermove', ev => {
            if (!start) return;
            const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
            if (!dragging && Math.hypot(dx, dy) < 6) return;   // 6px 内算点击，免得手机上一点就把球挪走
            dragging = true;
            el.classList.add('em-dragging');
            const size = ballSize();
            el.style.right = 'auto';
            el.style.left = `${clamp(start.left + dx, 0, window.innerWidth - size)}px`;
            el.style.top = `${clamp(start.top + dy, 0, window.innerHeight - size)}px`;
        });
        el.addEventListener('pointerup', () => {
            if (!start) return;
            const wasDrag = dragging;
            start = null; dragging = false;
            el.classList.remove('em-dragging');
            if (wasDrag) {
                const r = el.getBoundingClientRect();
                settings.ball.pos = { side: (r.left + r.width / 2) < window.innerWidth / 2 ? 'left' : 'right', y: r.top / window.innerHeight };
                saveSettings();
                positionBall();
            } else {
                togglePanel(true);
            }
        });
        el.addEventListener('pointercancel', () => { start = null; dragging = false; el.classList.remove('em-dragging'); positionBall(); });
        el.addEventListener('contextmenu', ev => ev.preventDefault());
        window.addEventListener('resize', positionBall);

        applyBallStyle();
        positionBall();
        updateBallVisibility();
    }

    // 输入框左侧魔杖菜单：记忆面板（带状态）+ 总结到当前（不开面板直接跑）
    function addWandEntries() {
        const menu = $('#extensionsMenu');
        if (!menu.length) return;
        const panelItem = $(`
        <div id="em_wand" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
            <div class="fa-solid fa-brain extensionsMenuExtensionButton"></div>
            <span id="em_wand_txt">记忆面板</span>
        </div>`);
        const sumItem = $(`
        <div id="em_wand_sum" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
            <div class="fa-solid fa-book-open extensionsMenuExtensionButton"></div>
            <span id="em_wand_sum_txt">总结到当前</span>
        </div>`);
        menu.append(panelItem, sumItem);
        panelItem.on('click', () => togglePanel(true));
        sumItem.on('click', () => summarizeAll());
    }

    /* ================= 设置表单（面板内覆盖层） ================= */

    function settingsFormHtml() {
        return `
        <div class="em-form">
            <div class="em-sec">总结节奏</div>
            <label class="checkbox_label"><input type="checkbox" id="em_enabled"><span>启用记忆（关掉后悬浮球与注入一并停用）</span></label>
            <div class="em-row">
                <label>自动总结
                    <select id="em_auto_sel">
                        <option value="0">手动（只在点按钮时总结）</option>
                        <option value="20">每 20 楼</option><option value="30">每 30 楼</option><option value="40">每 40 楼</option>
                        <option value="custom">自定义…</option>
                    </select>
                </label>
                <label>自定义楼数（0 = 手动） <input id="em_auto_n" class="text_pole" type="number" min="0" max="1000"></label>
            </div>
            <div class="em-row">
                <label>单次总结最大楼层
                    <select id="em_win_sel">
                        <option value="40">40 楼</option><option value="60">60 楼</option><option value="100">100 楼</option><option value="200">200 楼</option>
                        <option value="custom">自定义…</option>
                    </select>
                </label>
                <label>自定义楼数 <input id="em_win_n" class="text_pole" type="number" min="1" max="1000"></label>
                <label>单次最大字数 <input id="em_call_chars" class="text_pole" type="number" min="2000" step="5000" title="一次调用喂给副模型的材料上限，超过就自动再切一段；按副模型上下文大小调"></label>
                <label>事件密度：每 <input id="em_min_per" class="text_pole em-short" type="number" min="0" max="20" title="每这么多个 AI 楼至少要有 1 条事件；副模型给得太少就视为过度压缩，自动对半拆分重试。0 = 不核验"> 个 AI 楼 ≥ 1 条</label>
            </div>
            <div class="em-hint">楼数按酒馆楼层计：你一条 + AI 一条 = 2 楼，与聊天里的楼号一致。一次调用吃的楼越多越省钱、也越粗：日常 40–60 楼；清不在乎细节的老积压再开到 100–200。楼数与字数两个上限先到者生效；副模型拒答或输出损坏时自动对半拆分重试。</div>
            <label class="checkbox_label"><input type="checkbox" id="em_hide"><span>总结完成后隐藏已总结楼层（可逆，「更多 → 取消隐藏」恢复）</span></label>
            <div class="em-row">
                <label>保留可见楼数 <input id="em_keep" class="text_pole" type="number" min="2" max="40" title="从最新一条往前数，这么多条消息不隐藏；6 = 三回合"></label>
                <label>正文窗口 <input id="em_window" class="text_pole" type="number" min="2" max="40" title="可见楼层里深度不足此数的不注入（与预设 6🌸 的 minDepth 一致）"></label>
                <label>注入深度 <input id="em_depth" class="text_pole" type="number" min="0" max="40"></label>
            </div>
            <div class="em-row">
                <label>记忆注入上限(字) <input id="em_maxchars" class="text_pole" type="number" min="1000" step="500"></label>
                <label>档案注入上限(字) <input id="em_ent_chars" class="text_pole" type="number" min="200" step="100" title="关系现状 + 人物志 + 物件在注入块里的总字数；放不下的人物降为只列名字"></label>
                <label>人物激活扫描楼数 <input id="em_scan" class="text_pole" type="number" min="1" max="40" title="最近这么多条可见消息里提到的人物（名字/别称/身份）出完整档案，其余只列名字"></label>
            </div>
            <hr>
            <div class="em-sec">长期记忆（分层压缩）</div>
            <div class="em-row">
                <label>正典压缩阈值(条) <input id="em_canon_max" class="text_pole em-short" type="number" min="3" max="200" title="S 级/钉选超过这么多条时，由副 API 压成一段正典；之后新增的 S 逐条附在段后，S 集合变化 5 条重压"></label>
                <label>正典段上限(字) <input id="em_canon_chars" class="text_pole em-short" type="number" min="200" step="100"></label>
                <label>远景预算(字) <input id="em_outline_chars" class="text_pole em-short" type="number" min="300" step="100" title="被裁掉的条目折成的按日骨架，注入块里最多占这么多字；超过时最老的日行再折成时期行"></label>
                <label>攒够几条再折叠 <input id="em_fold_min" class="text_pole em-short" type="number" min="1" max="50"></label>
                <label>recap 保底深度 <input id="em_recap_win" class="text_pole em-short" type="number" min="0" max="100" title="与预设 5🌸 的 minDepth 一致：深度不足此数的楼预设自己还带着 recap，保底不重复注入"></label>
            </div>
            <div class="em-hint">往事超出注入上限时先裁最老最轻的 B/C，被裁的条目攒够后由副 API 按故事日折成一行「远景」（非破坏，条目仍在库里、仍可召回）；远景超预算再把最老的日行折成时期行。S 永不裁，多了就压成正典段。折叠规则：同一剧情日、同一目标合并一条；压措辞不删人名、日期、物件、承诺、结果。未总结/失败楼层用每楼自带的作者摘要保底。</div>
            <label>自动整理（远景折叠 / 正典压缩什么时候自动跑）
                <select id="em_auto_fold">
                    <option value="batch">总结批次结束后（默认）</option>
                    <option value="always">每次生成后，攒够就跑</option>
                    <option value="manual">只在点「现在折叠」时跑</option>
                </select>
            </label>
            <hr>
            <div class="em-sec">召回（把被裁掉/已折叠的条目按当下话题捞回来）</div>
            <label class="checkbox_label"><input type="checkbox" id="em_rc_kw"><span>关键词召回（零网络：用户最新输入 + 最近一楼 recap 与条目做 n-gram 匹配）</span></label>
            <label class="checkbox_label"><input type="checkbox" id="em_rc_vec"><span>向量召回（走酒馆自带向量接口，服务端存储；需要下面的源与密钥）</span></label>
            <div class="em-row">
                <label>向量源
                    <select id="em_rc_src">${Object.entries(VEC_SOURCES).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select>
                </label>
                <label class="em-grow">embeddings 地址（仅 vllm 源）<input id="em_rc_url" class="text_pole" placeholder="https://api.example.com（后端自动加 /v1/embeddings）"></label>
            </div>
            <div class="em-row">
                <label class="em-grow">模型（留空用源默认）<input id="em_rc_model" class="text_pole" placeholder="Qwen/Qwen3-Embedding-0.6B"></label>
                <label class="checkbox_label"><input type="checkbox" id="em_rc_cn"><span>硅基流动国内站</span></label>
                <label class="checkbox_label"><input type="checkbox" id="em_rc_raw"><span>原文细节（已总结楼层的正文切块入库，捞摘要没写进的小细节）</span></label>
            </div>
            <div class="em-row">
                <label class="em-grow">密钥（写入酒馆对应源的槽位，会覆盖同名槽位）<input id="em_rc_key" class="text_pole" type="password" autocomplete="off" placeholder="sk-…"></label>
                <div class="menu_button" id="em_rc_write_key">写入密钥</div>
            </div>
            <div class="em-row">
                <label>topK <input id="em_rc_topk" class="text_pole em-short" type="number" min="1" max="30"></label>
                <label>阈值 <input id="em_rc_thr" class="text_pole em-short" type="number" min="0" max="1" step="0.05" title="余弦相似度阈值，Qwen3-Embedding 建议 0.4 起调"></label>
                <label>召回预算(字) <input id="em_rc_chars" class="text_pole em-short" type="number" min="200" step="100"></label>
                <label>原文预算(字) <input id="em_rc_raw_chars" class="text_pole em-short" type="number" min="200" step="100"></label>
                <label>查询串上限(字) <input id="em_rc_query" class="text_pole em-short" type="number" min="100" step="100"></label>
                <label>生成前最多等(秒) <input id="em_rc_timeout" class="text_pole em-short" type="number" min="1" max="30" title="用户消息一发出就开始查；生成前最多再等这么久，超时就不带召回，绝不阻断生成"></label>
            </div>
            <div class="em-row">
                <div class="menu_button" id="em_rc_test">测试向量连接</div>
                <div class="menu_button" id="em_rc_fill">补向量（只补缺的）</div>
                <div class="menu_button" id="em_rc_rebuild">重建向量（清空重灌）</div>
            </div>
            <div class="em-hint" id="em_rc_hint"></div>
            <hr>
            <div class="em-sec">副 API（OpenAI 兼容）</div>
            <label>地址<input id="em_api_url" class="text_pole" placeholder="https://api.example.com/v1"></label>
            <label>密钥<input id="em_api_key" class="text_pole" type="password" placeholder="sk-…" autocomplete="off"></label>
            <div class="em-row em-model-row">
                <label class="em-grow">模型（先拉取再选，或直接手填）
                    <select id="em_api_model_sel"></select>
                </label>
                <div class="menu_button" id="em_models">拉取模型</div>
            </div>
            <label>模型名（手填 / 当前生效值）<input id="em_api_model" class="text_pole" placeholder="gpt-4o-mini / gemini-2.0-flash …"></label>
            <div class="em-hint"><span id="em_model_count"></span></div>
            <div class="em-row">
                <label>温度 <input id="em_api_temp" class="text_pole" type="number" step="0.1" min="0" max="2"></label>
                <label>回复上限 <input id="em_api_max" class="text_pole" type="number" min="200" step="100"></label>
                <label>超时(秒) <input id="em_api_timeout" class="text_pole" type="number" min="5"></label>
            </div>
            <div class="menu_button" id="em_test">测试连接</div>
            <hr>
            <div class="em-sec">悬浮球</div>
            <label class="checkbox_label"><input type="checkbox" id="em_ball_on"><span>显示悬浮球（单击开面板，可拖动，松手吸边）</span></label>
            <div class="em-row em-ball-row">
                <label>颜色 <input id="em_ball_color" type="color"></label>
                <div class="menu_button" id="em_ball_color_reset">跟随主题</div>
                <label>透明度 <input id="em_ball_opacity" type="range" min="0.1" max="1" step="0.05"></label>
                <label>大小 <input id="em_ball_size" type="range" min="28" max="64" step="2"></label>
                <div class="menu_button" id="em_ball_pos_reset">位置复位</div>
            </div>
            <hr>
            <div class="em-sec">提示词</div>
            <label>记忆导演指令（附加到每次摘要，可空）<textarea id="em_directive" class="text_pole" rows="2" placeholder="例：重点记录承诺与信息差"></textarea></label>
            <label>系统提示词（留空用默认）<textarea id="em_sys_prompt" class="text_pole" rows="3"></textarea></label>
            <label>摘要模板（留空用默认；必须含 {{material}}，其余占位符：{{name1}} {{name2}} {{roster}} {{relation}} {{context}} {{recent}} {{locked}} {{floor_range}} {{floor_count}} {{min_events}} {{max_events}} {{directive}}）<textarea id="em_tpl" class="text_pole" rows="8"></textarea></label>
            <label>注入块块首说明（每行一条，留空用默认；告诉主模型远景/正典/往事/知情栏各是什么）<textarea id="em_header" class="text_pole" rows="3"></textarea></label>
            <div class="em-row">
                <div class="menu_button" id="em_tpl_fill">把默认模板填进来改</div>
                <div class="menu_button" id="em_tpl_reset">恢复默认</div>
            </div>
            <hr>
            <div class="em-sec">调试</div>
            <label class="checkbox_label"><input type="checkbox" id="em_debug"><span>控制台调试日志</span></label>
            <div class="em-hint">斜杠命令：/em-panel 开面板 · /em-summarize 总结到当前 · /em-pin 楼层号 钉/取消钉 · /em-note 文字 手动记一条</div>
            <div class="em-status"></div>
        </div>`;
    }

    function renderModelSelect() {
        const sel = $('#em_api_model_sel');
        if (!sel.length) return;
        const cur = (settings.api.model || '').trim();
        const list = Array.isArray(settings.api.models) ? settings.api.models : [];
        const opts = ['<option value="">（未选择 / 手填）</option>']
            .concat(list.map(m => `<option value="${esc(m)}">${esc(m)}</option>`));
        sel.html(opts.join(''));
        sel.val(list.includes(cur) ? cur : '');
        $('#em_model_count').text(list.length ? `已拉取 ${list.length} 个模型` : '尚未拉取模型列表');
    }

    function setEnabled(on) {
        settings.enabled = !!on; saveSettings();
        $('#em_enabled, #em_enabled_d').prop('checked', settings.enabled);
        applyInjection(); refreshStatus();
    }

    function bindSettingsForm() {
        $('#em_enabled').prop('checked', settings.enabled).on('change', function () { setEnabled(this.checked); });
        // 下拉给常用档位，数字框可填任意值；两者互相同步
        const bindPick = (selId, numId, key, quick, min) => {
            const sel = $(selId), num = $(numId);
            const sync = () => { const v = Math.max(min, Number(settings[key]) || 0); settings[key] = v; sel.val(quick.includes(v) ? String(v) : 'custom'); num.val(v); };
            sync();
            sel.on('change', function () {
                if (this.value === 'custom') { num.trigger('focus'); return; }
                settings[key] = Number(this.value); saveSettings(); sync(); refreshStatus();
            });
            num.on('change', function () { settings[key] = Math.max(min, Number(this.value) || 0); saveSettings(); sync(); refreshStatus(); });
        };
        bindPick('#em_auto_sel', '#em_auto_n', 'autoInterval', [0, 20, 30, 40], 0);
        bindPick('#em_win_sel', '#em_win_n', 'windowFloors', [40, 60, 100, 200], 1);
        $('#em_hide').prop('checked', settings.hideSummarized).on('change', function () { setHideSummarized(this.checked); });
        const bindApi = (id, key, num) => $(id).val(settings.api[key]).on('change', function () {
            settings.api[key] = num ? Number(this.value) : this.value.trim(); saveSettings();
        });
        bindApi('#em_api_url', 'url'); bindApi('#em_api_key', 'key');
        bindApi('#em_api_temp', 'temperature', true); bindApi('#em_api_max', 'maxTokens', true); bindApi('#em_api_timeout', 'timeoutSec', true);
        $('#em_api_model').val(settings.api.model).on('change', function () {
            settings.api.model = this.value.trim(); saveSettings(); renderModelSelect();
        });
        $('#em_api_model_sel').on('change', function () {
            if (!this.value) return;
            settings.api.model = this.value; saveSettings();
            $('#em_api_model').val(this.value);
        });
        renderModelSelect();
        $('#em_models').on('click', async function () {
            if (!apiConfigured()) return toast('warning', '请先填写副 API 地址与密钥');
            const btn = $(this).addClass('disabled').text('拉取中…');
            try {
                const ids = await fetchModels();
                renderModelSelect();
                toast('success', `拉到 ${ids.length} 个模型，请在下拉框里选择`);
            } catch (err) {
                toast('error', `拉取失败：${err.message}`);
            } finally {
                btn.removeClass('disabled').text('拉取模型');
            }
        });
        const bindNum = (id, key, after) => $(id).val(settings[key]).on('change', function () {
            settings[key] = Number(this.value); saveSettings(); after?.();
        });
        bindNum('#em_window', 'contentWindow', () => { applyInjection(); renderPanel(); });
        bindNum('#em_depth', 'injectDepth', applyInjection);
        bindNum('#em_maxchars', 'maxInjectChars', applyInjection);
        bindNum('#em_call_chars', 'maxCallChars');
        bindNum('#em_min_per', 'minEventsPer');
        bindNum('#em_ent_chars', 'entityChars', applyInjection);
        bindNum('#em_scan', 'npcScanDepth', applyInjection);
        bindNum('#em_canon_max', 'canonMax'); bindNum('#em_canon_chars', 'canonChars');
        bindNum('#em_outline_chars', 'outlineChars', applyInjection); bindNum('#em_fold_min', 'foldMin');
        bindNum('#em_recap_win', 'recapWindow', applyInjection);
        bindNum('#em_keep', 'keepVisible', () => { $('#em_keep_q').val(settings.keepVisible); if (settings.hideSummarized) { hideSummarized(); applyInjection(); refreshStatus(); } });

        // 召回 / 向量
        const rcHint = () => {
            const s = settings.recall;
            const src = VEC_SOURCES[s.source] ? s.source : 'siliconflow';
            const data = getData();
            const n = data ? Object.keys(data.vec.entries).length : 0, r = data ? Object.keys(data.vec.raw).length : 0;
            $('#em_rc_hint').text(`${s.vector ? `向量：${VEC_SOURCES[src].label} · 模型 ${vecBody().model || '（源默认）'} · 密钥槽 ${VEC_SOURCES[src].secret} · 本聊天已入库 ${n} 条记忆 / ${r} 楼原文${data?.vec?.error ? ` · 上次错误：${data.vec.error}` : ''}` : '向量召回未开启；关键词召回不需要任何配置。'}`);
            $('#em_rc_url').closest('label').toggle(src === 'vllm');
            $('#em_rc_cn').closest('label').toggle(src === 'siliconflow');
        };
        const bindRc = (id, key, kind) => $(id).each(function () {
            if (kind === 'bool') $(this).prop('checked', !!settings.recall[key]); else $(this).val(settings.recall[key] ?? '');
        }).on('change', function () {
            settings.recall[key] = kind === 'bool' ? this.checked : kind === 'num' ? Number(this.value) : this.value.trim();
            saveSettings(); rc.key = ''; rc.result = null; rcHint(); applyInjection();
            if (key === 'vector' && this.checked && getData()?.entries.length) toast('info', '已有记忆尚未入向量库，点「补向量」灌一次');
        });
        bindRc('#em_rc_kw', 'keyword', 'bool'); bindRc('#em_rc_vec', 'vector', 'bool'); bindRc('#em_rc_src', 'source'); bindRc('#em_rc_url', 'apiUrl'); bindRc('#em_rc_model', 'model');
        bindRc('#em_rc_cn', 'cn', 'bool'); bindRc('#em_rc_raw', 'raw', 'bool'); bindRc('#em_rc_topk', 'topK', 'num'); bindRc('#em_rc_thr', 'threshold', 'num');
        bindRc('#em_rc_chars', 'recallChars', 'num'); bindRc('#em_rc_raw_chars', 'rawChars', 'num'); bindRc('#em_rc_query', 'queryChars', 'num'); bindRc('#em_rc_timeout', 'timeoutSec', 'num');
        $('#em_rc_src').on('change', () => $('#em_rc_model').attr('placeholder', VEC_SOURCES[settings.recall.source]?.model || '模型名'));
        rcHint();
        const busyBtn = async (btn, text, fn) => {
            const el = $(btn); const old = el.text();
            el.addClass('disabled').text(text);
            try { await fn(); } catch (err) { toast('error', `${old}失败：${err.message}`); const d = getData(); if (d) d.vec.error = err.message; }
            finally { el.removeClass('disabled').text(old); rcHint(); }
        };
        $('#em_rc_write_key').on('click', () => busyBtn('#em_rc_write_key', '写入中…', async () => {
            const v = String($('#em_rc_key').val() || '').trim();
            if (!v) throw new Error('密钥为空');
            const slot = await writeVecSecret(v);
            $('#em_rc_key').val('');
            toast('success', `密钥已写入酒馆槽位 ${slot}`);
        }));
        $('#em_rc_test').on('click', () => busyBtn('#em_rc_test', '测试中…', async () => {
            const n = await vecTest();
            toast('success', `向量接口可用（探针查询命中 ${n} 条）`);
        }));
        $('#em_rc_fill').on('click', () => busyBtn('#em_rc_fill', '补充中…', async () => {
            if (!settings.recall.vector) throw new Error('请先勾选向量召回');
            const data = getData(); if (!data) throw new Error('没有打开聊天');
            const r = await vecSync(data, (done, total) => $('#em_rc_fill').text(`补充中 ${done}/${total}`));
            toast('success', `已补 ${r.entries} 条记忆、${r.raw} 段原文`);
        }));
        $('#em_rc_rebuild').on('click', () => busyBtn('#em_rc_rebuild', '重建中…', async () => {
            if (!settings.recall.vector) throw new Error('请先勾选向量召回');
            if (!await confirmBox('清空本聊天的向量并全部重灌？条目多时要跑一会儿')) return;
            const r = await vecRebuild((done, total) => $('#em_rc_rebuild').text(`重建中 ${done}/${total}`));
            toast('success', `已重建：${r.entries} 条记忆、${r.raw} 段原文`);
        }));

        $('#em_ball_on').prop('checked', settings.ball.enabled).on('change', function () { settings.ball.enabled = this.checked; saveSettings(); updateBallVisibility(); });
        $('#em_ball_color').val(settings.ball.color || '#7ec8ff').on('input change', function () { settings.ball.color = this.value; saveSettings(); applyBallStyle(); });
        $('#em_ball_color_reset').on('click', () => { settings.ball.color = ''; saveSettings(); applyBallStyle(); $('#em_ball_color').val('#7ec8ff'); });
        $('#em_ball_opacity').val(settings.ball.opacity).on('input change', function () { settings.ball.opacity = Number(this.value); saveSettings(); applyBallStyle(); });
        $('#em_ball_size').val(settings.ball.size).on('input change', function () { settings.ball.size = Number(this.value); saveSettings(); applyBallStyle(); positionBall(); });
        $('#em_ball_pos_reset').on('click', () => { settings.ball.pos = null; saveSettings(); positionBall(); toast('info', '悬浮球位置已复位'); });

        $('#em_directive').val(settings.directive).on('change', function () { settings.directive = this.value; saveSettings(); });
        $('#em_sys_prompt').val(settings.systemPrompt).attr('placeholder', DEFAULT_SYSTEM_PROMPT).on('change', function () { settings.systemPrompt = this.value; saveSettings(); });
        $('#em_tpl').val(settings.promptTemplate).attr('placeholder', '（留空 = 默认模板，点下方按钮可把默认填进来修改）').on('change', function () {
            settings.promptTemplate = this.value; saveSettings();
            if (this.value.trim() && !this.value.includes('{{material}}')) toast('warning', '模板缺少 {{material}}，摘要时会退回默认模板');
        });
        $('#em_tpl_fill').on('click', () => { $('#em_tpl').val(DEFAULT_USER_TEMPLATE); settings.promptTemplate = DEFAULT_USER_TEMPLATE; saveSettings(); });
        $('#em_tpl_reset').on('click', () => { $('#em_tpl, #em_sys_prompt, #em_header').val(''); settings.promptTemplate = ''; settings.systemPrompt = ''; settings.headerText = ''; saveSettings(); applyInjection(); toast('info', '已恢复默认提示词'); });
        $('#em_header').val(settings.headerText).attr('placeholder', DEFAULT_HEADER.join('\n')).on('change', function () { settings.headerText = this.value; saveSettings(); applyInjection(); });
        $('#em_auto_fold').val(['always', 'batch', 'manual'].includes(settings.autoFold) ? settings.autoFold : 'batch').on('change', function () { settings.autoFold = this.value; saveSettings(); });
        $('#em_debug').prop('checked', settings.debug).on('change', function () { settings.debug = this.checked; saveSettings(); });
        $('#em_test').on('click', async function () {
            if (!apiConfigured()) return toast('warning', '请先填写副 API 地址与密钥');
            if (!settings.api.model?.trim()) toast('warning', '未指定模型，将由接口默认模型响应');
            const btn = $(this).addClass('disabled').text('测试中…');
            try {
                const r = await callApi([{ role: 'user', content: '请只回复「连接成功」四个字。' }], 50);
                toast('success', `副 API 可用：${r.text.slice(0, 60)}`);
            } catch (err) {
                toast('error', `副 API 失败：${err.message}`);
            } finally {
                btn.removeClass('disabled').text('测试连接');
            }
        });
    }

    function setHideSummarized(on) {
        settings.hideSummarized = !!on; saveSettings();
        $('#em_hide, #em_hide_q').prop('checked', settings.hideSummarized);
        if (settings.hideSummarized) {
            const n = hideSummarized();
            toast('info', n ? `已隐藏 ${n} 条已总结消息` : '没有需要隐藏的楼层');
        } else {
            const n = unhideAll();
            toast('info', n ? `已恢复 ${n} 条消息` : '没有本插件隐藏的楼层');
        }
        applyInjection(); renderPanel(); refreshStatus();
    }

    function addSettingsUI() {
        const html = `
        <div class="em-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>🧠 Erato Memory</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label"><input type="checkbox" id="em_enabled_d"><span>启用</span></label>
                    <div class="em-hint">入口：屏幕上的悬浮球，或输入框左侧魔杖菜单里的「记忆面板 / 总结到当前」。总结节奏、副 API、隐藏楼层、悬浮球样式等都在面板的设置页。</div>
                    <div class="em-row">
                        <div class="menu_button" id="em_open">打开记忆面板</div>
                        <div class="menu_button" id="em_open_cfg">设置</div>
                    </div>
                    <div class="em-status"></div>
                </div>
            </div>
        </div>`;
        $('#extensions_settings2').append(html);

        $('#em_enabled_d').prop('checked', settings.enabled).on('change', function () { setEnabled(this.checked); });
        $('#em_open').on('click', () => togglePanel(true, 'mem'));
        $('#em_open_cfg').on('click', () => togglePanel(true, 'cfg'));
    }

    /* ================= 记忆面板 ================= */

    let panelOpen = false;
    let panelTab = 'mem';
    let addingManual = false;
    const expanded = new Set();
    const filter = { grade: '', type: '', status: '', q: '' };
    // 人物志 / 物件各自的筛选：档位 / 状态 / 活跃度（人）或持有者（物）/ 搜索 / 排序
    const entFilter = { p: { tier: '', state: '', heat: '', q: '', sort: 'recent' }, i: { tier: '', state: '', holder: '', q: '', sort: 'recent' } };
    const sections = { people: true, items: true, outline: false, timeline: true, preview: false, raw: false };

    function addPanel() {
        const html = `
        <div id="em_backdrop" class="em-backdrop" style="display:none"></div>
        <div id="em_panel" class="em-panel" style="display:none">
            <div class="em-head">
                <div id="em_back" class="em-back fa-solid fa-chevron-left interactable" tabindex="0" style="display:none"></div>
                <div class="em-title"><span id="em_head_title">🧠 记忆</span></div>
                <div id="em_close" class="em-close fa-solid fa-xmark interactable" tabindex="0"></div>
            </div>
            <div id="em_view_mem" class="em-view">
                <div class="em-stats">
                    <div class="em-tile"><div class="em-num" id="em_n_ok">0</div><div class="em-lbl">已总结楼层</div></div>
                    <div class="em-tile"><div class="em-num" id="em_n_todo">0</div><div class="em-lbl">待总结楼层</div></div>
                    <div class="em-tile"><div class="em-num" id="em_n_hidden">0</div><div class="em-lbl">已隐藏消息</div></div>
                    <div class="em-tile em-tile-bad" id="em_tile_bad" style="display:none"><div class="em-num" id="em_n_bad">0</div><div class="em-lbl">失败段落</div></div>
                </div>
                <div class="em-inject-line" id="em_auto_line"></div>
                <div class="em-inject-line" id="em_inject_line"></div>
                <div class="em-actbar">
                    <div class="menu_button em-main" id="em_main">总结到当前</div>
                    <div class="em-hide-q">
                        <label class="checkbox_label"><input type="checkbox" id="em_hide_q"><span>隐藏已总结 · 保留</span></label>
                        <input id="em_keep_q" class="text_pole em-keep-q" type="number" min="2" max="40"><span>楼</span>
                    </div>
                    <div class="menu_button" id="em_more">更多 ▾</div>
                </div>
                <div id="em_more_menu" class="em-menu" style="display:none">
                    <div class="em-menu-item" data-act="add">手动新增一条记忆</div>
                    <div class="em-menu-item" data-act="backfill">从事件补人物（零网络，把事件里点到的人建档）</div>
                    <div class="em-menu-item" data-act="retry">重试失败的段落</div>
                    <div class="em-menu-item" data-act="unhide">取消隐藏（恢复本插件藏起来的楼层）</div>
                    <div class="em-menu-item" data-act="export">导出 JSON</div>
                    <div class="em-menu-item" data-act="import">导入 JSON</div>
                    <div class="em-menu-item" data-act="cfg">设置</div>
                    <div class="em-menu-item em-danger" data-act="clear">清空本聊天的记忆</div>
                    <input type="file" id="em_import_file" accept="application/json" hidden>
                </div>
                <div id="em_progress" class="em-progress" style="display:none"><div class="em-bar"></div><div class="em-prog-txt"></div></div>
                <div id="em_alert" class="em-alert" style="display:none"></div>

                <div class="em-section" data-sec="people">
                    <div class="em-sec-head"><span>人物志 <span class="em-sec-n" id="em_n_people"></span></span><span class="em-sec-arrow"></span></div>
                    <div class="em-sec-body">
                        <div id="em_rel_box"></div>
                        <div class="em-filters em-ef-bar">
                            <select class="em-ef" data-kind="p" data-key="tier"><option value="">全部档位</option>${TIERS.map(t => `<option value="${t}">${t}</option>`).join('')}<option value="none">未定</option></select>
                            <select class="em-ef" data-kind="p" data-key="state"><option value="">全部状态</option>${PERSON_STATES.map(s => `<option value="${s}">${s}</option>`).join('')}<option value="none">未定</option></select>
                            <select class="em-ef" data-kind="p" data-key="heat"><option value="">全部活跃度</option><option value="recent">近期（本轮出完整卡）</option><option value="listed">在册</option><option value="dormant">沉寂（${DORMANT_FLOORS} 楼未露面）</option></select>
                            <select class="em-ef" data-kind="p" data-key="sort"><option value="recent">最近露面</option><option value="first">首见先后</option><option value="name">名字</option><option value="seen">露面段数</option></select>
                            <input class="text_pole em-ef-q" data-kind="p" placeholder="搜索名字 / 别称 / 身份">
                        </div>
                        <div id="em_people" class="em-ents"></div>
                        <div id="em_tombs" class="em-tombs"></div>
                    </div>
                </div>
                <div class="em-section" data-sec="items">
                    <div class="em-sec-head"><span>物件 <span class="em-sec-n" id="em_n_items"></span></span><span class="em-sec-arrow"></span></div>
                    <div class="em-sec-body">
                        <div class="em-filters em-ef-bar">
                            <select class="em-ef" data-kind="i" data-key="tier"><option value="">全部关键性</option>${ITEM_TIERS.map(t => `<option value="${t}">${t}</option>`).join('')}<option value="none">未定</option></select>
                            <select class="em-ef" data-kind="i" data-key="state"><option value="">全部状态</option>${ITEM_STATES.map(s => `<option value="${s}">${s}</option>`).join('')}<option value="settled">已了结（合并）</option><option value="none">未定</option></select>
                            <select class="em-ef" data-kind="i" data-key="holder" id="em_fi_holder"><option value="">全部持有者</option></select>
                            <select class="em-ef" data-kind="i" data-key="sort"><option value="recent">最近更新</option><option value="first">首见先后</option><option value="name">名字</option></select>
                            <input class="text_pole em-ef-q" data-kind="i" placeholder="搜索名字 / 持有者 / 备注 / 意义">
                        </div>
                        <div id="em_items" class="em-ents"></div>
                        <div id="em_tombs_i" class="em-tombs"></div>
                    </div>
                </div>
                <div class="em-section" data-sec="outline">
                    <div class="em-sec-head"><span>远景 · 正典 <span class="em-sec-n" id="em_n_outline"></span></span><span class="em-sec-arrow"></span></div>
                    <div class="em-sec-body">
                        <div class="em-inject-line" id="em_outline_line"></div>
                        <div class="em-actions em-oact">
                            <div class="menu_button" data-oact="fold">现在折叠</div>
                            <div class="menu_button" data-oact="recanon">重建正典</div>
                        </div>
                        <div id="em_canon" class="em-canon"></div>
                        <div id="em_outline" class="em-ents"></div>
                    </div>
                </div>
                <div class="em-section" data-sec="timeline">
                    <div class="em-sec-head"><span>时间线</span><span class="em-sec-arrow"></span></div>
                    <div class="em-sec-body">
                        <div class="em-filters">
                            <select id="em_f_grade"><option value="">全部等级</option>${GRADES.map(g => `<option value="${g}">${g}</option>`).join('')}</select>
                            <select id="em_f_type"><option value="">全部类型</option>${TYPES.map(t => `<option value="${t}">${TYPE_LABEL[t]}</option>`).join('')}</select>
                            <select id="em_f_status">
                                <option value="">全部状态</option>
                                <option value="ok">正常</option><option value="pending">待处理</option><option value="failed">失败</option>
                                <option value="refused">拒答</option><option value="stale">过期</option><option value="orphan">孤立</option>
                                <option value="fallback">兜底抠取</option><option value="pinned">已钉</option><option value="manual">手动</option>
                            </select>
                            <input id="em_f_q" class="text_pole" placeholder="搜索标题 / 摘要 / 标签">
                        </div>
                        <div id="em_manual_form" class="em-manual" style="display:none"></div>
                        <div id="em_list" class="em-list"></div>
                    </div>
                </div>
                <div class="em-section" data-sec="preview">
                    <div class="em-sec-head"><span>本轮注入预览</span><span class="em-sec-arrow"></span></div>
                    <div class="em-sec-body"><div class="em-inject-line" id="em_preview_line"></div><pre id="em_preview" class="em-preview"></pre></div>
                </div>
                <div class="em-section" data-sec="raw">
                    <div class="em-sec-head"><span>副 API 最近的原始回复（诊断用）</span><span class="em-sec-arrow"></span></div>
                    <div class="em-sec-body"><pre id="em_raw" class="em-preview"></pre></div>
                </div>
            </div>
            <div id="em_view_cfg" class="em-view em-cfg" style="display:none">
                ${settingsFormHtml()}
            </div>
        </div>`;
        $('body').append(html);

        $('#em_close').on('click', () => togglePanel(false));
        $('#em_backdrop').on('click', () => togglePanel(false));
        $(document).on('keydown', ev => { if (ev.key === 'Escape' && panelOpen) togglePanel(false); });
        $('#em_back').on('click', () => showTab('mem'));
        $('#em_alert').on('click', () => { const bad = counts().failed + counts().refused; if (!bad) showTab('cfg'); });
        bindSettingsForm();

        $('#em_main').on('click', () => summarizeAll());
        $('#em_hide_q').prop('checked', settings.hideSummarized).on('change', function () { setHideSummarized(this.checked); });
        $('#em_keep_q').val(settings.keepVisible).on('change', function () {
            settings.keepVisible = clamp(Number(this.value) || 6, 2, 40); this.value = settings.keepVisible; saveSettings();
            $('#em_keep').val(settings.keepVisible);
            if (settings.hideSummarized) { hideSummarized(); applyInjection(); renderPanel(); refreshStatus(); }
        });
        $('#em_more').on('click', ev => { ev.stopPropagation(); $('#em_more_menu').toggle(); });
        $('#em_more_menu').on('click', '.em-menu-item', function () { $('#em_more_menu').hide(); panelAction($(this).data('act')); });
        $('#em_panel').on('click', ev => { if (!$(ev.target).closest('#em_more, #em_more_menu').length) $('#em_more_menu').hide(); });
        $('#em_panel').on('click', '.em-jump', function (ev) { ev.stopPropagation(); jumpTo(Number($(this).data('idx'))); });
        $('#em_import_file').on('change', importFile);

        $('#em_panel .em-sec-head').on('click', function () {
            const sec = $(this).closest('.em-section').data('sec');
            sections[sec] = !sections[sec];
            applySections();
        });
        applySections();

        $('#em_f_grade, #em_f_type, #em_f_status').on('change', function () {
            filter[this.id.replace('em_f_', '')] = this.value; renderPanel();
        });
        $('#em_f_q').on('input', debounce(function () { filter.q = this.value.trim(); renderPanel(); }, 200));
        $('#em_panel').on('change', '.em-ef', function () {
            entFilter[$(this).data('kind')][$(this).data('key')] = this.value; renderPanel();
        });
        $('#em_panel').on('input', '.em-ef-q', debounce(function () { entFilter[$(this).data('kind')].q = this.value.trim(); renderPanel(); }, 200));

        $('#em_manual_form').on('click', '[data-mact]', function () { manualFormAction($(this).data('mact')); });

        const ents = $('#em_people, #em_items');
        ents.on('click', '.em-ent-head', function () {
            const id = $(this).closest('.em-ent').data('id');
            expanded.has(id) ? expanded.delete(id) : expanded.add(id);
            renderPanel();
        });
        ents.on('click', '[data-xact]', function (ev) { ev.stopPropagation(); entityAction($(this).data('xact'), $(this).closest('.em-ent').data('id')); });
        $('#em_tombs, #em_tombs_i').on('click', '.em-tomb', function () { restoreTomb($(this).data('kind'), String($(this).data('name'))); });
        $('#em_rel_box').on('change', '#em_rel', function () {
            const data = getData(); if (!data) return;
            data.relation.v = this.value.trim(); data.relation.manual = true;
            saveData(); applyInjection(); renderPanel(); toast('success', '关系现状已保存并锁定（副 AI 不再覆盖）');
        });
        $('#em_rel_box').on('click', '#em_rel_unlock', function () {
            const data = getData(); if (!data) return;
            data.relation.manual = false; saveData(); renderPanel(); toast('info', '关系现状已解锁');
        });
        $('#em_outline').on('click', '.em-oline-head', function () {
            const id = $(this).closest('.em-oline').data('id');
            expanded.has(id) ? expanded.delete(id) : expanded.add(id);
            renderPanel();
        });
        $('#em_panel').on('click', '[data-oact]', function (ev) { ev.stopPropagation(); outlineAction($(this).data('oact'), $(this).closest('.em-oline').data('id')); });

        const list = $('#em_list');
        list.on('click', '.em-card-head', function () {
            const card = $(this).closest('.em-card');
            if (card.hasClass('em-wcard')) return;
            const id = card.data('id');
            expanded.has(id) ? expanded.delete(id) : expanded.add(id);
            renderPanel();
        });
        list.on('click', '[data-wact]', function (ev) { ev.stopPropagation(); windowAction($(this).data('wact'), $(this).closest('.em-wcard').data('wid')); });
        // 等级块：点按循环 S→A→B→C，长按钉/取消钉
        let pressTimer = null, longPressed = false;
        list.on('pointerdown', '.em-grade', function () {
            longPressed = false;
            const id = $(this).closest('.em-card').data('id');
            pressTimer = setTimeout(() => { longPressed = true; togglePin(id); }, 600);
        });
        list.on('pointerup pointerleave pointercancel', '.em-grade', () => clearTimeout(pressTimer));
        list.on('click', '.em-grade', function (ev) {
            ev.stopPropagation();
            if (longPressed) { longPressed = false; return; }
            cycleGrade($(this).closest('.em-card').data('id'));
        });
        list.on('contextmenu', '.em-grade', e => e.preventDefault());
        list.on('click', '[data-eact]', function (ev) {
            ev.stopPropagation();
            entryAction($(this).data('eact'), $(this).closest('.em-card').data('id'));
        });
    }

    function applySections() {
        $('#em_panel .em-section').each(function () {
            const open = !!sections[$(this).data('sec')];
            $(this).toggleClass('em-open', open).find('.em-sec-body').toggle(open);
        });
    }

    function showTab(name) {
        panelTab = name === 'cfg' ? 'cfg' : 'mem';
        $('#em_view_mem').toggle(panelTab === 'mem');
        $('#em_view_cfg').toggle(panelTab === 'cfg');
        $('#em_back').toggle(panelTab === 'cfg');
        $('#em_head_title').text(panelTab === 'cfg' ? '⚙ 设置' : '🧠 记忆');
        if (panelTab === 'cfg') renderModelSelect();
    }

    // 主题的 BlurTint 可能半透明，面板下面先垫一层实底：正文字色亮就垫深色，字色暗就垫浅色
    function applyPanelBase() {
        const panel = document.getElementById('em_panel');
        if (!panel) return;
        let light = false;
        try {
            const raw = getComputedStyle(document.body).getPropertyValue('--SmartThemeBodyColor').trim();
            let rgb = null;
            if (/^#[0-9a-f]{6}/i.test(raw)) rgb = [1, 3, 5].map(i => parseInt(raw.slice(i, i + 2), 16));
            else { const m = raw.match(/\d+(\.\d+)?/g); if (m && m.length >= 3) rgb = m.slice(0, 3).map(Number); }
            if (rgb) light = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) > 140;
        } catch { /* 取不到就按深色主题 */ }
        panel.style.setProperty('--em-panel-base', light ? '#1b1b1b' : '#f4f2ec');
    }

    // 未配副 API 且还没有条目时，打开面板直接落到设置页
    function togglePanel(force, tab) {
        panelOpen = force === undefined ? !panelOpen : !!force;
        if (panelOpen) applyPanelBase();
        $('#em_panel').toggle(panelOpen);
        $('#em_backdrop').toggle(panelOpen);
        $('#em_more_menu').hide();
        updateBallVisibility();
        if (!panelOpen) return;
        if (!tab && !apiConfigured() && !(getData()?.entries.length)) tab = 'cfg';
        showTab(tab || 'mem');
        reconcile(); applyInjection(); renderPanel(); refreshStatus();
    }

    function matchFilter(e) {
        if (filter.grade && e.grade !== filter.grade) return false;
        if (filter.type && e.type !== filter.type) return false;
        if (filter.status === 'fallback') { if (!e.src?.fallback) return false; }
        else if (filter.status === 'pinned') { if (!e.pinned) return false; }
        else if (filter.status === 'manual') { if (!e.manual) return false; }
        else if (filter.status && e.status !== filter.status) return false;
        if (filter.q) {
            const hay = `${e.title} ${e.summary} ${(e.tags || []).join(' ')} ${e.story_time} ${(e.characters || []).join(' ')}`.toLowerCase();
            if (!hay.includes(filter.q.toLowerCase())) return false;
        }
        return true;
    }

    const floorsLabel = e => {
        const f = e.src?.floors;
        if (!f?.length) return `#${e.src?.idx ?? '?'}`;
        return f.length > 1 ? `#${f[0]}–#${f[f.length - 1]}` : `#${f[0]}`;
    };

    function cardHtml(e, depths) {
        const open = expanded.has(e.id);
        const badges = [];
        if (STATUS_LABEL[e.status]) badges.push(`<span class="em-badge em-st-${e.status}">${STATUS_LABEL[e.status]}</span>`);
        if (e.manual) badges.push('<span class="em-badge em-st-manual">手动</span>');
        if (e.src?.fallback) badges.push('<span class="em-badge em-st-fallback">兜底抠取</span>');
        if (e.status === 'ok' && !injectable(e, depths)) badges.push('<span class="em-badge em-st-window">窗口内·未注入</span>');
        if (e.pinned) badges.push('<span class="em-badge em-st-pinned">📌</span>');
        if (e.locked) badges.push('<span class="em-badge em-st-lock" title="手改过：重跑本段时保留，副 AI 被告知勿重复">🔒</span>');
        const hiddenMark = depths[e.src?.idx] < 0 ? '·已隐藏' : '';
        const body = open ? `
            <div class="em-card-body">
                <label>标题<input class="text_pole em-e-title" value="${esc(e.title)}"></label>
                <label>时间·场景<input class="text_pole em-e-time" value="${esc(e.story_time)}"></label>
                <label>摘要<textarea class="text_pole em-e-summary" rows="4">${esc(e.summary)}</textarea></label>
                <label>情绪变化<input class="text_pole em-e-emotion" value="${esc(e.emotion_shift)}"></label>
                <label>知情者（顿号分隔，空=全员）<input class="text_pole em-e-known" value="${esc((e.known_by || []).join('、'))}"></label>
                ${e.intimacy ? `<div class="em-sub">亲密：${esc([e.intimacy.acts, e.intimacy.consent, e.intimacy.firsts, e.intimacy.aftermath].filter(Boolean).join('；'))}</div>` : ''}
                ${e.tags?.length ? `<div class="em-sub">标签：${esc(e.tags.join(' / '))}</div>` : ''}
                ${e.grade_reason ? `<div class="em-sub">定级理由：${esc(e.grade_reason)}</div>` : ''}
                <div class="em-actions">
                    <div class="menu_button" data-eact="save">保存</div>
                    ${e.locked ? '<div class="menu_button" data-eact="unlock">解锁</div>' : ''}
                    ${e.manual ? '' : '<div class="menu_button" data-eact="resum">重跑本段</div>'}
                    <div class="menu_button" data-eact="jump">跳到该楼</div>
                    ${e.manual ? '' : '<div class="menu_button" data-eact="skip">本段不入库</div><div class="menu_button em-danger" data-eact="undo" title="删掉本段记忆、档案退回上一版、恢复显示楼层；之后可重新总结">撤销本段</div>'}
                    <div class="menu_button em-danger" data-eact="del">删除</div>
                </div>
            </div>` : '';
        return `
        <div class="em-card em-g-${e.grade} ${e.status !== 'ok' ? 'em-dim' : ''}" data-id="${e.id}">
            <div class="em-card-head">
                <div class="em-grade" title="点按改等级，长按钉/取消钉">${e.grade}</div>
                <div class="em-card-main">
                    <div class="em-ttl-row"><span class="em-ttl">${esc(e.title || '（未摘要）')}</span><span class="em-time">${esc(e.story_time || '（时间未知）')}</span></div>
                    ${!open ? `<div class="em-sum">${esc(e.summary || '…')}</div>` : ''}
                    <div class="em-meta">
                        ${e.characters?.length ? `<span>人物：${esc(e.characters.join('、'))}</span>` : ''}
                        ${e.tags?.length ? `<span class="em-tags">${esc(e.tags.slice(0, 4).join(' · '))}</span>` : ''}
                        <span>${TYPE_LABEL[e.type] || e.type}</span>
                        ${badges.join('')}
                        <span class="em-floor">${floorsLabel(e)}${hiddenMark}</span>
                    </div>
                </div>
            </div>
            ${body}
        </div>`;
    }

    // 失败/拒答/排队中的段落在时间线顶部显示为一张卡，能重试、拆半、标不入库
    function winCardHtml(w) {
        const n = spanOf(getCtx().chat || [], w.floors);
        return `
        <div class="em-card em-dim em-wcard" data-wid="${w.id}">
            <div class="em-card-head">
                <div class="em-grade em-grade-bad">!</div>
                <div class="em-card-main">
                    <div class="em-ttl-row"><span class="em-ttl">${winLabel(w)} · ${n} 楼 · ${STATUS_LABEL[w.status] || w.status}</span></div>
                    <div class="em-sum">${esc(w.last_error || (run.busy ? '排队中' : '等待重试'))}</div>
                    <div class="em-meta">
                        <span>已试 ${w.attempts} 次</span>
                        ${w.fallback ? '<span class="em-badge em-st-fallback">兜底抠取</span>' : ''}
                        <span class="em-floor em-jump" data-idx="${w.floors[0]}">跳到 #${w.floors[0]}</span>
                    </div>
                </div>
            </div>
            <div class="em-actions em-wact">
                <div class="menu_button" data-wact="retry">重试</div>
                ${n > 1 ? '<div class="menu_button" data-wact="split">拆半重试</div>' : ''}
                <div class="menu_button em-danger" data-wact="skip">本段不入库</div>
            </div>
        </div>`;
    }

    // 面板活跃度：近期 = 最近 npcScanDepth 楼提到（与注入完整卡同一判断）；沉寂 = 超过 DORMANT_FLOORS 楼没露面；其余在册
    const heatOf = (p, text, len) => mentioned(p, text) ? 'recent' : (len - 1 - (p.last_idx || 0) > DORMANT_FLOORS ? 'dormant' : 'listed');
    const HEAT_LABEL = { recent: '近期', listed: '', dormant: '沉寂' };

    function entHtml(kind, x, heat) {
        const open = expanded.has(x.id);
        const fields = kind === 'p' ? PERSON_FIELDS : ITEM_FIELDS;
        const label = k => kind === 'p' ? personLabel(k) : ITEM_LABEL[k];
        const tiers = kind === 'p' ? TIERS : ITEM_TIERS;
        const states = kind === 'p' ? PERSON_STATES : ITEM_STATES;
        const mark = v => `${v?.manual ? ' <span class="em-lock" title="手改过，副 AI 不再覆盖">🔒</span>' : ''}${v?.stale ? ' <span class="em-stale" title="来源楼层已不存在，待核">?</span>' : ''}`;
        const rows = fields.map(k => {
            const f = x.f?.[k];
            if (open) return `<label>${esc(label(k))}${f?.manual ? ' 🔒' : ''}<input class="text_pole em-x-f" data-k="${k}" value="${esc(f?.v || '')}"></label>`;
            if (!f?.v) return '';
            return `<div class="em-ent-row"><span class="em-ent-k">${esc(label(k))}</span><span class="em-ent-v">${esc(f.v)}${mark(f)}</span><span class="em-floor em-jump" data-idx="${f.idx}" title="点击跳到该楼">#${f.idx}</span></div>`;
        }).join('');
        const views = kind === 'p' ? Object.entries(x.views || {}).filter(([, v]) => v?.v) : [];
        const viewRows = open ? '' : views.map(([to, v]) => `<div class="em-ent-row"><span class="em-ent-k">对${esc(to)}</span><span class="em-ent-v">${v.trend ? `[${esc(v.trend)}] ` : ''}${esc(v.v)}${mark(v)}</span><span class="em-floor em-jump" data-idx="${v.idx}" title="点击跳到该楼">#${v.idx}</span></div>`).join('');
        const hasLock = Object.values(x.f || {}).some(v => v?.manual) || Object.values(x.views || {}).some(v => v?.manual);
        const alias = kind === 'p' && x.aliases?.length ? `<span class="em-ent-alias">（${esc(x.aliases.join('/'))}）</span>` : '';
        const tierCls = kind === 'p' ? (x.tier === '龙套' ? 'x' : x.tier === '主' ? 'a' : 'b') : (x.tier === '摆设' ? 'x' : x.tier === '关键' ? 'a' : 'b');
        const badges = [];
        if (x.tier) badges.push(`<span class="em-tier em-tier-${tierCls}" title="${x.tierLock ? '手改已锁定' : ''}">${esc(x.tier)}${x.tierLock ? '🔒' : ''}</span>`);
        if (x.state && x.state !== '在场') badges.push(`<span class="em-tier em-state${kind === 'i' && isSettled(x) ? ' em-state-done' : ''}" title="${x.stateLock ? '手改已锁定' : ''}">${esc(x.state)}${x.stateLock ? '🔒' : ''}</span>`);
        if (kind === 'p' && HEAT_LABEL[heat]) badges.push(`<span class="em-tier em-heat-${heat}">${HEAT_LABEL[heat]}</span>`);
        if (x.lost) badges.push('<span class="em-tier em-lost" title="首见楼与所有来源楼都已被删：不注入；再次被提到或手动保存即恢复">来源全失</span>');
        const dim = kind === 'p' ? x.tier === '龙套' || x.lost : (isProp(x) || isSettled(x) || x.lost);
        const sel = (cls, list, cur, none, extra) => `<select class="${cls}"><option value="">${none}</option>${list.map(t => `<option value="${t}" ${cur === t ? 'selected' : ''}>${t}${extra?.(t) || ''}</option>`).join('')}</select>`;
        return `
        <div class="em-ent${dim ? ' em-ent-extra' : ''}" data-id="${x.id}">
            <div class="em-ent-head"><span class="em-ent-name">${kind === 'p' ? '👤' : '📦'} ${esc(x.name)}${alias}${badges.join('')}</span><span class="em-floor">首见 #${x.first_idx ?? '?'}${x.seen ? ` · ${x.seen} 段` : ''}</span></div>
            ${open ? `<div class="em-ent-body">
                <label>名字<input class="text_pole em-x-name" value="${esc(x.name)}"></label>
                ${kind === 'p' ? `<label>别称（顿号分隔）<input class="text_pole em-x-alias" value="${esc((x.aliases || []).join('、'))}"></label>` : ''}
                <div class="em-ent-2col">
                    <label>${kind === 'p' ? '档位' : '关键性'}${x.tierLock ? '（已锁，选「未定」解锁）' : '（手改后锁定，副 AI 不再改）'}${sel('em-x-tier', tiers, x.tier, '（未定）', t => (t === '龙套' || t === '摆设') ? '（不注入）' : '')}</label>
                    <label>状态${x.stateLock ? '（已锁，选「未定」解锁）' : ''}${sel('em-x-state', states, x.state, '（未定）')}</label>
                </div>
                ${rows}
                ${kind === 'p' ? `<label>对他人的看法（每行：对象｜趋势｜一句话；趋势可空）<textarea class="text_pole em-x-views" rows="3">${esc(views.map(([to, v]) => `${to}｜${v.trend || ''}｜${v.v}`).join('\n'))}</textarea></label>` : ''}
                <div class="em-actions"><div class="menu_button" data-xact="save">保存</div>${hasLock ? '<div class="menu_button" data-xact="unlockf">解除字段锁定</div>' : ''}<div class="menu_button em-danger" data-xact="del">删除</div></div>
            </div>` : `<div class="em-ent-rows">${rows}${viewRows}</div>`}
        </div>`;
    }

    function matchEnt(kind, x, heat) {
        const f = entFilter[kind];
        if (f.tier === 'none' ? x.tier : (f.tier && x.tier !== f.tier)) return false;
        if (f.state === 'none' ? x.state : f.state === 'settled' ? !isSettled(x) : (f.state && x.state !== f.state)) return false;
        if (kind === 'p' && f.heat && heat !== f.heat) return false;
        if (kind === 'i' && f.holder && fv(x, 'holder') !== f.holder) return false;
        if (f.q) {
            const hay = (kind === 'p'
                ? [x.name, ...(x.aliases || []), fv(x, 'role')]
                : [x.name, fv(x, 'holder'), fv(x, 'note'), fv(x, 'meaning')]).join(' ').toLowerCase();
            if (!hay.includes(f.q.toLowerCase())) return false;
        }
        return true;
    }
    const entSorter = sort => sort === 'first' ? (a, b) => (a.first_idx || 0) - (b.first_idx || 0)
        : sort === 'name' ? (a, b) => String(a.name).localeCompare(String(b.name), 'zh')
            : sort === 'seen' ? (a, b) => (b.seen || 0) - (a.seen || 0)
                : (a, b) => (b.last_idx || 0) - (a.last_idx || 0);

    function renderEntities(data) {
        const ctx = getCtx();
        const chat = ctx.chat || [];
        const rel = data.relation || {};
        $('#em_rel_box').html(`
        <div class="em-rel"><label>${esc(ctx.name2 || '{{char}}')} 对 ${esc(ctx.name1 || '{{user}}')} 的关系现状${rel.idx != null ? ` <span class="em-floor em-jump" data-idx="${rel.idx}">#${rel.idx}</span>` : ''}${rel.manual ? ' <span class="em-lock" title="手改过，副 AI 不再覆盖">🔒</span> <span id="em_rel_unlock" class="em-floor em-jump">解锁</span>' : ''}
            <input id="em_rel" class="text_pole" value="${esc(rel.v || '')}" placeholder="（尚无记录，总结后由副 AI 填写，也可手改）"></label></div>`);
        const tombHtml = kind => {
            const names = [...new Set(Object.values(data.tombstones?.[kind] || {}).map(t => t.name))];
            return names.length ? `已删除（不再自动建档，点名字恢复）：${names.map(n => `<span class="em-tomb" data-kind="${kind}" data-name="${esc(n)}">${esc(n)} ×</span>`).join(' ')}` : '';
        };
        $('#em_tombs').html(tombHtml('p'));
        $('#em_tombs_i').html(tombHtml('i'));

        const text = recentText(chat, Math.max(1, Number(settings.npcScanDepth) || 6));
        const heats = new Map(data.people.map(p => [p.id, heatOf(p, text, chat.length)]));
        const people = data.people.filter(p => matchEnt('p', p, heats.get(p.id))).sort(entSorter(entFilter.p.sort));
        $('#em_n_people').text(data.people.length ? `${people.length}/${data.people.length}` : '');
        $('#em_people').html(people.length ? people.map(p => entHtml('p', p, heats.get(p.id))).join('')
            : `<div class="em-empty">${data.people.length ? '没有符合筛选的人物' : '还没有人物志，总结后由副 AI 自动建档（不含主角）；老聊天可「更多 → 从事件补人物」'}</div>`);

        // 持有者下拉的选项随现有档案变，保住当前选择
        const holders = [...new Set(data.items.map(it => fv(it, 'holder')).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'));
        const hsel = $('#em_fi_holder');
        hsel.html(`<option value="">全部持有者</option>${holders.map(h => `<option value="${esc(h)}" ${entFilter.i.holder === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}`);
        if (entFilter.i.holder && !holders.includes(entFilter.i.holder)) entFilter.i.holder = '';
        const items = data.items.filter(it => matchEnt('i', it)).sort(entSorter(entFilter.i.sort));
        $('#em_n_items').text(data.items.length ? `${items.length}/${data.items.length}` : '');
        $('#em_items').html(items.length ? items.map(it => entHtml('i', it)).join('')
            : `<div class="em-empty">${data.items.length ? '没有符合筛选的物件' : '还没有物件，总结后由副 AI 自动建档'}</div>`);
    }

    function outlineHtml(l) {
        const open = expanded.has(l.id);
        return `
        <div class="em-oline${l.level === 2 ? ' em-oline-2' : ''}" data-id="${l.id}">
            <div class="em-oline-head"><span class="em-oline-key">${esc(l.key)}</span>${l.level === 2 ? `<span class="em-tier em-tier-b">时期${l.merged ? `·${l.merged} 日` : ''}</span>` : ''}${l.manual ? '<span class="em-tier">🔒</span>' : ''}<span class="em-floor">#${l.idx}${l.last != null && l.last !== l.idx ? `–#${l.last}` : ''} · ${(l.from || []).length} 条</span></div>
            ${open ? `<div class="em-ent-body"><textarea class="text_pole em-o-text" rows="3">${esc(l.text)}</textarea><div class="em-actions"><div class="menu_button" data-oact="save">保存</div><div class="menu_button em-danger" data-oact="del">删除</div></div></div>`
                : `<div class="em-oline-text">${esc(l.text)}</div>`}
        </div>`;
    }

    function renderOutline(data) {
        const lines = (data.outline?.lines || []).slice().sort((a, b) => a.idx - b.idx);
        const S = data.entries.filter(e => e.status === 'ok' && (e.grade === 'S' || e.pinned)).length;
        const canon = data.canon || {};
        const max = Number(settings.canonMax) || 25;
        $('#em_n_outline').text(lines.length ? `${lines.length} 行` : '');
        $('#em_outline_line').text(`远景 ${lines.length} 行${lines.some(l => l.level === 2) ? `（含时期 ${lines.filter(l => l.level === 2).length} 行）` : ''} · 待折叠 ${data.outline.pending.length} 条 · 正典 S ${S} 条${canon.text ? `，已压缩 ${canon.builtFrom.length} 条为 ${canon.text.length} 字` : `（超过 ${max} 条自动压缩）`}${gov.busy ? ' · 折叠中…' : ''}${gov.fails >= 3 ? ' · 折叠连续失败已暂停，点「现在折叠」重试' : ''}`);
        $('#em_canon').html(canon.text
            ? (expanded.has('canon')
                ? `<div class="em-canon-text"><b>正典（压缩段）</b><textarea class="text_pole em-c-text" rows="6">${esc(canon.text)}</textarea><div class="em-actions"><div class="menu_button" data-oact="csave">保存并锁定</div>${canon.manual ? '<div class="menu_button" data-oact="cunlock">解锁（恢复自动重压）</div>' : ''}<div class="menu_button" data-oact="ccancel">取消</div></div></div>`
                : `<div class="em-canon-text em-canon-view" data-oact="cedit" title="点击编辑"><b>正典（压缩段）${canon.manual ? ' 🔒手改锁定' : ''}</b><br>${esc(canon.text).replace(/\n/g, '<br>')}</div>`)
            : '');
        $('#em_outline').html(lines.length ? lines.map(outlineHtml).join('')
            : '<div class="em-empty">还没有远景：往事超出注入上限被裁掉的条目攒够后会自动折成按日骨架（非破坏，条目仍在时间线里）</div>');
    }

    function jumpTo(idx) {
        const el = document.querySelector(`#chat .mes[mesid="${idx}"]`);
        if (!el) return toast('warning', '该楼不在当前视图');
        togglePanel(false); el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function manualFormHtml() {
        const chat = getCtx().chat || [];
        let lastAi = chat.length - 1;
        while (lastAi > 0 && chat[lastAi]?.is_user) lastAi--;
        return `
        <div class="em-manual-title">手动新增一条记忆</div>
        <label>标题<input class="text_pole em-m-title" placeholder="≤8 字"></label>
        <label>时间·场景<input class="text_pole em-m-time" placeholder="例：3月4日 · 午后 · 厨房"></label>
        <label>摘要<textarea class="text_pole em-m-summary" rows="3" placeholder="发生了什么、为什么"></textarea></label>
        <div class="em-row">
            <label>等级<select class="em-m-grade">${GRADES.map(g => `<option value="${g}" ${g === 'A' ? 'selected' : ''}>${g}</option>`).join('')}</select></label>
            <label>挂在第几楼（决定时间顺序）<input class="text_pole em-m-idx" type="number" min="0" max="${Math.max(0, chat.length - 1)}" value="${Math.max(0, lastAi)}"></label>
        </div>
        <div class="em-actions">
            <div class="menu_button" data-mact="save">保存</div>
            <div class="menu_button" data-mact="cancel">取消</div>
        </div>`;
    }

    function addManualEntry({ title, story_time, summary, grade, idx }) {
        const data = getData(); if (!data) return null;
        const chat = getCtx().chat || [];
        const e = newEntry();
        e.manual = true;
        e.title = (title || '').trim().slice(0, 12) || (summary || '').trim().slice(0, 8) || '（手动）';
        e.story_time = (story_time || '').trim();
        e.summary = (summary || '').trim();
        e.grade = GRADES.includes(grade) ? grade : 'A';
        e.status = 'ok';
        e.src = { idx: clamp(Number(idx) || 0, 0, Math.max(0, chat.length - 1)), send_date: `manual:${e.id}`, hash: '' };
        data.entries.push(e);
        sortEntries(data); saveData(); applyInjection();
        return e;
    }

    function manualFormAction(act) {
        const f = $('#em_manual_form');
        if (act === 'cancel') { addingManual = false; renderPanel(); return; }
        const summary = f.find('.em-m-summary').val().trim();
        if (summary.length < 4) return toast('warning', '摘要至少写几个字');
        addManualEntry({
            title: f.find('.em-m-title').val(), story_time: f.find('.em-m-time').val(), summary,
            grade: f.find('.em-m-grade').val(), idx: f.find('.em-m-idx').val(),
        });
        addingManual = false;
        renderPanel(); refreshStatus();
        toast('success', '已新增');
    }

    function renderPanel() {
        if (!panelOpen) return;
        const data = getData();
        const list = $('#em_list');
        const form = $('#em_manual_form');
        if (!data) { list.html('<div class="em-empty">当前没有打开聊天</div>'); form.hide(); $('#em_rel_box, #em_people, #em_items, #em_tombs, #em_tombs_i, #em_canon, #em_outline').html(''); $('#em_n_people, #em_n_items, #em_n_outline, #em_outline_line').text(''); $('#em_preview').text(''); $('#em_raw').text(''); return; }
        const chat = getCtx().chat || [];
        const depths = visibleDepths(chat);
        renderEntities(data);
        renderOutline(data);
        const items = data.entries.filter(matchFilter).slice().reverse();
        const wins = filter.q ? [] : data.windows.filter(w => ['failed', 'refused', 'pending'].includes(w.status) && (!filter.status || filter.status === w.status)).slice().reverse();
        if (items.length || wins.length) {
            list.html(wins.map(winCardHtml).join('') + items.map(e => cardHtml(e, depths)).join(''));
        } else {
            const todo = counts().todo;
            const N = Math.max(0, Number(settings.autoInterval) || 0);
            const hasFilter = filter.grade || filter.type || filter.status || filter.q;
            list.html(`<div class="em-empty">${hasFilter ? '没有符合筛选的条目'
                : todo ? `本聊天有 ${todo} 楼尚未总结，点上方「总结到当前」开始`
                    : data.entries.length ? '没有条目' : `还没有记忆。${N ? `攒够 ${N} 楼后会自动总结，` : ''}点上方「总结到当前」可立刻总结`}</div>`);
        }
        if (addingManual) form.show().html(manualFormHtml()); else form.hide().empty();

        $('#em_preview').text(lastInject.text || '（本轮没有可注入的内容）');
        const sz = lastInject.sizes || {};
        $('#em_preview_line').text(lastInject.text ? `共 ${lastInject.chars} 字：档案 ${sz.ent || 0} · 远景 ${sz.outline || 0} · 正典 ${sz.canon || 0} · 往事 ${sz.past || 0} · 保底 ${sz.fallback || 0} · 召回 ${sz.recall || 0} · 原文 ${sz.raw || 0}${lastInject.dropped ? ` · 预算裁掉 ${lastInject.dropped} 条` : ''}` : '');
        $('#em_raw').text((data.rawLog || []).length
            ? data.rawLog.map(r => `[${new Date(r.at).toLocaleString()}] ${r.win} · ${r.model || ''}${r.finish ? ` · finish=${r.finish}` : ''}${r.note ? ` · ${r.note}` : ''}\n${r.text}`).join('\n\n========\n\n')
            : '（还没有调用记录）');

        const c = counts();
        const alert = $('#em_alert');
        const bad = c.failed + c.refused;
        if (bad) {
            alert.show().text(`${bad} 段摘要失败（其中拒答 ${c.refused}）${data.stats.lastError ? '：' + data.stats.lastError : ''}。时间线顶部可重试 / 拆半 / 标不入库，或「更多 → 重试失败」整批重跑`);
        } else if (!apiConfigured()) {
            alert.show().text('尚未配置副 API，不会自动总结（点此去设置）');
        } else {
            alert.hide();
        }
    }

    /* ---- 面板操作 ---- */

    async function confirmBox(text) {
        const ctx = getCtx();
        if (ctx.callGenericPopup && ctx.POPUP_TYPE) {
            const r = await ctx.callGenericPopup(text, ctx.POPUP_TYPE.CONFIRM);
            return r === (ctx.POPUP_RESULT?.AFFIRMATIVE ?? 1);
        }
        return window.confirm(text);
    }

    function cycleGrade(id) {
        const data = getData(); const e = data?.entries.find(x => x.id === id); if (!e) return;
        if (e.pinned) return toast('info', '已钉选的条目等级锁定为 S，长按可取消钉选');
        e.grade = GRADES[(GRADES.indexOf(e.grade) + 1) % GRADES.length];
        e.locked = true;   // 手改过等级：重跑保留、副模型被告知勿重复
        e.updated_at = Date.now();
        saveData(); applyInjection(); renderPanel();
    }

    function togglePin(id) {
        const data = getData(); const e = data?.entries.find(x => x.id === id); if (!e) return;
        e.pinned = !e.pinned;
        if (e.pinned) { e.prev_grade = e.grade; e.grade = 'S'; }
        else if (e.prev_grade) { e.grade = e.prev_grade; delete e.prev_grade; }
        e.updated_at = Date.now();
        saveData(); applyInjection(); renderPanel();
        toast('info', e.pinned ? '已钉为 S 级' : '已取消钉选');
        return e.pinned;
    }

    async function entryAction(act, id) {
        const data = getData(); if (!data) return;
        const e = data.entries.find(x => x.id === id); if (!e) return;
        const card = $(`#em_list .em-card[data-id="${id}"]`);
        if (act === 'save') {
            e.title = card.find('.em-e-title').val().trim() || e.title;
            e.story_time = card.find('.em-e-time').val().trim();
            e.summary = card.find('.em-e-summary').val().trim() || e.summary;
            e.emotion_shift = card.find('.em-e-emotion').val().trim();
            e.known_by = card.find('.em-e-known').val().split(/[、,，]/).map(s => s.trim()).filter(Boolean);
            e.locked = true;
            e.updated_at = Date.now();
            saveData(); applyInjection(); expanded.delete(id); renderPanel();
            if (vecOn() && e.status === 'ok') vecIndexEntries(data, [e]).then(() => saveData()).catch(err => warn('向量更新失败：', err.message));
            toast('success', '已保存（已锁定：重跑本段时保留）');
        } else if (act === 'unlock') {
            e.locked = false; e.updated_at = Date.now();
            saveData(); renderPanel();
            toast('info', '已解锁：重跑本段时会被替换');
        } else if (act === 'resum') {
            const w = e.win ? winById(data, e.win) : null;
            if (!w) return toast('error', '找不到这条记忆所属的段落');
            if (!apiConfigured()) return toast('warning', '请先配置副 API');
            if (run.busy) return toast('info', '正在总结中，稍后再试');
            const n = winEntries(data, w.id).length;
            const kept = winEntries(data, w.id).filter(x => x.pinned || x.locked).length;
            if (!await confirmBox(`重跑 ${winLabel(w)} 共 ${winFloors([w])} 楼（一次副 API 调用），该段现有 ${n} 条记忆会被替换${kept ? `（其中 ${kept} 条已钉选/锁定的会保留）` : ''}。继续？`)) return;
            w.status = 'stale'; w.attempts = 0; saveData();
            run.failToasted = false;
            ingest('retry');
        } else if (act === 'jump') {
            jumpTo(e.src?.idx);
        } else if (act === 'skip') {
            if (e.win) return windowAction('skip', e.win);
        } else if (act === 'undo') {
            if (e.win) return windowAction('undo', e.win);
        } else if (act === 'del') {
            if (!await confirmBox(e.manual ? '删除这条手动记忆？' : '删除这条记忆？该段楼层仍算已总结，不会自动重跑；要重新生成请用「重跑本段」')) return;
            data.entries = data.entries.filter(x => x.id !== id);
            data.outline.pending = data.outline.pending.filter(x => x !== id);
            if (vecOn()) vecDeleteEntries(data, [id]).catch(err => warn('向量删除失败：', err.message));
            saveData(); applyInjection(); renderPanel(); refreshStatus();
        }
    }

    async function windowAction(act, wid) {
        const data = getData(); if (!data) return;
        const w = winById(data, wid); if (!w) return;
        if (act === 'retry' || act === 'split') {
            if (!apiConfigured()) return toast('warning', '请先配置副 API');
            if (run.busy) return toast('info', '正在总结中，稍后再试');
            if (act === 'split' && w.floors.length > 1) splitWindow(data, w);
            else w.attempts = 0;
            saveData();
            run.failToasted = false;
            ingest('retry');
        } else if (act === 'skip') {
            if (!await confirmBox(`把 ${winLabel(w)} 共 ${winFloors([w])} 楼标记为「不入库」并删除其记忆？`)) return;
            for (const d of w.dates) data.skip[d] = true;
            undoWindow(data, w);
            saveData(); applyInjection(); renderPanel(); refreshStatus();
        } else if (act === 'undo') {
            if (!await confirmBox(`撤销 ${winLabel(w)} 这一段的总结？会删掉该段 ${winEntries(data, w.id).length} 条记忆、把档案里来自这段的值退回上一版、作废涉及这段的远景行，并恢复显示这段楼层；楼层本身不动，之后可以重新总结。`)) return;
            const n = undoWindow(data, w);
            saveData(); applyInjection(); renderPanel(); refreshStatus();
            toast('success', `已撤销 ${winLabel(w)}：档案回退 ${n} 处`);
        }
    }

    // 撤销一段：删窗口与条目、档案值来源落在该段的退回上一版、远景行作废、向量删除、楼层取消隐藏
    function undoWindow(data, w) {
        const dates = new Set(w.dates);
        const ids = winEntries(data, w.id).map(e => e.id);
        data.windows = data.windows.filter(x => x.id !== w.id);
        data.entries = data.entries.filter(x => x.win !== w.id);
        data.outline.pending = data.outline.pending.filter(id => !ids.includes(id));
        let n = rollbackValues(data, d => dates.has(d));
        const before = data.outline.lines.length;
        data.outline.lines = data.outline.lines.filter(l => !(l.dates || []).some(d => dates.has(d)));
        n += before - data.outline.lines.length;
        if (vecOn()) vecDeleteEntries(data, ids).catch(err => warn('向量删除失败：', err.message));
        const chat = getCtx().chat || [];
        let unhid = 0;
        chat.forEach((m, i) => {
            if (!m?.is_system || !m.send_date || !data.hidden[m.send_date]) return;
            const own = dates.has(m.send_date) || (m.is_user && chat[i + 1] && dates.has(chat[i + 1].send_date));
            if (!own) return;
            m.is_system = false; delete data.hidden[m.send_date]; setHiddenDom(i, false); unhid++;
        });
        if (unhid) Promise.resolve(getCtx().saveChat?.()).catch(err => warn('保存聊天失败：', err));
        return n;
    }

    function entityAction(act, id) {
        const data = getData(); if (!data) return;
        const kind = data.people.some(x => x.id === id) ? 'p' : 'i';
        const list = kind === 'p' ? data.people : data.items;
        const x = list.find(v => v.id === id); if (!x) return;
        const el = $(`#em_panel .em-ent[data-id="${id}"]`);
        if (act === 'save') {
            x.name = el.find('.em-x-name').val().trim() || x.name;
            // 档位 / 状态：改了就锁（副 AI 不再覆盖），选回「未定」= 清空并解锁
            const tiers = kind === 'p' ? TIERS : ITEM_TIERS, states = kind === 'p' ? PERSON_STATES : ITEM_STATES;
            const tier = String(el.find('.em-x-tier').val() || '');
            if (!tier) { x.tier = ''; x.tierLock = false; }
            else if (tiers.includes(tier) && tier !== x.tier) { x.tier = tier; x.tierLock = true; }
            const state = String(el.find('.em-x-state').val() || '');
            if (!state) { x.state = ''; x.stateLock = false; }
            else if (states.includes(state) && state !== x.state) { x.state = state; x.stateLock = true; }
            if (kind === 'p') {
                x.aliases = el.find('.em-x-alias').val().split(/[、,，/]/).map(s => s.trim()).filter(Boolean);
                const views = {};
                for (const line of String(el.find('.em-x-views').val() || '').split('\n')) {
                    const [to, trend, ...rest] = line.split(/[｜|]/).map(s => s.trim());
                    const v = rest.join('｜').trim();
                    if (!to || !v) continue;
                    const old = x.views?.[to];
                    views[to] = { v, trend: TRENDS.includes(trend) ? trend : '', idx: old?.idx ?? x.last_idx ?? 0, date: old?.date || '', manual: true };
                }
                x.views = views;
            }
            el.find('.em-x-f').each(function () {
                const k = $(this).data('k');
                const v = this.value.trim();
                if (!v) { delete x.f[k]; return; }
                if (x.f[k]?.v !== v) x.f[k] = { v, idx: x.f[k]?.idx ?? x.last_idx ?? 0, date: x.f[k]?.date || '', manual: true };
            });
            x.updated_at = Date.now();
            delete x.lost;
            saveData(); applyInjection(); expanded.delete(id); renderPanel();
            toast('success', '已保存（改过的字段已锁定，副 AI 不再覆盖）');
        } else if (act === 'unlockf') {
            // 解除本卡全部字段锁：副 AI 之后可以再覆盖
            for (const k of Object.keys(x.f || {})) delete x.f[k].manual;
            for (const k of Object.keys(x.views || {})) delete x.views[k].manual;
            saveData(); renderPanel();
            toast('info', '已解除字段锁定');
        } else if (act === 'del') {
            confirmBox(`删除「${x.name}」的档案？之后副 AI 再报这个名字也不会重新建档（人物志底部「已删除」可恢复）`).then(ok => {
                if (!ok) return;
                addTomb(data, kind, x);
                if (kind === 'p') data.people = data.people.filter(v => v.id !== id);
                else data.items = data.items.filter(v => v.id !== id);
                saveData(); applyInjection(); renderPanel(); refreshStatus();
            });
        }
    }

    // 恢复墓碑里的名字：之后再出现就正常建档
    function restoreTomb(kind, name) {
        const data = getData(); if (!data) return;
        removeTomb(data, kind, name);
        saveData(); renderPanel();
        toast('info', `「${name}」下次出现会重新建档`);
    }

    function outlineAction(act, id) {
        const data = getData(); if (!data) return;
        if (act === 'fold') {
            if (!apiConfigured()) return toast('warning', '请先配置副 API');
            if (run.busy || gov.busy) return toast('info', '正在处理中，稍后再试');
            gov.fails = 0;
            toast('info', `开始折叠：远景待折叠 ${data.outline.pending.length} 条${data.entries.filter(e => e.status === 'ok' && (e.grade === 'S' || e.pinned)).length > (Number(settings.canonMax) || 25) ? '，正典需要压缩' : ''}`);
            govern(true).then(did => toast(did ? 'success' : 'info', did ? '折叠完成' : '没有需要折叠的内容'));
            return;
        }
        if (act === 'recanon') {
            if (!apiConfigured()) return toast('warning', '请先配置副 API');
            if (run.busy || gov.busy) return toast('info', '正在处理中，稍后再试');
            data.canon = { text: '', builtFrom: [], builtAt: 0 };   // 也清掉手改锁
            saveData();
            govern(true).then(() => toast('success', '正典已重建'));
            return;
        }
        if (act === 'cedit') { expanded.add('canon'); renderPanel(); return; }
        if (act === 'ccancel') { expanded.delete('canon'); renderPanel(); return; }
        if (act === 'csave') {
            const text = String($('#em_canon .em-c-text').val() || '').trim();
            if (text) { data.canon.text = text; data.canon.manual = true; data.canon.builtAt = Date.now(); }
            expanded.delete('canon'); saveData(); applyInjection(); renderPanel();
            toast('success', '正典已保存并锁定：删 S、加 S 都不再自动重压，解锁或重建后恢复');
            return;
        }
        if (act === 'cunlock') { data.canon.manual = false; expanded.delete('canon'); saveData(); renderPanel(); toast('info', '正典已解锁'); return; }
        const line = data.outline.lines.find(l => l.id === id); if (!line) return;
        const el = $(`#em_outline .em-oline[data-id="${id}"]`);
        if (act === 'save') {
            const text = el.find('.em-o-text').val().trim();
            if (text) { line.text = text; line.manual = true; line.at = Date.now(); }
            expanded.delete(id); saveData(); applyInjection(); renderPanel();
        } else if (act === 'del') {
            confirmBox(`删除这行远景（${line.key}）？被它覆盖的 ${line.from?.length || 0} 条记忆会重新回到往事（预算不够时再次被裁掉并重新折叠）`).then(ok => {
                if (!ok) return;
                data.outline.lines = data.outline.lines.filter(l => l.id !== id);
                saveData(); applyInjection(); renderPanel();
            });
        }
    }

    async function panelAction(act) {
        const data = getData();
        if (act === 'cfg') return showTab('cfg');
        if (!data) return toast('warning', '当前没有打开聊天');
        if (act === 'add') { addingManual = true; sections.timeline = true; applySections(); renderPanel(); }
        else if (act === 'backfill') {
            const n = backfillPeople();
            saveData(); applyInjection(); renderPanel(); refreshStatus();
            toast(n ? 'success' : 'info', n ? `已从事件补出 ${n} 个人物（只有名字和楼层，档位与字段等下次总结补全）` : '事件里点到的人都已有档案');
        }
        else if (act === 'retry') {
            let n = 0;
            for (const w of data.windows) if (['failed', 'refused'].includes(w.status)) { w.attempts = 0; n++; }
            saveData();
            if (!n) return toast('info', '没有失败的段落');
            if (run.busy) return toast('info', '正在总结中，稍后再试');
            run.failToasted = false;
            ingest('retry');
        } else if (act === 'unhide') {
            const n = unhideAll();
            applyInjection(); renderPanel(); refreshStatus();
            toast('info', n ? `已恢复 ${n} 条消息；「隐藏已总结」仍勾着的话，下次总结后会再次隐藏` : '没有本插件隐藏的楼层');
        } else if (act === 'export') {
            const ctx = getCtx();
            const blob = new Blob([JSON.stringify({ chatId: ctx.chatId, exportedAt: new Date().toISOString(), data }, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `erato-memory-${String(ctx.chatId || 'chat').replace(/[^\w.-]+/g, '_')}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        } else if (act === 'import') {
            $('#em_import_file').val('').trigger('click');
        } else if (act === 'clear') {
            if (!await confirmBox(`清空当前聊天的全部记忆（${data.entries.length} 条、${data.people.length} 个人物、${data.items.length} 件物件、远景 ${data.outline.lines.length} 行）？不可恢复（建议先导出）。本插件隐藏的楼层会一并恢复显示`)) return;
            stopRun();   // 正在飞的调用返回后会发现库已换，结果作废
            unhideAll();
            if (vecOn()) { for (const k of ['mem', 'raw']) vecCall('purge', { collectionId: vecCollection(k) }).catch(err => warn('清向量失败：', err.message)); }
            getCtx().chatMetadata[META_KEY] = defaultData();
            rc.key = ''; rc.result = null;
            saveData(); applyInjection(); renderPanel(); refreshStatus();
        }
    }

    function importFile() {
        const file = this.files?.[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                const obj = JSON.parse(String(reader.result));
                const raw = obj?.data?.entries ? obj.data : obj;
                if (!Array.isArray(raw?.entries)) throw new Error('文件里没有 entries');
                const src = Object.assign(defaultData(), raw);
                for (const k of ['entries', 'windows', 'people', 'items']) if (!Array.isArray(src[k])) src[k] = [];
                if ((Number(raw.version) || 1) < 2) migrateV1(src);
                const data = getData();
                const has = data.entries.length || data.windows.length || data.people.length || data.items.length;
                const mode = has
                    ? (await confirmBox(`当前已有 ${data.entries.length} 条记忆、${data.people.length} 个人物。确定=替换，取消=合并（按 id / 名字去重）`) ? 'replace' : 'merge')
                    : 'replace';
                if (mode === 'replace') {
                    for (const k of ['entries', 'windows', 'people', 'items', 'relation', 'skip', 'archives', 'hidden', 'outline', 'canon', 'recaps', 'tombstones']) data[k] = src[k];
                    data.vec = { entries: {}, raw: {}, source: '', model: '', at: 0 };   // 向量库是本地索引，导入后按需「补向量」
                } else {
                    const eIds = new Set(data.entries.map(e => e.id)), wIds = new Set(data.windows.map(w => w.id));
                    for (const w of src.windows) if (!wIds.has(w.id)) data.windows.push(w);
                    for (const e of src.entries) if (!eIds.has(e.id)) data.entries.push(e);
                    for (const p of src.people) if (!findPerson(data, p.name)) data.people.push(p);
                    for (const it of src.items) if (!findItem(data, it.name)) data.items.push(it);
                    if (!data.relation?.v && src.relation?.v) data.relation = src.relation;
                    Object.assign(data.skip, src.skip || {});
                    const oIds = new Set(data.outline.lines.map(l => l.id));
                    for (const l of (src.outline?.lines || [])) if (!oIds.has(l.id)) data.outline.lines.push(l);
                    if (!data.canon?.text && src.canon?.text) data.canon = src.canon;
                    Object.assign(data.recaps, src.recaps || {});
                    for (const k of ['p', 'i']) Object.assign(data.tombstones[k], src.tombstones?.[k] || {});
                }
                sortEntries(data); sortWindows(data); reconcile(); saveData(); applyInjection(); renderPanel(); refreshStatus();
                toast('success', `已导入，现有 ${data.entries.length} 条记忆、${data.people.length} 个人物、${data.items.length} 件物件`);
            } catch (err) {
                toast('error', `导入失败：${err.message}`);
            }
        };
        reader.readAsText(file);
    }

    /* ================= 斜杠命令（供 QuickReply 接入） ================= */

    function addSlashCommands() {
        const ctx = getCtx();
        const P = ctx.SlashCommandParser;
        if (!P?.addCommand) return log('酒馆未暴露 SlashCommandParser.addCommand，跳过斜杠命令');
        const reg = (name, cb, help) => { try { P.addCommand(name, cb, [], help); } catch (err) { warn('注册 /' + name + ' 失败：', err); } };
        reg('em-panel', () => { togglePanel(true); return ''; }, '打开 Erato Memory 面板');
        reg('em-summarize', () => { summarizeAll(); return ''; }, '总结到当前：把所有未总结的楼层入库（含最新楼）');
        reg('em-pin', (args, value) => {
            const data = getData(); if (!data) return '没有打开聊天';
            const idx = Number(String(value || '').trim());
            if (!Number.isInteger(idx)) return '用法：/em-pin 楼层号';
            const e = data.entries.find(x => !x.manual && (x.src?.floors || []).includes(idx)) || data.entries.find(x => !x.manual && x.src?.idx === idx);
            if (!e) return `第 ${idx} 楼还没有记忆条目`;
            return togglePin(e.id) ? `已钉「${e.title}」为 S` : `已取消钉「${e.title}」`;
        }, '钉/取消钉某楼所在的记忆为 S：/em-pin 楼层号');
        reg('em-note', (args, value) => {
            const text = String(value || '').trim();
            if (!text) return '用法：/em-note 要记住的内容';
            const chat = getCtx().chat || [];
            let lastAi = chat.length - 1;
            while (lastAi > 0 && chat[lastAi]?.is_user) lastAi--;
            const e = addManualEntry({ summary: text, grade: 'A', idx: Math.max(0, lastAi) });
            if (e) { renderPanel(); refreshStatus(); }
            return e ? `已记：「${e.title}」` : '没有打开聊天';
        }, '手动记一条记忆（A 级，挂在最新 AI 楼）：/em-note 文字');
    }

    /* ================= 事件 ================= */

    function bindEvents() {
        const ctx = getCtx();
        const es = ctx.eventSource, ET = ctx.eventTypes;
        const autoOn = () => Number(settings.autoInterval) > 0;
        const ingestSoon = debounce(() => { if (autoOn()) ingest('auto'); }, 800);
        const resync = () => { reconcile(); applyInjection(); renderPanel(); refreshStatus(); };
        const vecSyncSoon = debounce(() => {
            const data = getData();
            if (!vecOn() || !data || !(data.entries.length || data.windows.length)) return;
            vecSync(data).catch(err => { data.vec.error = err.message; warn('向量对账失败：', err.message); });
        }, 5000);

        es.on(ET.CHAT_CHANGED, () => {
            expanded.clear(); addingManual = false; stopRun(); run.failToasted = false; rc.vecToasted = false;
            rc.key = ''; rc.result = null; rc.promise = null; rc.error = '';
            gov.fails = 0; clearTimeout(gov.timer);
            setTimeout(() => { resync(); if (autoOn()) ingest('chat_changed'); vecSyncSoon(); }, 1500);
        });
        es.on(ET.MESSAGE_RECEIVED, ingestSoon);
        es.on(ET.MESSAGE_DELETED, resync);
        es.on(ET.MESSAGE_UPDATED, () => { resync(); ingestSoon(); });
        if (ET.MESSAGE_EDITED) es.on(ET.MESSAGE_EDITED, () => { resync(); ingestSoon(); });
        // 召回预取：用户消息一落地就开始查（向量要走网络），生成前只等剩下的时间
        if (ET.MESSAGE_SENT) es.on(ET.MESSAGE_SENT, () => { try { prepareRecall(); } catch (err) { warn('召回预取失败：', err); } });
        if (ET.GENERATION_ENDED) es.on(ET.GENERATION_ENDED, () => { lastGenEnd = Date.now(); });
        if (ET.GENERATION_STOPPED) es.on(ET.GENERATION_STOPPED, () => { lastGenEnd = Date.now(); });
    }

    // 控制台排障入口（手机上可配合 Eruda）：eratoMemory_debug.buildBlock() 等
    window.eratoMemory_debug = {
        extractContent, extractRecap, parseJson, buildBlock, buildMessages, reconcile, ingest, summarizeAll, fetchModels,
        getData, counts, uncoveredFloors, retryWindows, planWindows, splitWindow, runWindow, applyWindowResult, checkResult, mergeEntities, backfillPeople, minEventsFor, coverage, floorSpan, spanOf, winFloors,
        raiseTier, promote, setState, heatOf, matchEnt, entFilter,
        visibleDepths, hideSummarized, unhideAll, addManualEntry, migrateV1, settings, run,
        govern, foldCanon, foldOutline, foldPeriods, dayKey, captureRecaps, fallbackLines, contextText,
        keywordRecall, termsOf, recallQuery, prepareRecall, recallForPrompt, doRecall, rc,
        vecSync, vecRebuild, vecTest, vecQuery, vecIndexEntries, vecIndexRaw, chunkText, vecBody, vecCollection, writeVecSecret,
        isTomb, addTomb, removeTomb, restoreTomb, rollbackValues, rollbackOnDelete, undoWindow, normDate, headerLines, hasEndMark, stripEndMark, stopRun, gov, lastInject: () => lastInject,
    };

    jQuery(() => {
        try {
            addSettingsUI();
            addPanel();
            addBall();
            addWandEntries();
            addSlashCommands();
            bindEvents();
            setTimeout(() => { reconcile(); applyInjection(); refreshStatus(); }, 2000);
            log('Erato Memory 已加载');
        } catch (err) {
            console.error('[EratoMemory] 初始化失败', err);
        }
    });
})();
