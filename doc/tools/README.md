# `doc/tools/` — 工具文档总目录

> 这里集中存放 agent 通过 `ToolRegistry` 注册的**每一个工具**的设计交底。
> Agent 的能力上限 ≈ 工具集合的能力上限,而**工具描述(`description` + `inputSchema`)是 LLM 看到的唯一线索**——这份目录就是这些「说明书」的**人类可读版**与**设计档案**。
>
> 上游事实来源:`CLAUDE.md`「核心设计原则」、`packages/agent-core/src/types.ts`(`ToolSpec` 定义)、各里程碑文档(`doc/Phase1/M*-…`)。

---

## 1. 为什么要有这个目录

我们的工具有**两个面孔**:

| 面孔 | 谁看 | 长什么样 |
| --- | --- | --- |
| 「说明书」 | LLM(运行时) | `ToolSpec.description` + `inputSchema`,几行字 |
| 「设计档案」 | 人(开发期 / review / 排错) | 这里的 `.md` 文档 |

代码里的 `description` 必须**短而准**,塞不下「为什么这么设计、踩过哪些坑、哪条护栏不能动」。这些**只能放文档里**。所以本目录的作用是:

1. **审计**:看完工具文档,就能复述「这工具能做什么、不能做什么、为什么」——不必反向读代码。
2. **新增工具时有标准模板**:不用每次重新发明轮子。
3. **改动工具时强制刷新文档**:工具改了、文档没跟上 = 设计意图丢失 = 下一个改它的人(包括未来的 agent)会踩坑。
4. **给 LLM 自己当上下文**:当 agent 不知道某个工具该怎么用时,可以被指向对应文档(比 `description` 长得多、解释完整)。

---

## 2. 命名约定

```
<tool-name>-<中文一句话总结>.md
```

**约束**:

- `<tool-name>` 必须与代码里 `ToolSpec.name` **逐字一致**(下划线、大小写一字不差)。文件名是文档与代码之间的**唯一锚点**,差一个字符就找不到对应。
- 中文一句话总结 **≤ 20 字**,概括「这工具干啥的」,与 `description` 第一行同义即可,不必再发明。
- 总结里若含路径符号(`/` `\`)、引号、冒号、问号等,用全角中文替代或去掉,避免 Windows 文件系统不接受。
- 一个工具一份文档;**别合并**(`fs-tools.md` 这种合集会让 git 改动归因变难)。

**示例**:

- `get_current_time-返回当前日期与时间.md`
- `run_demo_command-演示需要确认的受控操作.md`
- `read_file-按行号分段读取工作区文件.md`
- `list_files-列出目录下的文件与子目录.md`
- `read_pdf-抽取PDF文件的纯文本.md`

---

## 3. 文档模板(每份工具文档必备的章节)

新建一份工具文档时,从下面这份骨架开始;**顺序可以调,但章节不可省**(不适用时写"N/A"并说明原因)。

```markdown
# `<tool_name>` —— <中文一句话总结>

> 状态:✅ 已实现 / 🟡 设计中 / 🔴 已废弃|最近同步:<commit 或里程碑,如 M3 / bb09c5a>|代码位置:`packages/.../<file>.ts`

## 1. 一句话总结
这工具是干嘛的、什么时候被 LLM 调用。

## 2. 接口契约
- **`name`**:`<tool_name>`(必须与文件名前缀一致)
- **`description`(给 LLM 看的那段)**:粘贴代码里的原文(改动时同步更新)
- **`inputSchema`**:参数表 + JSON Schema
  | 参数 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | ... | ... | ... | ... | ... |
- **返回**(`ToolResult`):`result` 是什么、`sources` 怎么填
- **`requiresConfirm`**:true / false;若 true,确认卡片摘要是什么样

## 3. 设计要点
关键决策与 trade-off。例:为什么用工厂而不是常量、为什么这么分段、为什么这么写 description。
紧扣 `CLAUDE.md` 的「核心设计原则」(tool-driven / diff-first / read-heavy is free / 版本绑定)与「安全红线」。

## 4. 核心代码节选
节选 handler 里**最关键**的几段(不是粘贴全文),逐段讲解。
保持「概念 → 对应代码 → 注释」三段式;改动时**只更新被改动的那段**,其余保留以防意外重写。

## 5. 测试
- 单测位置:`packages/.../<file>.test.ts`
- 覆盖场景:列出关键 case(成功路径、边界、护栏拦截)

## 6. 已知局限 / 后续 TODO
- 当前哪些情况不支持、为什么不在本里程碑做、留到哪里做。
```

> 💡 写「核心代码节选」时的小提醒:**不要全文复制**——`packages/` 才是事实来源,文档里的代码片段一旦超过 50 行,基本一定会跟代码漂移。**只截关键的、注释稠的几段**,其它写「详见代码」+ 文件路径。

---

## 4. 维护规则(硬约束)

1. **新增工具 = 新增一份文档 + 在第 5 节索引表追加一行**(同一 PR 里完成,不分开提)。
2. **改动工具(任何会影响 `name` / `description` / `inputSchema` / `requiresConfirm` / handler 行为的改动)= 同步刷新对应文档**——尤其是「设计要点」和被改动的「核心代码节选」。
3. **删除/重命名工具 = 把对应 md 改名或标 🔴 已废弃,不删**(保留以便 git blame 追溯设计变迁;真要清理留到一次性大扫除时再做)。
4. **`description` 是 LLM 唯一的入口,改它要慎重**:每次改 `description`,在「设计要点」里加一行「<日期> 改了 description:<改了什么、为什么>」,方便回溯效果回归。
5. **代码里 `ToolSpec.name` 变了,文件名前缀必须同步**——`name` 是唯一锚点。
6. **CI 不强制校验**(目前没写校验脚本)——靠 PR review;以后若文档漂移频繁再补 lint。

> ⚠️ 「文档没跟上」是这类项目最常见的腐烂模式。建议改工具代码时**先改文档**再改代码——文档写不出来的设计,大概率代码也没想清楚。

---

## 5. 当前工具索引

> ✅ = 已实现并可在调试宿主里调用;🟡 = 设计中(详见对应里程碑文档);🔴 = 已废弃。

| 状态 | 工具 | 一句话 | 所属里程碑 | 代码位置 | 详细文档 |
| --- | --- | --- | --- | --- | --- |
| ✅ | `read_file` | 按行号分段读取工作区文件(带行号 + 来源引用) | M3 | `packages/agent-core/src/tools/read_file.ts` | [read_file-…](./read_file-按行号分段读取工作区文件.md) |
| ✅ | `list_files` | 列出目录下的文件与子目录(不递归) | M3 | `packages/agent-core/src/tools/list_files.ts` | [list_files-…](./list_files-列出目录下的文件与子目录.md) |
| ✅ | `read_pdf` | 抽取 PDF 文件的纯文本 | M3 | `packages/agent-core/src/tools/read_pdf.ts` | [read_pdf-…](./read_pdf-抽取PDF文件的纯文本.md) |
| ✅ | `search_files` | 用 ripgrep 按正则搜文件内容(grep) | M4 | `packages/agent-core/src/tools/search_files.ts` | [search_files-…](./search_files-用ripgrep按正则搜文件内容.md) |
| ✅ | `propose_file_edit` | 提议修改文件,经 diff 确认后落盘 | M4 | `packages/agent-core/src/tools/propose_file_edit.ts` | [propose_file_edit-…](./propose_file_edit-提议修改文件经diff确认落盘.md) |
| ✅ | `web_fetch` | 抓取网页转 Markdown | M4 | `packages/agent-core/src/tools/web_fetch.ts` | [web_fetch-…](./web_fetch-抓取网页转markdown.md) |
| 🟡 | `web_search` | 网页搜索(暂不实现,待选搜索后端) | M4+ | — | [待办-…](./待办-web_search与browser_action.md) |
| 🟡 | `browser_action` | Puppeteer 浏览器(大概率不做) | — | — | [待办-…](./待办-web_search与browser_action.md) |
| 🔴 | `get_current_time` | 返回当前日期与时间(ISO 8601) | M2 → M3 移除 | ~~`tools/demo.ts`~~(已删) | 演示工具,M3 起换成真实工具后移除 |
| 🔴 | `run_demo_command` | 演示「需要确认」的受控操作(不真执行) | M2 → M3 移除 | ~~`tools/demo.ts`~~(已删) | 演示工具,M3 起移除;真正受控的 `run_command` 留待 M4 |

> 状态以 M3 落地为准。两个 M2 演示工具(`get_current_time` / `run_demo_command`)已随 `tools/demo.ts` 一并删除——按本目录维护规则第 3 条「废弃工具标 🔴 不删行」,保留这两行以便追溯设计变迁。它们的确认原语 / 工具循环验证职责已由真实工具 + `loop.test.ts` 接管。

---

## 6. 与里程碑文档(`doc/Phase1/M*-…`)的关系

| 维度 | 里程碑文档 | 工具文档 |
| --- | --- | --- |
| **粒度** | 一关一份,讲「这一阶段引入的整组能力 + 工程脚手架 + 端到端验证」 | 一工具一份,讲「这个工具的设计 + 接口 + 关键代码」 |
| **读者** | 第一次复刻这一关的人,需要按部就班 | 想用 / 改 / 排错某个具体工具的人 |
| **生命周期** | 写完不太动(它是「当时怎么搭起来的」的快照) | **会反复修订**——工具一直在演化 |
| **跨引** | 引用工具文档作为「这一关都引入了哪些工具」的清单 | 引用里程碑文档作为「为什么引入这个工具」的背景 |

**简单规则**:**「为什么这个工具存在」放里程碑文档**,**「这个工具怎么用 / 内部怎么实现」放工具文档**。前者是历史,后者是现状。

---

## 7. 暂未涵盖(留待后续)

- **CI 校验**:文档前缀与代码 `ToolSpec.name` 一致性、索引表完整性——目前手工 review,等漂移频繁再写脚本。
- **自动生成**:从 `ToolSpec.description` / `inputSchema` 反向渲染文档骨架——M5+ 工具多起来再考虑,现在手写更有质量。
- **运行时引用**:让 agent 在不确定怎么用某工具时主动 read 对应文档——属于「自反 prompt」实验,M5+ 评测阶段再做。
