// Erato Memory — SillyTavern 第三方扩展
// 为 Erato 预设提供结构化长期记忆：
//   逐楼把正文+recap 交给副 API 摘要成条目 → 存进聊天元数据随聊天文件走
//   → 被预设窗口正则剥掉正文的楼层，由条目按时间顺序注入回上下文
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
        directive: '',
        debug: false,
    };

    const getCtx = () => SillyTavern.getContext();

    const ctx0 = getCtx();
    if (!ctx0.extensionSettings[EXT]) ctx0.extensionSettings[EXT] = {};
    const settings = ctx0.extensionSettings[EXT];
    for (const key of Object.keys(DEFAULTS)) {
        if (settings[key] === undefined) settings[key] = structuredClone(DEFAULTS[key]);
    }
    for (const key of Object.keys(DEFAULTS.api)) {
        if (settings.api[key] === undefined) settings.api[key] = structuredClone(DEFAULTS.api[key]);
    }
    const saveSettings = () => getCtx().saveSettingsDebounced();

    /* ================= 工具 ================= */

    const log = (...a) => { if (settings.debug) console.log('[EratoMemory]', ...a); };
    const warn = (...a) => console.warn('[EratoMemory]', ...a);
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const uid = p => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const sleep = ms => new Promise(r => setTimeout(r, ms));

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

    const SYSTEM_PROMPT =
        '你是成人向互动小说的档案员。你的工作是把一段已发生的剧情整理成一条结构化记忆，供后续写作参考。\n' +
        '只输出 JSON，不输出任何其他文字。用中性、克制、事实性的语言，不渲染不评价，性内容按事实记录不省略。';

    function buildMessages(input) {
        const ctx = getCtx();
        const recent = input.recent.length
            ? input.recent.map(e => `[${e.id}] ${e.story_time || '（时间未知）'} | ${e.title} | ${e.summary}`).join('\n')
            : '（无）';
        const recapText = (input.recap.storyTime || input.recap.narrative)
            ? `${input.recap.storyTime ? input.recap.storyTime + '\n' : ''}${input.recap.narrative}`.trim()
            : '（无）';
        const user =
`## 已知主角
用户角色：${ctx.name1 || '{{user}}'}；对手角色：${ctx.name2 || '{{char}}'}。其余出场者按原文名字记录。

## 最近三条记忆（供承接因果与去重，不要重复其中已记录的事实）
${recent}

## 本楼材料
### 用户的行动（括号内的 OOC 指令不是剧情，忽略）
${input.userText || '（无）'}

### 正文
${input.content}

### 作者摘要（日期·时段·场景 与 叙述，若有）
${recapText}

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
拿不准时降一级，不要升级。${settings.directive?.trim() ? `\n\n## 额外要求\n${settings.directive.trim()}` : ''}`;
        return [
            { role: 'system', content: SYSTEM_PROMPT },
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

    /* ================= 入库（幂等补齐） ================= */

    const run = { busy: false, again: false, chatId: null };

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
        for (let i = 0; i < chat.length; i++) {
            const m = chat[i];
            if (!m || m.is_user || m.is_system) continue;
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
        const recent = data.entries.filter(x => x.status === 'ok' && x.src.idx < idx).slice(-3);
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
        }
    }

    async function ingest(source = 'auto') {
        if (!settings.enabled) return;
        if (run.busy) { run.again = true; return; }
        const ctx = getCtx();
        const chatId = ctx.chatId;
        const data = getData();
        if (!chatId || !data) return;

        run.busy = true; run.chatId = chatId; run.again = false;
        let done = 0;
        try {
            reconcile();
            const todo = pendingFloors(ctx.chat || [], data).slice(0, Math.max(1, Number(settings.ingestBatch) || 20));
            if (!todo.length) return;
            if (!apiConfigured()) {
                if (source === 'manual') toast('warning', '请先在扩展设置里填写副 API 地址与密钥');
                return;
            }
            log('补齐', source, todo.length, '楼');
            for (const idx of todo) {
                if (getCtx().chatId !== chatId) break;
                await ingestFloor(idx);
                done++;
                saveData();
                refreshStatus();
                await sleep(150);
            }
            data.stats.lastIngestAt = Date.now();
            saveData();
        } catch (err) {
            warn('补齐中断：', err);
        } finally {
            run.busy = false;
            if (getCtx().chatId === chatId) { applyInjection(); renderPanel(); refreshStatus(); }
            if (source === 'manual') toast('info', done ? `已处理 ${done} 楼` : '没有需要入库的楼层');
            if (run.again) { run.again = false; setTimeout(() => ingest('again'), 500); }
        }
    }

    // 对账：删楼 → 孤立；编辑正文 → 过期；分支/检查点 → 越界条目孤立
    function reconcile() {
        const ctx = getCtx();
        const data = getData();
        if (!data) return;
        const chat = ctx.chat || [];
        const byDate = new Map();
        chat.forEach((m, i) => { if (m && !m.is_user && m.send_date) byDate.set(m.send_date, i); });
        let changed = false;
        for (const e of data.entries) {
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

    /* ================= 注入 ================= */

    let lastInject = { count: 0, chars: 0, dropped: 0 };

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
        const limit = len - 1 - (Number(settings.contentWindow) || 6);
        const list = data.entries.filter(e => e.status === 'ok' && (e.src?.idx ?? Infinity) <= limit);
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
            lastInject = { count: 0, chars: 0, dropped: 0 };
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

    /* ================= 状态与顶栏图标 ================= */

    function counts() {
        const data = getData();
        const c = { total: 0, ok: 0, pending: 0, failed: 0, refused: 0, stale: 0, orphan: 0 };
        if (!data) return c;
        for (const e of data.entries) { c.total++; if (c[e.status] !== undefined) c[e.status]++; }
        return c;
    }

    function refreshStatus() {
        const c = counts();
        const s = `已入库 ${c.ok} · 待处理 ${c.pending + c.stale} · 失败 ${c.failed + c.refused} · 孤立 ${c.orphan} · 本轮注入 ${lastInject.count} 条 ≈ ${lastInject.chars} 字${lastInject.dropped ? `（裁掉 ${lastInject.dropped}）` : ''}`;
        $('.em-status').text(s);
        $('#em_stat').text(`${c.ok}/${c.total}`);
        const icon = $('#em_icon');
        if (icon.length) {
            icon.toggleClass('em-off', !settings.enabled);
            icon.toggleClass('em-busy', run.busy);
            icon.toggleClass('em-warn', !run.busy && (c.failed + c.refused) > 0);
            icon.attr('title', `Erato Memory：${settings.enabled ? s : '已禁用'}`);
        }
    }

    // 顶栏图标：不挂 .drawer-toggle，免得酒馆的抽屉点击处理器抢事件（本扩展没有 drawer-content）
    function addTopIcon() {
        const holder = $('#top-settings-holder');
        if (!holder.length) return;
        const drawer = $(`
        <div id="em_drawer" class="drawer">
            <div class="em-toggle">
                <div id="em_icon" class="drawer-icon fa-solid fa-brain fa-fw closedIcon interactable" tabindex="0" title="Erato Memory"></div>
            </div>
        </div>`);
        const rightNav = holder.children('#rightNavHolder');
        rightNav.length ? rightNav.before(drawer) : holder.append(drawer);
        $('#em_icon').on('click', ev => { ev.stopPropagation(); ev.preventDefault(); togglePanel(); });
        $('#em_icon').on('contextmenu', e => e.preventDefault());
    }

    // 输入框左侧魔杖菜单里的入口，手机上比顶栏好点
    function addWandEntry() {
        const menu = $('#extensionsMenu');
        if (!menu.length) return;
        const item = $(`
        <div id="em_wand" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
            <div class="fa-solid fa-brain extensionsMenuExtensionButton"></div>
            <span>记忆面板</span>
        </div>`);
        menu.append(item);
        item.on('click', () => togglePanel(true));
    }

    /* ================= 设置表单（放在面板「设置」页；扩展设置抽屉只留开关和入口） ================= */

    function settingsFormHtml() {
        return `
        <div class="em-form">
            <label class="checkbox_label"><input type="checkbox" id="em_enabled"><span>启用记忆</span></label>
            <label class="checkbox_label"><input type="checkbox" id="em_auto"><span>自动入库（关掉则只在「记忆」页手动补齐）</span></label>
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
            <div class="em-sec">窗口与注入</div>
            <div class="em-row">
                <label>正文窗口 <input id="em_window" class="text_pole" type="number" min="2" max="40" title="与预设 6🌸 的 minDepth 保持一致"></label>
                <label>注入深度 <input id="em_depth" class="text_pole" type="number" min="0" max="40"></label>
                <label>注入上限(字) <input id="em_maxchars" class="text_pole" type="number" min="1000" step="500"></label>
                <label>单次补齐楼数 <input id="em_batch" class="text_pole" type="number" min="1" max="200"></label>
            </div>
            <div class="em-sec">记忆导演指令</div>
            <div class="em-hint">附加到每次摘要，可空</div>
            <textarea id="em_directive" class="text_pole" rows="3" placeholder="例：重点记录承诺与信息差"></textarea>
            <label class="checkbox_label"><input type="checkbox" id="em_debug"><span>控制台调试日志</span></label>
            <hr>
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

    function bindSettingsForm() {
        $('#em_enabled').prop('checked', settings.enabled).on('change', function () {
            settings.enabled = this.checked; saveSettings();
            $('#em_enabled_d').prop('checked', settings.enabled);
            applyInjection(); refreshStatus();
        });
        $('#em_auto').prop('checked', settings.autoIngest).on('change', function () {
            settings.autoIngest = this.checked; saveSettings();
        });
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
        bindNum('#em_window', 'contentWindow', applyInjection);
        bindNum('#em_depth', 'injectDepth', applyInjection);
        bindNum('#em_maxchars', 'maxInjectChars', applyInjection);
        bindNum('#em_batch', 'ingestBatch');
        $('#em_directive').val(settings.directive).on('change', function () { settings.directive = this.value; saveSettings(); });
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
                    <div class="em-hint">副 API、模型选择、窗口与注入等设置都在记忆面板的「设置」页里；顶栏 🧠 图标或魔杖菜单「记忆面板」也可打开。</div>
                    <div class="em-row">
                        <div class="menu_button" id="em_open">打开记忆面板</div>
                        <div class="menu_button" id="em_open_cfg">副 API 设置</div>
                    </div>
                    <div class="em-status"></div>
                </div>
            </div>
        </div>`;
        $('#extensions_settings2').append(html);

        $('#em_enabled_d').prop('checked', settings.enabled).on('change', function () {
            settings.enabled = this.checked; saveSettings();
            $('#em_enabled').prop('checked', settings.enabled);
            applyInjection(); refreshStatus();
        });
        $('#em_open').on('click', () => togglePanel(true, 'mem'));
        $('#em_open_cfg').on('click', () => togglePanel(true, 'cfg'));
    }

    /* ================= 记忆面板 ================= */

    let panelOpen = false;
    let panelTab = 'mem';
    const expanded = new Set();
    const filter = { grade: '', type: '', status: '', q: '' };

    function addPanel() {
        const html = `
        <div id="em_panel" class="em-panel" style="display:none">
            <div class="em-head">
                <div class="em-title">🧠 Erato Memory <span id="em_stat" class="em-stat"></span></div>
                <div class="em-tabs">
                    <div class="em-tab active" data-tab="mem">记忆</div>
                    <div class="em-tab" data-tab="cfg">设置</div>
                </div>
                <div id="em_close" class="em-close fa-solid fa-xmark interactable" tabindex="0"></div>
            </div>
            <div id="em_tab_mem" class="em-tabpane">
                <div id="em_alert" class="em-alert" style="display:none"></div>
                <div class="em-filters">
                    <select id="em_f_grade"><option value="">全部等级</option>${GRADES.map(g => `<option value="${g}">${g}</option>`).join('')}</select>
                    <select id="em_f_type"><option value="">全部类型</option>${TYPES.map(t => `<option value="${t}">${TYPE_LABEL[t]}</option>`).join('')}</select>
                    <select id="em_f_status">
                        <option value="">全部状态</option>
                        <option value="ok">正常</option><option value="pending">待处理</option><option value="failed">失败</option>
                        <option value="refused">拒答</option><option value="stale">过期</option><option value="orphan">孤立</option>
                        <option value="fallback">兜底抠取</option><option value="pinned">已钉</option>
                    </select>
                    <input id="em_f_q" class="text_pole" placeholder="搜索标题 / 摘要 / 标签">
                </div>
                <div id="em_list" class="em-list"></div>
                <div class="em-foot">
                    <div class="menu_button" data-act="ingest">补齐</div>
                    <div class="menu_button" data-act="reconcile">对账</div>
                    <div class="menu_button" data-act="retry">重试失败</div>
                    <div class="menu_button" data-act="export">导出</div>
                    <div class="menu_button" data-act="import">导入</div>
                    <div class="menu_button em-danger" data-act="clear">清空</div>
                    <input type="file" id="em_import_file" accept="application/json" hidden>
                </div>
            </div>
            <div id="em_tab_cfg" class="em-tabpane em-cfg" style="display:none">
                ${settingsFormHtml()}
            </div>
        </div>`;
        $('body').append(html);

        $('#em_close').on('click', () => togglePanel(false));
        $('#em_panel .em-tab').on('click', function () { showTab($(this).data('tab')); });
        $('#em_alert').on('click', () => showTab('cfg'));
        bindSettingsForm();
        $('#em_f_grade, #em_f_type, #em_f_status').on('change', function () {
            filter[this.id.replace('em_f_', '')] = this.value; renderPanel();
        });
        $('#em_f_q').on('input', debounce(function () { filter.q = this.value.trim(); renderPanel(); }, 200));
        $('.em-foot').on('click', '.menu_button', function () { panelAction($(this).data('act')); });
        $('#em_import_file').on('change', importFile);

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

    function showTab(name) {
        panelTab = name === 'cfg' ? 'cfg' : 'mem';
        $('#em_panel .em-tab').removeClass('active').filter(`[data-tab="${panelTab}"]`).addClass('active');
        $('#em_tab_mem').toggle(panelTab === 'mem');
        $('#em_tab_cfg').toggle(panelTab === 'cfg');
        if (panelTab === 'cfg') renderModelSelect();
    }

    // 未配副 API 且还没有条目时，打开面板直接落到设置页
    function togglePanel(force, tab) {
        panelOpen = force === undefined ? !panelOpen : !!force;
        $('#em_panel').toggle(panelOpen);
        $('#em_icon').toggleClass('openIcon', panelOpen).toggleClass('closedIcon', !panelOpen);
        if (!panelOpen) return;
        if (!tab && !apiConfigured() && !(getData()?.entries.length)) tab = 'cfg';
        showTab(tab || panelTab);
        reconcile(); renderPanel(); refreshStatus();
    }

    function matchFilter(e) {
        if (filter.grade && e.grade !== filter.grade) return false;
        if (filter.type && e.type !== filter.type) return false;
        if (filter.status === 'fallback') { if (!e.src?.fallback) return false; }
        else if (filter.status === 'pinned') { if (!e.pinned) return false; }
        else if (filter.status && e.status !== filter.status) return false;
        if (filter.q) {
            const hay = `${e.title} ${e.summary} ${(e.tags || []).join(' ')} ${e.story_time} ${(e.characters || []).join(' ')}`.toLowerCase();
            if (!hay.includes(filter.q.toLowerCase())) return false;
        }
        return true;
    }

    function cardHtml(e, len) {
        const open = expanded.has(e.id);
        const depth = len - 1 - (e.src?.idx ?? 0);
        const inWindow = depth < (Number(settings.contentWindow) || 6);
        const badges = [];
        if (STATUS_LABEL[e.status]) badges.push(`<span class="em-badge em-st-${e.status}">${STATUS_LABEL[e.status]}</span>`);
        if (e.src?.fallback) badges.push('<span class="em-badge em-st-fallback">兜底抠取</span>');
        if (e.status === 'ok' && inWindow) badges.push('<span class="em-badge em-st-window">窗口内·未注入</span>');
        if (e.pinned) badges.push('<span class="em-badge em-st-pinned">📌</span>');
        const meta = `${esc(e.story_time || '（时间未知）')} · ${TYPE_LABEL[e.type] || e.type} · #${e.src?.idx ?? '?'}楼`;
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
                    <div class="menu_button" data-eact="resum">重摘要</div>
                    <div class="menu_button" data-eact="jump">跳到该楼</div>
                    <div class="menu_button" data-eact="skip">该楼不入库</div>
                    <div class="menu_button em-danger" data-eact="del">删除</div>
                </div>
            </div>` : '';
        return `
        <div class="em-card em-g-${e.grade} ${e.status !== 'ok' ? 'em-dim' : ''}" data-id="${e.id}">
            <div class="em-card-head">
                <div class="em-grade" title="点按改等级，长按钉/取消钉">${e.grade}</div>
                <div class="em-card-main">
                    <div class="em-meta">${meta} ${badges.join('')}</div>
                    <div class="em-ttl">${esc(e.title || '（未摘要）')}</div>
                    ${!open ? `<div class="em-sum">${esc(e.summary || e.last_error || '…')}</div>` : ''}
                </div>
            </div>
            ${body}
        </div>`;
    }

    function renderPanel() {
        if (!panelOpen) return;
        const data = getData();
        const list = $('#em_list');
        if (!data) { list.html('<div class="em-empty">当前没有打开聊天</div>'); return; }
        const len = (getCtx().chat || []).length;
        const items = data.entries.filter(matchFilter).slice().reverse();
        list.html(items.length ? items.map(e => cardHtml(e, len)).join('') : '<div class="em-empty">没有条目</div>');

        const c = counts();
        const alert = $('#em_alert');
        const bad = c.failed + c.refused;
        if (bad) {
            alert.show().text(`${bad} 楼摘要失败（其中拒答 ${c.refused}）${data.stats.lastError ? '：' + data.stats.lastError : ''}`);
        } else if (!apiConfigured()) {
            alert.show().text('尚未配置副 API，条目不会自动入库（点此去设置页）');
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
            if (!await confirmBox('删除这条记忆？该楼下次补齐时会重新入库（除非标记不入库）')) return;
            data.entries = data.entries.filter(x => x.id !== id);
            saveData(); applyInjection(); renderPanel(); refreshStatus();
        }
    }

    async function panelAction(act) {
        const data = getData();
        if (!data) return toast('warning', '当前没有打开聊天');
        if (act === 'ingest') { ingest('manual'); }
        else if (act === 'reconcile') { reconcile(); applyInjection(); renderPanel(); refreshStatus(); toast('info', '对账完成'); }
        else if (act === 'retry') {
            let n = 0;
            for (const e of data.entries) if (['failed', 'refused'].includes(e.status)) { e.attempts = 0; n++; }
            saveData();
            n ? ingest('manual') : toast('info', '没有失败条目');
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
            if (!await confirmBox(`清空当前聊天的全部 ${data.entries.length} 条记忆？不可恢复（建议先导出）`)) return;
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
                    data.entries = src.entries; data.skip = src.skip || {}; data.archives = src.archives || [];
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

    /* ================= 事件 ================= */

    function bindEvents() {
        const ctx = getCtx();
        const es = ctx.eventSource, ET = ctx.eventTypes;
        const ingestSoon = debounce(() => { if (settings.autoIngest) ingest('auto'); }, 800);
        const resync = () => { reconcile(); applyInjection(); renderPanel(); refreshStatus(); };

        es.on(ET.CHAT_CHANGED, () => {
            expanded.clear();
            setTimeout(() => { resync(); if (settings.autoIngest) ingest('chat_changed'); }, 1500);
        });
        es.on(ET.MESSAGE_RECEIVED, ingestSoon);
        es.on(ET.MESSAGE_DELETED, resync);
        es.on(ET.MESSAGE_UPDATED, () => { resync(); ingestSoon(); });
        if (ET.MESSAGE_EDITED) es.on(ET.MESSAGE_EDITED, () => { resync(); ingestSoon(); });
    }

    // 控制台排障入口（手机上可配合 Eruda）：eratoMemory_debug.buildBlock() 等
    window.eratoMemory_debug = { extractContent, extractRecap, parseJson, buildBlock, reconcile, ingest, fetchModels, getData, counts, settings };

    jQuery(() => {
        try {
            addSettingsUI();
            addTopIcon();
            addPanel();
            addWandEntry();
            bindEvents();
            setTimeout(() => { reconcile(); applyInjection(); refreshStatus(); }, 2000);
            log('Erato Memory 已加载');
        } catch (err) {
            console.error('[EratoMemory] 初始化失败', err);
        }
    });
})();
