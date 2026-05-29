# 写文件 / 网络 / grep —— 三工具实现对比与选型(Codex · Claude Code · Cline)

> **一句话**:`read_file` 已落地,下一步要做**写文件**、**网络**、**grep** 三类工具。本文逐行扒了 **OpenAI Codex CLI**、**Claude Code**、**Cline** 三家对这三类工具的**真实实现**(Codex / Cline 直接 clone 源码读;Claude Code 闭源,靠官方文档 + 逆向),逐项对比,给出**「该模仿谁、为什么、怎么落到我们这套代码里」**的建议——**最终拍板权在你**(见 §6「需要你拍板的决策点」)。
>
> 调研时间:2026-05 · 上游:[`开源Agent工具设计调研.md`](./开源Agent工具设计调研.md)(总览)、根 `CLAUDE.md`(护栏)、`packages/agent-core/src/{types,loop}.ts`(契约)、`doc/tools/README.md`(工具文档规范)。
>
> ⚠️ **可信度提示**:本文里 **Codex / Cline 的细节来自一手源码**(分别 clone 到本地、逐文件读,版本见文末),可信度高;**Claude Code 闭源**,行为来自官方 tools-reference + 社区逆向(prompt 是从二进制里抠出来的),标注 `[逆向]` 处请打个折扣。

---

## 〇、结论速览(TL;DR)

先给最终建议。三类工具**没有哪一家可以整套照抄**——因为我们有三条硬约束把大部分「直接抄」的路堵死了(详见 §1)。所以每一类都是**「以某一家为骨架 + 嫁接另外两家的某个零件」**。

| 工具 | **该模仿谁** | 一句话理由 | 复杂度 | 建议优先级 |
| --- | --- | --- | --- | --- |
| **grep**(`search_files`) | **Cline 为蓝本**,schema 灵活度选学 Claude Code | Cline 给了可直接抄的工程实现(`rg --json` + 双重封顶 + `│` 输出);Codex 的「走 shell 跑 rg」被我们的架构直接排除 | **低** | **★ 先做** |
| **写文件**(`propose_file_edit`) | **骨架 Cline**(diff-first 流程)+ **接口 Claude Code**(`old_string`/`new_string`)+ **算法 Codex/Cline**(多级模糊匹配) | Cline 的「改动先进 VS Code diff、用户 Apply 才落盘」**就是我们 `CLAUDE.md` 写死的流程**;Codex 的 `apply_patch` 格式依赖微调模型,**只能抄算法不能抄格式** | **高**(跨 4 个包) | 中(价值最高但最重) |
| **网络**(`web_fetch`/`web_search`) | **`web_fetch` 学 Claude Code 形态**但本地自实现、**不做有损摘要**;**`web_search` 三家都没法直接抄** | 三家的搜索都绑死各自的托管后端(Anthropic / OpenAI / Cline 云),我们多 provider(含 DeepSeek)用不了;只能自选搜索 API 或走 MCP | 中 | 低(本地资料为主,网络靠后) |

**三个最关键的判断(先记住,后面展开)**:

1. **grep 是最该先做、也最没争议的**——Claude Code 和 Cline 都用「**专门的 TS 工具包一层 ripgrep**」,两家做法高度一致;Codex 那种「让模型自己写 `rg` 命令丢给 shell 跑」对我们**根本不成立**(我们没有 shell 工具、没有 OS 沙箱、产不出 `sources`、还会绕过 `allowedRoots`)。直接抄 Cline 的实现即可。
2. **写文件最复杂,因为它不是「一个 agent-core 工具」,而是一个横跨 `shared`/`extension`/`webview`/`agent-core` 四个包的端到端功能**——`CLAUDE.md` 要求「改动先生成 diff → VS Code 原生 diff viewer → 用户 Apply 才落盘」。这套流程 **Cline 已经做好了**(`DiffViewProvider`),是我们最该照搬的骨架。但**模型用什么格式表达「改哪里」**是另一个问题:Codex 的 `apply_patch` 自定义格式**需要专门微调过的模型**(只在 GPT‑5.x 上开),我们用通用 Claude/GPT **不能选它**;Cline 的 SEARCH/REPLACE 文本块在「原生 function-calling」下其实是**多余的复杂**(见 §2.4 的关键洞察)。
3. **网络对我们优先级最低**——我们是「**工具按需读本地 Zephyr/vendor 资料**」为主(`CLAUDE.md`:tool-driven, not context-stuffing),网络主要用于「抓在线文档」。而且**搜索后端**这件事三家都帮不上忙(全是各自的托管服务),需要你单独决定用哪个搜索 API,或干脆**先只做 `web_fetch`、把 `web_search` 推后/交给 MCP**。

---

## 一、先看清楚:我们的 8 条「过滤镜」

为什么不能整套照抄?因为下面这 8 条约束(全部来自 `CLAUDE.md` 与现有代码)会过滤掉每一家的一部分做法。**读后面的对比时,脑子里一直挂着这 8 条**,就知道某个做法为什么「不能抄 / 只能抄一半」。

| # | 约束(来自哪) | 它过滤掉什么 |
| --- | --- | --- |
| 1 | **diff-first,不自主写盘**(`CLAUDE.md` 核心原则) | 任何「工具内直接 `fs.writeFile`」的写法都不行——必须「产出 diff → 原生 diff viewer → 用户 Apply 才落盘」。Claude Code / Codex 都是**先写盘再展示**,只有 Cline 是**先展示后落盘**。 |
| 2 | **agent-core 是纯 TS、不 import `vscode`**(现有架构) | 需要编辑器能力的(diff viewer、`@vscode/ripgrep`)**不能硬写进 agent-core**,要走「工厂函数 + 依赖注入」(就是 `read_file` 那套 `FsToolConfig`)。 |
| 3 | **原生 function-calling(tool_use / function_call),不用 XML**(M2 已定) | Cline 的 `<path>`/`<diff>` XML 调用形式**不抄**;但它的**handler 逻辑与调用形式无关**,可以抄。 |
| 4 | **通用模型、无微调**(用户自带 Claude/GPT/DeepSeek key) | Codex 的 `apply_patch` 格式**只在 OpenAI 微调过的 GPT‑5.x 上可靠**,我们**不能选**(详见 §2.2)。 |
| 5 | **`ToolResult.sources` 强契约**(M2 已实现,`loop.ts::stringifyResult` 自动拼「来源:」) | 任何「丢掉来源」的设计要警惕——比如 Claude Code 把网页喂给小模型摘要后**只返回摘要**(原文 URL 在引用里弱化),对我们「必须引用来源」是减分项。 |
| 6 | **read 自由、write/exec/网络要 gated**(`CLAUDE.md`:read-heavy is free, write-heavy is gated) | grep = 读,**不需要确认**;写文件 = gated(走 diff Apply);网络 = 数据出网(隐私红线),**默认要确认**。 |
| 7 | **无 OS 沙箱**(我们跑在 extension host 进程里) | Codex「有沙箱就自动批准写/网络」的整套安全模型**不适用**;我们的护栏只有 `allowedRoots` 白名单 + diff-first Apply + 确认。 |
| 8 | **多 provider(含 DeepSeek),无自家托管后端** | Claude Code 的 WebSearch(Anthropic 后端)、Codex 的 web_search(OpenAI Responses API)、Cline 的 web_fetch/search(Cline 云)**全用不了**——搜索/抓取要么自实现、要么接外部 API/MCP。 |

> 💡 **一个反复出现的主题**:三家的「**工具描述 prose + 防呆设计 + 算法**」基本都能抄(这些是模型无关、平台无关的经验);三家的「**调用形式 / 托管后端 / 沙箱 / 微调依赖**」基本都不能抄(这些绑死了各自的产品形态)。**抄经验,不抄管道。**

---

## 二、写文件

### 2.1 三家做法一览

| 维度 | **Claude Code** `[部分逆向]` | **Codex** `[源码]` | **Cline** `[源码]` |
| --- | --- | --- | --- |
| 工具 | `Write`(整文件覆盖)+ `Edit`(精确改)+ `NotebookEdit` | **只有 `apply_patch`**(自定义 diff 格式) | `write_to_file`(整文件)+ `replace_in_file`(SEARCH/REPLACE 块)+ `apply_patch`(仅 GPT‑5) |
| 模型怎么表达改动 | `Edit`:`old_string` → `new_string`(**精确字符串**,必须唯一或 `replace_all`) | `*** Begin Patch / *** Update File / @@ / +-空格 / *** End Patch`(类 git diff 的自定义语法) | `------- SEARCH` / `=======` / `+++++++ REPLACE` 文本块(可多块) |
| 匹配算法 | **精确匹配 + 唯一性**(差一个空格就失败) | **4 级模糊**:精确 → 去尾空格 → 去首尾空格 → Unicode 归一化(花引号/破折号折叠);降序应用避免错位 | **3 级模糊**:精确 `indexOf` → 逐行 trim → 块锚点(首行+末行当锚,≥3 行才用);乱序块收集后排序再应用 |
| 改动前是否强制读过文件 | **是,硬约束**(handler 层强制:没 Read 过就报错;盘上变了也报错) | 否(但 prompt 说「apply_patch 后别重读,失败会报错」) | 否(但失败反馈里**回传整份最新文件**,逼模型基于最新内容重试) |
| 落盘时机 | **先写盘**,diff 作为「权限确认弹窗」展示 | **先写盘**(批准/自动批准后,可在 OS 沙箱里写) | **先展示后落盘**:流式写进 VS Code diff 编辑器 → 用户点 Apply 才 `saveDocument()` |
| 模型依赖 | 通用 | **`apply_patch` 仅在微调过的 GPT‑5.x 上开**(`apply_patch_tool_type` 字段只在这些模型置位) | SEARCH/REPLACE 通用;`apply_patch`(V4A)仅 GPT‑5/gpt-oss |
| 防呆亮点 | read-before-edit;「**别把 `cat -n` 行号前缀写进 old_string**」;唯一性报错而非乱改 | 4 级模糊匹配;**部分失败精确记账**(`AppliedPatchDelta{changes, exact}` 告诉你到底落了哪些);找不到上下文**该文件不写**(不留半截) | **`final_file_content` 回显**(把自动格式化后的最新文件回传给模型当新基准,解决「格式化后下次匹配不上」);**3 连败 → 提示改用整文件写**;诊断 diff 只回报**新增的错误** |

### 2.2 ⛔ 头号陷阱:Codex 的 `apply_patch` 不能照抄(依赖微调)

很多人看到 Codex 觉得「`apply_patch` 好优雅,一个工具搞定增删改 + 改名」,就想抄它的格式。**别抄。**

源码实锤:`apply_patch` 工具**只有当模型的 `apply_patch_tool_type` 字段被置位时才注册**,而这个字段在 Codex 的模型表(`models.json`)里**只在 OpenAI 自家的 GPT‑5.x 系列上设了值**。也就是说,`*** Begin Patch …` 这套自定义文本语法,是 **OpenAI 专门微调让这些模型「能稳定吐出格式正确的 patch」**。Cline 也印证了这点——它的 `apply_patch` 工具用 `isGPT5ModelFamily || isGptOssModelFamily` 门控。

我们用**通用 Claude/GPT/DeepSeek**,没微调,模型吐这种自定义语法**很容易格式错乱**(少个 `@@`、上下文行数不对)。Codex 自己为了兜没微调的 gpt‑4.1,还专门写了「宽松解析 + 把模型误包的 heredoc 拆掉」的补救代码——**那是打补丁,不是设计**。

> 🔑 **结论**:**`apply_patch` 的格式(模型接口)不抄;但它的 apply 算法(4 级模糊匹配 + 降序应用 + 部分失败记账)是模型无关的纯算法,值得抄进我们的「应用 diff」引擎。**

### 2.3 ✅ 必抄的骨架:Cline 的 diff-first 流程

`CLAUDE.md` 把写流程写死了:

> **Diff-first, not autonomous-write** — 任何文件修改先生成 diff,经 VS Code 原生 diff viewer 展示,用户 Apply 才落盘。禁止「自主多步执行后再报告」。

**这正是 Cline 的 `DiffViewProvider` 在做的事**,而 Claude Code / Codex 都是「先写盘、再把 diff 当确认弹窗」——**不符合**我们的红线。所以**写流程的骨架照搬 Cline**:

1. `open(path)`:存盘当前文件、读原文(带编码探测)、**记录改动前的诊断(报错/警告)**、打开 VS Code 原生 diff 编辑器;
2. `update(content, isFinal)`:把新内容**流式**写进 diff 编辑器右侧(节流 10 次/秒),滚动到改动处——用户实时看到 diff 在长出来;
3. **用户点 Apply** → `saveChanges()`:存盘(触发编辑器自动格式化)→ 对账(下面 §2.5)→ 返回最终内容当新基准;
4. **用户点 Reject** → `revertChanges()`:还原编辑器(新文件则删掉)。

对应到我们的代码,这意味着**写文件不是一个普通的 `requiresConfirm` 工具**——现有 `loop.ts` 的确认原语只是「弹一句话摘要、等 yes/no」(见 `confirm({id, toolName, summary})`),**展示不了真正的 diff,也没有 Apply 落盘动作**。需要新增一套「proposeEdit」原语(详见 §5)。

### 2.4 💡 关键洞察:在「原生 function-calling」下,SEARCH/REPLACE 文本块是多余的

Cline 用 `------- SEARCH / ======= / +++++++ REPLACE` 文本块,**为此写了几百行**:容错正则(`-{3,}` 容忍标记漂移)、状态机修复缺失标记、流式时把半截标记弹出去、deepseek/llama 加的 ```` ``` ```` 代码围栏剥离……

**为什么 Cline 要这么累?因为它历史上用 XML/文本协议**——模型把多个改动塞进一个 `<diff>` 文本参数里,Cline 得自己**从一坨文本里解析出**哪段是 SEARCH、哪段是 REPLACE。标记一漂移就崩,所以要大量修复代码。

**我们用原生 function-calling,没这个问题**:可以让模型直接吐**结构化 JSON 数组**,function-calling 层**替我们解析好**,根本不需要自定义文本标记:

```jsonc
// 我们的 propose_file_edit 输入(示意)——多个改动是 JSON 数组,不是文本块
{
  "path": "src/main.c",
  "edits": [
    { "old_string": "int x = 1;", "new_string": "int x = 2;" },
    { "old_string": "foo();",     "new_string": "bar();", "replace_all": true }
  ]
}
```

这等于**白拿了 Cline「多块改动」的效率,却免掉了它「解析文本标记」的全部复杂度**。`old_string`/`new_string` 的语义和 Claude Code 的 `Edit` 一模一样,只是允许一次传多条。

> 🔑 这是本节最重要的一条:**模型接口学 Claude Code 的 `Edit`(`old_string`/`new_string`),用 JSON 数组承载多条改动(白拿 Cline 的多块效率),完全跳过 SEARCH/REPLACE 文本标记那套。**

### 2.5 必抄的两个防呆设计(都和我们的 `read_file` 强相关)

1. **「别把行号前缀写进 `old_string`」**(Claude Code + Cline 都有,Cline 是 SEARCH/REPLACE 规则第 5 条)。我们的 `read_file` 是 `cat -n` 风格,每行 `   42\t内容`。模型很容易把 `   42\t` 一起复制进匹配串,导致匹配失败。**`propose_file_edit` 的 description 必须明写这条**——这是我们最容易踩、又最好防的坑。
2. **`final_file_content` 回显**(Cline 独有,极聪明)。文件落盘后会被编辑器**自动格式化**(单引号变双引号、加分号、长行折行)。如果模型还拿格式化前的内容做下一次匹配,必然失败。Cline 的做法:落盘后**把格式化后的最新文件回传给模型**,并告诉它「以后都以这份为基准」。这条建议 M4+ 再做,但**现在就要在设计里预留**(我们的 ToolResult 可以带上最新内容片段)。

另外**强烈建议抄 Claude Code 的 read-before-edit 硬约束**:在 handler 里检查「这个文件本轮对话里 `read_file` 过吗?」,没读过就拒绝(返回「拒绝:请先 read_file 再改」)。这是**一行检查挡掉「模型凭印象瞎改」**的头号写文件 bug。

### 2.6 应用算法:抄 Codex/Cline 的多级模糊匹配

模型给的 `old_string` 常和文件里的真实内容**差一点点空白**。如果像 Claude Code 那样**纯精确匹配**,失败率偏高。建议抄 Codex/Cline 的**逐级降级**(纯算法,~80 行 TS,带单测):

```
第 1 级:精确匹配(indexOf)
第 2 级:逐行去尾部空白后比(trim_end)
第 3 级:逐行去首尾空白后比(trim)—— 容忍缩进漂移
第 4 级(可选,Codex):Unicode 归一化(花引号→直引号、各种破折号→ '-'、NBSP→空格)
```

外加 Claude Code 的**唯一性检查**:`old_string` 在文件里出现多次又没给 `replace_all`,**报错让模型补更多上下文**,而不是改错地方。

### 2.7 写文件:推荐方案 + 落到我们代码

> **模仿谁**:**骨架 Cline(diff-first 流程)+ 模型接口 Claude Code 的 `Edit`(但用 JSON 数组多条)+ apply 算法 Codex/Cline 的多级模糊匹配**。**明确不抄**:Codex `apply_patch` 格式(要微调)、Cline 的 SEARCH/REPLACE 文本标记(原生 function-calling 下多余)。

最小工具集(对齐 `CLAUDE.md` 已起好的名字 `propose_file_edit` / `propose_multi_file_change`):

- **`propose_file_edit`**(先做):改**一个已存在文件**,`edits: [{old_string, new_string, replace_all?}]`。
- **`propose_new_file`** 或同工具的「整文件」模式(次做):新建文件 / 整文件重写(对应 Claude Code `Write` / Cline `write_to_file`,带 Cline 的「内容必须完整、不许截断」提示 + 截断侦测)。
- **`propose_multi_file_change`**(M5+):多文件原子事务。

agent-core 侧 handler **不写盘**,只**算出新内容 + diff**,通过新的 proposeEdit 原语交给 extension 渲染原生 diff viewer;extension 在用户 Apply 时落盘。`sources` 自然填**目标文件 + 改动行范围**,正好满足强契约。

```ts
// packages/agent-core/src/tools/propose_file_edit.ts —— 示意,非最终代码
export function createProposeFileEditTool(cfg: FsToolConfig, propose: ProposeFn): ToolSpec {
  return {
    name: 'propose_file_edit',
    description: `对一个【已存在】文件提出修改(diff-first:先展示 diff,用户 Apply 才落盘)。
参数:
  - path(必填):要改的文件(相对工作区根)。
  - edits(必填):改动数组,每条 { old_string, new_string, replace_all? }。
    · old_string 必须与文件里**现有内容逐字匹配**(允许空白略有出入,会模糊匹配)。
    · ⚠️ 不要把 read_file 输出里的行号前缀(如 "   42\\t")写进 old_string!
    · old_string 在文件里不唯一又没给 replace_all=true → 报错,请补更多上下文。
注意:改文件前你必须先 read_file 读过它;新建文件请用 propose_new_file。`,
    inputSchema: { /* path: string; edits: {old_string,new_string,replace_all?}[] */ },
    requiresConfirm: true, // 但真正的「确认」是 diff viewer 里的 Apply,见 §5
    handler: async (input) => {
      // 1) resolveSafe(path, cfg) —— 复用现有 allowedRoots 守门
      // 2) 检查本轮是否 read_file 过该文件(read-before-edit 硬约束)
      // 3) 多级模糊匹配,算出 newContent;不唯一/匹配不上 → 返回「拒绝:…」
      // 4) 算 unified diff,await propose({ path, newContent, diff }) 交给 extension 渲染
      // 5) 用户 Apply → extension 落盘;返回 { result: "已应用…", sources: [{file, lines}] }
    },
  };
}
```

---

## 三、网络

### 3.1 三家做法一览

| 维度 | **Claude Code** `[部分逆向]` | **Codex** `[源码]` | **Cline** `[源码]` |
| --- | --- | --- | --- |
| 抓网页 `web_fetch` | `WebFetch{url, prompt}`:抓取 → HTML 转 markdown(Turndown)→ **丢给小模型(Haiku)按 prompt 摘要** → 返回**摘要** | **没有**(要抓网页只能 shell 跑 curl,且沙箱默认禁网) | `web_fetch{url, prompt}`:**调 Cline 云**(`/api/v1/search/webfetch`,需 Cline 账号 token);抓取+摘要在云端 |
| 搜索 `web_search` | `WebSearch{query, allowed/blocked_domains}`:**Anthropic 托管后端**(仅美国可用),返回标题+URL | `web_search`:**OpenAI Responses API**(仅 OpenAI provider),默认走「缓存索引」防注入 | `web_search{query, allowed/blocked_domains}`:**调 Cline 云** |
| 浏览器 | 无(靠 WebFetch) | 无 | `browser_action`:**Puppeteer 真浏览器**(launch/click/type/scroll/close,每步回截图+console) |
| 可移植性 | WebFetch **形态**可抄,后端摘要模型/可信域名表绑死 Anthropic;WebSearch 后端**抄不了** | **整体抄不了**(绑 OpenAI) | 工具 handler **抄不了**(绑 Cline 云);但 `UrlContentFetcher`(本地 puppeteer+cheerio+turndown)**可直接抄** |

### 3.2 ⛔ 头号陷阱:搜索后端三家都帮不上忙

`web_search` 的「搜索」动作本身**需要一个搜索引擎后端**。三家分别用:Anthropic 托管(仅美国)、OpenAI Responses API(仅 OpenAI provider)、Cline 自家云。**这三个我们一个都用不了**(过滤镜 #8:我们多 provider,没有自家后端)。

所以 `web_search` 对我们来说**不是「抄哪家」的问题,而是「选哪个外部搜索 API」的问题**:

- 选项:Brave Search API、Bing、Tavily(专为 LLM 设计)、SerpAPI、Google Custom Search、DuckDuckGo(免 key 但易限流)……**大多要 key、要钱**。
- 或者:**交给 MCP**——接一个外部 MCP search server,我们自己不实现(Claude Code/Cline 的 description 都写了「**有 MCP 的网络工具就优先用 MCP**」,因为限制更少)。
- 或者:**先不做 `web_search`**,只做 `web_fetch`(给定 URL 抓取),搜索推后。对「抓在线文档」场景,`web_fetch` 已经够用。

> 🔑 **`web_search` 是一个需要你拍板的决策点**(见 §6),不是技术选型,是「要不要为它引入一个外部付费/限流依赖」的产品决策。

### 3.3 `web_fetch`:学 Claude Code 的形态,但**本地自实现 + 不做有损摘要**

Claude Code 的 `WebFetch` 形态值得学:**抓取 → HTML 转干净 markdown → 返回**。但它的「**丢给小模型(Haiku)摘要后只返回摘要**」对我们是**减分项**:

- 它**有损**(description 自己写了「lossy by design」:页面没提到某事,可能只是 prompt 没问到);
- 它**冲击我们的 `sources` 强契约**(过滤镜 #5):你引用的是 Haiku 的转述,不是原文;
- 它的「可信域名表(~71 个)+ 域名风险查询接口」**绑死 Anthropic 基础设施**,抄不了。

**Cline 给了我们更合适的可移植代码**——`UrlContentFetcher`(纯本地,~60 行):

```
page.goto(url, { waitUntil: ["domcontentloaded","networkidle2"], timeout: 10s })
→ cheerio 删掉 <script>/<style>/<nav>/<footer>/<header>
→ TurndownService 转 markdown
```

> **推荐**:`web_fetch` = **抓取 → 转干净 markdown → 直接返回(像 `read_file` 一样带分段 offset/limit)+ URL 作为 `sources`**。**不做强制摘要**(可作为可选模式,但永远带上原始 URL)。这样既学了 Claude Code 的形态,又守住了「引用来源」红线。

实现取舍:

- **抓取**:优先用 Node 18+ 内置 `fetch`(undici),**轻量**;只有遇到「纯前端渲染的 SPA 文档站」才需要 Cline 那种 puppeteer 真浏览器(**重**,要拉 Chromium)。建议**先用 `fetch`**,puppeteer 推后/可选。
- **HTML→markdown**:`turndown` + `cheerio` 剥噪声(Cline 路线),或 `@mozilla/readability`+`jsdom`(正文提取)。
- **SSRF 安全**(必做,过滤镜 #6/7):抄 Claude Code 的几条——HTTP 自动升 HTTPS、**跨域重定向「只返回不跟随」**(把重定向 URL 当数据返给模型让它自己决定,既防 SSRF 又透明)、**禁止解析到内网/本地/云元数据 IP**(127.0.0.1 / 10.x / 169.254.169.254 等)。
- **gated**(过滤镜 #6):网络是数据出网,`requiresConfirm: true` 默认开,或做域名白名单确认。

### 3.4 `browser_action`(Puppeteer 真浏览器):大概率超纲

Cline 的 `browser_action` 是「真浏览器 + 截图给视觉模型看 + 点坐标」——对**嵌入式开发助手**来说太重、用不上(我们不需要操作网页 UI)。**不做**,除非将来有「跑起来看渲染结果」的需求。

### 3.5 网络:推荐方案小结

> **模仿谁**:`web_fetch` 学 **Claude Code 的形态**(抓→转 md→返回),但**本地自实现**(Node `fetch` + turndown)、**不做有损摘要**、**带 SSRF 守门**、**带 URL 来源**、**默认确认**;`browser_action` **不做**;`web_search` **三家都抄不了**,需你定外部搜索 API 或走 MCP,**建议先推后**。

---

## 四、grep

### 4.1 三家做法一览

| 维度 | **Claude Code** `[部分逆向]` | **Codex** `[源码]` | **Cline** `[源码]` |
| --- | --- | --- | --- |
| 有没有专门工具 | **有**:`Grep`(包一层 ripgrep) | **没有**:让模型自己写 `rg` 命令丢给 `shell` 工具跑 | **有**:`search_files`(包一层 ripgrep) |
| 参数 | `pattern` + `path` + `output_mode`(content/files/count)+ `glob`/`type` + `-A/-B/-C`/`-i`/`-n` + `multiline` + `head_limit`/`offset`(**旋钮多**) | (就是一条 shell 命令字符串) | `path` + `regex`(**Rust 正则**)+ `file_pattern`(glob)(**极简**) |
| 后端 | `@vscode/ripgrep` 自带二进制(可切系统 rg) | 依赖系统 PATH 上有 `rg` | VS Code 自带的 `rg`(`getBinaryLocation("rg")`) |
| 输出 | 三种模式可选;默认只列文件名(省 token) | shell 原样输出 | **`rg --json` 流式解析** → 按文件分组、`│` 前缀、带上下文 1 行;**双重封顶**(300 条 / 0.25 MB) |
| 安全/权限 | 读层,不确认;受 `Read(path)` 规则约束;**「永远别用 Bash 跑 grep/rg」** | OS 沙箱把 `rg` 归为只读安全命令、自动批准 | 读层;**结果按 `.clineignore` 过滤后才给模型** |
| 防呆 | 「字面花括号要转义」`interface\{\}`;`multiline` 要显式开 | stdin 设 `/dev/null` 防 rg 等 stdin 卡死 | **Rust 正则**提示(无 lookahead/反向引用);截断信息**顺便教模型「缩小搜索范围」** |

### 4.2 ⛔ Codex 的「走 shell 跑 rg」对我们直接排除

Codex **没有 grep 工具**,它让模型自己写 `rg -n "TODO" src` 丢给 `shell` 工具,靠 OS 沙箱保证安全。这套对我们**四条全不成立**:

- 我们**没有 shell 工具**(也不打算在这个阶段开);
- 我们**没有 OS 沙箱**(过滤镜 #7),shell 能读 OS 允许的任何地方,**绕过 `allowedRoots`**(过滤镜 #2);
- shell 输出**产不出 `sources`**(过滤镜 #5);
- 还依赖用户机器 PATH 上有 `rg`。

**结论:Codex 这条直接 pass。** 它唯一值得留意的是「stdin 设 null 防 ripgrep 卡死」这个小细节(我们 spawn rg 时也该这么做)。

### 4.3 ✅ Claude Code vs Cline:两家高度一致,抄 Cline 的实现

两家都用「**专门 TS 工具包一层 ripgrep**」,差别只在表面:

- **Claude Code 旋钮多**(`output_mode`/`type`/`multiline`/`head_limit`)——更灵活,但模型要学更多;
- **Cline 给了可直接抄的工程实现**:`rg --json` 流式 + readline 逐行解析 + **到上限就 `proc.kill()`** + **双重封顶(300 条 AND 0.25 MB,边拼边算字节)** + **按文件分组的 `│` 前缀输出**(对模型极友好)+ **截断信息顺便教模型缩小范围**。

```
// Cline 的 search_files 输出长这样(对模型很友好,建议照抄格式):
Found 12 results.

src/foo.ts
│----
│function processData(data: any) {
│  // TODO: implement
│  return processedData;
│----
```

> **推荐**:**grep 以 Cline 的实现为蓝本**(`rg --json` + 双重封顶 + `proc.kill` + `│` 分组输出),**可选**叠加 Claude Code 的 `output_mode`(content/files/count)增加灵活度(但起步只做 content+上下文即可)。

### 4.4 落到我们代码的两个要点

1. **ripgrep 二进制要「注入」,不能硬写进 agent-core**(过滤镜 #2)。建议在 `FsToolConfig` 里加一个 `ripgrepPath`,由 extension 提供:
   - extension 依赖 **`@vscode/ripgrep`**(拿到自带 rg 路径),或定位 VS Code 的 `vscode.env.appRoot` 下的 rg;
   - 兜底:系统 PATH 上的 `rg`。
   - **不要**用 VS Code 的 `workspace.findTextInFiles` API——那会让 grep 工具依赖 `vscode`,破坏 agent-core 纯 TS + 离线单测。**用 `child_process` spawn 注入的 rg 路径**,保持 agent-core 可单测。
2. **`allowedRoots` + `sources` 两条契约都要守**:把搜索根限制在 `allowedRoots` 内(用 `resolveSafe`),结果**逐条匹配填 `sources: [{file, lines}]`**——Cline 的 `SearchResult` 本来就带 `filePath`+`line`,转成我们的 `sources` 几乎零成本。这点**比 Claude Code 还强**(它只返回 prose,我们结构化引用)。

```ts
// packages/agent-core/src/tools/grep.ts —— 示意,非最终代码
export function createGrepTool(cfg: FsToolConfig & { ripgrepPath: string }): ToolSpec {
  return {
    name: 'search_files', // 或 'grep'
    description: `用 ripgrep 在允许范围内按【正则】搜索文件内容,返回 file:line + 上下文。
参数:
  - pattern(必填):正则(Rust 语法;无 lookahead/反向引用;字面花括号要转义,如 interface\\{\\})。
  - path(可选,默认工作区根):搜索目录(相对工作区根),递归搜索。
  - file_pattern(可选,默认 *):只搜匹配的文件,如 "*.c" / "*.{h,c}"。
返回:按文件分组的匹配 + 上下文;结果上限 300 条 / 0.25 MB,超出会提示缩小范围。`,
    inputSchema: { /* pattern: string(必填); path?, file_pattern? */ },
    // requiresConfirm 不设(= false):grep 是读操作,read-heavy is free(过滤镜 #6)
    handler: async (input) => {
      // 1) resolveSafe(path) 限制在 allowedRoots 内
      // 2) spawn(cfg.ripgrepPath, ['--json','-e',pattern,'--glob',file_pattern,'--context','1', dir])
      //    stdin 设 'ignore'(抄 Codex,防 rg 卡死);readline 逐行解析 --json
      // 3) 双重封顶(300 条 / 0.25MB),到顶 proc.kill()
      // 4) 拼 │ 分组输出 + sources: [{file, lines}]
    },
  };
}
```

### 4.5 grep:推荐方案小结

> **模仿谁**:**Cline 为蓝本**(`rg --json` + 双重封顶 + `proc.kill` + `│` 分组输出 + Rust 正则提示),ripgrep 路径走**注入**,守住 `allowedRoots` + `sources`;**可选**叠加 Claude Code 的 `output_mode`。**Codex 的 shell-rg 直接排除。** 这是三类工具里**最该先做、最没争议**的一个。

---

## 五、落地顺序与对现有代码的改动

### 5.1 建议顺序:grep → 写文件 → 网络

| 顺序 | 工具 | 为什么这个位置 |
| --- | --- | --- |
| 1️⃣ | **grep** | 最简单(读层、不碰 diff/确认)、最没争议(抄 Cline)、**最急需**——`read_file` 对 800 KB 大头文件会截断,必须靠 grep 定位(`prompt.ts` 里已经埋了「grep 类工具(M4 起)」的伏笔)。 |
| 2️⃣ | **写文件** | 价值最高(agent 终于能「干活」),但**最重**:横跨 4 个包,要新增 diff-first 原语。先用 grep 把读侧打磨好,再上写。 |
| 3️⃣ | **网络** | 优先级最低(本地资料为主);且 `web_search` 卡在「选外部后端」的决策上。建议先只做 `web_fetch`,`web_search` 视情况推后/MCP。 |

> 你列的顺序是「写文件、网络、grep」;工程上我建议**反过来从 grep 起步**(理由如上)。当然最终你定——如果有产品上的理由要先做写文件,也行,只是要先把 §5.3 的跨包改动铺开。

### 5.2 三类工具都复用的现有脚手架

- **工厂函数 + 依赖注入**:全部沿用 `read_file`/`list_files` 的 `createXxxTool(cfg)` 模式(过滤镜 #2)。
- **`resolveSafe` + `allowedRoots`**:grep 限制搜索根;写文件校验目标路径;`web_fetch` 不碰 fs,改用 SSRF 守门。
- **`ToolResult.sources`**:三类都填,`loop.ts::stringifyResult` 会自动拼「来源:」。
- **`prompt.ts` 纪律**:加 grep/写/网络的使用纪律(grep 何时用、写前先 read_file、网络结果要标 URL),并把现有那句「grep 类工具(M4 起)」落实。
- **`requiresConfirm`**:grep=false;网络=true;写文件=需要**新原语**(见下)。

### 5.3 写文件需要的「跨 4 个包」新增(重点提醒)

写文件**不是一个 agent-core 工具就能搞定**——现有确认原语只能弹「一句话 + yes/no」,撑不起 diff-first。需要(类比 `shared` 里已有的 `requestConfirm`/`confirmResponse`,新增一对):

- **`shared`**:新增消息类型,如 `requestApplyDiff`(extension→webview:这是 path + diff)、`applyDiffResponse`(webview→extension:Apply / Reject)。
- **`agent-core`**:`types.ts` 加一个 `ProposeFn`(类似 `ConfirmFn` 的依赖注入),`loop.ts` 在执行写工具时 `await propose(...)`;写工具 handler **只算 newContent + diff,不落盘**。
- **`extension`**:实现 `ProposeFn`——用 `vscode.diff` 打开**原生 diff viewer**,用户 Apply 时**才** `fs.writeFile` 落盘(抄 Cline `DiffViewProvider` 的 open→update→saveChanges/revert 生命周期)。
- **`webview`**:diff 卡片上的 Apply / Reject 按钮。

> ⚠️ **过渡 MVP(如果想快)**:也可以**先复用现有 `requiresConfirm`**——确认卡片里塞一段**文本 diff 预览**,用户点 yes 后**handler 直接落盘**。但这**违背 `CLAUDE.md`「经 VS Code 原生 diff viewer」**那条,只能算临时。真要做就一步到位上 §5.3 的原生 diff 流程。

### 5.4 新增依赖预估

| 工具 | 新增依赖 | 装在哪 | 备注 |
| --- | --- | --- | --- |
| grep | `@vscode/ripgrep`(拿 rg 路径) | `extension` | agent-core 只收一个 `ripgrepPath: string`,不引包 |
| 写文件 | (无新包)diff 用 `vscode.diff` + 自写模糊匹配 | extension / agent-core | 模糊匹配 ~80 行纯 TS,带单测 |
| web_fetch | `turndown` + `cheerio`(或 `@mozilla/readability`+`jsdom`);抓取用内置 `fetch` | agent-core | puppeteer 暂不引(重) |
| web_search | 取决于选哪个搜索 API / 是否走 MCP | 待定 | 见 §6 决策点 |

---

## 六、需要你拍板的决策点

下面是**真正需要你定**的几处(其余我已给明确推荐)。建议逐条选 A/B:

1. **先做哪个?**
   - **A(推荐)**:grep → 写文件 → 网络(理由见 §5.1)。
   - B:按你原话「写文件 → 网络 → grep」。

2. **写文件:模型用什么接口表达改动?**
   - **A(推荐)**:Claude Code 的 `old_string`/`new_string`,用 **JSON 数组**承载多条(§2.4),配多级模糊匹配。
   - B:Cline 的 SEARCH/REPLACE 文本块(更贴近 Cline 原版,但要自己解析文本标记,在原生 function-calling 下是多余复杂)。
   - C:Codex 的 `apply_patch` 格式(**不建议**:依赖微调模型,通用模型易格式错乱)。

3. **写文件:diff-first 流程做到哪一步?**
   - **A(推荐)**:一步到位上**原生 diff viewer + Apply 落盘**(跨 4 包,§5.3),对齐 `CLAUDE.md`。
   - B:先用现有 `requiresConfirm` 做**文本 diff 预览 + yes 落盘**的过渡 MVP(快,但暂时违背「原生 diff viewer」红线)。

4. **网络:`web_search` 怎么办?**
   - **A(推荐)**:**先只做 `web_fetch`**,`web_search` 推后。
   - B:现在就做,选一个外部搜索 API(Brave / Tavily / Bing / Google CSE …,**要 key/要钱**)——你定哪个。
   - C:不自实现,**交给 MCP** search server。

5. **网络:`web_fetch` 抓取用什么?**
   - **A(推荐)**:Node 内置 `fetch` + turndown(轻);只在遇到 SPA 文档站再考虑 puppeteer。
   - B:直接上 Cline 的 puppeteer 真浏览器(重,但能渲染 JS 页面)。

6. **grep:要不要现在就上 Claude Code 的 `output_mode`(content/files/count)三模式?**
   - **A(推荐)**:起步只做 content+上下文(Cline 风),够用;旋钮以后再加。
   - B:一步到位做三模式(更灵活,模型要多学一点)。

> 你定完这几条,我就可以按选择**直接进入实现**(grep 大约半天;写文件要先铺 §5.3 的跨包原语;web_fetch 半天 + 选型)。

---

## 七、来源

> Codex / Cline 为**一手源码**(本地 clone 逐文件读);Claude Code 为官方文档 + 社区逆向。

**Codex**(`openai/codex`,Rust,clone @ `main` 2026-05-28):
- `apply-patch/src/{parser.rs, seek_sequence.rs, lib.rs}` —— patch 语法、4 级模糊匹配、应用算法、部分失败记账 [源码]
- `core/src/tools/handlers/{apply_patch.rs, apply_patch.lark, shell_spec.rs}`、`core/src/{safety.rs, spawn.rs}`、`core/src/tools/spec_plan.rs` —— 工具注册、审批、`apply_patch` 微调门控、shell 跑 rg、stdin=null [源码]
- `core/src/tools/hosted_spec.rs`、`ext/web-search/src/extension.rs` —— web_search 绑 OpenAI 后端 [源码]
- `developers.openai.com/codex/concepts/sandboxing`、`/agent-approvals-security` [官方文档]

**Cline**(`cline/cline`,TS,v3.86.0 @ 2026-05-28):
- `apps/vscode/src/core/assistant-message/diff.ts` —— SEARCH/REPLACE 标记 + 3 级匹配 [源码]
- `apps/vscode/src/core/prompts/system-prompt/tools/{write_to_file,replace_in_file,search_files,web_fetch,web_search,browser_action}.ts` —— 工具描述与参数 [源码]
- `apps/vscode/src/core/task/tools/handlers/{WriteToFileToolHandler,SearchFilesToolHandler,WebFetchToolHandler}.ts`、`integrations/editor/DiffViewProvider.ts`、`core/prompts/responses.ts` —— diff-first 流程、final_file_content、diffError 升级反馈 [源码]
- `apps/vscode/src/services/ripgrep/index.ts` —— `rg --json` + 双重封顶 + `│` 输出 [源码]
- `apps/vscode/src/services/browser/UrlContentFetcher.ts` —— 本地 URL→markdown(puppeteer+cheerio+turndown)[源码]

**Claude Code**(闭源,官方文档 + 逆向):
- `code.claude.com/docs/en/tools-reference` —— Write/Edit/Grep/WebFetch/WebSearch 行为与权限 [官方文档]
- Piebald `claude-code-system-prompts`(从二进制抠出的工具描述)、vtrivedy / thepete.net / mikhail.io 等逆向文 —— WebFetch 二级摘要、可信域名、Grep schema [逆向]

---

> 📌 **本文用途**:三工具(写/网络/grep)实现选型的**决策依据**。落地后,每个工具单独在 `doc/tools/<name>-<一句话>.md` 建档(按 `doc/tools/README.md` 模板)。
> 撰写:2026-05-29 · 调研:Claude(三个并行 subagent 逐家扒源码)· 配套:[`开源Agent工具设计调研.md`](./开源Agent工具设计调研.md)。
