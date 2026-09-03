// Erato Memory v0.3.3 桩环境冒烟测试：不依赖酒馆，只验证纯逻辑（楼数口径 / 窗口切分 / 拆半重试 / 点名表与档案合并 / 事件密度 / 截断重试 / 清空世代 / 残影清理 / 对账 / 隐藏 / 注入 / 迁移）
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

// ---- 假副 API：材料里超过 2 楼就「拒答」（逼出拆半重试），否则每楼回一条事件 + 点名表 + 档案 ----
// mode.fewEvents：只回 1 条事件（测密度下限）；mode.finishLength：前 N 次回 finish_reason=length（测截断重试）；
// mode.clearDuring：调用期间把库换掉（测清空世代）
const apiLog = [];
const mode = { fewEvents: false, finishLength: 0, clearDuring: false };
global.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    const user = body.messages[1].content;
    const floors = [...user.matchAll(/【#(\d+)】/g)].map(m => Number(m[1]));
    apiLog.push({ floors, msgs: body.messages.length, retry: body.messages.length > 2 && /截断/.test(body.messages[body.messages.length - 1].content) });
    if (mode.clearDuring) { mode.clearDuring = false; ctx.chatMetadata.eratoMemory = { version: 2 }; }
    let content, finish = 'stop';
    const ev = i => ({ floors: [i], story_time: `3月${i}日 · 午后 · 厨房`, type: 'plot', title: `题${i}`, summary: `第${i}楼发生的事情，陆衍在厨房里做了决定。`, characters: ['陆衍', i === 2 ? '小刘' : '用户'], grade: i === 2 ? 'S' : 'B', tags: ['厨房'] });
    if (floors.length > 2) content = '抱歉，我无法协助处理这段内容。';
    else if (mode.finishLength > 0) { mode.finishLength--; finish = 'length'; content = '{"cast": [{"name": "陆衍"'; }
    else content = JSON.stringify({
        cast: [
            { name: '陆衍', aliases: ['小衍'], tier: '配', role: '邻居', seen: floors },
            { name: '周远', tier: '配', role: '医生', seen: [floors[0]] },
            { name: '司机老王', tier: '龙套', role: '司机', seen: [floors[0]] },
            { name: 'Char', tier: '主' }, { name: '用户', tier: '主' },
            floors[0] <= 5 ? { name: '陆母', aliases: ['母亲'], tier: '配', role: '用户的母亲', seen: [floors[0]] }
                : { name: '王秀英', aliases: ['陆母'], tier: '配', seen: [floors[0]] },
        ],
        events: (mode.fewEvents ? [floors[0]] : floors).map(ev),
        relation: `对用户从戒备转为依赖（#${floors[floors.length - 1]}）`,
        people: [
            { name: '陆衍', aliases: ['小衍'], role: '邻居', rel_user: '暧昧', status: '在场', arc: '试探期', views: [{ to: '用户', v: '越来越依赖', trend: '亲密' }, { to: '周远', v: '提防', trend: '反感' }, { to: '陆衍', v: '自恋不算' }], floor: floors[0] },
            { name: '周远', role: '医生', floor: floors[0] },
            { name: 'Char', rel_user: '不该建档' },
            { name: '用户', role: '不该建档' },
        ],
        items: [{ name: '牛皮笔袋', holder: '陆衍', status: '完好', floor: floors[0] }],
    });
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }) };
};

// ---- 假酒馆 ----
const mkMsg = (i, isUser, opts = {}) => ({
    name: isUser ? 'User' : 'Char', is_user: isUser, is_system: !!opts.hidden, send_date: `d${i}`,
    mes: isUser ? `用户第${i}楼` : `<think_format>备选走向</think_format><content>正文第${i}楼：陆衍在厨房。</content><details><summary>📍状态</summary>x</details><recap><details><summary>📜</summary>**3月${i}日 · 午后 · 厨房**\n叙述${i}</details></recap>`,
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
    t('默认模板替换全部占位符，材料按楼编号', () => {
        const wins = D.planWindows(chat, data, [2, 5]);
        const floors = wins[0].floors.map(i => ({ idx: i, userText: 'U', content: 'C正文' + i, recap: { storyTime: '3月1日', narrative: 'N' } }));
        const msgs = D.buildMessages({ floors, recent: [], data });
        assert.ok(!/\{\{(name1|name2|roster|relation|recent|floor_range|floor_count|material|min_events|max_events|directive)\}\}/.test(msgs[1].content), '占位符残留');
        assert.ok(msgs[1].content.includes('"cast"') && msgs[1].content.includes('亲属'), '模板应含点名表与亲属明文');
        assert.ok(msgs[1].content.includes('【#2】') && msgs[1].content.includes('【#5】') && msgs[1].content.includes('#2–#5') && msgs[1].content.includes('用户角色：用户'));
    });
    t('自定义模板缺 {{material}} 时退回默认', () => {
        D.settings.promptTemplate = '坏模板 {{recent}}';
        const msgs = D.buildMessages({ floors: [{ idx: 1, userText: '', content: 'XYZ', recap: {} }], recent: [], data });
        assert.ok(msgs[1].content.includes('XYZ') && msgs[1].content.includes('等级标准'));
        D.settings.promptTemplate = '';
    });

    console.log('== 入库（假副 API：>2 楼拒答 → 拆半） ==');
    D.settings.api.url = 'https://x/v1'; D.settings.api.key = 'k'; D.settings.api.model = 'm';
    D.settings.autoInterval = 20; D.settings.windowFloors = 8; D.settings.hideSummarized = false;
    await ta('手动总结到当前：拒答窗口对半拆，最终全部楼层入库', async () => {
        await D.ingest('manual');
        assert.ok(data.windows.every(w => w.status === 'ok'), '窗口应全部 ok：' + data.windows.map(w => w.status).join(','));
        assert.deepStrictEqual(data.windows.map(w => w.floors), [[0, 2], [5], [7, 9], [11, 13], [15, 17], [19]]);
        assert.ok(apiLog.some(f => f.floors.length === 5), '应先尝试过 5 个 AI 楼（8 楼）的窗口');
        assert.strictEqual(D.uncoveredFloors(chat, data, true).length, 0);
        assert.strictEqual(data.entries.length, 10);
        assert.ok(data.entries.every(e => e.status === 'ok' && e.win && e.src.floors.length === 1));
        assert.strictEqual(data.entries.find(e => e.src.idx === 2).grade, 'S');
    });
    t('档案合并：主角不建档，点名表建档带档位，事件里点到的人也建档，别称升级真名，views/arc 落地', () => {
        const names = data.people.map(p => p.name);
        assert.deepStrictEqual(names.sort(), ['司机老王', '周远', '小刘', '王秀英', '陆衍'].sort(), '人物：' + names.join(','));
        const lu = data.people.find(p => p.name === '陆衍');
        assert.deepStrictEqual(lu.aliases, ['小衍']);
        assert.strictEqual(lu.tier, '配');
        assert.strictEqual(lu.f.role.v, '邻居');
        assert.strictEqual(lu.f.role.idx, 19, '最后一窗覆盖后来源楼应为 19');
        assert.strictEqual(lu.f.arc.v, '试探期');
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
        assert.ok(liu && liu.first_idx === 2 && !liu.tier, '事件 characters 反哺建档，只有名字与楼层');
        assert.strictEqual(data.people.find(p => p.name === '司机老王').tier, '龙套');
        assert.strictEqual(data.items.length, 1);
        assert.strictEqual(data.items[0].f.holder.v, '陆衍');
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

    console.log('== 隐藏 / 恢复 ==');
    t('保留最近 6 条可见，其余已总结楼层及其前一条用户楼被藏；用户手动藏的 0 楼不进 hidden 表', () => {
        D.settings.hideSummarized = true; D.settings.keepVisible = 6;
        const n = D.hideSummarized();
        assert.ok(n > 0, '应隐藏若干');
        for (let i = 19; i <= 24; i++) assert.strictEqual(chat[i].is_system, false, `#${i} 应可见`);
        assert.strictEqual(chat[17].is_system, true, '#17 AI 已总结应藏');
        assert.strictEqual(chat[16].is_system, true, '#16 用户楼跟着藏');
        assert.strictEqual(chat[18].is_system, false, '#18 用户楼在保留区外但其后 #19 在保留区内，不藏');
        assert.ok(!data.hidden['d0'], '0 楼本来就是酒馆藏的，不记进表');
        assert.strictEqual(domAttrs['17'], 'true');
        assert.strictEqual(ctx.savedChat, 1, '保存一次聊天');
    });
    t('再次调用幂等', () => { assert.strictEqual(D.hideSummarized(), 0); assert.strictEqual(ctx.savedChat, 1); });
    t('注入：隐藏楼层的条目全部注入，S 进正典；档案在前，提到的人物出完整卡（含阶段/看法），其余只列名，龙套不注入', () => {
        D.applyInjection?.();
        const b = D.buildBlock();
        assert.ok(b.text.includes('题13') && b.text.includes('题2'), '隐藏楼层条目应注入');
        assert.ok(b.text.includes('## 正典') && b.text.includes('## 关系现状') && b.text.includes('## 人物志') && b.text.includes('## 物件'));
        assert.ok(b.text.indexOf('## 人物志') < b.text.indexOf('## 正典'));
        assert.ok(b.text.includes('[以上是还留在眼前的对话') && b.text.includes('信息墙'), '块首四行');
        assert.ok(/- 陆衍（小衍）｜身份：邻居/.test(b.text), '陆衍在最近楼层出现，出完整卡');
        assert.ok(b.text.includes('阶段：试探期') && b.text.includes('看法：对用户·亲密·越来越依赖；对周远·反感·提防'), '完整卡含阶段与看法');
        const brief = /其他已登场：([^\n]*)/.exec(b.text)?.[1] || '';
        assert.ok(brief.includes('周远·医生') && brief.includes('王秀英（母亲/陆母）·用户的母亲') && brief.includes('小刘'), '没露面的只列名（带别称）：' + brief);
        assert.ok(!b.text.includes('司机老王'), '龙套不进注入块');
        assert.ok(b.text.includes('牛皮笔袋｜持有者：陆衍'));
        assert.ok(!b.text.includes('题22'), '#22 在正文窗口内不注入');
    });
    t('取消隐藏只恢复自己藏的', () => {
        const n = D.unhideAll();
        assert.ok(n > 0);
        assert.strictEqual(chat[17].is_system, false);
        assert.strictEqual(chat[0].is_system, true, '酒馆藏的 0 楼不动');
        assert.deepStrictEqual(data.hidden, {});
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

    console.log('== 事件密度 / 截断重试 / 清空世代 / 残影清理 / 补人物 ==');
    t('密度下限换算', () => {
        D.settings.minEventsPer = 4;
        assert.strictEqual(D.minEventsFor(16), 4); assert.strictEqual(D.minEventsFor(5), 2); assert.strictEqual(D.minEventsFor(1), 1);
        D.settings.minEventsPer = 0; assert.strictEqual(D.minEventsFor(16), 1);
        D.settings.minEventsPer = 4;
    });
    await ta('事件太少 → 视为过度压缩走拆半，切到单楼后通过', async () => {
        chat.push(mkMsg(25, true), mkMsg(26, false), mkMsg(27, true), mkMsg(28, false));   // 未入库 AI 楼：24, 26, 28
        D.settings.minEventsPer = 1; mode.fewEvents = true;
        const n0 = apiLog.length;
        await D.ingest('manual');
        mode.fewEvents = false; D.settings.minEventsPer = 4;
        const ws = data.windows.filter(w => w.floors.some(i => i >= 24));
        assert.ok(ws.every(w => w.status === 'ok' && w.floors.length === 1), '应全部切到单楼：' + ws.map(w => w.floors.join('+') + ':' + w.status).join(' '));
        assert.ok(apiLog.slice(n0).some(f => f.floors.length === 2), '应先试过 2 楼窗口');
        assert.strictEqual(D.uncoveredFloors(chat, data, true).length, 0);
    });
    await ta('finish_reason=length → 带长度约束重来一次，成功入库并留档', async () => {
        chat.push(mkMsg(29, true), mkMsg(30, false));
        mode.finishLength = 1;
        const n0 = apiLog.length;
        await D.ingest('manual');
        const calls = apiLog.slice(n0);
        assert.strictEqual(calls.length, 2, '应恰好两次调用：' + calls.length);
        assert.ok(!calls[0].retry && calls[1].retry && calls[1].msgs === 4, '第二次带截断提示');
        const w = data.windows.find(w => w.floors.includes(30));
        assert.strictEqual(w.status, 'ok');
        assert.strictEqual(data.rawLog[0].note, '压缩重试'); assert.strictEqual(data.rawLog[1].finish, 'length');
    });
    await ta('调用期间库被清空：结果作废，不写进新库', async () => {
        chat.push(mkMsg(31, true), mkMsg(32, false));
        const old = D.getData();
        mode.clearDuring = true;
        await D.ingest('manual');
        const fresh = D.getData();
        assert.notStrictEqual(fresh, old, '库应已换');
        assert.strictEqual(fresh.entries.length, 0); assert.strictEqual(fresh.windows.length, 0); assert.strictEqual(fresh.people.length, 0);
        ctx.chatMetadata.eratoMemory = old;
        old.windows = old.windows.filter(w => !w.floors.includes(32));
        old.entries = old.entries.filter(e => !e.src.floors?.includes(32));
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
    t('v0.3.1 旧设置（AI 楼计）加载时翻倍；新装用新默认；已迁移的不重复翻倍；v0.2 直升不把默认值翻倍', () => {
        const load = saved => { ctx.extensionSettings = saved ? { 'erato-memory': saved } : {}; new Function(src)(); return ctx.extensionSettings['erato-memory']; };
        let s = load({ autoInterval: 10, windowFloors: 20, enabled: true });
        assert.strictEqual(s.autoInterval, 20); assert.strictEqual(s.windowFloors, 40); assert.strictEqual(s.floorUnit, 'chat');
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
