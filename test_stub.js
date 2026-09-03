// Erato Memory v0.4.0 桩环境冒烟测试：不依赖酒馆，只验证纯逻辑
// （楼数口径 / 窗口切分 / 拆半重试 / 点名表与档案合并 / 档位与状态 / 事件密度 / 哨兵与截断 / 覆盖核验与纠正重试 / 锁与墓碑 / recap 保底 /
//   远景折叠与时期折叠 / 正典压缩 / 关键词召回 / 向量对账与召回 / 停止中止 / 待核 / 清空世代 / 残影清理 / 对账 / 隐藏 / 注入 / 迁移）
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// ---- 假 jQuery：任何方法都可链式调用 ----
const chain = () => new Proxy(function () {}, {
    get(_, k) {
        if (k === 'length') return 0;
        if (k === Symbol.toPrimitive) return () => '';
        if (k === 'val' || k === 'text' || k === 'html' || k === 'attr' || k === 'data') return (...a) => (a.length ? chain() : '');
        if (k === 'is') return () => false;
        return () => chain();
    },
    apply() { return chain(); },
});
const $ = (arg) => (typeof arg === 'function' ? (arg(), undefined) : chain());
global.jQuery = $; global.$ = $;

// ---- 假 DOM ----
const fakeEl = () => ({
    style: { setProperty() {}, removeProperty() {} }, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 40 }),
    appendChild() {}, innerHTML: '', id: '', className: '',
});
const domAttrs = {};
global.document = {
    getElementById: () => null,
    querySelector: (sel) => { const m = /mesid="(\d+)"/.exec(sel); if (!m) return null; return { setAttribute: (k, v) => { domAttrs[m[1]] = v; } }; },
    createElement: fakeEl,
    body: { appendChild() {} },
};
global.window = global;
global.innerWidth = 400; global.innerHeight = 800;
global.addEventListener = () => {};

const END = '<END_OF_MEMORY/>';

// ---- 假副 API：材料里超过 2 楼就「拒答」（逼出拆半重试），否则每楼回一条事件 + 点名表 + 档案 ----
// mode.fewEvents：只回 1 条事件（测密度下限）；mode.finishLength：前 N 次回 finish_reason=length（测截断重试）；
// mode.clearDuring：调用期间把库换掉（测清空世代）；mode.noSentinel：前 N 次不带结束哨兵；
// mode.allowBig：不拒答大窗口；mode.skipFloors：漏掉前 N 楼的事件（测覆盖核验）；mode.declare：漏掉的楼在 uncovered 里申报；
// mode.slow：调用挂 300ms 且尊重 abort（测停止）
const apiLog = [];
const foldLog = [];
const vecStore = {};   // collectionId → Map(hash → { text, index })
const vecLog = [];
const secrets = [];
const mode = { fewEvents: false, finishLength: 0, clearDuring: false, noSentinel: 0, allowBig: false, skipFloors: 0, declare: false, slow: false };
const sleep = ms => new Promise(r => setTimeout(r, ms));
global.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    if (url.startsWith('/api/vector/')) {
        const route = url.slice('/api/vector/'.length);
        vecLog.push({ route, collection: body.collectionId, n: body.items?.length || body.hashes?.length || 0, source: body.source, endpoint: body.siliconflow_endpoint, model: body.model });
        const col = (vecStore[body.collectionId] ||= new Map());
        let out = 'OK';
        if (route === 'insert') for (const it of body.items) col.set(Number(it.hash), { text: it.text, index: it.index, hash: it.hash });
        else if (route === 'list') out = JSON.stringify([...col.keys()]);
        else if (route === 'delete') for (const h of body.hashes) col.delete(Number(h));
        else if (route === 'purge') delete vecStore[body.collectionId];
        else if (route === 'query') {
            const q = String(body.searchText);
            const hits = [...col.values()].filter(v => [...q].some(ch => /[㐀-鿿]/.test(ch) && v.text.includes(ch) && q.includes(ch) && ['钥', '匙', '刘'].includes(ch))).slice(0, body.topK);
            out = JSON.stringify({ metadata: hits.map(v => ({ hash: v.hash, text: v.text, index: v.index })), hashes: hits.map(v => v.hash) });
        }
        return { ok: true, status: 200, text: async () => out };
    }
    if (url === '/api/secrets/write') { secrets.push(body); return { ok: true, status: 200, text: async () => '{"id":"x"}' }; }
    if (mode.slow) {
        await new Promise((res, rej) => { const t = setTimeout(res, 300); opt.signal?.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); }); });
    }
    const sys = body.messages[0].content;
    const user = body.messages[1].content;
    const last = body.messages[body.messages.length - 1].content;
    // 折叠 / 压缩调用
    if (/更细的记忆条目覆盖过/.test(sys)) {
        foldLog.push({ kind: /"lines"/.test(user) ? 'outline' : /时期/.test(user) ? 'period' : 'canon', user });
        let content;
        if (/"lines"/.test(user)) content = JSON.stringify({ lines: [...user.matchAll(/^### (.+)$/gm)].map(m => ({ key: m[1].trim(), text: `【${m[1].trim()}骨架】陆衍与用户在厨房定下了钥匙的去向` })) });
        else if (/时期/.test(user)) content = '这段时期里陆衍与用户从试探走到依赖，钥匙几经易手';
        else content = '- 3月2日 陆衍第一次向用户交出钥匙（不可逆）\n- 后续 S 事件压缩为此段';
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: content + '\n' + END }, finish_reason: 'stop' }] }) };
    }
    const floors = [...user.matchAll(/【#(\d+)】/g)].map(m => Number(m[1]));
    const correction = body.messages.length > 2 ? (/截断/.test(last) ? 'length' : /认领/.test(last) ? 'coverage' : /太少|事件/.test(last) ? 'density' : 'json') : '';
    apiLog.push({ floors, msgs: body.messages.length, retry: correction === 'length', correction, hasLocked: /已锁定的记忆[\s\S]*?\n(?!（无）)/.test(user) && !/已锁定的记忆（[^\n]*\n（无）/.test(user), user });
    if (mode.clearDuring) { mode.clearDuring = false; ctx.chatMetadata.eratoMemory = { version: 2 }; }
    let content, finish = 'stop';
    const ev = i => ({ floors: [i], story_time: `3月${i}日 · 午后 · 厨房`, type: 'plot', title: `题${i}`, summary: `第${i}楼发生的事情，陆衍在厨房里做了决定，提到了${i}号钥匙。`, characters: ['陆衍', i === 2 ? '小刘' : '用户'], grade: i === 2 ? 'S' : 'B', tags: ['厨房'] });
    if (floors.length > 2 && !mode.allowBig) content = '抱歉，我无法协助处理这段内容。';
    else if (mode.finishLength > 0) { mode.finishLength--; finish = 'length'; content = '{"cast": [{"name": "陆衍"'; }
    else {
        let evFloors = mode.fewEvents ? [floors[0]] : floors;
        let uncovered = [];
        if (mode.skipFloors > 0 && correction !== 'coverage') {
            const skipped = floors.slice(0, mode.skipFloors);
            evFloors = floors.slice(mode.skipFloors);
            if (mode.declare) uncovered = [{ floors: skipped, why: '纯氛围' }];
        }
        content = JSON.stringify({
            cast: [
                // 后面的窗口故意把陆衍报成龙套：档位只升不降，应仍是配
                { name: '陆衍', aliases: ['小衍'], tier: floors[0] >= 15 ? '龙套' : '配', role: '邻居', seen: floors },
                { name: '周远', tier: '配', role: '医生', seen: [floors[0]] },
                ...(floors[0] <= 2 ? [{ name: '司机老王', tier: '龙套', role: '司机', seen: [floors[0]] }] : []),   // 只露一段，不该自动升配
                { name: 'Char', tier: '主' }, { name: '用户', tier: '主' },
                floors[0] <= 5 ? { name: '陆母', aliases: ['母亲'], tier: '配', role: '用户的母亲', seen: [floors[0]] }
                    : { name: '王秀英', aliases: ['陆母'], tier: '配', seen: [floors[0]] },
            ],
            events: evFloors.map(ev),
            relation: `对用户从戒备转为依赖（#${floors[floors.length - 1]}）`,
            people: [
                { name: '陆衍', aliases: ['小衍'], role: '邻居', rel_user: '暧昧', state: '在场', status: '在厨房忙', arc: '试探期', views: [{ to: '用户', v: '越来越依赖', trend: '亲密' }, { to: '周远', v: '提防', trend: '反感' }, { to: '陆衍', v: '自恋不算' }], floor: floors[0] },
                { name: '周远', role: '医生', state: floors[0] >= 15 ? '离场' : '', floor: floors[0] },
                { name: 'Char', rel_user: '不该建档' },
                { name: '用户', role: '不该建档' },
            ],
            items: [
                { name: '牛皮笔袋', tier: '关键', state: '在用', holder: '陆衍', note: '完好', floor: floors[0] },
                { name: '咖啡杯', tier: '摆设', state: '在用', holder: '周远', floor: floors[0] },
            ],
            uncovered,
        });
    }
    if (mode.noSentinel > 0) mode.noSentinel--; else if (finish !== 'length') content += '\n' + END;
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }) };
};

// ---- 假酒馆 ----
const mkMsg = (i, isUser, opts = {}) => ({
    name: isUser ? 'User' : 'Char', is_user: isUser, is_system: !!opts.hidden, send_date: `d${i}`,
    mes: isUser ? `用户第${i}楼` : `<think_format>备选走向</think_format><content>正文第${i}楼：陆衍在厨房${i === 6 ? '把7号钥匙藏进了抽屉' : ''}。</content><details><summary>📍状态</summary>x</details><recap><details><summary>📜</summary>**3月${i}日 · 午后 · 厨房**\n叙述${i}</details></recap>`,   // i=6 的 AI 楼插入旁白后是 chat[7]
    extra: opts.extra,
});
const chat = [];
for (let i = 0; i < 20; i++) chat.push(mkMsg(i, i % 2 === 1));   // 0 AI, 1 user, 2 AI, ...
chat[0].is_system = true;                                          // 旧楼被酒馆隐藏过（用户手动）
chat.splice(4, 0, { name: 'System', is_user: false, is_system: true, send_date: 'sys', mes: '旁白', extra: { type: 'narrator' } });
// 插入旁白后 AI 楼：0,2,5,7,9,11,13,15,17,19；用户楼：1,3,6,8,...,20（共 21 条）

const prompts = {};
const chatMetadata = {};
const ctx = {
    chatId: 'chat1', chat, chatMetadata, name1: '用户', name2: 'Char',
    extensionSettings: {}, saveSettingsDebounced() {}, saveMetadataDebounced() {},
    saveChat: async () => { ctx.savedChat = (ctx.savedChat || 0) + 1; },
    getRequestHeaders: () => ({}),
    setExtensionPrompt: (k, t, type, depth) => { prompts[k] = { t, type, depth }; },
    eventSource: { on() {} }, eventTypes: { CHAT_CHANGED: 'a', MESSAGE_RECEIVED: 'b', MESSAGE_DELETED: 'c', MESSAGE_UPDATED: 'd' },
};
global.SillyTavern = { getContext: () => ctx };

// ---- 载入扩展 ----
const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
new Function(src)();
const D = global.eratoMemory_debug;
let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ', name); } catch (e) { console.log('  FAIL', name, '\n       ', e.message); process.exitCode = 1; } };
const ta = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { console.log('  FAIL', name, '\n       ', e.message); process.exitCode = 1; } };

(async () => {
    console.log('== 楼层判定 ==');
    const data = D.getData();
    t('系统旁白(extra.type)不算 AI 楼；被酒馆隐藏的 AI 楼算；depth<2 只在 all 模式入队', () => {
        const todo = D.uncoveredFloors(chat, data);
        assert.ok(!todo.includes(4), '旁白不应入库');
        assert.ok(todo.includes(0), '隐藏的 0 楼应入库');
        assert.ok(!todo.includes(19), 'depth 1 不入库');
        assert.ok(D.uncoveredFloors(chat, data, true).includes(19), 'all 模式含最新楼');
        assert.deepStrictEqual(todo, [0, 2, 5, 7, 9, 11, 13, 15, 17]);
    });
    t('可见深度：隐藏层=-1，其余按可见计数', () => {
        const d = D.visibleDepths(chat);
        assert.strictEqual(d[0], -1); assert.strictEqual(d[4], -1);
        assert.strictEqual(d[20], 0); assert.strictEqual(d[19], 1);
        assert.strictEqual(d[1], 18);
    });
    t('楼数口径：AI 楼 + 前一条用户楼 = 2 楼；开场白 / 前面是旁白的只算 1', () => {
        assert.strictEqual(D.floorSpan(chat, 0), 1, '开场白没有用户楼');
        assert.strictEqual(D.floorSpan(chat, 2), 2);
        assert.strictEqual(D.floorSpan(chat, 5), 1, '#4 是旁白不是用户楼');
        assert.strictEqual(D.spanOf(chat, [0, 2, 5, 7, 9, 11, 13, 15, 17, 19]), 18, '10 个 AI 楼 = 18 个酒馆楼层');
        assert.strictEqual(D.counts().todo, 18, '待总结按酒馆楼层计');
    });
    t('recap 底层：对账时把每个 AI 楼的作者摘要存进 recaps', () => {
        D.reconcile();
        assert.strictEqual(Object.keys(data.recaps).length, 10);
        assert.strictEqual(data.recaps.d2.t, '3月2日 · 午后 · 厨房'); assert.strictEqual(data.recaps.d2.n, '叙述2'); assert.strictEqual(data.recaps.d2.i, 2);
    });

    console.log('== 窗口切分 ==');
    t('按单次最大楼层切窗口（酒馆楼层计：8 楼 = 5 个 AI 楼，因 #0/#5 前面没有用户楼）', () => {
        D.settings.windowFloors = 8; D.settings.maxCallChars = 60000;
        const wins = D.planWindows(chat, data, D.uncoveredFloors(chat, data, true));
        assert.deepStrictEqual(wins.map(w => w.floors), [[0, 2, 5, 7, 9], [11, 13, 15, 17], [19]]);
        assert.deepStrictEqual(wins.map(w => D.spanOf(chat, w.floors)), [8, 8, 2]);
        assert.ok(wins[0].dates.length === 5 && wins[0].hashes.every(h => h.length === 8));
    });
    t('单次最大字数先到者生效：超长楼单独成窗', () => {
        const saved = chat[9].mes;
        chat[9].mes = `<content>${'长'.repeat(1990)}</content>`;
        D.settings.maxCallChars = 2000;
        const wins = D.planWindows(chat, data, D.uncoveredFloors(chat, data, true));
        assert.deepStrictEqual(wins.map(w => w.floors), [[0, 2, 5, 7], [9], [11, 13, 15, 17], [19]]);
        chat[9].mes = saved; D.settings.maxCallChars = 60000;
    });
    t('中间隔着已入库楼层时断开', () => {
        data.windows.push({ id: 'wx', floors: [7], dates: [chat[7].send_date], hashes: [''], status: 'ok', attempts: 0, created_at: 0 });
        try {
            const wins = D.planWindows(chat, data, D.uncoveredFloors(chat, data, true));
            assert.deepStrictEqual(wins.map(w => w.floors), [[0, 2, 5], [9, 11, 13, 15], [17, 19]]);
        } finally { data.windows.pop(); }
    });

    console.log('== 模板 ==');
    t('默认模板替换全部占位符，材料按楼编号，含哨兵与 uncovered', () => {
        const wins = D.planWindows(chat, data, [2, 5]);
        const floors = wins[0].floors.map(i => ({ idx: i, userText: 'U', content: 'C正文' + i, recap: { storyTime: '3月1日', narrative: 'N' } }));
        const msgs = D.buildMessages({ floors, recent: [], locked: [], data });
        assert.ok(!/\{\{(name1|name2|roster|relation|context|recent|locked|floor_range|floor_count|material|min_events|max_events|directive)\}\}/.test(msgs[1].content), '占位符残留');
        assert.ok(msgs[1].content.includes('"cast"') && msgs[1].content.includes('亲属') && msgs[1].content.includes('"uncovered"') && msgs[1].content.includes(END), '模板应含点名表、亲属明文、覆盖申报与哨兵');
        assert.ok(msgs[1].content.includes('【#2】') && msgs[1].content.includes('【#5】') && msgs[1].content.includes('#2–#5') && msgs[1].content.includes('用户角色：用户'));
    });
    t('自定义模板缺 {{material}} 时退回默认', () => {
        D.settings.promptTemplate = '坏模板 {{recent}}';
        const msgs = D.buildMessages({ floors: [{ idx: 1, userText: '', content: 'XYZ', recap: {} }], recent: [], data });
        assert.ok(msgs[1].content.includes('XYZ') && msgs[1].content.includes('等级标准'));
        D.settings.promptTemplate = '';
    });
    t('哨兵判定：有哨兵即完整，缺哨兵即截断；剥离后再解析', () => {
        assert.ok(D.hasEndMark('{"a":1}\n' + END) && D.hasEndMark('{"a":1}' + END + '  '));
        assert.ok(!D.hasEndMark('{"a":1}') && !D.hasEndMark('{"a":1}' + END + ' 还有话'));
        assert.strictEqual(D.stripEndMark('{"a":1}\n' + END + '\n'), '{"a":1}');
    });

    console.log('== 入库（假副 API：>2 楼拒答 → 拆半） ==');
    D.settings.api.url = 'https://x/v1'; D.settings.api.key = 'k'; D.settings.api.model = 'm';
    D.settings.autoInterval = 20; D.settings.windowFloors = 8; D.settings.hideSummarized = false;
    await ta('手动总结到当前：拒答窗口对半拆，最终全部楼层入库；每窗 uncovered 为空', async () => {
        await D.ingest('manual');
        assert.ok(data.windows.every(w => w.status === 'ok'), '窗口应全部 ok：' + data.windows.map(w => w.status + ':' + w.last_error).join(','));
        assert.deepStrictEqual(data.windows.map(w => w.floors), [[0, 2], [5], [7, 9], [11, 13], [15, 17], [19]]);
        assert.ok(apiLog.some(f => f.floors.length === 5), '应先尝试过 5 个 AI 楼（8 楼）的窗口');
        assert.strictEqual(D.uncoveredFloors(chat, data, true).length, 0);
        assert.strictEqual(data.entries.length, 10);
        assert.ok(data.entries.every(e => e.status === 'ok' && e.win && e.src.floors.length === 1));
        assert.strictEqual(data.entries.find(e => e.src.idx === 2).grade, 'S');
        assert.ok(data.windows.every(w => Array.isArray(w.uncovered) && !w.uncovered.length));
        assert.ok(!apiLog.some(f => f.correction), '正常输出不该触发纠正重试');
    });
    t('档案合并：主角不建档，点名表建档带档位，事件里点到的人也建档，别称升级真名，views/arc/state 落地，档位只升不降，S 事件升配', () => {
        const names = data.people.map(p => p.name);
        assert.deepStrictEqual(names.sort(), ['司机老王', '周远', '小刘', '王秀英', '陆衍'].sort(), '人物：' + names.join(','));
        const lu = data.people.find(p => p.name === '陆衍');
        assert.deepStrictEqual(lu.aliases, ['小衍']);
        assert.strictEqual(lu.tier, '配', '后面窗口报龙套不能把配降下去');
        assert.strictEqual(lu.state, '在场');
        assert.strictEqual(lu.f.role.v, '邻居');
        assert.strictEqual(lu.f.role.idx, 19, '最后一窗覆盖后来源楼应为 19');
        assert.strictEqual(lu.f.arc.v, '试探期');
        assert.strictEqual(lu.f.status.v, '在厨房忙', '自由文本现状照旧');
        assert.strictEqual(lu.views['用户'].trend, '亲密'); assert.strictEqual(lu.views['周远'].v, '提防');
        assert.ok(!lu.views['陆衍'], '对自己的看法不记');
        assert.strictEqual(lu.first_idx, 0);
        assert.ok(lu.seen >= 6, '登场段数应累计：' + lu.seen);
        const mom = data.people.find(p => p.name === '王秀英');
        assert.ok(mom, '真名出现后应改名');
        assert.ok(mom.aliases.includes('陆母') && mom.aliases.includes('母亲'), '旧写法与称呼都进别称：' + mom.aliases.join(','));
        assert.strictEqual(mom.f.role.v, '用户的母亲', '点名表只在 role 为空时补');
        assert.strictEqual(mom.first_idx, 0);
        const liu = data.people.find(p => p.name === '小刘');
        assert.ok(liu && liu.first_idx === 2 && !liu.f.role, '事件 characters 反哺建档，只有名字与楼层');
        assert.strictEqual(liu.tier, '配', '进过 S 事件的未定人物自动升配');
        const zhou = data.people.find(p => p.name === '周远');
        assert.strictEqual(zhou.state, '离场', '状态以最新一窗为准');
        const wang = data.people.find(p => p.name === '司机老王');
        assert.strictEqual(wang.tier, '龙套'); assert.strictEqual(wang.seen, 1, '只露一段不升配');
        assert.strictEqual(data.items.length, 2);
        const bag = data.items.find(i => i.name === '牛皮笔袋');
        assert.strictEqual(bag.f.holder.v, '陆衍'); assert.strictEqual(bag.f.note.v, '完好');
        assert.strictEqual(bag.tier, '关键'); assert.strictEqual(bag.state, '在用');
        assert.strictEqual(data.items.find(i => i.name === '咖啡杯').tier, '摆设');
        assert.ok(data.relation.v.includes('#19'), '关系现状来自最后一窗');
        assert.strictEqual(data.relation.idx, 19);
        assert.ok(data.rawLog.length === 3 && data.rawLog[0].finish === 'stop', '原始回复留档 3 条');
    });
    t('计数：已总结 18 楼（10 个 AI 楼）/ 10 条，待总结 0', () => {
        const c = D.counts();
        assert.strictEqual(c.done, 18); assert.strictEqual(c.events, 10); assert.strictEqual(c.todo, 0); assert.strictEqual(c.people, 5);
    });
    await ta('自动模式：未攒够间隔不开新窗口，攒够才开（间隔按酒馆楼层计）', async () => {
        chat.push(mkMsg(21, true), mkMsg(22, false), mkMsg(23, true), mkMsg(24, false));  // AI 22(depth 2), 24(depth 0)
        const before = data.windows.length;
        await D.ingest('auto');
        assert.strictEqual(data.windows.length, before, '2 楼 < 20 不应开窗');
        assert.strictEqual(D.counts().todoAuto, 2, '#21 用户 + #22 AI = 已攒 2 楼');
        D.settings.autoInterval = 3;
        await D.ingest('auto');
        assert.strictEqual(data.windows.length, before, '2 楼 < 3 仍不开窗');
        D.settings.autoInterval = 2;
        await D.ingest('auto');
        assert.strictEqual(data.windows.length, before + 1);
        assert.deepStrictEqual(data.windows[data.windows.length - 1].floors, [22]);
        assert.ok(D.uncoveredFloors(chat, data, true).includes(24), 'depth 0 的 24 楼留着');
        D.settings.autoInterval = 20;
    });

    console.log('== 哨兵 / 覆盖核验 / 纠正重试 ==');
    await ta('缺结束哨兵 → 视为截断，带长度约束重来一次后入库', async () => {
        chat.push(mkMsg(25, true), mkMsg(26, false));   // 未入库：24, 26
        mode.noSentinel = 1;
        const n0 = apiLog.length;
        await D.ingest('manual');
        const calls = apiLog.slice(n0);
        assert.ok(calls.length >= 2 && calls[1].retry, '第二次应带截断提示：' + JSON.stringify(calls.map(c => c.correction)));
        assert.ok(data.windows.filter(w => w.floors.includes(24) || w.floors.includes(26)).every(w => w.status === 'ok'));
        assert.strictEqual(data.rawLog.find(r => r.note === '压缩重试')?.note, '压缩重试');
    });
    await ta('楼层覆盖不足 → 纠正式重试（点名漏楼），重试后入库且不拆半', async () => {
        chat.push(mkMsg(27, true), mkMsg(28, false), mkMsg(29, true), mkMsg(30, false), mkMsg(31, true), mkMsg(32, false), mkMsg(33, true), mkMsg(34, false));   // 未入库：28,30,32,34
        D.settings.windowFloors = 8; mode.allowBig = true; mode.skipFloors = 2;
        const n0 = apiLog.length;
        try { await D.ingest('manual'); } finally { mode.skipFloors = 0; }
        const calls = apiLog.slice(n0);
        assert.ok(calls.some(c => c.correction === 'coverage'), '应有覆盖纠正重试：' + JSON.stringify(calls.map(c => [c.floors.length, c.correction])));
        const w = data.windows.find(w => w.floors.includes(28));
        assert.strictEqual(w.status, 'ok'); assert.strictEqual(w.floors.length, 4, '不该拆半');
        assert.deepStrictEqual(w.uncovered, []);
    });
    await ta('漏楼但在 uncovered 里申报 → 不重试，窗口记下未覆盖楼；注入时用 recap 保底', async () => {
        chat.push(mkMsg(35, true), mkMsg(36, false), mkMsg(37, true), mkMsg(38, false), mkMsg(39, true), mkMsg(40, false));   // 未入库：36,38,40
        mode.skipFloors = 1; mode.declare = true;
        const n0 = apiLog.length;
        try { await D.ingest('manual'); } finally { mode.skipFloors = 0; mode.declare = false; mode.allowBig = false; }
        assert.ok(!apiLog.slice(n0).some(c => c.correction), '申报过就不该纠正');
        const w = data.windows.find(w => w.floors.includes(36));
        assert.strictEqual(w.status, 'ok');
        assert.deepStrictEqual(w.uncovered, ['d36'], '申报的楼按 send_date 记：' + JSON.stringify(w.uncovered));
        D.settings.recapWindow = 0;
        const fb = D.fallbackLines(data, chat, D.visibleDepths(chat));
        D.settings.recapWindow = 20;
        assert.ok(fb.some(x => x.idx === 36 && x.text.includes('#36·作者摘要') && x.text.includes('叙述36')), '保底行：' + JSON.stringify(fb));
    });
    t('recap 保底：失败窗口的楼注入作者摘要；没有 recap 的楼合并成区间占位；深度不足 recapWindow 的不注入', () => {
        const w = data.windows.find(w => w.floors.includes(28));
        w.status = 'failed';
        const saved = chat[30].mes;
        chat[30].mes = '<content>没有摘要的楼</content>';
        delete data.recaps.d30; delete data.recaps.d32;
        D.settings.recapWindow = 0;
        let fb = D.fallbackLines(data, chat, D.visibleDepths(chat));
        assert.ok(fb.some(x => x.text.includes('#28·作者摘要')), '有 recap 的楼出作者摘要');
        assert.ok(fb.some(x => x.text.includes('#30–#32 楼尚未整理')), '连续无 recap 的楼合并占位：' + JSON.stringify(fb.map(x => x.text)));
        D.settings.recapWindow = 20;
        fb = D.fallbackLines(data, chat, D.visibleDepths(chat));
        assert.ok(!fb.some(x => x.text.includes('#28')), '深度不足 20 的楼预设自己带 recap，不保底');
        w.status = 'ok'; chat[30].mes = saved; D.reconcile();
        assert.ok(data.recaps.d30 && data.recaps.d32, '对账补回 recap');
    });

    console.log('== 对账 ==');
    t('编辑正文 → 所在窗口过期，条目跟着过期；改回来恢复', () => {
        const saved = chat[13].mes;
        chat[13].mes = saved.replace('陆衍在厨房', '陆衍在客厅');
        D.reconcile();
        const w = data.windows.find(w => w.floors.includes(13));
        assert.strictEqual(w.status, 'stale');
        assert.ok(data.entries.filter(e => e.win === w.id).every(e => e.status === 'stale'));
        assert.ok(D.retryWindows(data).includes(w));
        chat[13].mes = saved;
        w.status = 'ok'; D.reconcile();
        assert.strictEqual(w.status, 'ok');
        assert.ok(data.entries.filter(e => e.win === w.id).every(e => e.status === 'ok'));
    });
    t('删掉窗口里一楼 → 窗口缩到剩下的楼并过期，条目跟着过期；楼回来后恢复', () => {
        const d7 = chat[7].send_date, d9 = chat[9].send_date, d11 = chat[11].send_date;
        const w = data.windows.find(w => w.dates.includes(d9));   // 窗口 [7, 9]
        const keep = { dates: w.dates.slice(), hashes: w.hashes.slice() };
        const removed = chat.splice(9, 2);          // 删 AI 9 + 用户 10
        D.reconcile();
        assert.deepStrictEqual(w.dates, [d7]);
        assert.strictEqual(w.status, 'stale');
        assert.deepStrictEqual(w.floors, [7]);
        const e11 = data.entries.find(e => e.src.dates[0] === d11);
        assert.strictEqual(e11.src.idx, 9, '11 楼前移成 9');
        assert.strictEqual(data.entries.find(e => e.src.dates[0] === d9).status, 'stale', '楼没了但窗口还在，跟窗口一起等重跑');
        assert.ok(D.uncoveredFloors(chat, data, true).every(i => i !== 9), '缩窗后 9 楼（原 11）仍被窗口覆盖');
        chat.splice(9, 0, ...removed);
        w.dates = keep.dates; w.hashes = keep.hashes; w.status = 'ok';
        D.reconcile();
        assert.strictEqual(w.status, 'ok'); assert.deepStrictEqual(w.floors, [7, 9]);
        assert.strictEqual(e11.src.idx, 11);
    });
    t('删楼回滚：来源楼没了的值退回上一版，退无可退清掉；手改的保留标待核；关系现状与状态同样回退；首见楼与全部值都没了标来源全失，再被提到即恢复', () => {
        const lu = data.people.find(p => p.name === '陆衍');
        const savedRel = { ...data.relation };
        lu.f.age = { v: '31', idx: 99, date: 'gone', hist: [{ v: '30', idx: 2, date: 'd2' }] };
        lu.f.look = { v: '高', idx: 99, date: 'gone', manual: true };
        lu.f.knows = { v: '秘密', idx: 99, date: 'gone' };
        lu.views['小刘'] = { v: '讨厌', idx: 99, date: 'gone', hist: [{ v: '一般', trend: '陌生', idx: 2, date: 'd2' }] };
        data.relation = { v: '新关系', idx: 99, date: 'gone', hist: [{ v: '旧关系', idx: 2, date: 'd2' }] };
        lu.state = '离场'; lu.stateDate = 'gone'; lu.stateHist = [{ s: '在场', idx: 2, date: 'd2' }];
        const ghost = { id: 'p_ghost', name: '幽灵', aliases: [], f: { role: { v: 'x', idx: 99, date: 'gone' } }, views: {}, tier: '配', state: '', seen: 1, first_idx: 99, first_date: 'gone', last_idx: 99 };
        data.people.push(ghost);
        D.reconcile();
        assert.strictEqual(lu.f.age.v, '30'); assert.strictEqual(lu.f.age.date, 'd2');
        assert.ok(lu.f.look.stale && lu.f.look.v === '高', '手改的值保留并标待核');
        assert.ok(!lu.f.knows, '退无可退就清掉');
        assert.strictEqual(lu.views['小刘'].v, '一般');
        assert.strictEqual(data.relation.v, '旧关系');
        assert.strictEqual(lu.state, '在场');
        assert.ok(!lu.f.role.stale, '活着的值不动');
        assert.strictEqual(ghost.lost, true, '来源全失');
        assert.ok(!D.buildBlock().text.includes('幽灵'), '来源全失不注入');
        D.mergeEntities(data, { cast: [{ name: '幽灵', tier: '配', seen: [2] }] }, { floors: [2] }, new Map([[2, chat[2]]]), []);
        assert.ok(!ghost.lost, '再被提到即恢复');
        data.people = data.people.filter(p => p !== ghost);
        delete lu.f.age; delete lu.f.look; delete lu.views['小刘']; data.relation = savedRel; lu.stateHist = [];
    });
    t('故事日归一化：全角数字转半角、汉字数字转阿拉伯、号→日，年份保留；无日期按 40 楼一段', () => {
        assert.strictEqual(D.normDate('２０２５年三月十二日'), '2025年3月12日');
        assert.strictEqual(D.normDate('二零二五年 十月 五号'), '2025年10月5日');
        assert.strictEqual(D.dayKey({ story_time: '三月四日 · 午后 · 厨房', src: { idx: 2 } }), '3月4日');
        assert.strictEqual(D.dayKey({ story_time: '2026年3月4日 · 夜', src: { idx: 2 } }), '2026年3月4日', '年份保留');
        assert.strictEqual(D.dayKey({ story_time: '（未知）', src: { idx: 85 } }), '#80 楼段');
    });

    console.log('== 锁 / 墓碑 / 字段锁 ==');
    await ta('钉选与手改过的条目重跑本段时保留，并作为「已锁定记忆」喂回副模型；未锁的被替换', async () => {
        const w = data.windows.find(w => w.floors.includes(13));   // 窗口 [11, 13]
        const e11 = data.entries.find(e => e.src.idx === 11), e13 = data.entries.find(e => e.src.idx === 13);
        e11.summary = '用户手改过的摘要文字'; e11.locked = true;
        e13.pinned = true; e13.grade = 'S';
        w.status = 'stale'; w.attempts = 0;
        const n0 = apiLog.length;
        await D.ingest('retry');
        assert.strictEqual(w.status, 'ok');
        assert.ok(data.entries.includes(e11) && e11.summary === '用户手改过的摘要文字', '手改条目应保留原对象');
        assert.ok(data.entries.includes(e13) && e13.pinned && e13.grade === 'S', '钉选条目应保留');
        assert.strictEqual(data.entries.filter(e => e.win === w.id).length, 4, '2 条保留 + 2 条新的');
        assert.ok(apiLog.slice(n0).some(c => c.user.includes('用户手改过的摘要文字') && c.user.includes('已锁定的记忆')), '锁定条目喂回副模型');
        e13.pinned = false; e13.grade = 'B';
        data.entries = data.entries.filter(e => !(e.win === w.id && e.src.idx === 11 && e !== e11) && !(e.win === w.id && e.src.idx === 13 && e !== e13));
    });
    t('拆半时钉选/手改条目按楼归到子窗口', () => {
        const w = data.windows.find(w => w.floors.includes(13));
        const e13 = data.entries.find(e => e.src.idx === 13); e13.locked = true;
        const [a, b] = D.splitWindow(data, w);
        assert.ok(data.entries.includes(e13) && e13.win === b.id, '13 楼条目归到后半窗');
        data.windows = data.windows.filter(x => x !== a && x !== b).concat(w); e13.win = w.id; e13.locked = false;
        for (const e of data.entries) if (e.src.idx === 11 && e.win !== w.id) e.win = w.id;
        D.reconcile();
    });
    t('墓碑：删过的人副模型再报不建档，事件反哺也不建；恢复后可重建', () => {
        const liu = data.people.find(p => p.name === '小刘');
        D.addTomb(data, 'p', liu); data.people = data.people.filter(p => p !== liu);
        D.mergeEntities(data, { cast: [{ name: '小刘', tier: '配', seen: [2] }], people: [{ name: '小刘', role: '助理', floor: 2 }] }, { floors: [2] }, new Map([[2, chat[2]]]), [{ src: { idx: 2 }, characters: ['小刘'], grade: 'A' }]);
        assert.ok(!data.people.some(p => p.name === '小刘'), '墓碑里的名字不该复活');
        assert.strictEqual(D.backfillPeople(), 0, '补人物也尊重墓碑');
        D.removeTomb(data, 'p', '小刘');
        assert.strictEqual(D.backfillPeople(), 1, '解除墓碑后可重建');
    });
    t('字段锁：手改过的字段、看法、关系现状副模型不覆盖；未锁的照常更新', () => {
        const lu = data.people.find(p => p.name === '陆衍');
        lu.f.role = { v: '手改身份', idx: 2, date: 'd2', manual: true };
        lu.views['用户'] = { v: '手改看法', trend: '亲密', idx: 2, date: 'd2', manual: true };
        data.relation = { v: '手改关系', idx: 2, date: 'd2', manual: true };
        D.mergeEntities(data, { relation: '副模型关系', people: [{ name: '陆衍', role: '副模型身份', age: '28', views: [{ to: '用户', v: '副模型看法' }, { to: '周远', v: '新看法' }], floor: 2 }] }, { floors: [2] }, new Map([[2, chat[2]]]), []);
        assert.strictEqual(lu.f.role.v, '手改身份'); assert.strictEqual(lu.f.age.v, '28', '未锁字段照常更新');
        assert.strictEqual(lu.views['用户'].v, '手改看法'); assert.strictEqual(lu.views['周远'].v, '新看法');
        assert.strictEqual(data.relation.v, '手改关系');
        delete lu.f.role.manual; delete lu.views['用户'].manual; data.relation.manual = false; delete lu.f.age;
        D.mergeEntities(data, { relation: '副模型关系', people: [{ name: '陆衍', role: '邻居', views: [{ to: '用户', v: '越来越依赖', trend: '亲密' }, { to: '周远', v: '提防', trend: '反感' }], floor: 19 }] }, { floors: [19] }, new Map([[19, chat[19]]]), []);
        assert.strictEqual(lu.f.role.v, '邻居'); assert.strictEqual(data.relation.v, '副模型关系');
    });

    console.log('== 隐藏 / 恢复 ==');
    t('保留最近 6 条可见，其余已总结楼层及其前一条用户楼被藏；用户手动藏的 0 楼不进 hidden 表', () => {
        D.settings.hideSummarized = true; D.settings.keepVisible = 6;
        const n = D.hideSummarized();
        assert.ok(n > 0, '应隐藏若干');
        for (let i = chat.length - 6; i < chat.length; i++) assert.strictEqual(chat[i].is_system, false, `#${i} 应可见`);
        assert.strictEqual(chat[17].is_system, true, '#17 AI 已总结应藏');
        assert.strictEqual(chat[16].is_system, true, '#16 用户楼跟着藏');
        assert.ok(!data.hidden['d0'], '0 楼本来就是酒馆藏的，不记进表');
        assert.strictEqual(domAttrs['17'], 'true');
        assert.strictEqual(ctx.savedChat, 1, '保存一次聊天');
    });
    t('再次调用幂等', () => { assert.strictEqual(D.hideSummarized(), 0); assert.strictEqual(ctx.savedChat, 1); });
    t('注入：隐藏楼层的条目全部注入，S 进正典；档案在前，提到的人物出完整卡（含阶段/看法/身份激活），其余只列名，龙套不注入，关键物件带履历', () => {
        D.applyInjection?.();
        const b = D.buildBlock();
        assert.ok(b.text.includes('题13') && b.text.includes('题2'), '隐藏楼层条目应注入');
        assert.ok(b.text.includes('## 正典') && b.text.includes('## 关系现状') && b.text.includes('## 人物志') && b.text.includes('## 物件'));
        assert.ok(b.text.indexOf('## 人物志') < b.text.indexOf('## 正典'));
        assert.ok(b.text.includes('[以上是还留在眼前的对话') && b.text.includes('信息墙') && b.text.includes('远景 ='), '块首五行');
        assert.ok(/- 陆衍（小衍）｜身份：邻居/.test(b.text), '陆衍在最近楼层出现，出完整卡');
        assert.ok(b.text.includes('阶段：试探期') && b.text.includes('看法：对用户·亲密·越来越依赖；对周远·反感·提防'), '完整卡含阶段与看法');
        const brief = /其他已登场：([^\n]*)/.exec(b.text)?.[1] || '';
        assert.ok(brief.includes('周远·医生·离场') && brief.includes('王秀英（母亲/陆母）·用户的母亲') && brief.includes('小刘'), '没露面的只列名（带别称与非在场状态）：' + brief);
        assert.ok(!b.text.includes('司机老王'), '龙套不进注入块');
        assert.ok(b.text.includes('牛皮笔袋｜状态：在用｜持有者：陆衍｜备注：完好'), '物件卡带状态：' + b.text);
        assert.ok(!b.text.includes('咖啡杯'), '摆设不进注入块');
        assert.ok(!b.text.includes('题40'), '#40 在正文窗口内不注入');
        assert.strictEqual(b.fallback, 0, '#36 虽申报未覆盖，但还在可见窗口内（深度 <20，预设自己带 recap），不保底：' + b.fallback);
        D.settings.recapWindow = 0;
        const b0 = D.buildBlock();
        assert.ok(b0.fallback === 1 && b0.text.includes('#36·作者摘要'), '保底深度设 0 时 #36 走 recap 保底');
        D.settings.recapWindow = 20;
        // 身份激活：最近楼层提到「医生」→ 周远出完整卡
        const saved = chat[chat.length - 1].mes;
        chat[chat.length - 1].mes = '<content>去找医生。</content>';
        assert.ok(/- 周远｜状态：离场｜身份：医生/.test(D.buildBlock().text), '身份词激活完整卡');
        chat[chat.length - 1].mes = saved;
        // 关键物件履历：条目里提到物件名
        const bag = data.items.find(i => i.name === '牛皮笔袋');
        const e0 = data.entries.find(e => e.src.idx === 0), e5 = data.entries.find(e => e.src.idx === 5);
        e0.tags.push('牛皮笔袋'); e5.summary += '牛皮笔袋被翻出来。';
        assert.ok(D.buildBlock().text.includes('履历：#0 题0 · #5 题5'), '履历行：' + D.buildBlock().text);
        e0.tags.pop(); e5.summary = e5.summary.replace('牛皮笔袋被翻出来。', ''); void bag;
    });
    t('取消隐藏只恢复自己藏的', () => {
        const n = D.unhideAll();
        assert.ok(n > 0);
        assert.strictEqual(chat[17].is_system, false);
        assert.strictEqual(chat[0].is_system, true, '酒馆藏的 0 楼不动');
        assert.deepStrictEqual(data.hidden, {});
    });

    console.log('== 远景折叠 / 时期折叠 / 正典压缩 ==');
    await ta('注入超预算 → 裁掉的条目进待折叠队列 → 折叠成按日骨架 → 注入 ## 远景，被折叠的不再进往事', async () => {
        D.settings.hideSummarized = true; D.hideSummarized();
        D.settings.maxInjectChars = 700; D.settings.foldMin = 3;
        const b = D.buildBlock();
        assert.ok(b.dropped >= 3 && data.outline.pending.length >= 3, '应裁掉若干：' + b.dropped + '/' + data.outline.pending.length);
        const pendingIds = data.outline.pending.slice();
        const did = await D.govern(true);
        assert.ok(did, '治理应有动作');
        assert.ok(foldLog.some(f => f.kind === 'outline' && /同一剧情日、同一目标/.test(f.user) && /压措辞不删事实/.test(f.user)), '折叠提示词含两条硬规则');
        assert.ok(data.outline.lines.length >= 1 && data.outline.lines.every(l => l.level === 1 && /^3月\d+日$/.test(l.key)), '按故事日成行：' + JSON.stringify(data.outline.lines.map(l => l.key)));
        assert.strictEqual(data.outline.pending.length, 0);
        const folded = new Set(data.outline.lines.flatMap(l => l.from));
        assert.ok(pendingIds.every(id => folded.has(id)));
        const b2 = D.buildBlock();
        assert.ok(b2.text.includes('## 远景') && b2.text.includes('骨架】'), '注入含远景');
        for (const id of pendingIds) { const e = data.entries.find(x => x.id === id); assert.ok(!b2.text.includes(`「${e.title}」(B)`), '被折叠条目不再进往事：' + e.title); }
        assert.ok(b2.outline >= 1);
        assert.ok(b2.sizes && b2.sizes.outline > 0 && b2.sizes.ent > 0, '预览分段计数：' + JSON.stringify(b2.sizes));
        assert.ok(data.outline.lines.every(l => Array.isArray(l.dates) && l.dates.length), '日行记下覆盖的楼层 send_date');
    });
    t('远景按楼作废：日行覆盖的楼被删 → 行删除、条目退回待折叠；块首说明可自定义', () => {
        const line = data.outline.lines[0];
        const from = line.from.slice();
        const savedDates = line.dates.slice();
        line.dates = [...savedDates, 'gone'];
        D.reconcile();
        assert.ok(!data.outline.lines.includes(line), '行应作废');
        assert.ok(from.every(id => data.outline.pending.includes(id)), '条目退回待折叠');
        data.outline.pending = data.outline.pending.filter(id => !from.includes(id));
        line.dates = savedDates; data.outline.lines.push(line); data.outline.lines.sort((a, b) => a.idx - b.idx);
        D.settings.headerText = '[自定义块首]\n[第二行]';
        const t2 = D.buildBlock().text;
        assert.ok(t2.includes('[自定义块首]\n[第二行]') && !t2.includes('以上是还留在眼前的对话'));
        D.settings.headerText = '';
    });
    await ta('远景手改行不被覆盖：同一天再折叠另起「·续」行', async () => {
        const line = data.outline.lines[0];
        line.text = '用户手改的骨架'; line.manual = true;
        const e = data.entries.find(x => x.status === 'ok' && !x.manual && D.dayKey(x) === line.key && !line.from.includes(x.id)) || data.entries.find(x => x.status === 'ok' && !x.manual && D.dayKey(x) === line.key);
        data.outline.pending.push(e.id);
        await D.govern(true);
        assert.strictEqual(line.text, '用户手改的骨架', '手改行不动');
        const cont = data.outline.lines.find(l => l.key === `${line.key}·续`);
        assert.ok(cont && cont.from.includes(e.id), '另起续行：' + JSON.stringify(data.outline.lines.map(l => l.key)));
        data.outline.lines = data.outline.lines.filter(l => l !== cont); line.manual = false;
    });
    await ta('远景超预算 → 最老的日行折成一条时期行', async () => {
        for (let i = 0; i < 4; i++) data.outline.lines.push({ id: 'o_x' + i, key: `4月${i + 1}日`, text: '填充'.repeat(60), from: [], idx: 100 + i, last: 100 + i, level: 1, at: 0 });
        D.settings.outlineChars = 500;
        const before = data.outline.lines.length;
        await D.govern(true);
        assert.ok(foldLog.some(f => f.kind === 'period'));
        const p = data.outline.lines.find(l => l.level === 2);
        assert.ok(p && p.merged >= 3 && p.key.includes('～') && p.text.includes('这段时期'), '时期行：' + JSON.stringify(p));
        assert.ok(data.outline.lines.length < before);
        data.outline.lines = data.outline.lines.filter(l => l.level === 1 && !String(l.id).startsWith('o_x'));
        D.settings.outlineChars = 2000;
    });
    await ta('正典压缩：S 超过阈值压成一段，之后新增的 S 逐条附后；喂给摘要模型的骨架含远景与正典', async () => {
        D.settings.canonMax = 3;
        const es = data.entries.filter(e => e.status === 'ok').slice(0, 5);
        for (const e of es) e.grade = 'S';
        await D.govern(true);
        assert.ok(foldLog.some(f => f.kind === 'canon'));
        assert.ok(data.canon.text.includes('不可逆') && data.canon.builtFrom.length === 5, '正典段：' + JSON.stringify(data.canon));
        const later = data.entries.find(e => e.status === 'ok' && e.grade !== 'S' && D.visibleDepths(chat)[e.src.idx] < 0);
        later.grade = 'S';
        const b = D.buildBlock();
        assert.ok(b.text.includes('## 正典') && b.text.includes('不可逆') && b.text.includes(`「${later.title}」`), '压缩段 + 新 S 逐条');
        assert.ok(!b.text.includes(`「${es[0].title}」`) || es[0].title === later.title, '已压缩的 S 不再逐条出现');
        const cx = D.contextText(data);
        assert.ok(cx.includes('正典：') && (!data.outline.lines.length || cx.includes('远景：')), '骨架：' + cx);
        // 有 S 被删（builtFrom 里的 id 消失）→ 不等攒够就重压；手改锁定后连强制都不压
        const n0 = foldLog.length;
        es[4].grade = 'B';
        assert.strictEqual(await D.foldCanon(data, false), true, '丢了 S 应立即重压');
        assert.strictEqual(foldLog.length, n0 + 1); assert.strictEqual(data.canon.builtFrom.length, data.entries.filter(x => x.status === 'ok' && (x.grade === 'S' || x.pinned)).length);
        data.canon.manual = true;
        assert.strictEqual(await D.foldCanon(data, true), false, '手改锁定不压');
        data.canon.manual = false;
        for (const e of es) e.grade = e.src.idx === 2 ? 'S' : 'B';
        later.grade = 'B';
        assert.strictEqual(await D.foldCanon(data, false), true, 'S 降回阈值以内 → 清掉压缩段');
        assert.strictEqual(data.canon.text, '');
        D.settings.canonMax = 25; D.settings.maxInjectChars = 9000;
    });
    await ta('撤销本段：删窗口与条目、档案值退回上一版、远景行作废、楼层恢复显示；之后可重新总结', async () => {
        const w = data.windows.find(w => w.floors.includes(15));   // [15, 17]（send_date 是插旁白前的编号：d14、d16）
        const lu = data.people.find(p => p.name === '陆衍');
        lu.f.age = { v: '40', idx: 17, date: w.dates[1], hist: [{ v: '39', idx: 2, date: 'd2' }] };
        data.outline.lines.push({ id: 'o_undo', key: '9月9日', text: 'x', from: [], dates: [w.dates[0]], idx: 15, last: 15, level: 1, at: 0 });
        D.hideSummarized();
        assert.strictEqual(chat[15].is_system, true);
        const n = D.undoWindow(data, w);
        assert.ok(n >= 2, '回退数：' + n);
        assert.ok(!data.windows.includes(w) && !data.entries.some(e => e.win === w.id));
        assert.ok(D.uncoveredFloors(chat, data, true).includes(15) && D.uncoveredFloors(chat, data, true).includes(17), '楼层回到未总结');
        assert.strictEqual(lu.f.age.v, '39');
        assert.ok(!data.outline.lines.some(l => l.id === 'o_undo'));
        assert.strictEqual(chat[15].is_system, false); assert.strictEqual(chat[14].is_system, false, '前一条用户楼一起恢复'); assert.ok(!data.hidden[w.dates[0]]);
        delete lu.f.age;
        await D.ingest('manual');
        assert.ok(data.windows.some(w => w.floors.includes(15) && w.status === 'ok'), '可重新总结');
    });

    console.log('== 召回：关键词 / 向量 ==');
    t('关键词召回：查询串命中条目 n-gram，最相关的排第一；注入时只捞没渲染的条目', () => {
        const cands = data.entries.filter(e => e.status === 'ok');
        const hits = D.keywordRecall('那把7号钥匙后来呢', cands, 5);
        assert.ok(hits.length >= 1 && data.entries.find(e => e.id === hits[0].id).src.idx === 7, '第一名应是 7 楼：' + JSON.stringify(hits.map(h => data.entries.find(e => e.id === h.id).src.idx)));
        assert.ok(D.termsOf('陆衍在厨房').has('厨房') && !D.termsOf('的了').size);
        assert.ok(D.recallQuery(chat).length > 0);
    });
    await ta('生成前召回：预取 + 等待；被裁掉的条目按话题捞回进 ## 相关往事', async () => {
        D.settings.maxInjectChars = 700;
        chat.push(mkMsg(41, true)); chat[chat.length - 1].mes = '（OOC：忽略）陆衍，那把7号钥匙你藏哪了？';
        D.rc.key = ''; D.rc.result = null;
        await D.recallForPrompt();
        assert.ok(D.rc.result && D.rc.result.entries.length >= 1 && D.rc.result.mode === '关键词', JSON.stringify(D.rc.result));
        const b = D.buildBlock();
        assert.ok(b.text.includes('## 相关往事') && b.text.includes('题7'), '相关往事应含 7 楼：' + b.text);
        assert.ok(b.recalled >= 1);
        const key = D.rc.key;
        await D.recallForPrompt();
        assert.strictEqual(D.rc.key, key, '同一查询串不重算');
        D.settings.maxInjectChars = 9000;
    });
    await ta('向量：窗口入库后同步条目与原文 chunk；对账补缺；查询命中；重建 purge 后重灌；密钥写入槽位', async () => {
        D.settings.recall.vector = true; D.settings.recall.source = 'siliconflow'; D.settings.recall.model = '';
        const r = await D.vecSync(data);
        assert.ok(r.entries >= 10 && r.raw >= 10, '首次补向量：' + JSON.stringify(r));
        assert.ok(vecLog.some(l => l.route === 'insert' && l.collection.startsWith('erato-mem-') && l.source === 'siliconflow' && l.endpoint === 'cn' && l.model === 'Qwen/Qwen3-Embedding-0.6B'));
        assert.ok(vecLog.some(l => l.route === 'insert' && l.collection.startsWith('erato-raw-')));
        assert.strictEqual(Object.keys(data.vec.entries).length, data.entries.filter(e => e.status === 'ok').length);
        const r2 = await D.vecSync(data);
        assert.strictEqual(r2.entries, 0, '第二次对账无需补');
        const q = await D.vecQuery(data, '7号钥匙', 8);
        assert.ok(q.ids.length >= 1 && q.raw.length >= 1, '向量查询：' + JSON.stringify(q));
        assert.ok(q.raw.some(x => x.index === 7 && x.text.includes('7号钥匙藏进了抽屉')), '原文 chunk 命中 7 楼');
        D.rc.key = ''; D.rc.result = null;
        D.settings.maxInjectChars = 700;
        await D.recallForPrompt();
        assert.strictEqual(D.rc.result.mode, '关键词+向量');
        const b = D.buildBlock();
        assert.ok(b.text.includes('## 原文细节') && b.text.includes('#7：') && b.text.includes('藏进了抽屉'), '原文细节：' + b.text);
        assert.ok(b.raw >= 1);
        // 条目删除同步删向量；新窗口入库后自动灌
        const e = data.entries.find(x => x.src.idx === 7);
        await D.vecIndexEntries(data, [e]);
        const n0 = vecLog.length;
        chat.push(mkMsg(42, false), mkMsg(43, true), mkMsg(44, false));
        await D.ingest('manual');
        await sleep(20);
        assert.ok(vecLog.slice(n0).some(l => l.route === 'insert'), '入库后应同步向量');
        const rr = await D.vecRebuild();
        assert.ok(vecLog.some(l => l.route === 'purge') && rr.entries >= 10);
        const secretsBefore = secrets.length;
        assert.strictEqual(await D.writeVecSecret('sk-test'), 'api_key_siliconflow');
        assert.strictEqual(secrets[secretsBefore].key, 'api_key_siliconflow');
        D.settings.recall.source = 'vllm'; D.settings.recall.apiUrl = 'https://emb.example.com/v1/'; D.settings.recall.model = 'bge-m3';
        assert.deepStrictEqual(D.vecBody(), { source: 'vllm', apiUrl: 'https://emb.example.com', model: 'bge-m3' });
        D.settings.recall.source = 'siliconflow'; D.settings.recall.vector = false; D.settings.maxInjectChars = 9000;
        D.rc.key = ''; D.rc.result = null;
    });
    t('原文切块：长文按句末切、带重叠', () => {
        const chunks = D.chunkText(('陆衍在厨房里做了一个决定。').repeat(120));
        assert.ok(chunks.length >= 3 && chunks.every(c => c.length <= 800) && chunks[0].endsWith('。'));
    });

    console.log('== 手动条目 ==');
    t('手动条目参与注入、对账不孤立、越界回夹', () => {
        const e = D.addManualEntry({ title: '手动题', summary: '手动记的事', grade: 'A', idx: 3 });
        assert.ok(e.manual && e.src.send_date.startsWith('manual:'));
        D.reconcile();
        assert.strictEqual(e.status, 'ok');
        assert.ok(D.buildBlock().text.includes('手动记的事'));
        e.src.idx = 999; D.reconcile(); assert.strictEqual(e.src.idx, chat.length - 1);
    });

    console.log('== 事件密度 / 截断重试 / 停止 / 清空世代 / 残影清理 / 补人物 ==');
    t('密度下限换算', () => {
        D.settings.minEventsPer = 4;
        assert.strictEqual(D.minEventsFor(16), 4); assert.strictEqual(D.minEventsFor(5), 2); assert.strictEqual(D.minEventsFor(1), 1);
        D.settings.minEventsPer = 0; assert.strictEqual(D.minEventsFor(16), 1);
        D.settings.minEventsPer = 4;
    });
    await ta('事件太少 → 先纠正重试一次，仍太少视为过度压缩走拆半，切到单楼后通过', async () => {
        chat.push(mkMsg(45, true), mkMsg(46, false), mkMsg(47, true), mkMsg(48, false));
        D.settings.minEventsPer = 1; mode.fewEvents = true;
        const n0 = apiLog.length;
        await D.ingest('manual');
        mode.fewEvents = false; D.settings.minEventsPer = 4;
        const ws = data.windows.filter(w => w.floors.some(i => i >= 46));
        assert.ok(ws.every(w => w.status === 'ok' && w.floors.length === 1), '应全部切到单楼：' + ws.map(w => w.floors.join('+') + ':' + w.status).join(' '));
        const calls = apiLog.slice(n0);
        assert.ok(calls.some(f => f.floors.length === 2) && calls.some(f => f.correction === 'density'), '应先试过 2 楼窗口并做过一次密度纠正');
        assert.strictEqual(D.uncoveredFloors(chat, data, true).length, 0);
    });
    await ta('finish_reason=length → 带长度约束重来一次，成功入库并留档', async () => {
        chat.push(mkMsg(49, true), mkMsg(50, false));
        mode.finishLength = 1;
        const n0 = apiLog.length;
        await D.ingest('manual');
        const calls = apiLog.slice(n0);
        assert.strictEqual(calls.length, 2, '应恰好两次调用：' + calls.length);
        assert.ok(!calls[0].retry && calls[1].retry && calls[1].msgs === 4, '第二次带截断提示');
        const w = data.windows.find(w => w.floors.includes(50));
        assert.strictEqual(w.status, 'ok');
        assert.strictEqual(data.rawLog[0].note, '压缩重试'); assert.strictEqual(data.rawLog[1].finish, 'length');
    });
    await ta('停止：在飞的副 API 请求被中止，窗口保持待处理、不计失败', async () => {
        chat.push(mkMsg(51, true), mkMsg(52, false));
        mode.slow = true;
        const p = D.ingest('manual');
        await sleep(30);
        assert.ok(D.run.busy);
        D.stopRun();
        await p;
        mode.slow = false;
        const w = data.windows.find(w => w.floors.includes(52));
        assert.ok(w && w.status === 'pending' && w.attempts === 0 && w.last_error === '已停止', JSON.stringify({ s: w?.status, a: w?.attempts, e: w?.last_error }));
        await D.ingest('manual');
        assert.strictEqual(w.status, 'ok');
    });
    await ta('调用期间库被清空：结果作废，不写进新库', async () => {
        chat.push(mkMsg(53, true), mkMsg(54, false));
        const old = D.getData();
        mode.clearDuring = true;
        await D.ingest('manual');
        const fresh = D.getData();
        assert.notStrictEqual(fresh, old, '库应已换');
        assert.strictEqual(fresh.entries.length, 0); assert.strictEqual(fresh.windows.length, 0); assert.strictEqual(fresh.people.length, 0);
        ctx.chatMetadata.eratoMemory = old;
        old.windows = old.windows.filter(w => !w.floors.includes(54));
        old.entries = old.entries.filter(e => !e.src.floors?.includes(54));
    });
    t('残影清理：窗口不存在且楼层已被正常窗口覆盖的条目删除；未覆盖的保留为孤立', () => {
        const mk = (id, win, idx, dates) => ({ id, win, ord: 0, status: 'ok', manual: false, title: id, summary: id + ' 的摘要文字', grade: 'B', type: 'plot', characters: [], src: { idx, floors: [idx], dates } });
        data.entries.push(mk('ghost', 'gone', 2, [chat[2].send_date]), mk('lonely', 'gone2', 2, ['dZ']));
        D.reconcile();
        assert.ok(!data.entries.some(e => e.id === 'ghost'), '残影应删除');
        const lonely = data.entries.find(e => e.id === 'lonely');
        assert.ok(lonely && lonely.status === 'orphan', '未覆盖的保留为孤立');
        data.entries = data.entries.filter(e => e.id !== 'lonely');
    });
    t('从事件补人物：删掉的人按事件 characters 重建', () => {
        data.people = data.people.filter(p => p.name !== '小刘');
        assert.strictEqual(D.backfillPeople(), 1);
        const liu = data.people.find(p => p.name === '小刘');
        assert.ok(liu && liu.first_idx === 2 && liu.seen === 1);
        assert.strictEqual(D.backfillPeople(), 0, '幂等');
    });

    console.log('== 档位 / 状态：只升不降、手改锁、自动升配、终态物件、活跃度、筛选 ==');
    const merge = obj => D.mergeEntities(data, obj, { floors: [2] }, new Map([[2, chat[2]]]), []);
    t('档位只升不降；手改锁住后副 AI 报更高档也不动；选回未定即解锁', () => {
        const lu = data.people.find(p => p.name === '陆衍');
        merge({ cast: [{ name: '陆衍', tier: '龙套', seen: [2] }] });
        assert.strictEqual(lu.tier, '配');
        merge({ cast: [{ name: '陆衍', tier: '主', seen: [2] }] });
        assert.strictEqual(lu.tier, '主', '升档放行');
        lu.tier = '龙套'; lu.tierLock = true;
        merge({ cast: [{ name: '陆衍', tier: '主', seen: [2] }] });
        assert.strictEqual(lu.tier, '龙套', '手改锁住不动');
        lu.tier = '配'; lu.tierLock = false;
    });
    t('状态最新为准、手改锁；物件关键性只升不降', () => {
        const lu = data.people.find(p => p.name === '陆衍');
        merge({ people: [{ name: '陆衍', state: '离场', floor: 2 }] });
        assert.strictEqual(lu.state, '离场');
        merge({ people: [{ name: '陆衍', state: '乱写', floor: 2 }] });
        assert.strictEqual(lu.state, '离场', '不在枚举里的忽略');
        lu.stateLock = true;
        merge({ people: [{ name: '陆衍', state: '死亡', floor: 2 }] });
        assert.strictEqual(lu.state, '离场', '手改锁住不动');
        lu.state = '在场'; lu.stateLock = false;
        const bag = data.items.find(i => i.name === '牛皮笔袋');
        merge({ items: [{ name: '牛皮笔袋', tier: '摆设', floor: 2 }] });
        assert.strictEqual(bag.tier, '关键', '物件关键性只升不降');
        merge({ items: [{ name: '咖啡杯', tier: '次要', floor: 2 }] });
        assert.strictEqual(data.items.find(i => i.name === '咖啡杯').tier, '次要');
        merge({ items: [{ name: '咖啡杯', tier: '摆设', status: '缺口', floor: 2 }] });
        const cup = data.items.find(i => i.name === '咖啡杯');
        assert.strictEqual(cup.tier, '次要'); assert.strictEqual(cup.f.note.v, '缺口', '旧键名 status 仍落到 note');
        cup.tier = '摆设';
    });
    t('终态物件：注入降成一行「已了结」，不再出完整卡', () => {
        const bag = data.items.find(i => i.name === '牛皮笔袋');
        merge({ items: [{ name: '牛皮笔袋', state: '已使用', floor: 2 }] });
        assert.strictEqual(bag.state, '已使用');
        const text = D.buildBlock().text;
        assert.ok(text.includes('已了结：牛皮笔袋（已使用·陆衍）'), text);
        assert.ok(!text.includes('牛皮笔袋｜'), '终态不出完整卡');
        bag.state = '在用';
    });
    t('龙套累计露面 ≥3 段自动升配；A 事件里点到的也升', () => {
        merge({ cast: [{ name: '门房', tier: '龙套', seen: [2] }] });
        merge({ cast: [{ name: '门房', tier: '龙套', seen: [2] }] });
        const gk = data.people.find(p => p.name === '门房');
        assert.strictEqual(gk.tier, '龙套'); assert.strictEqual(gk.seen, 2);
        merge({ cast: [{ name: '门房', tier: '龙套', seen: [2] }] });
        assert.strictEqual(gk.tier, '配', '第 3 段升配');
        D.mergeEntities(data, { cast: [{ name: '保安', tier: '龙套', seen: [2] }] }, { floors: [2] }, new Map([[2, chat[2]]]), [{ src: { idx: 2 }, characters: ['保安'], grade: 'A' }]);
        assert.strictEqual(data.people.find(p => p.name === '保安').tier, '配');
        D.mergeEntities(data, { cast: [{ name: '收银员', tier: '龙套', seen: [2] }] }, { floors: [2] }, new Map([[2, chat[2]]]), [{ src: { idx: 2 }, characters: ['收银员'], grade: 'B' }]);
        assert.strictEqual(data.people.find(p => p.name === '收银员').tier, '龙套', 'B 事件不升');
        data.people = data.people.filter(p => !['门房', '保安', '收银员'].includes(p.name));
    });
    t('活跃度与筛选：近期 = 最近几楼提到；沉寂 = 100 楼未露面；档位/状态/持有者/搜索各自可筛', () => {
        const lu = data.people.find(p => p.name === '陆衍');
        const wang = data.people.find(p => p.name === '司机老王');
        const recent = '陆衍在厨房'.toLowerCase();
        assert.strictEqual(D.heatOf(lu, recent, chat.length), 'recent');
        assert.strictEqual(D.heatOf(wang, recent, chat.length), 'listed');
        assert.strictEqual(D.heatOf(wang, recent, wang.last_idx + 102), 'dormant');
        const F = D.entFilter;
        F.p.tier = '龙套'; assert.ok(D.matchEnt('p', wang, 'listed') && !D.matchEnt('p', lu, 'recent'));
        F.p.tier = 'none'; assert.ok(!D.matchEnt('p', wang, 'listed'));
        F.p.tier = ''; F.p.heat = 'recent'; assert.ok(D.matchEnt('p', lu, 'recent') && !D.matchEnt('p', wang, 'listed'));
        F.p.heat = ''; F.p.q = '小衍'; assert.ok(D.matchEnt('p', lu, 'recent') && !D.matchEnt('p', wang, 'listed'), '别称可搜');
        F.p.q = '';
        const bag = data.items.find(i => i.name === '牛皮笔袋'), cup = data.items.find(i => i.name === '咖啡杯');
        F.i.holder = '陆衍'; assert.ok(D.matchEnt('i', bag) && !D.matchEnt('i', cup));
        F.i.holder = ''; F.i.state = 'settled'; bag.state = '遗失'; assert.ok(D.matchEnt('i', bag) && !D.matchEnt('i', cup)); bag.state = '在用';
        F.i.state = ''; F.i.q = '完好'; assert.ok(D.matchEnt('i', bag), '备注可搜'); F.i.q = '';
    });
    t('旧数据：物件的自由文本 status 读取时改名 note，档位/状态键补空；v0.3 数据缺新字段自动补齐', () => {
        data.items.push({ id: 'i_old', name: '旧伞', f: { status: { v: '破了', idx: 2 } }, first_idx: 2, last_idx: 2 });
        delete data.outline; delete data.tombstones; delete data.vec; delete data.recaps;
        const d = D.getData();
        const old = d.items.find(i => i.id === 'i_old');
        assert.strictEqual(old.f.note.v, '破了'); assert.ok(!old.f.status); assert.strictEqual(old.tier, ''); assert.strictEqual(old.state, '');
        assert.ok(Array.isArray(d.outline.lines) && Array.isArray(d.outline.pending) && d.tombstones.p && d.vec.entries && d.recaps);
        d.items = d.items.filter(i => i.id !== 'i_old');
    });

    console.log('== 迁移 v1 → v2 ==');
    t('旧的逐楼条目变成单楼窗口，失败占位条目丢掉但窗口保留其失败状态', () => {
        const old = {
            version: 1,
            entries: [
                { id: 'a', src: { idx: 2, send_date: 'd2', hash: 'h' }, status: 'ok', summary: '旧摘要', title: '旧', grade: 'B' },
                { id: 'b', src: { idx: 5, send_date: 'd5', hash: 'h' }, status: 'failed', attempts: 2, last_error: 'x', summary: '' },
                { id: 'c', manual: true, src: { idx: 3, send_date: 'manual:c', hash: '' }, status: 'ok', summary: '手动' },
            ],
        };
        D.migrateV1(old);
        assert.strictEqual(old.version, 2);
        assert.strictEqual(old.windows.length, 2);
        assert.strictEqual(old.entries.length, 2, '失败占位条目应丢弃');
        const wa = old.windows.find(w => w.dates[0] === 'd2');
        assert.strictEqual(wa.status, 'ok');
        assert.strictEqual(old.entries.find(e => e.id === 'a').win, wa.id);
        assert.deepStrictEqual(old.entries.find(e => e.id === 'a').src, { idx: 2, floors: [2], dates: ['d2'], fallback: false });
        const wb = old.windows.find(w => w.dates[0] === 'd5');
        assert.strictEqual(wb.status, 'failed'); assert.strictEqual(wb.attempts, 2);
    });

    console.log('== 抠取 / JSON ==');
    t('说戏 COT 不进正文', () => { const c = D.extractContent(chat[2].mes); assert.ok(!c.text.includes('备选走向') && c.text.includes('正文第2楼') && !c.fallback); });
    t('缺 </content> 走兜底', () => { const c = D.extractContent('<think>x</think><content>正文<details>d</details>'); assert.ok(c.fallback && c.text === '正文'); });
    t('JSON 修复链', () => { assert.strictEqual(D.parseJson('```json\n{"summary": "a\nb", "grade": "S",}\n```').summary, 'a\nb'); assert.strictEqual(D.parseJson('{"summary": "截断').summary, '截断'); });

    console.log('== 设置迁移：楼数单位 ==');
    t('v0.3.1 旧设置（AI 楼计）加载时翻倍；新装用新默认；已迁移的不重复翻倍；v0.2 直升不把默认值翻倍；v0.3 设置补齐 recall 组', () => {
        const load = saved => { ctx.extensionSettings = saved ? { 'erato-memory': saved } : {}; new Function(src)(); return ctx.extensionSettings['erato-memory']; };
        let s = load({ autoInterval: 10, windowFloors: 20, enabled: true });
        assert.strictEqual(s.autoInterval, 20); assert.strictEqual(s.windowFloors, 40); assert.strictEqual(s.floorUnit, 'chat');
        assert.strictEqual(s.recall.keyword, true); assert.strictEqual(s.recall.vector, false); assert.strictEqual(s.recall.source, 'siliconflow'); assert.strictEqual(s.canonMax, 25); assert.strictEqual(s.recapWindow, 20);
        assert.strictEqual(s.autoFold, 'batch'); assert.strictEqual(s.headerText, '');
        s = load({ autoInterval: 0, windowFloors: 50, enabled: true });
        assert.strictEqual(s.autoInterval, 0, '手动模式保持 0'); assert.strictEqual(s.windowFloors, 100);
        s = load(null);
        assert.strictEqual(s.autoInterval, 20); assert.strictEqual(s.windowFloors, 40); assert.strictEqual(s.floorUnit, 'chat');
        s = load({ autoInterval: 30, windowFloors: 60, floorUnit: 'chat' });
        assert.strictEqual(s.autoInterval, 30); assert.strictEqual(s.windowFloors, 60);
        s = load({ autoIngest: true, enabled: true });
        assert.strictEqual(s.autoInterval, 20, 'v0.2 没有间隔设置，用新默认不翻倍'); assert.strictEqual(s.windowFloors, 40);
    });

    console.log(`\n${pass} passed${process.exitCode ? ' (有失败)' : ''}`);
    setTimeout(() => process.exit(process.exitCode || 0), 50);
})();
