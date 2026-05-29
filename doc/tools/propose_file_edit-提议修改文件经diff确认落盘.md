# `propose_file_edit` —— 提议修改文件,经 diff 确认后落盘(写文件)

> 状态:✅ 已实现 | 最近同步:M4 | 代码位置:`packages/agent-core/src/tools/propose_file_edit.ts` + 匹配引擎 `fuzzyMatch.ts`(单测 `propose_file_edit.test.ts` / `fuzzyMatch.test.ts`);extension 侧 diff 流程在 `packages/extension/src/ChatViewProvider.ts`;前端卡片 `packages/webview/src/components/ApplyDiffCard.tsx`。
>
> 选型依据:[`../写文件-网络-grep-实现对比与选型.md`](../写文件-网络-grep-实现对比与选型.md) §2。

## 1. 一句话总结

agent 第一个「会动手改东西」的工具。模型给一组「把 old_string 换成 new_string」的编辑,本工具算出改完后的完整内容,**先在 VS Code 原生 diff 编辑器里展示**,用户点「应用」才真正写盘——兑现 `CLAUDE.md` 的硬红线「Diff-first, not autonomous-write」。

## 2. 接口契约

- **`name`**:`propose_file_edit`
- **`description`(给 LLM 看)**:对【已存在】文件应用一组精确替换;强调三条防呆——改前必须先 `read_file`、`old_string` 别带行号前缀、不唯一要补上下文或 `replace_all`。原文见代码。
- **`inputSchema`**:

  | 参数 | 类型 | 必填 | 说明 |
  | --- | --- | --- | --- |
  | `path` | string | ✅ | 要改的文件(相对工作区根),必须已存在 |
  | `edits` | array(≥1) | ✅ | 改动数组,按顺序依次应用 |
  | `edits[].old_string` | string | ✅ | 要被替换的原文(允许空白略有出入,会模糊匹配) |
  | `edits[].new_string` | string | ✅ | 替换成的新文本 |
  | `edits[].replace_all` | boolean | | true=替换全部;否则要求 old_string 唯一 |

- **返回**(`ToolResult`):成功 → `已应用对 <file> 的修改(N 处编辑)` + `sources:[{file, lines:"a-b"}]`;用户放弃 → `用户放弃了…文件未改动`;匹配失败 → `fuzzyMatch` 的「教学式」中文报错。
- **`requiresConfirm`**:**不设(false)**。原因:diff 卡片 + Apply 按钮本身就是确认;若再设 `requiresConfirm`,会先弹一个通用 yes/no 卡片再弹 diff 卡片,双重确认。改由 handler 内部 `await propose(...)` 来「带 diff 地确认」。

## 3. 设计要点(= 选型文档结论的落地)

- **模型接口学 Claude Code 的 `Edit`**:`old_string`/`new_string` 精确替换,但允许一次传**多条**(JSON 数组)。这样白拿了 Cline「多块改动」的效率,又**免掉**它「从文本里解析 SEARCH/REPLACE 标记」的全部复杂度——原生 function-calling 直接给我们结构化数组。
- **apply 算法 = `fuzzyMatch.ts` 的多级模糊匹配**(抄 Cline + Codex):
  - 4 级阶梯逐级放宽:T1 精确 `indexOf` → T2 逐行 `trim` → T3 块锚点(≥3 行,首尾行当锚)→ T4 Unicode 归一化(折叠花引号/破折号/花哨空格,移植自 Codex `seek_sequence.rs`);
  - **唯一性校验**:不唯一又没 `replace_all` → 报错(不乱改);
  - **顺序作用在「演进的字符串」上**:第 N 条作用在前 N-1 条结果上(Claude Code MultiEdit 语义);
  - **换行修正**:按行命中的区间末尾含 `\n`,若 `new_string` 不以 `\n` 结尾则补回,避免黏连下一行。
- **流程学 Cline 的 diff-first**(extension 侧):虚拟只读文档承载 diff 两侧(base64 塞进 URI query,无状态 provider)→ `vscode.diff` 打开 → 发 `requestApplyDiff` 弹卡片 → 等 `applyDiffResponse` → Apply 时用 `vscode.workspace.fs.writeFile` 落盘。**agent-core 绝不写盘**,只 `await` 注入的 `ProposeFn`。
- **read-before-edit(抄 Claude Code 硬约束)**:`read_file` 注册时带 `onRead` 回调把读过的文件记进 `ChatViewProvider.readFiles`;本工具改文件前查 `wasRead(abs)`,没读过直接拒。这是一行检查挡掉「没看过文件就凭印象瞎改」的头号写文件 bug。(键在 Windows 上统一小写,避免 `Src/App.ts` 与 `src/app.ts` 被当成两个文件而误判没读过。)
- **写入红线 deny-list**:即便路径在 allowedRoots 内,落在 `.git/ node_modules/ build/ dist/ out/ coverage/` 里的文件也【永远拒改】(对齐 CLAUDE.md「永远禁止写 .git/build」;改 `.git/config`/`hooks` 是本地代码执行风险)。handler 里 `isWriteDenied(display)` 提前拦下,连 diff 都不弹。
- **不抄 Codex 的 `apply_patch` 自定义格式**:那要专门微调过的模型(只在 GPT-5.x 开),通用 Claude/GPT 会格式错乱。

## 4. 核心代码节选

- `fuzzyMatch.ts::findMatch`:4 级阶梯,返回「获胜那一级」的所有命中区间。**载荷易错点**:T2/3/4 的命中区间 `end` 含末尾 `\n`(每行累加 `len+1`)。
- `fuzzyMatch.ts::applyEdits`:顺序应用 + 唯一性/`replace_all`(多处命中**降序切片**避免错位)+ 换行修正。
- `propose_file_edit.ts::handler`:resolveSafe → stat 存在性 → read-before-edit → 读原文 → `applyEdits` → `changedLineRange`(算 sources 行号)→ `await propose(...)`。
- `ChatViewProvider.ts::propose`(arrow field):打开 diff → 发卡片 → 等响应 → 关 diff → Apply 时 `writeProposed`。

> 详细逐行注释见各文件。

## 5. 测试

- `fuzzyMatch.test.ts`(15 例):4 级匹配各一例(含逼出 tier 2 的「尾部空白破坏连续子串」技巧)、唯一性、`replace_all`、空 old_string、换行修正、多条顺序编辑。
- `propose_file_edit.test.ts`(7 例):用 **stub propose** 覆盖正常修改(断言 newContent)、**本工具不写盘**(磁盘文件保持原样)、read-before-edit 拒绝、用户放弃、找不到、文件不存在、越界路径。
- extension 侧的真实 diff viewer + 落盘靠 F5 手动联调(要 vscode,测不到)。

## 6. 已知局限 / 后续 TODO

- **只改【已存在】文件**;新建文件留给将来的 `propose_new_file`(`ProposeEditRequest.isNewFile` 字段与 extension 的 `writeProposed` 新建分支已为它预留)。
- read-before-edit **只查「读过」不查「读后盘上是否又变了」**(Claude Code 还会比 mtime);并发编辑场景未防。
- **块锚点级(T3)有误命中风险**(中间行不校验)——靠「diff-first 让用户在 diff 里复核」兜底。
- 单文件 5 MB 上限;`final_file_content` 回显(把格式化后的最新文件回传给模型当新基准,Cline 的聪明设计)未做,列入后续。
