// Erato Memory v0.2.1 桩环境冒烟测试：不依赖酒馆，只验证纯逻辑
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

console.log('== 楼层判定 ==');
const data = D.getData();
t('系统旁白(extra.type)不算 AI 楼；被酒馆隐藏的 AI 楼算', () => {
    const todo = D.pendingFloors(chat, data);
    assert.ok(!todo.includes(4), '旁白不应入库');
    assert.ok(todo.includes(0), '隐藏的 0 楼应入库');
    assert.ok(!todo.includes(20) && !todo.includes(19), 'depth<2 不入库');
});
t('可见深度：隐藏层=-1，其余按可见计数', () => {
    const d = D.visibleDepths(chat);
    assert.strictEqual(d[0], -1); assert.strictEqual(d[4], -1);
    assert.strictEqual(d[20], 0); assert.strictEqual(d[19], 1);
    assert.strictEqual(d[1], 18);   // 21 层里 2 层隐藏，1 楼后面有 18 条可见
});

console.log('== 模板 ==');
t('默认模板替换全部占位符', () => {
    const msgs = D.buildMessages({ userText: 'U', content: 'C正文', recap: { storyTime: '3月1日', narrative: 'N' }, recent: [] });
    assert.ok(!/\{\{(name1|name2|recent|user_text|content|recap|directive)\}\}/.test(msgs[1].content), '占位符残留');
    assert.ok(msgs[1].content.includes('C正文') && msgs[1].content.includes('用户角色：用户'));
});
t('自定义模板缺 {{content}} 时退回默认', () => {
    D.settings.promptTemplate = '坏模板 {{recap}}';
    const msgs = D.buildMessages({ userText: '', content: 'XYZ', recap: { storyTime: '', narrative: '' }, recent: [] });
    assert.ok(msgs[1].content.includes('XYZ') && msgs[1].content.includes('等级标准'));
    D.settings.promptTemplate = '';
});

console.log('== 隐藏 / 恢复 ==');
// 伪造：0..14 楼的 AI 层都已总结成功
for (let i = 0; i < chat.length; i++) {
    const m = chat[i];
    if (m.is_user || m.extra) continue;
    if (i > 14) continue;
    data.entries.push({ id: 'em' + i, manual: false, src: { idx: i, send_date: m.send_date, hash: '' }, status: 'ok', grade: i === 2 ? 'S' : 'B', pinned: false,
        story_time: `3月${i}日`, title: '题' + i, summary: '摘要' + i, characters: [], known_by: [], tags: [], type: 'plot', emotion_shift: '' });
}
t('保留最近 6 条可见，其余已总结的 AI 楼及其前一条用户楼被藏；用户手动藏的 0 楼不进 hidden 表', () => {
    D.settings.hideSummarized = true; D.settings.keepVisible = 6;
    const n = D.hideSummarized();
    assert.ok(n > 0, '应隐藏若干');
    // 最后 6 条可见 = idx 15..20（15 是 AI 未总结，16 用户 ...）；cut 之前：idx ≤ 14
    for (let i = 15; i <= 20; i++) assert.strictEqual(chat[i].is_system, false, `#${i} 应可见`);
    // 插入旁白后：#13 = AI(d12) 已总结 → 藏；#12 = 用户楼跟着藏；#14 = 用户楼，其后 #15 AI 未总结 → 不藏
    assert.strictEqual(chat[13].is_system, true, '#13 AI 已总结应藏');
    assert.strictEqual(chat[12].is_system, true, '#12 用户楼跟着藏');
    assert.strictEqual(chat[14].is_system, false, '#14 用户楼后面的 AI 未总结，不藏');
    assert.ok(!data.hidden['d0'], '0 楼本来就是酒馆藏的，不记进表');
    assert.ok(data.hidden['d12'] && data.hidden['d11']);
    assert.strictEqual(domAttrs['13'], 'true');
    assert.strictEqual(ctx.savedChat, 1, '保存一次聊天');
});
t('用户楼后面不是已总结 AI 楼时不藏', () => {
    assert.strictEqual(chat[3].is_system, false, '#3 后面是 #4 旁白，不藏');
});
t('再次调用幂等，不重复保存', () => { assert.strictEqual(D.hideSummarized(), 0); assert.strictEqual(ctx.savedChat, 1); });
t('注入：隐藏楼层的条目全部注入，可见但深度不足的不注入', () => {
    const b = D.buildBlock();
    assert.ok(b.text.includes('题13') && b.text.includes('题2'), '隐藏楼层条目应注入');
    assert.ok(b.text.includes('## 正典'), 'S 进正典');
    // 加一条挂在 #17（可见，深度 3）的条目 → 不注入
    data.entries.push({ id: 'emv', src: { idx: 17, send_date: 'd17', hash: '' }, status: 'ok', grade: 'B', title: '窗口内', summary: '窗口内摘要', characters: [], known_by: [], tags: [], type: 'plot', emotion_shift: '' });
    assert.ok(!D.buildBlock().text.includes('窗口内'), '深度 3 < 6 不注入');
    data.entries.pop();
});
t('取消隐藏只恢复自己藏的', () => {
    const n = D.unhideAll();
    assert.ok(n > 0);
    assert.strictEqual(chat[13].is_system, false);
    assert.strictEqual(chat[0].is_system, true, '酒馆藏的 0 楼不动');
    assert.deepStrictEqual(data.hidden, {});
});
t('用户手动取消过隐藏的楼层不再自动藏（hidden 表里有但可见）', () => {
    D.hideSummarized();
    chat[13].is_system = false;            // 用户在酒馆里手动取消隐藏
    assert.strictEqual(D.hideSummarized(), 0);
    assert.strictEqual(chat[13].is_system, false);
    D.unhideAll();
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
t('reconcile 对被隐藏的 AI 楼层仍能定位（byDate 含 is_system）', () => {
    chat[13].is_system = true;
    D.reconcile();
    const e13 = data.entries.find(x => x.id === 'em13');
    assert.notStrictEqual(e13.status, 'orphan', '隐藏楼层仍应被定位到');
    assert.strictEqual(e13.src.idx, 13);
    chat[13].is_system = false;
});

console.log('== 抠取 / JSON ==');
t('说戏 COT 不进正文', () => { const c = D.extractContent(chat[2].mes); assert.ok(!c.text.includes('备选走向') && c.text.includes('正文第2楼') && !c.fallback); });
t('缺 </content> 走兜底', () => { const c = D.extractContent('<think>x</think><content>正文<details>d</details>'); assert.ok(c.fallback && c.text === '正文'); });
t('JSON 修复链', () => { assert.strictEqual(D.parseJson('```json\n{"summary": "a\nb", "grade": "S",}\n```').summary, 'a\nb'); assert.strictEqual(D.parseJson('{"summary": "截断').summary, '截断'); });

console.log(`\n${pass} passed${process.exitCode ? ' (有失败)' : ''}`);
setTimeout(() => process.exit(process.exitCode || 0), 50);
