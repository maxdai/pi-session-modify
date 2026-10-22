# pi-session-modify 设计文档

> 状态：设计阶段，尚未实现
> 参考版本：pi 1.4.0（`~/.pi/agent/install/releases/1.4.0/`）
> 所有"事实"条目均已通过读源码或解包 npm 包核实；"未验证"条目会显式标注。

---

## 1. 目标

一个 pi 扩展，两个命令：

- `/psm-edit` —— 挑一条历史消息，改掉它的内容，后面的历史保持不动并继续
- `/psm-remove` —— 丢掉一整轮（一条 `user` 及它引发的 assistant / toolCall / toolResult）

改完自动重载，界面与模型看到的都是新内容。

不算目标：从某条消息重新开始（那是 `/tree` + 重新提问）、在历史中间插入新消息。

---

## 2. pi 的 session 存储现状

### 2.1 存储形态

| 项 | 值 |
|---|---|
| 格式 | **只有 JSONL**，一行一个 entry |
| 位置 | `~/.pi/agent/sessions/--<cwd编码>--/<ISO时间戳>_<sessionId>.jsonl` |
| 格式版本 | `CURRENT_SESSION_VERSION = 3`（`session-manager.ts:41`） |
| 抽象层 | **没有**。`SessionManager` 直接 `openSync`/`appendFileSync`/`writeFileSync` |
| SQLite | 只存在于 `pi-durable`，pi 主产品不含（安装目录 `node_modules` 里零 sqlite） |

### 2.2 文件格式

第一行是 header，其后每行一个 entry：

```jsonl
{"type":"session","version":3,"id":"01a00555-...","timestamp":"2026-08-15T12:11:54.672Z","cwd":"/root/research/pi"}
{"type":"message","id":"942d6bb7","parentId":"454dec9f","timestamp":"2026-08-15T12:13:01.378Z","message":{"role":"user","content":[{"type":"text","text":"..."}],"timestamp":1786795981214}}
{"type":"message","id":"1d3abaa9","parentId":"942d6bb7","timestamp":"...","message":{"role":"assistant","content":[{"type":"thinking",...},{"type":"text",...}],"usage":{...}}}
{"type":"message","id":"8661cd70","parentId":"0d4c184a","timestamp":"...","message":{"role":"toolResult","toolCallId":"call_...","toolName":"aft_search","content":[...],"isError":false}}
```

### 2.3 entry 类型（`session-manager.ts:183`）

```
SessionMessageEntry       type:"message"          { message: AgentMessage }
ThinkingLevelChangeEntry  type:"thinking_level_change"
ModelChangeEntry          type:"model_change"
UsageEntry                type:"usage"
CompactionEntry           type:"compaction"
BranchSummaryEntry        type:"branch_summary"
CustomEntry               type:"custom"           不进模型上下文
CustomMessageEntry        type:"custom_message"   进模型上下文
ContextEditEntry          type:"context_edit"     见 §3.2
LabelEntry                type:"label"
SessionInfoEntry          type:"session_info"
```

### 2.4 树结构

- 每个 entry 有 `id` 和 `parentId`；`parentId = null` 是根
- `SessionManager` 维护一个 `leafId`（当前活动末端）
- 读取时 `buildSessionPath()` 从 leaf 沿 `parentId` 回溯到根，再 `path.reverse()` 得到 root→leaf 顺序
- **物理行序 ≠ 逻辑顺序**：`branch()` 之后新 entry 物理上追加在文件末尾，逻辑上挂在旧节点下

### 2.5 读取的宽容度（风险点）

```ts
function parseSessionEntryLine(line: string): FileEntry | null {
  if (!line.trim()) return null;
  try { return JSON.parse(line) as FileEntry; }
  catch { return null; }        // ← 坏行静默丢弃，不报错
}
```

- 解析失败的行**直接消失**，无警告
- `parentId` 指向不存在的 id 时，回溯在那里**静默终止**，历史凭空截断
- 尾行缺换行是安全的：读取后会自动补 `\n`
- 整个文件解析不出 header 时抛 `Session file is not a valid pi session`

### 2.6 写入路径

| 路径 | 行为 | 对手工改动的态度 |
|---|---|---|
| `_persist()` → `appendFileSync` | 只追加 | 早期行的手改能活下来 |
| `_rewriteFile()` → `openSync(file,"w")` + 按**内存** entries 重写 | 整文件覆盖 | 会被覆盖 |
| `_persist()` 首次落盘 → `openSync(file,"wx")` | 新建 | — |

`_rewriteFile()` 触发点（全仓三处）：空文件初始化（`:1043`）、版本迁移（`:1093`）、`createBranchedSession`（`/fork`，`:1720`）。**压缩不重写文件**，只追加。

**结论：pi 持有 session 时改文件是可行的。** pi 自己每次写入都按路径打开（`appendFileSync` / `openSync(path,"w")`），`rename` 换掉 inode 后会自然写到新文件。代价是 pi 内存里仍是旧内容 —— 需要 `/resume` 重新读盘才生效（`/reload` 不重读 session 文件，见 §3.4）。

---

## 3. 能改什么

### 3.1 `SessionManager` 的写入 API（全是追加）

```
appendMessage / appendCustomMessageEntry / appendCustomEntry
appendThinkingLevelChange / appendModelChange / appendUsage
appendCompaction / appendSessionInfo / appendLabelChange
appendContextEdit            ← 唯一有"改"语义的
branch / resetLeaf / branchWithSummary / createBranchedSession   ← 只改 leaf
```

**没有** `deleteEntry` / `editEntry` / `updateEntry` / `rewriteEntry`。

### 3.2 `context_edit` 机制

```ts
export interface ContextEditEntry extends SessionEntryBase {
  type: "context_edit";
  targetId: string;
  replacement: { content: ContextEditableContent } | null;
}

appendContextEdit(targetId, replacement): string
```

生效点在投影时：

```ts
function projectContextEntry(entry, edit) {
  const messages = sessionEntryToContextMessages(entry);
  if (!edit) return messages;
  if (edit.replacement === null) return [];                     // 抹掉
  return messages.map(m => ({ ...m, content: edit.replacement.content }));  // 只换 content
}
```

- `null` = 该条不进模型上下文
- 非 null = 只换 `content`，`usage`/`toolCallId`/`timestamp` 全保留
- assistant / toolResult 传字符串会自动包成 `[{type:"text",text}]`
- 同一目标多条编辑，**后出现的覆盖前面的**（`buildSessionPath` 的 root→leaf 顺序 + `Map.set`）
- 分支相关：`branch(targetId)` 跳到编辑之前，原文恢复
- 原文、UI、导出、用量统计**全部不受影响**

强制的四道校验（`session-manager.ts:1360`）：

1. `replacement` 必须是 `null` 或含 string/array 的 `content`
2. target 必须存在
3. target 必须在活动分支上
4. target 必须是 `custom_message` 或 `message` 且 role ∈ {user, assistant, toolResult}
   → `compaction` / `model_change` / `usage` / 另一条 `context_edit` 都改不了

### 3.3 关键限制：命令里写了不能立即生效

`appendContextEdit` 只做 `_appendEntry`（追加 + 落盘），**不刷新 `agent.state.messages`**。

刷新由私有方法 `_refreshFinalizedContext()` 负责，它的 9 个调用点全在 pi 内部（另 1 处为定义）：

```
938  定义
1026 _commitBoundaryDrafts        ← turn_end / agent_before_settle 的草稿
1271 _omitRecoveryAttempt         ← auto_retry 与溢出恢复
1441 refreshContext()             ← 公开，但扩展拿不到 AgentSession
2402 _appendCustomMessage
2913 appendCompaction 之后
3239 compaction 之后
3958 / 3992 bash 消息 flush
4197 navigateTree
```

**扩展拿不到任何一个触发点：**

| 尝试 | 结果 |
|---|---|
| `ctx.sessionManager.refreshContext()` | ❌ 类型是 `ReadonlySessionManager`，无此方法 |
| `ctx.navigateTree(当前 leaf, {summarize:false})` | ❌ 函数开头 `if (targetId === oldLeafId) return {cancelled:false}` 提前返回，不刷新 |
| `ctx.reload()` | ❌ 只重读 settings / api providers / resource loader，不碰 sessionManager |
| `pi.appendEntry()` | ❌ 落的是 `custom` entry，不是 `context_edit` |

**所以：命令式扩展写 `context_edit` 的结局是"文件里有了，模型看不见"。**

### 3.4 扩展确实有的合法出口

**① 边界草稿（canonical，pi 自己 apply）**

```ts
export interface ContextEditEntryDraft {
  type: "context_edit";
  targetId: string;
  replacement: ContextEditEntry["replacement"];
}
export type SessionBoundaryDraft = CustomEntryDraft | CustomMessageEntryDraft | ContextEditEntryDraft | CompactionEntryDraft;
export interface BoundaryResult { entries?: SessionBoundaryDraft[]; continue?: boolean; }
export type TurnEndEventResult = BoundaryResult;              // turn_end
export type AgentBeforeSettleEventResult = BoundaryResult;    // agent_before_settle
```

pi 内部 `_applyBoundaryDrafts` 里 `case "context_edit": manager.appendContextEdit(...)` → 写完立刻 `_commitBoundaryDrafts` 里调 `_refreshFinalizedContext()`。

**限制：只在 turn 结束 / settle 时触发，命令里用不上（会有延迟）。**

**② `context` 钩子（纯运行时，每次请求）**

```ts
export interface ContextEvent {
  type: "context";
  messages: AgentMessage[];   // 不含 system message
}
```

- 立即生效、零私有 API
- **不参与 canonical 投影**：footer token 统计、压缩、branch 摘要、reload 都看不到
- **拿不到 entryId** —— 只有 message 数组，只能按内容/位置识别目标

**③ `switchSession` 重新加载（公开）**

```ts
ctx.switchSession(sessionPath, options?): Promise<{ cancelled: boolean }>
```

内部走 `SessionManager.open(path)` → `_setSessionFile` → `loadEntriesFromFile()` **全量重读**，然后 `teardownCurrent` + 重建 runtime。

**这是让"文件改动"生效的官方途径。** 目标路径传当前 session 文件即为"原地重载"。

### 3.5 可用的公开依赖（1.4.0 实测能导入）

```ts
// @earendil-works/pi-coding-agent
SessionManager                 // 可 instanceof 校验
CURRENT_SESSION_VERSION        // 3
// loadEntriesFromFile 未导出

// @earendil-works/pi-tui
SelectList, SelectItem, ScrollView, Markdown, Text, TruncatedText, Box, VStack, matchesKey

// @earendil-works/pi-ai
contentText(content, separator?)   // string | Content[] → 纯文本
```

`SelectItem` 形状：

```ts
interface SelectItem { value: string; label: string; description?: string }
```

`ctx.ui` 可用方法（相关部分）：

```ts
select(title, options: string[], opts?): Promise<string | undefined>   // 只接受纯字符串
editor(title, prefill?): Promise<string | undefined>                   // 多行编辑器,可预填
input / confirm / notify
custom<T>(factory: (tui, theme, keybindings, done) => Component): Promise<T>   // 任意 TUI 组件
```

---

## 4. 现有工具盘点

### 4.1 pi 官方：没有编辑器

只有 `/tree`（跳 leaf）、`/fork`、`/clone`、`/resume`。`appendContextEdit` 没暴露成命令或扩展 API。

### 4.2 第三方：能改 session 的四个

| 工具 | 版本 | 机制 | 语义 |
|---|---|---|---|
| `pi-edit-session-in-place` | 0.4.0 | **私有** `SessionManager` 的 `branch`/`resetLeaf`/`appendMessage`/`appendCustomEntry`/`appendCustomMessageEntry` | 回退到某条用户消息 → 编辑或空提交删除 → 从这里继续 |
| `@sevten/pi-edit-reply` | 0.2.1 | **自己读写 JSONL**（`readFileSync` → 造副本 → `writeFileSync(tmp)` + `renameSync`），只用 `getLeafId`/`getTree`/`getSessionFile` 三个读方法 | 批量改 assistant 回复与 thinking，写成 in-file branch 或新 session |
| `cx-jev-tidy` | 0.1.1 | **`turn_end`/`agent_before_settle` 返回 `context_edit` 草稿** | 旧工具输出截到 300 字符或整条丢 |
| `pi-smart-compact` | 10.6.2 | 输出归档 / checkpoint / 验证式压缩 / 命名锚点 / handoff | 面最广 |

### 4.3 只读或非 canonical 的

| 工具 | 说明 |
|---|---|
| `pi-context-prune` 2.1.0 | `pi.on("context")` 每请求过滤 + `pi.appendEntry` 存索引 |
| `@tallshort/pi-context-prune-manual-plus` 1.8.1 | 同上，但会**读取 `context_edit` 后的有效投影** |
| `pi-mulligan` 0.1.5 | `context` 钩子 + `mulligan:rewind`/`shrink` 自定义 entry |
| `pi-rewind-hook` 1.8.7 | git 快照 + 对话回退，元数据存 session 隐藏 entry |
| `pi-session-jsonl`（dwsy skill） | 只读：索引/搜索/审计 JSONL |

### 4.4 两个可直接借用的先例

**① `pi-edit-session-in-place` 的私有 API 校验模式**（fail closed）

```ts
const WRITABLE_SESSION_METHODS = ["branch","resetLeaf","appendMessage","appendCustomEntry","appendCustomMessageEntry"];

export const getWritableSessionManager = (value: unknown): WritableSessionManager | undefined => {
  if (!(value instanceof SessionManager)) return undefined;
  return WRITABLE_SESSION_METHODS.every((m) => typeof value[m] === "function") ? value : undefined;
};
```

**② `@sevten/pi-edit-reply` 的原子写**

```ts
export function writeAtomic(file: string, lines: string[]): void {
  const tmp = `${file}.edittree.tmp`;
  writeFileSync(tmp, [...lines, ""].join("\n"));
  renameSync(tmp, file);
}
```

### 4.5 `pi-edit-session-in-place` 明确不做的

> Canonical `context_edit` entries **intentionally are not used** for rewinding: they alter earlier context while retaining later turns, **which is not this command's edit/delete-and-continue behavior**.

**"改一点、后面不动"恰好是它刻意避开的场景 —— 这是我们这个工具的空档。**

---

## 5. 三个候选方案

|  | **A. 覆写原行** | **B. 追加 `context_edit`** | **C. `context` 钩子** |
|---|---|---|---|
| 如何生效 | 写文件 → 自动重载（等价于 `/resume` 选自己） | 写 entry → 手工 `/resume`（或等下个刷新点） | 每次请求实时 |
| `/resume` 后的聊天界面 | ✅ 显示新文本 | ❌ 永远显示原文 | ❌ 显示原文 |
| 导出 / footer 统计 | ✅ 一致 | ✅ 一致（需先 `refreshContext`） | ❌ 不一致 |
| 参与压缩 | ✅ | ✅ | ❌ |
| 原文 | ❌ 被覆盖（靠备份） | ✅ 保留 | ✅ 保留 |
| 破坏 append-only | ⚠️ 是 | ❌ 否 | ❌ 否 |
| 写坏的后果 | ⚠️ 中间行坏 → 历史静默截断 | 丢一行 → 等于没改 | 无写入 |
| 目标识别 | entryId（可靠） | entryId（可靠） | 只能靠内容/位置（脆弱） |
| 能否验证改成功了 | ✅ 一眼看出 | ❌ 无法验证 | ❌ 无法验证 |

**选定 A。** 理由：

1. 重载后聊天界面、导出、footer 统计全部是改后内容 —— 修改结果**一眼可验**
2. 目标用 entryId 定位，不依赖内容匹配
3. 不改动 pi 的运行时逻辑，纯文件操作 + 公开的 `switchSession` 重载
4. `context_edit` 虽然对文件更“干净”，但它从不影响 UI 渲染源（`buildContextEntries()` 返回原始 entry，编辑只出现在 `buildSessionProjection().messages`），即使给 `custom` entry 加标记渲染器，被编辑那条也永远显示原文 —— 不能接受
5. `context` 钩子不参与 canonical 投影，且拿不到 entryId

**代价**（详见 §7.2）：覆盖原文字节（靠备份兜）、破坏 append-only、整文件重写的风险等级高于追加一行。

> 注：命令成功后**自动重载**（`ctx.switchSession(当前文件)`），用户无需手工操作；重载失败或被其他扩展 cancel 时降级提示手工 `/resume`。

### 5.1 删除的两种语义

|  | **投影删除**（`context_edit` + `replacement: null`） | **真删除**（删行 + 重连 `parentId`） |
|---|---|---|
| 模型上下文 | ✅ 这条消失 | ✅ 消失 |
| 聊天界面 | ❌ 仍显示 | ✅ 消失 |
| 文件结构 | 不动 | 改写若干行的 `parentId` |
| 撤回 | `/tree` 跳回 | 从 `psm-log` 还原 |

`replacement: null` 在 `projectContextEntry` 里就是 `return []`（`session-manager.ts:523`）—— 这是 pi 官方的“从上下文删除”语义，但界面上看不出来。

**选定真删除**：与编辑保持同一心智 —— 改的是文件，重载后所见即所得。

---

## 6. 设计

### 6.1 两个命令

| 命令 | 作用 | 列表内容 |
|---|---|---|
| `/psm-edit` | 改写一条历史的文本内容 | `user` / `assistant` / `toolResult`（当前分支） |
| `/psm-remove` | 删除一整轮（一条 `user` 及其引发的后续） | 仅 `user` |

一次调用只做一件事：改一条，或删一轮。命令结束后操作即完成，不保留“上次位置”。

### 6.2 公共流程

```
/psm-edit | /psm-remove
  ├─ 前置：ctx.hasUI、session 已落盘（getSessionFile() 有值）
  ├─ await ctx.waitForIdle()                    ← 非 streaming 才动手
  ├─ 1. 读 ctx.sessionManager.getBranch()
  ├─ 2. 过滤 → 列表选择（正序：旧在上、最新在下，初始选中最后一条）
  ├─ 3. /psm-edit → ctx.ui.editor(标题, 原文) 取新文本
  │   /psm-remove → ctx.ui.confirm(标题, 将删除 N 条) 确认
  ├─ 4. 以下是一个**零 await 的同步块**（防同进程后台写者插进来）
  │     ├─ readFileSync 全文
  │     ├─ 在内存里算出改动后的行集合（编辑：改一行 / 删除：删多行 + 重连 parentId）
  │     ├─ 写前校验（§6.6）
  │     ├─ 追加 psm-log（§6.7）—— 先写日志，再动 session
  │     ├─ 只改必要的行，其余行原样输出 → 写 `<file>.psm-tmp`
  │     ├─ renameSync(tmp, file)
  │     └─ 回读校验：entry 数 / id 集合 / parentId 全部可解析
  └─ 5. await ctx.switchSession(getSessionFile(), { withSession })
        ├─ 成功 → withSession(newCtx).ui.notify(操作结果)
        └─ cancelled / 抛错 → 提示「文件已修改，请手工 /resume」
```

前置检查：`ctx.hasUI` 为真、session 已落盘（`getSessionFile()` 有值）、非 streaming。

### 6.3 列表

```ts
interface SelectItem { value: string; label: string; description?: string }
```

**排序：正序（旧在上、最新在下），初始选中最后一条**（`setSelectedIndex`，`select-list.ts:67`）。方向与聊天界面一致，说“上面那条”不会指错。

编辑列表：

```
label:        `${roleLabel}  ${首行预览,截断到 ~60 字}`
            roleLabel = 你 / 助手 / 工具结果
description:  `${toolName?}  ${字数} 字  ${相对时间}  ${已编辑标记}`
value:        entry.id
```

删除列表（只列 `user`）：

```
label:        `你  ${提问首行预览}`
description:  `本轮共 N 条（${角色分布}）  ${相对时间}`
value:        entry.id
```

- 只列**当前分支**上的（`getBranch()` 已经保证）
- 已存在 `context_edit` 指向它的，标一个记号（避免困惑）
- `ctx.ui.select(title, string[])` 只能给纯字符串、无搜索；要 label + description 双列 + 子串搜索，必须走 `ctx.ui.custom` + `Input` + `SelectList`（参照 `model-selector.ts` 的搜索框写法）

### 6.4 编辑：改写细节（按 role 分支）

**只替换 text，保留其余 block。** 这是最关键的一条 —— assistant 的 `toolCall` block 一旦丢失，后续 `toolResult` 变孤儿，provider 直接报错。

| role | 原 content | 新 content |
|---|---|---|
| `user` | `Content[]` | 保留非 text block（图片原样保留），text 部分替换为一条新 text |
| `assistant` | `Content[]`（可能含 thinking / text / toolCall） | **原样保留 `thinking` 与所有 `toolCall` block**，只替换 `text` block |
| `toolResult` | `Content[]` | 通常整体替换为 `[{type:"text",text:新内容}]`；含图片块时图片保留 |

**图片：原样保留**，编辑器标题写明「编辑消息（含 N 张图片，图片将保留）」。想删图做不到 —— 那是删除需求，不在编辑职责内。

**`custom_message` 不纳入可编辑集合**。它是其他扩展注入进模型上下文的内容（如 magic-context 的 `<system-reminder>` 纸条），改了会让扩展自身状态与上下文不一致；真要清理噪音属于“删除”需求，由 `/psm-remove` 覆盖。

**空内容**：允许改成空文本（`[{type:"text",text:""}]`），合法但无明显效果；与原文本逐字相同时提示“未修改”且不写文件、不重载。

**改写实现：**

```
读整个文件 → split("\n") → 仅 JSON.parse 需要定位/校验的行
  → 命中 entry.id 的那一行：替换 entry.message.content
  → 其余行原样保留原始字符串
→ 写 `<file>.psm-tmp` → renameSync 覆盖
```

**其余行保持原始字符串，不做 parse→stringify 往返**，避免浮点/转义/字段顺序被改写。这是与 `@sevten/pi-edit-reply` 的差别（它整文件重排）。

### 6.5 删除：一轮

**区间定义**：从选中的 `user` 条目（含）到下一条 `user` 条目（不含）。

**删什么**：区间内的 `message` 与 `custom_message`；**`usage` / `model_change` / `label` / `context_edit` / `custom` / `session_info` 等 bookkeeping 条目全部保留**（它们不是“这一轮说了什么”；删 `model_change` 会改变该处的模型归属，`label` 是你自己打的标记）。

**重连算法**：

```
1. 标记区间内要删的条目
2. 顺序遍历当前分支：若某条 parentId 指向被删条目
   → 改指向“它之前最近的保留条目”（没有则 null）
3. 重写涉及的行（被删行丢弃，被重连行只改 parentId 字段）
```

区间内若存在分支点（一个条目有多个子节点），删除后这些子节点会一起上挂到同一个保留父节点 —— 结构合法（只是分支点上移一层），不报错。

**三条安全前提：**

1. **toolCall / toolResult 配对** —— 按轮删天然满足。但已知单向不对称：删 `toolResult` 留 `toolCall` 是安全的（pi 会补合成结果 `"No result provided"`，`transform-messages.ts:179-206`）；删 `toolCall` 留 `toolResult` 会直接透传给 API（`:110-118` 无过滤）→ Anthropic 拒。所以**永不支持单条删 toolResult / assistant**。
2. **compaction 的 `firstKeptEntryId` 不得被删** —— 否则 `buildContextEntries` 里 `foundFirstKept` 永远为 false（`session-manager.ts:501-509`），那段时间的条目静默不进上下文。检测到就**拒绝删除**并提示。
3. **允许删最后一轮** —— 逻辑上没有额外风险（重载后 leaf 自动落到文件最后一行）。

其余悬空引用（`context_edit.targetId`、`label.targetId`、`branch_summary.fromId` 指向被删条目）**都无害**：只是查不到目标，不影响加载与投影，不额外处理。

### 6.6 写文件与校验

1. **零 await 同步块**：`读 → 算 → 校验 → 写 tmp → rename → 回读` 全程不 await。扩展与 pi 同进程，事件循环单线程，同步块内其他回调（cache-warmer 的 `appendUsage`、其他扩展的 `appendEntry`）插不进来。弹窗全部结束后才开始此块。
2. **写前校验**：header 存在且 `version === CURRENT_SESSION_VERSION`；目标 `id` 在整文件中唯一；改后所有 `parentId` 仍全部可解析；`id` 集合只减不增（编辑不变、删除只减）
3. **原子写**：tmp + `renameSync`，不原地截断
4. **失败不写**：任何异常都中止，原文件不动
5. **写后回读校验**：重新 parse 整份文件，entry 数与 id 集合符合预期，编辑行内容为新内容
6. **不处理多进程**：同一 session 文件被多个 pi 实例同时打开没被支持（pi 对 `auth.json` / `settings.json` / `trust` 用 `proper-lockfile`，**session 文件不加锁**），不在设计范围内

### 6.7 日志与自动重载

**日志：`<sessionFile>.psm-log`**（同一目录，不以 `.jsonl` 结尾，所以不会被 `/resume` 扫到）。追加式，每行一条：

```json
{"ts":"…","op":"edit","entryId":"…","originalLine":"…"}
{"ts":"…","op":"delete","removedLines":["…","…"]}
{"ts":"…","op":"reparent","entryId":"…","oldParentId":"…","newParentId":"…"}
```

一次删除会写 1 条 `delete` + N 条 `reparent`，这样能精确还原（含父指针）。**先写日志再 rename session 文件**：日志多一条比少一条安全。

为什么不做整文件快照：你的会话最大已到 39.7 MB，每次编辑整文件备份就是 40MB；而整文件回滚本身也不优雅 —— 编辑之后新增的条目会被一起覆盖回去。

**自动重载**：`await ctx.switchSession(getSessionFile(), { withSession })`
- 成功：重建 runtime → 清屏重画整份 transcript → 新内容当场可见
- cancelled（其他扩展在 `session_before_switch` 里 cancel）或抛错：**不回滚**，提示「文件已修改，请手工 `/resume`」
- 代价：每次操作都触发所有扩展的 `session_shutdown` + `session_start`（与真 `/resume` 完全同路径）

---

## 7. 风险与边界

### 7.1 删除为什么比编辑重

编辑只改一条的 content；删除要改多条 `parentId`，还可能导致：

- 子节点 `parentId` 指向已删除行 → `buildSessionPath` 回溯**静默终止**，后续历史凭空消失且不报错
- `compaction.firstKeptEntryId` 被删 → 那段历史静默不进上下文
- toolCall / toolResult 配对断裂 → provider 报错

所以删除必须：修父指针、检查 compaction 引用、只按轮删。三者缺一不可，其余悬空引用无害（§6.5）。

### 7.2 已知风险表

| 风险 | 影响 | 缓解 |
|---|---|---|
| 破坏 append-only | 与设计约定不符 | 零 await 同步块 + psm-log + 文档写明 |
| 原文/被删内容 | 不可从 session 文件找回 | `psm-log` 逐条记录（含父指针），可精确还原 |
| 改坏 JSON | 中间行坏 → `parentId` 悬空 → 回溯静默终止，后续历史消失 | §6.6 写前全量 `parentId` 校验 + 写后回读校验 |
| 删到 `compaction.firstKeptEntryId` | 那段时间静默不进上下文 | §6.5 检测到就拒绝删除 |
| 删除后出现分支合并 | 区间内分支点的子节点一起上挂，树形变了 | 结构合法，不影响加载；风险表已知即可 |
| 改 assistant 的 content 丢 toolCall | provider 报 tool_result 无对应 tool_use | §6.4 强制保留非 text block |
| 重载被 cancel / 抛错 | 文件已改但内存仍旧，模型与界面不一致 | §6.7 降级提示手工 `/resume` |
| 每次操作都触发 `session_shutdown` + `session_start` | 其他扩展（如 magic-context）重建状态；大 session 有短暂重建耗时 | 与真 `/resume` 完全同路径，不再额外处理 |
| 压缩后 entry 位置变化 | 目标行还在，不影响按 id 定位 | — |

### 7.3 明确不做

- **插入新消息**：需要在 B 与 C 之间插一条并改 C 的 `parentId`，风险与删除同级但收益低；`/tree` 跳回去重问已覆盖“从这里重开”
- **删除单条**：只按轮删（单条删容易断 toolCall/toolResult 配对）
- **编辑 `custom_message`**：它属于删除范畴，不属于编辑
- **删除或编辑区间内的 bookkeeping 条目**（`usage` / `model_change` / `label` / `custom` / `session_info`）
- **跨分支操作**：`getBranch()` 只含活动分支，要动别的分支先 `/tree` 过去
- **记住上次位置**：一次调用只完成一件事，结束后不保留状态
- **多进程同文件**：pi 对 session 文件不加锁，不在支持范围
- **`context_edit` 与文件改动混用**：若目标已有 `context_edit`，改文件只改了原文，模型看到的仍是 replacement（后者覆盖）；UI 上标一个记号提醒

---

## 8. 已定决策

| 项 | 决定 |
|---|---|
| 可编辑集合 | `user` / `assistant` / `toolResult`（已含 `custom_message` 以外的全部模型可见角色） |
| 列表排序 | 正序（旧在上、最新在下），初始选中最后一条 |
| 图片 | 原样保留，编辑器标题提示 |
| 备份 | 旁挂单行日志 `<session>.psm-log`（不整文件快照） |
| 插入新消息 | 不做 |
| 记住上次位置 | 不做 |
| 删除 | 真删（界面也消失）· 按轮 · 列表仅 `user` · bookkeeping 保留重连 |
| 命令 | `/psm-edit`、`/psm-remove` |
| 生效方式 | 自动 `switchSession` 重载，失败降级提示手工 `/resume` |

---

## 9. 源码索引（pi 1.4.0，`/root/research/pi`）

| 内容 | 位置 |
|---|---|
| session 版本常量、entry 类型 | `packages/coding-agent/src/core/session-manager.ts:41,183` |
| `context_edit` 定义与校验 | `session-manager.ts:175,1360` |
| 投影（编辑生效点） | `session-manager.ts:543` / `:519`（`buildSessionProjection` / `projectContextEntry`） |
| 读取与坏行处理 | `session-manager.ts:616,627` |
| 写入（append / rewrite） | `session-manager.ts:1172,1124` |
| `open`（全量重读） | `session-manager.ts:1766` |
| 刷新上下文 | `agent-session.ts:938,1441` |
| 边界草稿 apply | `agent-session.ts:946,1024` |
| `navigateTree` 的 same-leaf 早退 | `agent-session.ts:4040`（`if (targetId === oldLeafId) return`） |
| `reload` 不碰 sessionManager | `agent-session.ts:3720` |
| `switchSession` | `agent-session-runtime.ts:196` |
| 扩展 API（`SessionBoundaryDraft` 等） | `core/extensions/types.ts:986-1025` |
| `ReadonlySessionManager` | `session-manager.ts:245` |
| `ctx.ui` 能力 | `core/extensions/types.ts:151,214,240` |
| `SelectList` / `SelectItem` | `packages/tui/src/components/select-list.ts:12` |
| session 格式文档 | `packages/coding-agent/docs/session-format.md` |

---

## 10. 参考：被检查过的第三方包

解析方法：`npm pack <pkg>` + `tar xzf` + grep。

| 包 | 结论 |
|---|---|
| `pi-edit-session-in-place@0.4.0` | 904 行 `extensions/edit-session-in-place.ts`；`context_edit` 零命中；用私有 `SessionManager` 的 5 个方法 |
| `@sevten/pi-edit-reply@0.2.1` | `context_edit` 零命中；`extensions/lib/session-file.ts` 里 `readFileSync` + `writeAtomic`(tmp+rename) |
| `cx-jev-tidy@0.1.1` | 用 `{entries:[{type:"context_edit",...}]}` 草稿；依赖 ComChatX box 的 `127.0.0.1:8081` 打分服务 |
| `pi-context-prune@2.1.0` | `pi.on("context")` 过滤 + `pi.appendEntry` 存 `context-prune-*` |
| `pi-mulligan@0.1.5` | `pi.on("context")` + `pi.appendEntry("mulligan:rewind" | "shrink" | ...)` |
