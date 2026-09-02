// Erato Memory — SillyTavern 第三方扩展
// 为 Erato 预设提供结构化长期记忆：
//   逐楼把正文+recap 交给副 API 摘要成条目 → 存进聊天元数据随聊天文件走
//   → 已总结的旧楼层自动隐藏（可逆），由条目按时间顺序注入回上下文
//
// 扩展跑在打开酒馆页面的浏览器里，手机/电脑都可用；同一酒馆实例两端共享记忆。

(() => {
    const EXT = 'erato-memory';
    const META_KEY = 'eratoMemory';
    const PROMPT_KEY = 'erato_memory';
    const DATA_VERSION = 1;

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

    const DEFAULTS = {
        enabled: true,
        autoIngest: true,
        api: { url: '', key: '', model: '', models: [], temperature: 0.3, maxTokens: 900, timeoutSec: 60 },
        contentWindow: 6,   // 与预设 6🌸 的 minDepth 一致
        injectDepth: 6,
        maxInjectChars: 9000,
        ingestBatch: 20,
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
    for (const key of Object.keys(DEFAULTS)) {
        if (settings[key] === undefined) settings[key] = structuredClone(DEFAULTS[key]);
    }
    for (const group of ['api', 'ball']) {
        if (!settings[group] || typeof settings[group] !== 'object') settings[group] = {};
        for (const key of Object.keys(DEFAULTS[group])) {
            if (settings[group][key] === undefined) settings[group][key] = structuredClone(DEFAULTS[group][key]);
        }
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
            entries: [],
            archives: [],
            canon: { text: '', builtFrom: [], builtAt: 0 },
            skip: {},
            hidden: {},   // 本插件隐藏过的楼层 send_date → true；只恢复自己藏的
            stats: { lastIngestAt: 0, lastError: '', failStreak: 0 },
        };
    }

    function getData() {
        const ctx = getCtx();
        if (!ctx.chatId || !ctx.chatMetadata) return null;
        let d = ctx.chatMetadata[META_KEY];
        if (!d || typeof d !== 'object') d = ctx.chatMetadata[META_KEY] = defaultData();
        const def = defaultData();
        for (const k of Object.keys(def)) if (d[k] === undefined) d[k] = def[k];
        if (!Array.isArray(d.entries)) d.entries = [];
        return d;
    }

    const saveData = () => getCtx().saveMetadataDebounced();

    const sortEntries = data => data.entries.sort((a, b) => (a.src?.idx ?? 0) - (b.src?.idx ?? 0));

    function findEntry(data, m) {
        if (!m?.send_date) return null;
        return data.entries.find(e => e.src?.send_date === m.send_date) || null;
    }

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
    // 不受浏览器跨域限制，不碰主模型连接
    async function callApi(messages, maxTokens) {
        const ctx = getCtx();
        const base = apiBase();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(5, Number(settings.api.timeoutSec) || 60) * 1000);
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
            throw new Error(controller.signal.aborted ? `超时（${settings.api.timeoutSec}s）` : `网络错误：${err.message}`);
        } finally {
            clearTimeout(timer);
        }
        let json;
        try { json = JSON.parse(text); } catch { throw new Error(`后端返回非 JSON：${text.slice(0, 120)}`); }
        if (!res.ok || json.error) {
            const msg = json.error?.message || json.error || json.message || `HTTP ${res.status}`;
            throw new Error(String(msg).slice(0, 200));
        }
        const content = json.choices?.[0]?.message?.content;
        if (!content || !String(content).trim()) throw new Error('空回复');
        return String(content).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    }

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
        !/"summary"\s*:/.test(raw) &&
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
        '你是成人向互动小说的档案员。你的工作是把一段已发生的剧情整理成一条结构化记忆，供后续写作参考。\n' +
        '只输出 JSON，不输出任何其他文字。用中性、克制、事实性的语言，不渲染不评价，性内容按事实记录不省略。';

    // 可在设置「提示词」里改；占位符：{{name1}} {{name2}} {{recent}} {{user_text}} {{content}} {{recap}} {{directive}}
    const DEFAULT_USER_TEMPLATE =
`## 已知主角
用户角色：{{name1}}；对手角色：{{name2}}。其余出场者按原文名字记录。

## 最近三条记忆（供承接因果与去重，不要重复其中已记录的事实）
{{recent}}

## 本楼材料
### 用户的行动（括号内的 OOC 指令不是剧情，忽略）
{{user_text}}

### 正文
{{content}}

### 作者摘要（日期·时段·场景 与 叙述，若有）
{{recap}}

## 输出要求
输出一个 JSON 对象：
{
  "story_time": "沿用作者摘要的『日期 · 时段 · 场景』原文；没有则从正文推断；推断不出写（未知），禁止编造",
  "type": "plot | emotion | intimacy | relationship | setting 之一。setting=新角色登场/世界观揭示/规则确立",
  "title": "≤8字，意象或事件名，不用『之后』『开始』这类空词",
  "summary": "≤120字。以事件为单位写起因→经过→结果，写『为什么』而不只是『做了什么』。可保留1句决定走向的原台词。去掉感官修辞。",
  "characters": ["在场且有行动的人"],
  "emotion_shift": "『角色：A→B』格式，一人一句，无变化留空",
  "known_by": ["知道这件事的角色。若是秘密/信息差，只列知情者；全员在场则留空数组"],
  "tags": ["3-6个检索词：人名/地点/物件/情绪/主题"],
  "intimacy": null 或 {"acts": "行为要点，事实性", "consent": "同意状态与主动方", "firsts": "第一次的事项，没有留空", "aftermath": "事后状态与余波"},
  "related_to": ["最近三条记忆里与本楼有因果关系的 id，没有留空数组"],
  "grade": "S | A | B | C",
  "grade_reason": "≤20字"
}

等级标准（按语义重要度，不按篇幅）：
S = 不可逆事实：死亡/告白成立/关系定名/身份揭露/立誓承诺/任何『第一次』。永不遗忘。
A = 关系转折、重大冲突、重要秘密或信息差的建立、角色重大决定。
B = 推动剧情但可被概括的普通事件。
C = 日常、闲聊、氛围、无后果的互动。
拿不准时降一级，不要升级。{{directive}}`;

    const systemPromptText = () => settings.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
    // 用户模板缺 {{content}} 就不可用，静默退回默认，免得摘要出来全是空
    const userTemplateText = () => {
        const t = settings.promptTemplate || '';
        return t.includes('{{content}}') ? t : DEFAULT_USER_TEMPLATE;
    };

    function buildMessages(input) {
        const ctx = getCtx();
        const vars = {
            name1: ctx.name1 || '{{user}}',
            name2: ctx.name2 || '{{char}}',
            recent: input.recent.length
                ? input.recent.map(e => `[${e.id}] ${e.story_time || '（时间未知）'} | ${e.title} | ${e.summary}`).join('\n')
                : '（无）',
            user_text: input.userText || '（无）',
            content: input.content,
            recap: (input.recap.storyTime || input.recap.narrative)
                ? `${input.recap.storyTime ? input.recap.storyTime + '\n' : ''}${input.recap.narrative}`.trim()
                : '（无）',
            directive: settings.directive?.trim() ? `\n\n## 额外要求\n${settings.directive.trim()}` : '',
        };
        const user = userTemplateText().replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
        return [
            { role: 'system', content: systemPromptText() },
            { role: 'user', content: user },
        ];
    }

    const asArr = v => Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : [];

    function applyResult(e, obj, recap, recent) {
        const summary = String(obj.summary || '').trim();
        if (summary.length < 10) throw new Error('摘要过短或缺失');
        const recentIds = new Set(recent.map(x => x.id));
        e.story_time = String(obj.story_time || '').trim() || recap.storyTime || '';
        if (/^（?未知）?$/.test(e.story_time)) e.story_time = recap.storyTime || '';
        e.type = TYPES.includes(obj.type) ? obj.type : 'plot';
        e.title = String(obj.title || '').trim().slice(0, 12) || '（无题）';
        e.summary = summary;
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

    /* ================= 入库（幂等补齐 / 总结前文） ================= */

    const run = { busy: false, again: false, chatId: null, manual: false, stop: false, done: 0, total: 0, failToasted: false };

    function newEntry() {
        return {
            id: uid('em'), src: {}, story_time: '', type: 'plot', title: '', summary: '',
            characters: [], emotion_shift: '', known_by: [], tags: [], intimacy: null, related_to: [],
            grade: 'B', pinned: false, status: 'pending', attempts: 0, last_error: '',
            model: '', created_at: Date.now(), updated_at: Date.now(),
        };
    }

    // depth≥2 的 AI 楼层才入库：depth 0/1 还可能被 swipe 或重 roll
    function pendingFloors(chat, data) {
        const out = [];
        const ctx = getCtx();
        for (let i = 0; i < chat.length; i++) {
            const m = chat[i];
            if (!isAiFloor(m, ctx)) continue;
            if (chat.length - 1 - i < 2) continue;
            if (data.skip[m.send_date]) continue;
            const e = findEntry(data, m);
            if (!e) { out.push(i); continue; }
            if (e.status === 'stale') { out.push(i); continue; }
            if (['pending', 'failed', 'refused'].includes(e.status) && e.attempts < MAX_ATTEMPTS) out.push(i);
        }
        return out;
    }

    async function ingestFloor(idx) {
        const ctx = getCtx();
        const data = getData();
        const m = ctx.chat[idx];
        if (!m || !data) return;
        const content = extractContent(m.mes);
        const recap = extractRecap(m.mes);
        const prev = ctx.chat[idx - 1];
        const userText = prev?.is_user ? cleanUser(prev.mes) : '';

        let e = findEntry(data, m);
        if (!e) { e = newEntry(); data.entries.push(e); }
        if (e.status === 'stale') e.attempts = 0;
        e.src = { idx, send_date: m.send_date, hash: hash(content.text), fallback: content.fallback, user_idx: userText ? idx - 1 : null };
        e.status = 'pending';
        sortEntries(data);

        if (!content.text) {
            e.status = 'failed'; e.last_error = '正文为空'; e.attempts = MAX_ATTEMPTS;
            return;
        }
        const recent = data.entries.filter(x => x.status === 'ok' && !x.manual && x.src.idx < idx).slice(-3);
        try {
            const raw = await callApi(buildMessages({ userText, content: content.text, recap, recent }));
            const obj = parseJson(raw);
            if (!obj) {
                if (isRefusal(raw)) throw Object.assign(new Error('疑似拒答：' + raw.slice(0, 80)), { refused: true });
                throw new Error('无法解析 JSON：' + raw.slice(0, 80));
            }
            applyResult(e, obj, recap, recent);
            e.status = 'ok'; e.last_error = ''; e.attempts = 0;
            e.model = settings.api.model; e.updated_at = Date.now();
            data.stats.failStreak = 0;
            log('入库', idx, e.grade, e.title);
        } catch (err) {
            e.attempts++;
            e.status = err.refused ? 'refused' : 'failed';
            e.last_error = err.message;
            data.stats.failStreak++;
            data.stats.lastError = err.message;
            warn('楼层', idx, '摘要失败：', err.message);
            if (!run.failToasted) { run.failToasted = true; toast('error', `第 ${idx} 楼摘要失败：${err.message.slice(0, 60)}`); }
        }
    }

    // source: auto / chat_changed / again = 每次最多 ingestBatch 楼，静默；manual = 一次跑到底，带进度，可停
    async function ingest(source = 'auto') {
        if (!settings.enabled) return;
        if (run.busy) { run.again = true; return; }
        const ctx = getCtx();
        const chatId = ctx.chatId;
        const data = getData();
        if (!chatId || !data) return;
        const manual = source === 'manual';

        run.busy = true; run.chatId = chatId; run.again = false; run.manual = manual; run.stop = false; run.done = 0; run.total = 0;
        let done = 0, failed = 0;
        try {
            reconcile();
            let todo = pendingFloors(ctx.chat || [], data);
            if (!manual) todo = todo.slice(0, Math.max(1, Number(settings.ingestBatch) || 20));
            if (!todo.length) return;
            if (!apiConfigured()) {
                if (manual) toast('warning', '请先在设置里填写副 API 地址与密钥');
                return;
            }
            run.total = todo.length;
            log('总结', source, todo.length, '楼');
            refreshStatus();
            for (const idx of todo) {
                if (run.stop || getCtx().chatId !== chatId) break;
                await ingestFloor(idx);
                done++; run.done = done;
                const e = findEntry(data, getCtx().chat[idx]);
                if (e && e.status !== 'ok') failed++;
                saveData();
                refreshStatus();
                if (manual && done % 10 === 0 && done < todo.length) toast('info', `正在总结 ${done}/${todo.length}`);
                await sleep(150);
            }
            data.stats.lastIngestAt = Date.now();
            saveData();
        } catch (err) {
            warn('总结中断：', err);
        } finally {
            const stopped = run.stop;
            run.busy = false; run.manual = false; run.stop = false; run.done = 0; run.total = 0;
            if (getCtx().chatId === chatId) {
                const hid = hideSummarized();
                applyInjection(); renderPanel(); refreshStatus();
                if (manual) {
                    if (!done) toast('info', '没有需要总结的楼层');
                    else toast(failed ? 'warning' : 'success',
                        `${stopped ? '已停止，' : ''}已总结 ${done - failed} 楼${failed ? `，${failed} 楼失败` : ''}${hid ? `，隐藏 ${hid} 条消息` : ''}，注入 ≈ ${lastInject.chars} 字`);
                }
            }
            if (run.again) { run.again = false; setTimeout(() => ingest('again'), 500); }
        }
    }

    // 「总结前文」入口：确认楼数后跑到底
    async function summarizeAll() {
        const data = getData();
        if (!data) return toast('warning', '当前没有打开聊天');
        if (run.busy) { run.stop = true; toast('info', '正在停止…'); return; }
        if (!settings.enabled) return toast('warning', '插件已禁用，请先在设置里启用');
        if (!apiConfigured()) { togglePanel(true, 'cfg'); return toast('warning', '请先填写副 API 地址与密钥'); }
        reconcile();
        const n = pendingFloors(getCtx().chat || [], data).length;
        if (!n) return toast('info', '没有需要总结的楼层');
        if (!await confirmBox(`将总结 ${n} 楼，每楼调用一次副 API。继续？`)) return;
        ingest('manual');
    }

    // 对账：删楼 → 孤立；编辑正文 → 过期；分支/检查点 → 越界条目孤立；手动条目只校正楼层号
    function reconcile() {
        const ctx = getCtx();
        const data = getData();
        if (!data) return;
        const chat = ctx.chat || [];
        const byDate = new Map();
        chat.forEach((m, i) => { if (m && !m.is_user && m.send_date) byDate.set(m.send_date, i); });
        let changed = false;
        for (const e of data.entries) {
            if (e.manual) {
                const max = Math.max(0, chat.length - 1);
                if ((e.src?.idx ?? 0) > max) { e.src.idx = max; changed = true; }
                continue;
            }
            const i = byDate.get(e.src?.send_date);
            if (i === undefined) {
                if (e.status !== 'orphan') { e.status = 'orphan'; changed = true; }
                continue;
            }
            if (e.src.idx !== i) { e.src.idx = i; changed = true; }
            if (['pending', 'failed', 'refused'].includes(e.status)) continue;
            const h = hash(extractContent(chat[i].mes).text);
            if (h !== e.src.hash) {
                if (e.status !== 'stale') { e.status = 'stale'; changed = true; }
            } else if (e.status === 'orphan') {
                e.status = e.summary ? 'ok' : 'pending'; changed = true;
            }
        }
        if (changed) { sortEntries(data); saveData(); }
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
        const okDates = new Set(data.entries.filter(e => e.status === 'ok' && !e.manual && e.src?.send_date).map(e => e.src.send_date));
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

    let lastInject = { text: '', count: 0, chars: 0, dropped: 0 };

    function weight(e, len) {
        const age = Math.max(0, len - 1 - (e.src?.idx ?? 0));
        return GRADE_BASE[e.grade] * Math.pow(0.5, age / GRADE_HALFLIFE[e.grade]);
    }

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

    function buildBlock() {
        const ctx = getCtx();
        const data = getData();
        const chat = ctx.chat || [];
        const len = chat.length;
        if (!data) return { text: '', count: 0, chars: 0, dropped: 0 };
        const depths = visibleDepths(chat);
        const list = data.entries.filter(e => e.status === 'ok' && injectable(e, depths));
        const canon = list.filter(e => e.grade === 'S' || e.pinned);
        const past = list.filter(e => !(e.grade === 'S' || e.pinned));
        const budget = Number(settings.maxInjectChars) || 9000;
        const size = () => canon.reduce((n, e) => n + fmtEntry(e).length, 0) + past.reduce((n, e) => n + fmtEntry(e, true).length, 0);
        let dropped = 0;
        while (past.length && size() > budget) {
            let k = -1, kw = Infinity;
            past.forEach((e, i) => { if (e.grade === 'A') return; const w = weight(e, len); if (w < kw) { kw = w; k = i; } });
            if (k < 0) k = past.findIndex(e => e.grade === 'A');
            if (k < 0) break;
            past.splice(k, 1); dropped++;
        }
        const count = canon.length + past.length;
        if (!count) return { text: '', count: 0, chars: 0, dropped };
        const parts = [
            '<erato_memory>',
            '[长期记忆 · 由记忆插件维护 · 覆盖最近三回合之前的全部剧情，按时间顺序]',
            '[仅作为已发生事实使用：不复述、不总结、不预告；信息差按「知情」栏执行，未列名者不知情]',
        ];
        if (canon.length) parts.push('', '## 正典', ...canon.map(e => fmtEntry(e, false)));
        if (past.length) parts.push('', '## 往事', ...past.map(e => fmtEntry(e, true)));
        parts.push('</erato_memory>');
        const text = parts.join('\n');
        return { text, count, chars: text.length, dropped };
    }

    function applyInjection() {
        const ctx = getCtx();
        const depth = Number(settings.injectDepth) || 6;
        if (!settings.enabled || !ctx.chatId) {
            ctx.setExtensionPrompt(PROMPT_KEY, '', IN_CHAT, depth, false, ROLE_SYSTEM);
            lastInject = { text: '', count: 0, chars: 0, dropped: 0 };
            return;
        }
        const b = buildBlock();
        lastInject = b;
        ctx.setExtensionPrompt(PROMPT_KEY, b.count ? b.text : '', IN_CHAT, depth, false, ROLE_SYSTEM);
        log('注入', b.count, '条', b.chars, '字', b.dropped ? `裁掉 ${b.dropped}` : '');
    }

    // 生成前拦截器（manifest.generate_interceptor）：零网络，只做对账与格式化
    window.eratoMemory_intercept = async (chat, contextSize, abort, type) => {
        if (type === 'quiet') return;
        try { reconcile(); applyInjection(); } catch (err) { warn('拦截器异常：', err); }
    };

    /* ================= 状态 ================= */

    function counts() {
        const data = getData();
        const c = { total: 0, ok: 0, pending: 0, failed: 0, refused: 0, stale: 0, orphan: 0, todo: 0, hidden: 0 };
        if (!data) return c;
        for (const e of data.entries) { c.total++; if (c[e.status] !== undefined) c[e.status]++; }
        const chat = getCtx().chat || [];
        c.todo = pendingFloors(chat, data).length;
        for (const m of chat) if (m?.is_system && m.send_date && data.hidden[m.send_date]) c.hidden++;
        return c;
    }

    function refreshStatus() {
        const c = counts();
        const bad = c.failed + c.refused;
        const injectLine = `本轮注入 ${lastInject.count} 条 ≈ ${lastInject.chars} 字${lastInject.dropped ? `（预算裁掉 ${lastInject.dropped}）` : ''}`;
        $('.em-status').text(`已总结 ${c.ok} · 待总结 ${c.todo} · 失败 ${bad} · 孤立 ${c.orphan} · 已隐藏 ${c.hidden} · ${injectLine}`);

        $('#em_n_ok').text(c.ok); $('#em_n_todo').text(c.todo); $('#em_n_hidden').text(c.hidden); $('#em_n_bad').text(bad);
        $('#em_tile_bad').toggle(bad > 0);
        $('#em_inject_line').text(injectLine);

        const main = $('#em_main');
        if (run.busy && run.manual) main.text(`停止（${run.done}/${run.total}）`).addClass('em-stop');
        else main.text(c.todo ? `总结前文（${c.todo} 楼）` : '总结前文').removeClass('em-stop');
        const prog = $('#em_progress');
        if (run.busy && run.total) {
            prog.show().find('.em-bar').css('width', `${Math.round(run.done / run.total * 100)}%`);
            prog.find('.em-prog-txt').text(`正在总结 ${run.done}/${run.total}`);
        } else prog.hide();

        const suffix = run.busy ? ' · 处理中' : bad ? ` · ${bad} 条失败` : '';
        $('#em_wand_txt').text(`记忆面板${suffix}`);
        $('#em_wand_sum_txt').text(run.busy ? `总结前文 · ${run.done}/${run.total || '?'}` : c.todo ? `总结前文 · 尚有 ${c.todo} 楼` : '总结前文 · 已全部总结');
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

    // 输入框左侧魔杖菜单：记忆面板（带状态）+ 总结前文（不开面板直接跑）
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
            <span id="em_wand_sum_txt">总结前文</span>
        </div>`);
        menu.append(panelItem, sumItem);
        panelItem.on('click', () => togglePanel(true));
        sumItem.on('click', () => summarizeAll());
    }

    /* ================= 设置表单（面板内覆盖层） ================= */

    function settingsFormHtml() {
        return `
        <div class="em-form">
            <div class="em-sec">总结</div>
            <label class="checkbox_label"><input type="checkbox" id="em_enabled"><span>启用记忆（关掉后悬浮球与注入一并停用）</span></label>
            <label class="checkbox_label"><input type="checkbox" id="em_auto"><span>聊天进行中自动总结新楼层（关掉则只手动「总结前文」）</span></label>
            <label class="checkbox_label"><input type="checkbox" id="em_hide"><span>总结完成后隐藏已总结楼层（可逆，「更多 → 取消隐藏」恢复）</span></label>
            <div class="em-row">
                <label>保留可见楼数 <input id="em_keep" class="text_pole" type="number" min="2" max="40" title="从最新一条往前数，这么多条消息不隐藏；6 = 三回合"></label>
                <label>自动模式单次楼数 <input id="em_batch" class="text_pole" type="number" min="1" max="200"></label>
            </div>
            <div class="em-row">
                <label>正文窗口 <input id="em_window" class="text_pole" type="number" min="2" max="40" title="可见楼层里深度不足此数的不注入（与预设 6🌸 的 minDepth 一致）"></label>
                <label>注入深度 <input id="em_depth" class="text_pole" type="number" min="0" max="40"></label>
                <label>注入上限(字) <input id="em_maxchars" class="text_pole" type="number" min="1000" step="500"></label>
            </div>
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
            <label>摘要模板（留空用默认；必须含 {{content}}，其余占位符：{{name1}} {{name2}} {{recent}} {{user_text}} {{recap}} {{directive}}）<textarea id="em_tpl" class="text_pole" rows="8"></textarea></label>
            <div class="em-row">
                <div class="menu_button" id="em_tpl_fill">把默认模板填进来改</div>
                <div class="menu_button" id="em_tpl_reset">恢复默认</div>
            </div>
            <hr>
            <div class="em-sec">调试</div>
            <label class="checkbox_label"><input type="checkbox" id="em_debug"><span>控制台调试日志</span></label>
            <div class="em-hint">斜杠命令：/em-panel 开面板 · /em-summarize 总结前文 · /em-pin 楼层号 钉/取消钉 · /em-note 文字 手动记一条</div>
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
        $('#em_auto').prop('checked', settings.autoIngest).on('change', function () {
            settings.autoIngest = this.checked; saveSettings();
        });
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
        bindNum('#em_batch', 'ingestBatch');
        bindNum('#em_keep', 'keepVisible', () => { $('#em_keep_q').val(settings.keepVisible); if (settings.hideSummarized) { hideSummarized(); applyInjection(); refreshStatus(); } });

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
            if (this.value.trim() && !this.value.includes('{{content}}')) toast('warning', '模板缺少 {{content}}，摘要时会退回默认模板');
        });
        $('#em_tpl_fill').on('click', () => { $('#em_tpl').val(DEFAULT_USER_TEMPLATE); settings.promptTemplate = DEFAULT_USER_TEMPLATE; saveSettings(); });
        $('#em_tpl_reset').on('click', () => { $('#em_tpl').val(''); $('#em_sys_prompt').val(''); settings.promptTemplate = ''; settings.systemPrompt = ''; saveSettings(); toast('info', '已恢复默认提示词'); });
        $('#em_debug').prop('checked', settings.debug).on('change', function () { settings.debug = this.checked; saveSettings(); });
        $('#em_test').on('click', async function () {
            if (!apiConfigured()) return toast('warning', '请先填写副 API 地址与密钥');
            if (!settings.api.model?.trim()) toast('warning', '未指定模型，将由接口默认模型响应');
            const btn = $(this).addClass('disabled').text('测试中…');
            try {
                const r = await callApi([{ role: 'user', content: '请只回复「连接成功」四个字。' }], 50);
                toast('success', `副 API 可用：${r.slice(0, 60)}`);
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
                    <div class="em-hint">入口：屏幕上的悬浮球，或输入框左侧魔杖菜单里的「记忆面板 / 总结前文」。副 API、隐藏楼层、悬浮球样式等都在面板的设置页。</div>
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
    const sections = { timeline: true, preview: false };

    function addPanel() {
        const html = `
        <div id="em_panel" class="em-panel" style="display:none">
            <div class="em-head">
                <div id="em_back" class="em-back fa-solid fa-chevron-left interactable" tabindex="0" style="display:none"></div>
                <div class="em-title"><span id="em_head_title">🧠 记忆</span></div>
                <div id="em_close" class="em-close fa-solid fa-xmark interactable" tabindex="0"></div>
            </div>
            <div id="em_view_mem" class="em-view">
                <div class="em-stats">
                    <div class="em-tile"><div class="em-num" id="em_n_ok">0</div><div class="em-lbl">已总结楼层</div></div>
                    <div class="em-tile"><div class="em-num" id="em_n_todo">0</div><div class="em-lbl">待总结</div></div>
                    <div class="em-tile"><div class="em-num" id="em_n_hidden">0</div><div class="em-lbl">已隐藏消息</div></div>
                    <div class="em-tile em-tile-bad" id="em_tile_bad" style="display:none"><div class="em-num" id="em_n_bad">0</div><div class="em-lbl">失败</div></div>
                </div>
                <div class="em-inject-line" id="em_inject_line"></div>
                <div class="em-actbar">
                    <div class="menu_button em-main" id="em_main">总结前文</div>
                    <div class="em-hide-q">
                        <label class="checkbox_label"><input type="checkbox" id="em_hide_q"><span>隐藏已总结 · 保留</span></label>
                        <input id="em_keep_q" class="text_pole em-keep-q" type="number" min="2" max="40"><span>楼</span>
                    </div>
                    <div class="menu_button" id="em_more">更多 ▾</div>
                </div>
                <div id="em_more_menu" class="em-menu" style="display:none">
                    <div class="em-menu-item" data-act="add">手动新增一条记忆</div>
                    <div class="em-menu-item" data-act="retry">重试失败的楼层</div>
                    <div class="em-menu-item" data-act="unhide">取消隐藏（恢复本插件藏起来的楼层）</div>
                    <div class="em-menu-item" data-act="export">导出 JSON</div>
                    <div class="em-menu-item" data-act="import">导入 JSON</div>
                    <div class="em-menu-item" data-act="cfg">设置</div>
                    <div class="em-menu-item em-danger" data-act="clear">清空本聊天的记忆</div>
                    <input type="file" id="em_import_file" accept="application/json" hidden>
                </div>
                <div id="em_progress" class="em-progress" style="display:none"><div class="em-bar"></div><div class="em-prog-txt"></div></div>
                <div id="em_alert" class="em-alert" style="display:none"></div>

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
                    <div class="em-sec-body"><pre id="em_preview" class="em-preview"></pre></div>
                </div>
            </div>
            <div id="em_view_cfg" class="em-view em-cfg" style="display:none">
                ${settingsFormHtml()}
            </div>
        </div>`;
        $('body').append(html);

        $('#em_close').on('click', () => togglePanel(false));
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

        $('#em_manual_form').on('click', '[data-mact]', function () { manualFormAction($(this).data('mact')); });

        const list = $('#em_list');
        list.on('click', '.em-card-head', function () {
            const id = $(this).closest('.em-card').data('id');
            expanded.has(id) ? expanded.delete(id) : expanded.add(id);
            renderPanel();
        });
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

    // 未配副 API 且还没有条目时，打开面板直接落到设置页
    function togglePanel(force, tab) {
        panelOpen = force === undefined ? !panelOpen : !!force;
        $('#em_panel').toggle(panelOpen);
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

    function cardHtml(e, depths) {
        const open = expanded.has(e.id);
        const badges = [];
        if (STATUS_LABEL[e.status]) badges.push(`<span class="em-badge em-st-${e.status}">${STATUS_LABEL[e.status]}</span>`);
        if (e.manual) badges.push('<span class="em-badge em-st-manual">手动</span>');
        if (e.src?.fallback) badges.push('<span class="em-badge em-st-fallback">兜底抠取</span>');
        if (e.status === 'ok' && !injectable(e, depths)) badges.push('<span class="em-badge em-st-window">窗口内·未注入</span>');
        if (e.pinned) badges.push('<span class="em-badge em-st-pinned">📌</span>');
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
                ${e.last_error ? `<div class="em-sub em-err">错误：${esc(e.last_error)}（已试 ${e.attempts} 次）</div>` : ''}
                <div class="em-actions">
                    <div class="menu_button" data-eact="save">保存</div>
                    ${e.manual ? '' : '<div class="menu_button" data-eact="resum">重摘要</div>'}
                    <div class="menu_button" data-eact="jump">跳到该楼</div>
                    ${e.manual ? '' : '<div class="menu_button" data-eact="skip">该楼不入库</div>'}
                    <div class="menu_button em-danger" data-eact="del">删除</div>
                </div>
            </div>` : '';
        return `
        <div class="em-card em-g-${e.grade} ${e.status !== 'ok' ? 'em-dim' : ''}" data-id="${e.id}">
            <div class="em-card-head">
                <div class="em-grade" title="点按改等级，长按钉/取消钉">${e.grade}</div>
                <div class="em-card-main">
                    <div class="em-ttl-row"><span class="em-ttl">${esc(e.title || '（未摘要）')}</span><span class="em-time">${esc(e.story_time || '（时间未知）')}</span></div>
                    ${!open ? `<div class="em-sum">${esc(e.summary || e.last_error || '…')}</div>` : ''}
                    <div class="em-meta">
                        ${e.characters?.length ? `<span>人物：${esc(e.characters.join('、'))}</span>` : ''}
                        ${e.tags?.length ? `<span class="em-tags">${esc(e.tags.slice(0, 4).join(' · '))}</span>` : ''}
                        <span>${TYPE_LABEL[e.type] || e.type}</span>
                        ${badges.join('')}
                        <span class="em-floor">#${e.src?.idx ?? '?'}${hiddenMark}</span>
                    </div>
                </div>
            </div>
            ${body}
        </div>`;
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
        if (!data) { list.html('<div class="em-empty">当前没有打开聊天</div>'); form.hide(); $('#em_preview').text(''); return; }
        const chat = getCtx().chat || [];
        const depths = visibleDepths(chat);
        const items = data.entries.filter(matchFilter).slice().reverse();
        if (items.length) {
            list.html(items.map(e => cardHtml(e, depths)).join(''));
        } else {
            const todo = pendingFloors(chat, data).length;
            const hasFilter = filter.grade || filter.type || filter.status || filter.q;
            list.html(`<div class="em-empty">${hasFilter ? '没有符合筛选的条目'
                : todo ? `本聊天有 ${todo} 楼尚未总结，点上方「总结前文」开始`
                    : data.entries.length ? '没有条目' : '还没有记忆。聊到第 4 楼后会自动开始总结，或点上方「总结前文」'}</div>`);
        }
        if (addingManual) form.show().html(manualFormHtml()); else form.hide().empty();

        $('#em_preview').text(lastInject.text || '（本轮没有可注入的条目）');

        const c = counts();
        const alert = $('#em_alert');
        const bad = c.failed + c.refused;
        if (bad) {
            alert.show().text(`${bad} 楼摘要失败（其中拒答 ${c.refused}）${data.stats.lastError ? '：' + data.stats.lastError : ''}。展开条目可看原因，「更多 → 重试失败」可重跑`);
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
            if (e.status === 'failed' || e.status === 'refused') e.status = e.summary.length >= 10 ? 'ok' : e.status;
            e.updated_at = Date.now();
            saveData(); applyInjection(); expanded.delete(id); renderPanel();
            toast('success', '已保存');
        } else if (act === 'resum') {
            if (!apiConfigured()) return toast('warning', '请先配置副 API');
            const ctx = getCtx();
            const i = (ctx.chat || []).findIndex(m => m && m.send_date === e.src?.send_date);
            if (i < 0) return toast('error', '找不到对应楼层');
            toast('info', `正在重摘要 #${i} 楼…`);
            e.status = 'stale'; e.attempts = 0;
            await ingestFloor(i);
            saveData(); applyInjection(); renderPanel(); refreshStatus();
            toast(e.status === 'ok' ? 'success' : 'error', e.status === 'ok' ? '重摘要完成' : `失败：${e.last_error}`);
        } else if (act === 'jump') {
            const el = document.querySelector(`#chat .mes[mesid="${e.src?.idx}"]`);
            if (!el) return toast('warning', '该楼不在当前视图');
            togglePanel(false); el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else if (act === 'skip') {
            if (!await confirmBox('把这一楼标记为「不入库」并删除其条目？')) return;
            if (e.src?.send_date) data.skip[e.src.send_date] = true;
            data.entries = data.entries.filter(x => x.id !== id);
            saveData(); applyInjection(); renderPanel(); refreshStatus();
        } else if (act === 'del') {
            if (!await confirmBox(e.manual ? '删除这条手动记忆？' : '删除这条记忆？该楼下次总结时会重新入库（除非标记不入库）')) return;
            data.entries = data.entries.filter(x => x.id !== id);
            saveData(); applyInjection(); renderPanel(); refreshStatus();
        }
    }

    async function panelAction(act) {
        const data = getData();
        if (act === 'cfg') return showTab('cfg');
        if (!data) return toast('warning', '当前没有打开聊天');
        if (act === 'add') { addingManual = true; sections.timeline = true; applySections(); renderPanel(); }
        else if (act === 'retry') {
            let n = 0;
            for (const e of data.entries) if (['failed', 'refused'].includes(e.status)) { e.attempts = 0; n++; }
            saveData();
            if (!n) return toast('info', '没有失败条目');
            run.failToasted = false;
            ingest('manual');
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
            if (!await confirmBox(`清空当前聊天的全部 ${data.entries.length} 条记忆？不可恢复（建议先导出）。本插件隐藏的楼层会一并恢复显示`)) return;
            unhideAll();
            getCtx().chatMetadata[META_KEY] = defaultData();
            saveData(); applyInjection(); renderPanel(); refreshStatus();
        }
    }

    function importFile() {
        const file = this.files?.[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                const obj = JSON.parse(String(reader.result));
                const src = obj?.data?.entries ? obj.data : obj;
                if (!Array.isArray(src?.entries)) throw new Error('文件里没有 entries');
                const data = getData();
                const mode = data.entries.length
                    ? (await confirmBox(`当前已有 ${data.entries.length} 条。确定=替换，取消=合并（按楼层去重）`) ? 'replace' : 'merge')
                    : 'replace';
                if (mode === 'replace') {
                    data.entries = src.entries; data.skip = src.skip || {}; data.archives = src.archives || []; data.hidden = src.hidden || {};
                } else {
                    const have = new Set(data.entries.map(e => e.src?.send_date));
                    for (const e of src.entries) if (!have.has(e.src?.send_date)) data.entries.push(e);
                }
                sortEntries(data); reconcile(); saveData(); applyInjection(); renderPanel(); refreshStatus();
                toast('success', `已导入，现有 ${data.entries.length} 条`);
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
        reg('em-summarize', () => { summarizeAll(); return ''; }, '总结前文：把所有未总结的楼层入库');
        reg('em-pin', (args, value) => {
            const data = getData(); if (!data) return '没有打开聊天';
            const idx = Number(String(value || '').trim());
            if (!Number.isInteger(idx)) return '用法：/em-pin 楼层号';
            const e = data.entries.find(x => !x.manual && x.src?.idx === idx);
            if (!e) return `第 ${idx} 楼还没有记忆条目`;
            return togglePin(e.id) ? `已钉第 ${idx} 楼为 S` : `已取消钉第 ${idx} 楼`;
        }, '钉/取消钉某楼的记忆为 S：/em-pin 楼层号');
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
        const ingestSoon = debounce(() => { if (settings.autoIngest) ingest('auto'); }, 800);
        const resync = () => { reconcile(); applyInjection(); renderPanel(); refreshStatus(); };

        es.on(ET.CHAT_CHANGED, () => {
            expanded.clear(); addingManual = false; run.stop = true; run.failToasted = false;
            setTimeout(() => { resync(); if (settings.autoIngest) ingest('chat_changed'); }, 1500);
        });
        es.on(ET.MESSAGE_RECEIVED, ingestSoon);
        es.on(ET.MESSAGE_DELETED, resync);
        es.on(ET.MESSAGE_UPDATED, () => { resync(); ingestSoon(); });
        if (ET.MESSAGE_EDITED) es.on(ET.MESSAGE_EDITED, () => { resync(); ingestSoon(); });
    }

    // 控制台排障入口（手机上可配合 Eruda）：eratoMemory_debug.buildBlock() 等
    window.eratoMemory_debug = {
        extractContent, extractRecap, parseJson, buildBlock, buildMessages, reconcile, ingest, summarizeAll, fetchModels,
        getData, counts, pendingFloors, visibleDepths, hideSummarized, unhideAll, addManualEntry, settings,
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
