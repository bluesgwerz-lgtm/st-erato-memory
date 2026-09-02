# Erato Memory — 设计稿 v0.1（2026-09-02）

SillyTavern 第三方扩展，为 Erato 预设提供结构化长期记忆，与预设的恒定窗口正则组严格对齐。
手机端酒馆使用，GitHub 安装，本机无酒馆，全部由真机实测。

---

## 0. 已定案的决策（讨论结论，不再重开）

| 项 | 决策 |
|---|---|
| 存储 | 本地 `chat_metadata.eratoMemory`，随聊天文件保存；不上云 |
| 双端 | 扩展跑在打开酒馆页面的浏览器里，手机/电脑都可用；两端连同一个酒馆实例时记忆随聊天文件自动共享，各装各的酒馆则各自独立 |
| 摘要模型 | 独立副 API（OpenAI 兼容，地址/密钥/模型可配），经酒馆后端转发，不碰主模型连接 |
| 入库时机 | 幂等补齐：每次生成结束扫一遍，所有 depth≥2 且未入库的 AI 楼层全部入库 |
| 注入范围 | 只注入 depth≥6（正文已被 6🌸 剥离）的楼层对应条目；正文与摘要不同时在窗口 |
| 注入方式 | `setExtensionPrompt` in-chat，depth 6，system 角色 |
| 等级 | S/A/B/C 由副 AI 判，用户可手动钉 S；衰减按楼层数不按墙上时间 |
| 隔离 | 记忆按聊天隔离；分支自动继承（元数据随复制）+ 切聊天时对账作废越界条目 |
| 面板 | 必做，手机优先；可看/改等级/改文字/删/重摘要/钉 S |
| 失败 | 副 API 拒答或超时 → 标记待重试 + 面板显眼提示，下轮自动重试，绝不静默跳过 |
| 向量召回 | 二期。200 楼以内全量顺序注入足够 |
| recap | 主模型每楼产出的 `<recap>` 是摘要输入之一，日期/时段/场景直接沿用 |

---

## 1. 与 Erato 预设的接口事实（Erato0814.json 实测）

depth 从最后一条消息倒数，0 = 最新；用户消息与 AI 消息各占一层。以下正则全部 promptOnly，
聊天文件里存的是全量原文。

| depth | 被剥掉 | 正则 |
|---|---|---|
| ≥2 | 历史用户输入（只留最新一条） | 13🌸 |
| ≥4 | 状态栏 `<details><summary>📍…` | 4🌸 |
| ≥6 | `<content>…</content>` 正文 | 6🌸 |
| ≥20 | `<recap>…</recap>` | 5🌸 |
| ≥10 全剥 | 14🌸 **目前关闭** | — |

每楼 AI 消息的原文结构（顺序）：
`说戏 COT（<think_format>/<COT_Director>，可达数千 token）` → `<content>正文（含 :::newspaper 卷引）</content>`
→ `<details><summary>📍状态栏</summary>…</details>` → `<recap><details><summary>📜 摘要</summary>**日期 · 时段 · 场景**\n叙述</details></recap>`
→ `<plot_directions>…</plot_directions>`；另有 `<!--prop-->…<!--/prop-->` 道具卡与 `‹toy:xxx›` 玩具标记随机出现。

扩展提示不是消息，不受任何正则影响；注入块用 `<erato_memory>` 标签包裹，与预设现有标签零冲突。

**预设侧唯一可选改动**：插件跑稳后把 5🌸 的 minDepth 从 20 改成 6，省掉 depth 6–19 的 recap。
MVP 阶段不改，两者并存无害。

---

## 2. 架构

```
[采集] 事件钩子 → 抠取楼层文本(content/recap/前一条用户消息) → 内容哈希
   ↓
[摘要] 副 API(经酒馆后端转发) → JSON 条目(带等级) → JSON 修复 → 写入 chat_metadata
   ↓
[对账] CHAT_CHANGED / 删楼 / 编辑 → 孤立/过期条目标记 → 过期自动重摘要
   ↓
[注入] generate_interceptor → 过滤(depth≥6, status ok) → 排序 → 预算裁剪 → setExtensionPrompt(depth 6)
   ↓
[治理] 衰减权重 → B/C 归档合并(非破坏) → S 正典压缩(有上限)
   ↓
[面板] 手机全屏浮层：列表/筛选/编辑/钉S/重摘要/补齐/对账/导出导入
```

代码组织：单入口 `index.js`（IIFE，`SillyTavern.getContext()`，与 st-toy-sync 同风格），
按职责拆成几个内部对象（`collector / summarizer / store / injector / governor / panel`），不引入构建工具。

`manifest.json` 关键字段：`"generate_interceptor": "eratoMemory_intercept"`，`"loading_order": 100`。

---

## 3. 数据结构

存放位置：`ctx.chatMetadata.eratoMemory`，通过 `ctx.saveMetadata()` / `saveMetadataDebounced` 持久化。

```js
{
  version: 1,
  entries: [ Entry ],          // 按 src.idx 升序维护
  archives: [ Archive ],       // B/C 归档段
  canon: { text: '', builtFrom: [ids], builtAt: 0 },   // S 正典压缩文本（S 条目超上限时才生成）
  skip: { [send_date]: true }, // 用户手动标记"不入库"的楼层
  stats: { lastIngestAt, lastError, failStreak }
}

Entry = {
  id: 'em_k3x9a1',
  src: {
    idx: 12,                 // AI 楼层在 chat[] 中的下标（对账时可修正）
    send_date: '…',          // 酒馆消息自带，跨删楼定位用
    hash: 'a91f…',           // 仅对抠出的 <content> 文本做哈希，改状态栏不算改
    user_idx: 11, user_hash: '…'   // 前一条用户消息（可为空）
  },
  story_time: '2025年3月4日 · 午后两点 · 陆衍家·厨房',   // 直接取 recap 锚点行
  type: 'plot' | 'emotion' | 'intimacy' | 'relationship' | 'setting',
  title: '≤8字',
  summary: '≤120字，因果链，写"为什么"不只写"做了什么"',
  characters: ['陆衍', '{{user}}'],
  emotion_shift: '陆衍：戒备→动摇',            // 可空
  known_by: ['陆衍'],                          // 信息差：谁知道这件事；空=在场者皆知
  tags: [],
  intimacy: null | { acts: '', consent: '', firsts: '', aftermath: '' },   // 仅 type=intimacy
  related_to: ['em_…'],                        // 因果前驱
  grade: 'S' | 'A' | 'B' | 'C',
  pinned: false,                               // 用户钉 S；pinned 时 grade 锁死为 S
  status: 'ok' | 'pending' | 'failed' | 'stale' | 'orphan' | 'archived',
  attempts: 0, last_error: '',
  model: 'deepseek-chat', created_at: 0, updated_at: 0
}

Archive = {
  id: 'ar_…', covers: ['em_…', …], story_time_range: '3月4日–3月9日',
  text: '一段 150–250 字的合并叙述', created_at: 0
}
```

体积估算：每条约 600 字节，300 楼 ≈ 150 条 ≈ 90 KB，chat_metadata 完全承受。
**向量不进 chat_metadata**：几百条浮点数组会让聊天文件每次防抖保存都重新序列化整份，二期另存。

---

## 4. 事件钩子与流程

| 事件 | 动作 |
|---|---|
| `CHAT_CHANGED` | 取消进行中的摘要任务 → 对账 → 重建注入 → 触发补齐（延迟 1.5s，避免与酒馆加载抢） |
| `MESSAGE_RECEIVED` / `CHARACTER_MESSAGE_RENDERED` | 防抖 800ms → 触发补齐 |
| `MESSAGE_DELETED` | 对账（标 orphan、修正 idx）→ 重建注入 |
| `MESSAGE_UPDATED` | 对账（哈希变化标 stale → 重摘要） |
| `MESSAGE_SWIPED` | 不处理。depth 0 的楼层永远不入库，swipe 只影响 depth 0 |
| `generate_interceptor` | 见 §7；`type === 'quiet'` 时直接返回 |

### 4.1 补齐（ingest）

```
for i in 0..chat.length-1:
  m = chat[i]
  if m.is_user or m.is_system: continue
  depth = chat.length-1-i
  if depth < 2: continue                       // 还可能被 swipe/重roll
  if skip[m.send_date]: continue
  e = entries.find(src.send_date == m.send_date)
  if e and e.status in (ok, archived, pending-with-attempts<3): continue
  if e and e.status == stale: 重摘要并原地替换
  else: 新建 pending 条目 → 摘要 → ok / failed
```

单飞锁：内存变量 + 当前 chatId，切聊天即失效。**不把锁写进 metadata**，否则刷新页面或异常中断后锁会残留在聊天文件里。
串行执行，每条之间不并发，避免副 API 限流；一次补齐最多处理 N 条（默认 20）后让出，下次事件继续。

### 4.2 对账（reconcile）

对每条 entry：
1. `chat[src.idx]?.send_date === src.send_date` → 命中；否则按 send_date 全表搜，找到则修正 idx。
2. 找不到 → `orphan`（面板显示，可删可留，不注入）。
3. 找到但 `hash(content) !== src.hash` → `stale`（下次补齐自动重摘要）。
4. `src.idx > chat.length-1` 的一律 orphan —— 这就是分支/检查点场景：新文件只复制到分支点，之后的条目全部越界作废。

---

## 5. 楼层文本抠取

输入给摘要模型的文本 = 三段拼接，每段独立抠取：

**A. 前一条用户消息**（`chat[idx-1]`，若是用户消息）：原文，仅剥 `<!--prop-->` 与玩具标记。
提示词里声明"括号内 OOC 指令不是剧情"。

**B. 正文**：
1. 优先 `<content>([\s\S]*?)<\/content>` 第一个匹配。
2. 缺标签兜底：整条消息依次剥 `<think_format>…</think_format>`、`<COT_Director>…</COT_Director>`、
   `<thinking>…</thinking>`、所有 `<details>…</details>`、`<recap>…</recap>`、`<plot_directions>…</plot_directions>`、
   `<!--prop-->…<!--/prop-->`、`‹toy:x›`，剩余部分当正文，并在条目上记 `src.fallback = true`。
3. 两种情况都再剥 `:::newspaper … :::` 卷引块。
4. 哈希只对 B 的结果做。

**C. recap**：`<recap>` 内取 `**…**` 加粗行为 `story_time`，其后文本为 recap 叙述。缺失则 story_time 留空，
提示词要求模型从正文推断，推断不出写"（未知）"，禁止编造。

说戏 COT 绝不进入摘要输入——它含备选方案与未采用的走向，混入会造成假记忆。

---

## 6. 摘要引擎

### 6.1 API 路由（酒馆后端的公开行为：`reverse_proxy` / `proxy_password` 覆盖请求目标与密钥）

```js
fetch('/api/backends/chat-completions/generate', {
  method: 'POST',
  headers: ctx.getRequestHeaders(),
  body: JSON.stringify({
    chat_completion_source: 'openai',
    reverse_proxy: baseUrl,          // 用户填的地址，去掉尾部 /chat/completions
    proxy_password: apiKey,
    model, messages,
    temperature: 0.3, max_tokens: 900,
    stream: false,
  }),
})
```
不受浏览器跨域限制，不碰主模型密钥，不切 connection profile。Gemini 走其 OpenAI 兼容端点即可。
超时默认 60s（AbortController）。可选**备用模型**（第二组 url/key/model）：主副 API 连续失败或返回空时自动换。

### 6.2 提示词初稿

system：
```
你是成人向互动小说的档案员。你的工作是把一段已发生的剧情整理成一条结构化记忆，供后续写作参考。
只输出 JSON，不输出任何其他文字。用中性、克制、事实性的语言，不渲染不评价，性内容按事实记录不省略。
```

user：
```
## 已知主角
用户角色：{{name1}}；对手角色：{{name2}}。其余出场者按原文名字记录。

## 最近三条记忆（供承接因果与去重，不要重复其中已记录的事实）
{{last3: [id] story_time | title | summary}}

## 本楼材料
### 用户的行动（括号内的 OOC 指令不是剧情，忽略）
{{userText 或 "（无）"}}

### 正文
{{content}}

### 作者摘要（日期·时段·场景 与 叙述，若有）
{{recap 或 "（无）"}}

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
拿不准时降一级，不要升级。

{{用户自定义指令，可空}}
```

`{{name1}}/{{name2}}` 取自 `ctx.name1/name2`。用户自定义指令来自设置项「记忆导演指令」，
用于"重点记录 X"之类的偏好。

### 6.3 解析与失败

- 解析链：```json 代码块 → 最外层 `{…}` → 弯引号修复 → 字符串内裸换行/未转义引号修复 → 截断补闭合。
  覆盖模型实际会犯的三类错：字符串里的裸引号、字符串里的真换行、max_tokens 截断。
- 校验：`summary` ≥10 字、`grade` 合法、`type` 合法，否则视为失败。
- 失败：`status=failed, attempts++`，记录 `last_error`（HTTP 码 / 空回复 / 解析失败 / 疑似拒答）。
  `attempts<3` 时下次补齐自动重试；`≥3` 停止自动重试，面板顶部红条提示「N 条待处理」，可手动重试或切备用模型。
- **疑似拒答判定**：回复含 "无法" / "不能协助" / "违反" / "I can't" / "I cannot" 且无 JSON → 直接标 `refused`，
  有备用模型则立即换模型重试一次。这是 🚗 组楼层的主要失败路径，必须可见。

---

## 7. 注入层

### 7.1 触发

`window.eratoMemory_intercept = async (chat, contextSize, abort, type)`：
`type === 'quiet'` 返回；否则 `reconcile()` → `buildBlock()` → `setExtensionPrompt('erato_memory', text, IN_CHAT, depth, false, SYSTEM)`。
MVP 无网络调用，零延迟。`CHAT_CHANGED` 时同样重建，空聊天则清空。

### 7.2 过滤与排序

- 取 `status === 'ok'` 且 `src.idx <= chat.length - 1 - contentWindow`（`contentWindow` 默认 6，与 6🌸 一致，可配）。
- 归档段替代其 `covers` 内的条目。
- 按 `src.idx` 升序（时间顺序），S/pinned 另抽一份进正典区。

### 7.3 预算

`maxInjectChars` 默认 9000 字（≈6k token）。超出时按顺序丢弃：C 最老 → B 最老 → 触发治理归档（§8）。
S/A 不丢，S 超上限走正典压缩。丢弃时面板显示「本轮 N 条未注入」。

### 7.4 格式

```
<erato_memory>
[长期记忆 · 由记忆插件维护 · 覆盖最近三回合之前的全部剧情，按时间顺序]
[仅作为已发生事实使用：不复述、不总结、不预告；信息差按「知情」栏执行，未列名者不知情]

## 正典
- {story_time}「{title}」{summary}
…

## 往事
- {story_time}「{title}」({grade}) {summary}｜情绪：{emotion_shift}｜知情：{known_by}
- （归档）{story_time_range}：{archive.text}
…
</erato_memory>
```
intimacy 字段以「亲密：acts；consent；firsts；aftermath」一行附在该条之后，仅在 `type=intimacy` 时输出。
`known_by` 为空时不输出「知情」栏。

### 7.5 depth 为什么是 6

depth 6 正好落在全文窗口的外沿：注入块 → depth 6–19 的 recap → 最近三回合全文，时间顺序自然。
预设自身的 in-chat 模块集中在 depth 4/2/0，不冲突。可配（0–20）。

---

## 8. 记忆治理

### 8.1 衰减

`age = chat.length - 1 - src.idx`（楼层数）。`weight = base[grade] × 0.5^(age / halfLife[grade])`。
`base = S:∞, A:1.0, B:0.6, C:0.3`；`halfLife = S:∞, A:200, B:60, C:20`。
MVP 只在预算裁剪时用作排序依据；二期向量召回时与相似度加权。

### 8.2 归档（非破坏）

条件：`age > 40` 的 B/C 条目 ≥ 12 条。取最老的一段（按 story_time 相邻，8–12 条），副 API 合并成一段
150–250 字叙述 → 新建 Archive，原条目 `status=archived`（保留原文，面板可看可恢复，恢复即删除对应 Archive）。
在补齐流程末尾执行，与摘要同一队列，不阻塞生成。

合并提示词要点：按时间顺序、保留人名地名与因果、保留每条的 known_by 信息差、去重、不加新事实。

### 8.3 正典上限

S + pinned 条目 ≤ 25 时逐条注入；超过时副 API 把全部 S 压成 ≤600 字正典段 `canon.text`，
之后 S 集合每变化 5 条重压一次。S 条目本身永不归档、永不删除（除非用户手动删）。

---

## 9. 面板（手机优先）

入口：顶栏图标（与 toy-sync 状态灯同位置风格）+ 扩展设置抽屉里的「打开记忆面板」按钮。
形态：`position:fixed; inset:0` 全屏浮层，顶部工具条，主体纵向滚动卡片列表，底部操作条。不用 `prompt()/confirm()`。

顶部：状态摘要「已入库 N / 待处理 N / 失败 N / 本轮注入 N 条 ≈ M 字」；筛选：等级 / 类型 / 状态；搜索框（标题/摘要/标签）。

卡片：`story_time` 一行 · 等级色块（点按循环 S→A→B→C；长按钉/取消钉 S）· 标题 · 摘要（点开展开全文，
再点进入编辑 textarea）· 状态徽标（待处理/失败/过期/孤立/归档/兜底抠取）· 楼层号（点击跳到该楼）。
展开后操作：编辑保存 / 重摘要 / 删除 / 标记该楼不入库。

底部操作条：补齐（手动触发 ingest）· 对账 · 重试全部失败 · 导出 JSON / 导入 JSON · 清空（二次确认）。

失败可见性：有 `failed/refused` 条目时顶部红条常显，点击展开错误原因。

样式：只用酒馆的 CSS 变量（`--SmartThemeBodyColor` 等），适配深浅主题；`@media (min-width: 800px)` 时改为右侧抽屉。

---

## 10. 设置项

| 键 | 默认 | 说明 |
|---|---|---|
| enabled | true | 总开关 |
| autoIngest | true | 自动补齐；关掉则只手动 |
| api.url / api.key / api.model | 空 | 副 API；「测试连接」按钮 |
| api.temperature | 0.3 | |
| api.maxTokens | 900 | |
| api.timeoutSec | 60 | |
| fallback.url / key / model | 空 | 备用模型，可空 |
| contentWindow | 6 | 与 6🌸 minDepth 同步 |
| injectDepth | 6 | |
| maxInjectChars | 9000 | |
| ingestBatch | 20 | 单次补齐上限 |
| archive.enabled | true | 归档开关 |
| directive | 空 | 记忆导演指令，附加到摘要提示词 |
| debug | false | 控制台日志 |

密钥存在 `extension_settings`（酒馆 settings.json，本机文件）；不走 `/api/secrets` 以免占用 custom 槽位。

---

## 11. 设计取舍（为什么这样做）

- **逐楼一条，不做多楼批量提取。** Erato 每楼自带 recap 锚点，逐楼粒度天然对齐；send_date 做唯一键，不需要去重逻辑。
- **输入只给正文 + recap + 用户行动。** 说戏 COT 含未采用的备选走向，状态栏是快照不是事件，道具卡是 HTML，三者进摘要都会制造假记忆。
- **send_date 定位 + 内容哈希判过期。** 删楼、编辑旧楼、开分支三种情况共用一套对账，不需要分别处理。
- **归档非破坏。** 原条目保留可恢复，合并段只是注入时的替身。
- **注入零网络。** MVP 的 interceptor 只做过滤和格式化，生成不会被记忆层拖慢；二期向量也只允许一次 embedding 调用且带硬超时。
- **锁在内存不在文件。** 切聊天、刷新页面自动失效。
- **等级 + 钉选 + 信息差三个字段是 Erato 场景的刚需。** 等级决定衰减与保底，钉选让用户纠正副 AI 的误判，`known_by` 对应预设指南里「角色未卜先知」那条排障项。
- **手机优先。** 全屏浮层、不用原生弹窗、只用酒馆 CSS 变量。

---

## 12. 分期

**v0.1 MVP**：§3–§7 + §9 基础面板（列表/编辑/钉S/删除/重摘要/补齐/对账/导出导入）+ §10 设置。
不含归档、正典压缩、备用模型（预算超出只做裁剪+提示）。

**v0.2 治理**：§8 全部 + 备用模型 + 疑似拒答自动换模。

**v0.3 向量召回**：embedding（走何种转发路径待查——酒馆 chat-completions 端点不做 embeddings，
候选是酒馆内置 `/api/vector/*` 或自建 server plugin）、S/A 保底 + B/C 相似度×权重竞争、related_to 链拉取。

---

## 13. 真机实测清单（v0.1）

（预设侧 📖预设使用说明 第六节的「长程剧情记忆」归宿一行，待插件跑稳后改为指向本插件。）

1. 装载：扩展面板出现、顶栏图标出现、无控制台报错。
2. 副 API：测试连接成功；填错密钥时错误可见。
3. 入库：新开一局聊到第 4 楼（chat.length ≥ 4），面板出现第 1 楼条目；说戏 COT 未混入摘要。
4. 抠取：故意在某楼删掉 `</content>`，条目带「兜底抠取」徽标且摘要正常。
5. 注入：聊到 depth≥6 出现，打开酒馆「提示词查看器」确认 `<erato_memory>` 块在 depth 6 且只含 depth≥6 楼层。
6. 对账：删一楼 → 对应条目变孤立；编辑一楼正文 → 变过期并自动重摘要；开分支 → 分支里越界条目变孤立。
7. 钉 S：钉后进正典区，改等级无效直到取消钉。
8. NSFW：用 🚗 组开着的楼层看副 API 是否拒答，拒答时红条可见。
9. 失败路径：断网发一楼 → 待处理 → 恢复后自动补齐。
10. 切聊天：A 局条目不出现在 B 局。
