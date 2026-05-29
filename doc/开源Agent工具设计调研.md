# 开源 Agent 工具系统设计调研

> **一句话**:为 Embed Agent 的 M3「真实只读工具」阶段做的横向调研——看 Claude Code / Cline / Codex / Aider / Continue / OpenCode / Roo Code / Goose / MCP 这些主流项目的「工具(tool / function-calling)系统」都怎么设计,我们能借鉴什么。
>
> 调研时间:2026-05 · 配套:[`Phase1/M3-真实只读工具-详细文档.md`](./Phase1/M3-真实只读工具-详细文档.md)、[`Phase1-plan.md`](./Phase1-plan.md)、[`开源项目与框架调研.md`](./开源项目与框架调研.md)、根 `CLAUDE.md`。
>
> ⚠️ 本文是**调研与建议**,不是要推翻 M3 已定的设计(read_file / list_files / read_pdf + 工厂函数 + allowedRoots + sources 引用)。结论是:**M3 方向完全对**,只需在落地时**顺手吸收 3~4 条事实标准**,M4 起就会受益。

---

## 〇、结论速览(TL;DR)

**M3 现有方案与主流项目的差距**:

| 维度 | M3 现有设计 | 主流做法 | 差距严重度 |
| --- | --- | --- | --- |
| 工具数量 | 3 个(read_file / list_files / read_pdf) | 5~30 不等 | 起步阶段够用 |
| 路径安全 | `allowedRoots` 白名单 + `resolveSafe` | 白名单 + `.ignore` + OS 沙箱,三层任选 | M3 单层够用 |
| 来源引用 | `ToolResult.sources` **强契约**(独此一家) | 全靠模型自觉在回复里写路径 | ✅ 你**领先** |
| **read_file 输出** | 整文件 + 字节截断 | **行号前缀 + 分页(默认 500~1000 行上限)** | ⚠️ **该补** |
| **缺一个 `grep`** | — | **几乎所有项目都有**(ripgrep 内核) | ⚠️ **该补** |
| 工具描述风格 | JSON Schema + 中等长度 description | **长 prose + Usage notes + 反例**(Anthropic 风) | 可优化 |
| 工具分类/审批 | `requiresConfirm?: boolean`(M2 已有) | category('read'|'write'|'exec')+ 多档审批策略 | M4 前补即可 |

**三个最重要的判断**:

1. **`ToolResult.sources` 是你比 Cline / Claude Code / Codex 都更先进的设计**——继续保留,这是 CLAUDE.md「输出契约」红线的兑现,M3 文档概念 6 已经说得很清楚了。
2. **行号前缀(`cat -n` 风格)+ 分页参数**是 Read 类工具的事实标准,Claude Code / Cline / Roo Code 全采用——它不只是给当前 read_file 用,更是 **M4 `propose_file_edit` 工具做「精确 string 匹配」的前提**。M3 提前做,比 M4 回头改成本低得多。
3. **`grep` / `search_files`(基于 ripgrep)在 M3 的呼吸灯场景就该有**——你 `vendor/` 里的 `stm32f103xb.h` 是 ~800 KB,read_file 会被 200 KB 截断,LLM 根本看不到关键内容,必须靠 grep 定位。

---

## 一、调研范围与方法

**为什么做这个调研**:M3 是"agent 第一次接触真实磁盘"的关卡,工具设计决定了后续 M4~M6 所有领域工具的基底形态。在动手敲三个工具的代码之前,值得花半天看清:别人都怎么做、踩过哪些坑、有哪些约定俗成的"事实标准"。

**调研对象**(按调研深度):

- **重点深挖**:Cline(同为 VS Code 插件 + tool-calling 架构)、Claude Code(Anthropic 官方 CLI,工具最细颗粒)、OpenAI Codex CLI(沙箱设计的范本)
- **快速扫描**:Aider、Continue.dev、OpenCode、Roo Code、Goose
- **协议层**:Model Context Protocol(MCP)— 工具的事实标准协议

**方法**:WebFetch/WebSearch 看一手资料(GitHub 仓库、官方文档、DeepWiki 拆解),优先关注**与我们同构**的(VS Code 插件 + tool-calling agent)。每个项目至少看 README / system prompt / tools 目录三处。

---

## 二、跨项目「工具大全」对照表

按**功能维度**汇总。★ 标记的是 M3 没规划、但很多项目都有的:

| 维度 | Claude Code | Cline | Codex | OpenCode | MCP filesystem | Aider |
| --- | --- | --- | --- | --- | --- | --- |
| **读单文件** | Read(行号+分页) | read_file(行号+PDF/DOCX 内置) | (走 shell) | read | read_text_file | (无,塞 prompt) |
| **★读多文件** | (逐次 Read) | — | — | — | **read_multiple_files** | repo map 全塞 |
| **读图/PDF** | Read(原生) | read_file 内置抽取 | view_image | (插件) | **read_media_file**(base64) | — |
| **列目录** | (用 Glob) | list_files(可递归) | (shell) | — | list_directory / **★directory_tree** | — |
| **glob** | Glob(modtime 排序+封顶) | (并入 list_files) | — | glob | search_files | — |
| **★grep** | Grep(ripgrep,三档输出) | search_files(ripgrep+上下文行) | (shell) | grep | — | — |
| **★符号速览** | (用 Agent + Grep) | **list_code_definition_names** | — | — | — | repo map(tree-sitter+PageRank) |
| **★元信息** | — | — | — | — | **get_file_info** | — |
| **★边界自查** | — | — | — | — | **list_allowed_directories** | — |
| **shell** | Bash(2 min 超时) | execute_command(LLM 自评 requires_approval) | shell + apply_patch | bash | — | — |
| **写文件** | Write/Edit(read-before-edit + 唯一匹配) | write_to_file / replace_in_file | **apply_patch**(自定义 diff,模型微调过) | edit | — | SEARCH/REPLACE 块 |
| **网络** | WebFetch+WebSearch | web_fetch+web_search | web_search | webfetch | — | — |
| **追问** | AskUserQuestion | ask_followup_question(2-5 选项) | — | — | — | — |
| **TODO** | TaskCreate 系列 | focus_chain / new_task | update_plan | — | — | — |
| **子 agent** | Agent | subagent(最多 5 并行) | — | — | — | — |

> 📌 **观察**:除了 Aider(走另一条路,见下文),所有 tool-calling 项目都收敛到「**读单文件 + 列目录 + grep + shell + 写文件**」这五件套。我们 M3 做读三件、M4 起做写/执行,正在沿这条主路径走。

---

## 三、四大设计维度对比

### 3.1 工具描述风格(三种流派)

| 流派 | 代表项目 | 特征 | 何时选 |
| --- | --- | --- | --- |
| **Long prose + DO/DON'T** | Claude Code | description 写成 1~2 段散文 + Usage notes / IMPORTANT / 反例 / 多个 example 代码块,单条可达 1500 词 | **Anthropic 模型**最准 |
| **XML/Markdown 三段式** | Cline | `## 名字` + `Description:` + `Parameters: - name: (required) instruction` + `Usage: <xml>`;**模型用 XML tag 调用**,不是 JSON tool_use | 跨模型兼容(GPT-5/Gemini/Claude 各有变体) |
| **JSON Schema + 短 prose** | Codex | 极简,约束下沉到沙箱/审批层 | 工具少而精时 |

**对 M3 的启示**:我们 M2 已用「JSON Schema + 中等长度 description」(典型 Anthropic 风),**M3 文档 §3 概念 4「工具描述的艺术」其实就在往 Claude Code 风格靠**——「用途 / 参数语义 / 返回 / 不做什么」这套四段式,正是 Anthropic 模型最吃的格式。继续保持就好。

> 💡 **Cline 的 XML 调用形式不要学**——那是它为了同时兼容不支持原生 function-calling 的模型(早期 Claude 没有 tool_use 时的 hack 路线)而做的折中。我们 M2 已经走原生 `tool_use` / `function_call`,继续走更现代。

**典型 description 模板**(借鉴 Claude Code,我们 M3 已经在用):

```
用途:[一句话,LLM 决定要不要调]
参数:
  - path(必填):[语义 + 相对什么 + 边界]
返回:[结构 + 上限 + 截断标记]
注意:
  - 不要用本工具读 XX,请改用 YY
  - 不确定时先调 ZZ 探明
```

### 3.2 路径安全 / 权限设计

| 项目 | 机制 | 关键点 |
| --- | --- | --- |
| **M3 现设计** | `allowedRoots`(白名单)+ `resolveSafe` 拦穿越 | 工厂函数注入,agent-core 不碰 vscode |
| **Cline** | `.clineignore`(gitignore 语法,chokidar 热更新)+ Auto-Approve 分类开关 + LLM 自评 `requires_approval` | 黑名单模型,贴近用户直觉(gitignore 大家都会写) |
| **Codex** | **OS 级沙箱**:macOS Seatbelt(`sandbox-exec -p`)/ Linux Landlock+bwrap+seccomp / Windows 原生 + 4 档审批策略(`untrusted` / `on-request` / `never` / `danger-full-access`) | 安全下沉到操作系统层,最硬 |
| **Claude Code** | `ToolName(specifier)` glob 规则(如 `Bash(npm run *)`、`Read(~/secrets/**)`、`WebFetch(domain:example.com)`)+ 4 种 permission mode | 细粒度规则化,但要用户写规则 |
| **MCP filesystem** | `allowed_directories` 启动声明 + 暴露 `list_allowed_directories` 让 LLM 自查 | 白名单 + 自查工具,极简优雅 |

**对 M3 的启示**:

1. M3 单层 `allowedRoots` 是**正确起点**,简单而有效。
2. **M5+ 可以叠 `.embedignore`**(gitignore 语法,用 `ignore` npm 包),覆盖「白名单内但不该读」的目录(`node_modules` / `build` / `.git`)。**不在 M3 做**——但工厂函数模式天然支持后加。
3. **OS 级沙箱不学**——我们是 VS Code 插件,跑在 extension host 进程里,本来就受 VS Code 进程沙箱保护,再加一层 OS sandbox 收益小、复杂度爆炸。
4. **借鉴 MCP 的「`list_allowed_directories` 工具」**——M3 加一个 5 行代码的工具,让 LLM 第一步自查「我能访问哪里」,比报错给它看体验好得多。

### 3.3 大文件 / 输出契约

几乎所有项目都收敛到**同一套约定**:

| 约定 | Claude Code | Cline | Roo Code | M3 现设计 |
| --- | --- | --- | --- | --- |
| **行号前缀** | `   42  code...`(`cat -n` 风) | `42 \| code...` | 同上 | ❌ 未做 |
| **分页参数** | `offset` + `limit` | `start_line` + `end_line` | 同上,默认 500 行 | ❌ 仅按字节截断 |
| **截断元信息** | 截断标记 + `totalLines` | 同 | 100 KB 预览 + `totalLines` | ✅ 有截断标记 |
| **gitignore-aware** | Glob 自动跳过 | 默认遵守 | — | ❌ |

**对 M3 的启示**:**行号前缀 + 分页参数**是 M3 落地时**最该顺手补的两件事**,具体见下文 §五。

### 3.4 来源引用(M3 的领先点)

| 项目 | 来源引用机制 |
| --- | --- |
| **M3 现设计** | **`ToolResult.sources: Source[]`** 强契约,`{ file, lines?, section? }`,M2 `loop.ts` 自动把它拼到工具结果末尾"来源:"段 |
| Claude Code | 无统一字段;**行号前缀** 是隐式引用契约(为 Edit 的 read-before-edit + 唯一匹配铺路) |
| Cline | 无统一字段;靠 system prompt 要求模型在回复中提及 file path / line |
| Codex | 无统一字段 |
| MCP | 无统一字段 |

**这是 M3 比所有主流项目都更先进的设计**——CLAUDE.md「输出契约」红线 + M3 文档概念 6 已经把价值说透了。**继续保留,不要动**。

> 🔑 **建议**:在 M3 文档基础上,**额外让行号前缀进 `result` 文本**,**让 `sources` 同时携带 `lines` 范围**——两者并存:
>
> - 行号前缀给 LLM 看(它会复制粘贴回 `propose_edit` 的精确匹配里);
> - `sources.lines` 给上层 UI 看(以后可以做"点击跳转到具体行")。
>
> 两层冗余但目标不同,不冲突。

---

## 四、各项目逐一速写

按"对我们最相关"排序。

### 4.1 Claude Code(Anthropic 官方 CLI)

- **工具数量**:30+,**细颗粒**,主力 6 件:Read / Write / Edit / Bash / Glob / Grep
- **风格**:长 prose + DO/DON'T;Read **返回带行号**(为 Edit 的 read-before-edit + 唯一匹配铺路)
- **权限**:`ToolName(specifier)` glob 规则 + 4 种 permission mode
- **看点**:工具描述写得像 SOP,Bash 单条 description ~1500 词,值得当作 prompt engineering 教材
- **借鉴**:Read 的行号 + offset/limit、Glob 的 modtime 排序 + 封顶 100、Grep 的三档 output_mode

### 4.2 Cline(`cline/cline`,VS Code 插件)

- **工具数量**:26 个,分 8 大类(读/写/执行/浏览器/网络/MCP/元/流程)
- **风格**:**XML/Markdown 三段式**,按模型族分变体(GENERIC / NATIVE_GPT_5 / NATIVE_NEXT_GEN / GEMINI_3)
- **权限**:`.clineignore` + Auto-Approve 分类开关 + LLM 自评 `requires_approval`
- **看点**:
  - **`list_code_definition_names`**——目录级符号目录,比直接 read_file 省 token 的架构速览(独门)
  - **`subagent`**——最多 5 个 in-process 并行子代理,节省主上下文
  - **`new_task`**——结构化模板压缩长会话(Current Work / Key Concepts / Files / Problem Solving / Next Steps)
  - **`replace_in_file`** 的 SEARCH/REPLACE 块用「字符级匹配 + 显式提示『行号前缀不能进 SEARCH』」绕开常见 LLM 失败模式
- **借鉴**:写工具时学它的 read-before-edit 强契约、错误信息里**主动教模型怎么避免下次再错**

### 4.3 OpenAI Codex CLI(`openai/codex`,Rust)

- **工具数量**:少而精,~6 件(shell / apply_patch / update_plan / web_search / view_image / MCP)
- **风格**:JSON Schema + 短 prose,**约束下沉到沙箱**
- **权限**:OS 级沙箱(Seatbelt / Landlock+bwrap / Windows native)+ 4 档审批策略
- **看点**:
  - **`apply_patch`** 是自定义 diff 格式,模型经过**专门微调**,部分失败也能保证 turn diff 准确——这是它最大的差异化
  - 把"是否危险"从 prompt 工程问题变成 OS 进程问题
- **借鉴**:M4 写工具时考虑「`propose_edit` 用 unified diff 而非 SEARCH/REPLACE 块」这条路线——但前提是模型微调过,我们用通用 Claude/GPT 选 SEARCH/REPLACE 更稳

### 4.4 Aider(`paul-gauthier/aider`)

- **架构**:**不是 tool-calling**,而是把整个会话当文本编辑协议——LLM 直接输出 SEARCH/REPLACE 块或 unified diff,Aider 解析后落盘
- **看点**:**repo map** 用 tree-sitter 提取定义/引用 → 建文件依赖图 → PageRank 排序 → 按 token 预算截断,**把整个仓库浓缩进 system prompt**(替代 RAG)
- **借鉴**:它证明了"读类工具"可以**不是工具**,而是**前置生成的上下文**。M5+ 我们做"项目速览"时可以参考——但 M3 阶段我们选的"工具按需读"是对的,符合 CLAUDE.md「tool-driven, not context-stuffing」原则

### 4.5 Continue.dev(`continuedev/continue`,VS Code/JetBrains 插件)

- **架构**:**context providers + MCP** 双轨。`@Files / @Codebase / @Folder / @Search / @URL / @Docs / @Web` 是用户主动 @ 引用,工具能力交给 MCP server
- **信号**:`@Codebase` 和 `@Folder` 已被官方标记为 **deprecated**——**统一转向 MCP**
- **借鉴**:把"工具协议"和"自己实现工具"解耦的思路;以及 MCP 化的方向

### 4.6 OpenCode(`sst/opencode`)

- **工具数量**:20+,核心五件套 `bash / read / edit / grep / glob` 跟 Claude Code 几乎一致
- **看点**:
  - glob/grep 用 ripgrep 且**默认遵守 `.gitignore`**(自动跳过 `node_modules/dist`)
  - bash 跨壳层(bash/zsh/pwsh/cmd)
- **借鉴**:`list_files` 默认遵守 `.gitignore` 的默认值——省掉 80% 噪声

### 4.7 Roo Code(`RooCodeInc/Roo-Code`,Cline fork)

- **差异**:加了 **5 种模式(Code/Architect/Ask/Debug/Orchestrator)**,每种模式有独立工具白名单
- **看点**:`read_file` 有 **token-budget aware 截断**——超大文件返回 100KB 预览 + 默认 500 行分页(`DEFAULT_LINE_LIMIT`),失败时优先保留文件开头
- **借鉴**:M3 `read_file` 的截断阈值参考这个

### 4.8 Goose(`block/goose`,已转入 Linux Foundation AAIF)

- **架构**:全套 MCP-native,自身只是个 host
- **看点**:**70+ 官方扩展 marketplace**,工具完全靠 MCP 协议解耦
- **借鉴**:看 MCP 生态长出来后的最终形态——给我们的 ToolRegistry 朝 MCP 兼容形态靠提供了正当性

### 4.9 MCP(Model Context Protocol,事实标准)

- **协议**:工具定义 = `{ name, description, inputSchema (JSON Schema) }` 三元组——这就是 OpenAI/Anthropic function-calling 的**超集**
- **官方 reference servers**:filesystem / git / github / memory / time / everything,按日历版本发布(`2026.1.x`)
- **filesystem server 的设计是范本**:
  - 启动时声明 `allowed_directories`(对应我们的 `allowedRoots`)
  - 所有工具受其约束
  - 暴露 `list_allowed_directories` 让 LLM 自查边界
  - 提供 `read_multiple_files`(★ 见 §六)、`directory_tree`、`get_file_info`、`read_media_file` 等
- **借鉴**:把 `ToolRegistry` 朝 MCP 兼容形态靠,未来"包装成 MCP server"或"接外部 MCP server"都是零成本

---

## 五、对 M3 的具体建议(按优先级)

| 优先级 | 建议 | 来自谁 | 实现复杂度 |
| --- | --- | --- | --- |
| ★★★ | **`read_file` 输出加行号前缀**(`cat -n` 风,如 `  42 \| code...`),并在 description 明确「行号是 metadata,改文件时别带」 | Claude Code / Cline | 5 行代码 |
| ★★★ | **`read_file` 加 `start_line` / `end_line` 参数**,默认上限 1000 行(替代/补充当前 200 KB 字节截断),超出给摘要 + `totalLines` | Roo / Claude Code | 10 行代码 |
| ★★★ | **保留 `sources` 强契约不变**——这是 M3 比所有主流项目都先进的地方 | M3 原设计 | 已实现 |
| ★★☆ | **新增 `grep` / `search_files` 工具**(用 `ripgrep` 二进制或 `@vscode/ripgrep` npm 包,带 `path:line` + 上下文行)——M3 呼吸灯场景必备,800 KB 头文件不可能整读 | Cline / OpenCode / Claude Code | 半天(挑库 + 包 child_process) |
| ★★☆ | **`list_files` 默认遵守 `.gitignore`**,加 `respectGitignore: false` 逃生口 | OpenCode | 0.5 小时(用 `ignore` npm 包) |
| ★★☆ | **`ToolSpec` 加 `category: 'read' \| 'write' \| 'exec'`** 字段,M3 全标 `'read'`,M4 写类工具复用同一确认机制 | Cline / Claude Code | 10 行 |
| ★★☆ | **`read_pdf` 保持独立,不并入 `read_file`**(Cline 是合并的,但 M3 文档 §3 概念 5 已论证心智契约不同,分开更清晰) | M3 原设计 | 已规划 |
| ★☆☆ | **新增 `list_allowed_directories` 工具**——让 LLM 第一步自查能访问哪里 | MCP filesystem | 5 行代码 |
| ★☆☆ | **新增 `read_multiple_files` 工具**(MCP 同名,`Promise.allSettled` 一把),Agent 看 header+impl+test 三件套时省一来一回 | MCP filesystem(三个 agent 一致点名,见 §六) | 20 行代码 |
| ★☆☆ | **`ToolRegistry` 朝 MCP 兼容形态靠**(`{name, description, inputSchema}` 三元组就是 MCP 超集) | MCP | 微调 |
| ☆☆☆ | **M5+ 仿 Cline 的 `list_code_definition_names`**(目录级符号目录,tree-sitter 抽顶层 class/function 名)—— **不在 M3 做**,但是 M5+ token 效率最高的"架构速览"工具 | Cline 独门 | 1~2 天(tree-sitter-c/cpp/yaml) |

### 5.1 建议的最小落地集(在 M3 范围内)

**只需要在 M3 现有 10 个步骤的基础上,加 3 处微调**:

1. **步骤 3 (`read_file`)**:
   - 增加 `start_line` / `end_line` 两个可选参数
   - 默认上限改为「行数 1000 + 字节 200 KB,先到先截」
   - 输出文本加 `cat -n` 风行号前缀
   - description 加一句:「行号前缀是 metadata,**改文件时不要带**」(为 M4 propose_edit 铺路)
2. **新增步骤 4.5 (`grep` 工具)** ——半天活,塞在 list_files 和 read_pdf 之间。最小可用版用 `child_process` 调系统 `rg`,或装 `@vscode/ripgrep`(VS Code 自带,无需额外二进制)
3. **新增步骤 4.6 (`list_allowed_directories` 工具)** —— 5 行代码,LLM 自查边界用

**`ToolSpec.category` 这条建议是 M4 准备工作**——M3 可以暂不做,但建议在 `types.ts` 注释里**提一句**,提醒自己 M4 加。

### 5.2 不要做的(明确说不)

- ❌ **不上 OS 级沙箱**(Codex 风)——VS Code 进程已经够了,过度工程
- ❌ **不学 Cline 的 XML 调用形式**——我们 M2 已经用原生 tool_use,更现代
- ❌ **不在 M3 上 RAG / 向量库**——M3 文档 §3 概念 7 已论证,Aider 的 repo map 也证明 ~2 MB 资料根本不需要
- ❌ **不在 M3 加写类工具**——CLAUDE.md「write-heavy is gated」红线,推到 M4 走 diff-first 流程
- ❌ **不学 Cline 的 `requires_approval` 由 LLM 自评**——我们走「工具静态标 `requiresConfirm`」更稳,LLM 自评是给"上千种命令都可能跑"的 shell 工具用的,M3 只读工具用不到

---

## 六、惊喜推荐:被低估的 `read_multiple_files`

三个调研 agent 之中有一个把它列为「**被低估的小工具**」,确实值得单独一节。

**它是什么**:MCP filesystem 的工具,一次请求读 N 个文件,**遇错继续而不是整体失败**,逐个返回 `{path, content, error?}`。

**为什么对我们有用**:

- **嵌入式场景天然多文件**:`.h` + `.c` + `.overlay` + `.yaml` 一组,Blue Pill 呼吸灯就需要同时看「`variant_PILL_F103Cx.h` + `board-bluepill.yaml`」两份
- **省 token + 省延迟**:串行 3 次 round-trip 浪费一来一回的网络延迟和 token(每次都要重发 system prompt 的 cache miss 部分)
- **容错语义**:某文件不存在不影响其他,避免 LLM 拿到 error 后陷入"再试一次"的低效循环
- **实现成本约等于免费**:`read_file` × N + `Promise.allSettled`,你的工厂函数模式天然支持

**Cline / Roo / OpenCode 都没有这个工具**——属于"被低估的小工具",MCP filesystem 用过的人都说香。

**M3 建议**:**做**(列入 ★☆☆,20 行代码量)。

```ts
// 大致形态(伪代码)
export function createReadMultipleFilesTool(cfg: FsToolConfig): ToolSpec {
  const readOne = createReadFileTool(cfg);
  return {
    name: 'read_multiple_files',
    description: `一次性读取多个文件...用于同时查看 .h+.c+test 等关联文件。
任意单个文件失败不影响其他,失败的会在 errors 里列出。`,
    inputSchema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' } } },
      required: ['paths'],
    },
    handler: async (input) => {
      const { paths } = input as { paths: string[] };
      const results = await Promise.allSettled(
        paths.map((p) => readOne.handler({ path: p })),
      );
      // ... 拼成 { result: "...各文件内容...", sources: [...] }
    },
  };
}
```

---

## 七、一句话总结

> **M3 文档现有方案方向完全对**,但建议在落地时把「**行号前缀 + 分页 + grep 工具**」这三件「事实标准」一并做了。它们都是从 Cline/Claude Code/Codex 反复迭代出来的经验,M4 写类工具(`propose_file_edit`)严重依赖行号前缀做精确匹配,**提前做比 M4 时回头改成本低得多**。

按优先级落地顺序:

1. **必做**(M3 完工前):read_file 加行号前缀 + 分页参数
2. **强烈推荐**(M3 完工前,半天活):加 `grep` 工具
3. **顺手做**(M3 完工前,各几行代码):`list_allowed_directories` + `read_multiple_files`
4. **M4 准备**:`ToolSpec.category` + 审批策略骨架
5. **M5+**:`.embedignore` + `list_code_definition_names`(tree-sitter)+ MCP 桥接

---

## 八、来源链接

### Claude Code
- [Tools reference (官方)](https://code.claude.com/docs/en/tools-reference)
- [Tools deep dive (vtrivedy 博客)](https://www.vtrivedy.com/posts/claudecode-tools-reference)
- [Tools (Pete Hodgson 博客)](https://blog.thepete.net/claude-code-tools/)

### Cline
- [cline/cline GitHub](https://github.com/cline/cline)
- [system-prompt/tools 目录](https://github.com/cline/cline/tree/main/apps/vscode/src/core/prompts/system-prompt/tools)
- [.clineignore 官方文档](https://docs.cline.bot/customization/clineignore)
- [Auto Approve & YOLO Mode](https://docs.cline.bot/features/auto-approve)
- [DeepWiki: Cline Access Control](https://deepwiki.com/cline/cline/10.3-access-control)

### Codex CLI
- [openai/codex GitHub](https://github.com/openai/codex)
- [Codex CLI Features (developers.openai.com)](https://developers.openai.com/codex/cli/features)
- [Codex Agent Approvals & Security](https://developers.openai.com/codex/agent-approvals-security)
- [Codex Sandboxing concept](https://developers.openai.com/codex/concepts/sandboxing)
- [DeepWiki: Codex Tool Registry](https://deepwiki.com/openai/codex/5.1-tool-registry-and-configuration)

### Aider
- [Repo Map (tree-sitter)](https://aider.chat/docs/repomap.html)
- [Edit Formats](https://aider.chat/docs/more/edit-formats.html)

### Continue.dev
- [Context Providers](https://docs.continue.dev/customize/deep-dives/custom-providers)

### OpenCode
- [Built-in Tools (DeepWiki)](https://deepwiki.com/sst/opencode/5.3-built-in-tools-reference)
- [Tools Docs](https://opencode.ai/docs/tools/)

### Roo Code
- [read_file Doc](https://docs.roocode.com/advanced-usage/available-tools/read-file)
- [Roo Code vs Cline 2026](https://www.qodo.ai/blog/roo-code-vs-cline/)

### Goose
- [Built-in Extensions (DeepWiki)](https://deepwiki.com/block/goose/5.2-built-in-extensions)

### MCP
- [MCP Servers Repo](https://github.com/modelcontextprotocol/servers)
- [MCP Filesystem Server Source](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)

---

> 📌 **本文修订**:2026-05-28 初版 · 调研人:Claude(借三个 general-purpose subagent 并行调研)· 用途:M3 落地前的最后一次设计校准。
>
> 后续若有新发现(尤其 Phase 2 启动前),在本文追加一节,**别开新文件**。
