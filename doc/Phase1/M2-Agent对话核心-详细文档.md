# M2 · Agent 对话核心(LLM + 流式 + 工具框架)— 手把手详细文档

> 配套:总规划 [`Embed-AI-Agent-开发规划.md`](../Embed-AI-Agent-开发规划.md)、Phase 1 计划 [`Phase1-plan.md`](../Phase1-plan.md)、上一步 [`M1-插件骨架与Chat面板-详细文档.md`](./M1-插件骨架与Chat面板-详细文档.md)、工程约束根 `CLAUDE.md`。
>
> **本文延续 M0/M1 的风格,面向「会 Vue + 简单 JS,但 TypeScript / React / Node 工程化还在入门」的你。** 新概念第一次出现都会解释,并尽量用你熟悉的经验类比。M2 是 Phase 1 的**主菜**,代码量和概念都比前两关多,照着做大约三到五天。

> 🎯 **M2 一句话目标**:把 M1 的「echo 占位后台」换成**真正的大模型**,并让它能**调用工具**——模型说「我需要查一下时间」→ 框架替它跑工具 → 把结果喂回去 → 模型据此继续回答。打通这条「**工具循环**」,就达成了 Phase 1 的 ★ **tracer bullet**:在面板里和 LLM 多轮流式对话。

> 🧭 **本文的几个关键选择(已定型,别在 M2 重新纠结)**:
>
> 1. 新建一层 **thin adapter**(自写的薄封装)隔离不同厂商(Anthropic / OpenAI / DeepSeek)的 SDK 差异。**先做 Anthropic,再做 OpenAI 分支**(同一份代码靠 `baseURL` 覆盖 DeepSeek)。
> 2. **agent-core 包不碰 `vscode`**——纯 TS、可被 vitest 直接测;它需要的「API key」「确认弹窗」都由 extension **注入**进来。
> 3. **必须流式**:adapter 返回一个 `AsyncIterable`(异步生成器),边收边吐字。
> 4. **确认原语走 Webview**:危险工具执行前,在聊天面板里弹一张「允许 / 拒绝」卡片(M1 已经把 `requestConfirm`/`confirmResponse` 通道留好了)。

> ✅ **实现状态(2026-05-25)**:本文所述代码(含步骤 13 的可视化设置面板)**已全部落地到仓库并通过验证**——`pnpm typecheck` / `pnpm lint` 零报错、`pnpm test` 3 个用例(含 agent 循环离线单测)全绿、`pnpm build` 三件套产出且 SDK 已打进 `extension.js`。实测 SDK 版本:`@anthropic-ai/sdk@0.98`、`openai@6.39`(下文示例 `package.json` 的版本号以实际安装为准)。**F5 真对话需自备 API key**;离线单测不需要联网。

---

## 0. 怎么用这份文档

- 先读**第 3 节「动手前必须懂的概念」**。M2 的难点几乎全在概念上:**agent 的工具循环、async generator(流式)、provider 适配、确认原语**。不先建立心智模型,后面的代码会像天书。
- 第 5 节是动手部分,**分 12 个步骤**,从最底层的类型往上搭到端到端跑通。每步结尾尽量给「运行 → 你应该看到」;中途用 `pnpm typecheck` / `pnpm test` 当检查点。
- 不熟 `async function*` / `for await` / `AbortController` 的,随时翻**附录 A**。
- 报 401 / 429 / 工具 JSON 解析失败之类的坑,翻**附录 B**。

> ⚠️ 心态:M2 你会第一次写「有真正逻辑」的代码(不再是管道)。但好消息是 **M1 把通信协议做扎实的回报来了**——前端的**流式聊天主链路几乎一行不用改**(还是 `streamDelta` / `assistantDone` / `tokenUsage` 那套)。M2 的前端改动只集中在「显示工具调用」和「确认卡片」这两块新东西上。

---

## 1. M2 要达成什么(验收目标)

做完后:

| 命令 / 操作            | 作用                            | 成功标志                                                                       |
| ---------------------- | ------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm install`         | 装 LLM SDK(anthropic / openai) | 无报错                                                                          |
| `pnpm typecheck`       | 类型检查                        | `0 errors`                                                                      |
| `pnpm test`            | 单测                            | M0 用例 + **新增的 agent 循环单测**全绿(不烧 API)                              |
| `pnpm build`           | 打包                            | 三件套仍产出;`extension.js` 里已打进 SDK                                       |
| `pnpm lint`            | 规范                            | 无 error                                                                        |
| **F5 → 发普通消息**    | 真·流式对话                     | 设好 key 后问「你好」→ 助手**逐字**冒出**真模型**的回答;底部显示 token 用量    |
| **F5 → 问「现在几点」**| 工具循环                        | 面板出现「⏳ 工具 `get_current_time`」→「✅」→ 模型用真实时间继续作答           |
| **F5 → 触发确认工具**  | 确认原语                        | 让它跑 `run_demo_command`,面板弹「允许 / 拒绝」卡片;拒绝则操作不执行           |
| 流式途中点「停止」     | 取消                            | 当前回答立即中断(`AbortController` 生效)                                       |
| 没设 key / 配错 model  | 错误可读                        | 面板显示「请运行 Set API Key」「模型不存在」等**人话**错误,而不是一堆红色堆栈  |
| 切 provider            | 多 provider                     | 设置切到 `deepseek` + 填对 `model`/key → 同样能流式对话(走 OpenAI 兼容分支)    |
| **F5 → 点右上角 ⚙**    | 可视化设置(步骤 13)            | 弹出设置面板,可视化选 provider / 填 model·baseURL / 设 key,「保存」即生效     |

**一句话交付物**:给一个假工具(查时间 / 演示命令),agent 能完成「**模型请求调用 → 框架执行 → 结果回填 → 模型续答**」的多步循环;`requiresConfirm` 工具会弹确认;★ **tracer bullet 达成**。

---

## 2. 你会新建 / 改动的文件

`✏️ 改` = 在 M1 基础上修改;`➕ 新` = 新建。**本关主战场是 `agent-core` 包**(M0/M1 一直只占位,现在填满)。

```
Embed-agent/
├─ packages/
│  ├─ shared/
│  │  └─ src/index.ts                  ✏️ 改：工具消息加 id、确认通用化；+ 设置面板消息（步骤 13）
│  ├─ agent-core/                      ← 本关主战场（之前只有一行占位）
│  │  ├─ package.json                  ✏️ 改：加 @anthropic-ai/sdk、openai、shared 依赖
│  │  └─ src/
│  │     ├─ index.ts                   ✏️ 改：从占位 → 重新导出公共 API
│  │     ├─ types.ts                   ➕ 新：核心类型（消息 / 流事件 / 工具 / adapter）
│  │     ├─ prompt.ts                  ➕ 新：通用助手 system prompt
│  │     ├─ errors.ts                  ➕ 新：错误人话化 + 识别「取消」
│  │     ├─ registry.ts                ➕ 新：工具注册表
│  │     ├─ loop.ts                    ➕ 新：★ agent 工具循环（核心）
│  │     ├─ loop.test.ts               ➕ 新：用「假 adapter」驱动循环的单测（不烧 API）
│  │     ├─ tools/
│  │     │  └─ demo.ts                 ➕ 新：两个演示工具（查时间 / 需确认的假命令）
│  │     └─ adapters/
│  │        ├─ index.ts                ➕ 新：工厂——按 provider 造对应 adapter
│  │        ├─ anthropic.ts            ➕ 新：Anthropic adapter（先做这个）
│  │        └─ openai.ts               ➕ 新：OpenAI adapter（覆盖 OpenAI + DeepSeek）
│  ├─ extension/
│  │  ├─ package.json                  ✏️ 改：依赖加 @embed-agent/agent-core
│  │  └─ src/ChatViewProvider.ts       ✏️ 改：删 echo，接 runAgent（key/确认/取消/历史）+ 配置读写（步骤 13）
│  └─ webview/
│     └─ src/
│        ├─ store.ts                   ✏️ 改：消息模型加「工具条目」；处理确认
│        ├─ settings.ts                ➕ 新：设置面板状态（步骤 13）
│        ├─ App.tsx                    ✏️ 改：确认卡片 + token 页脚 + ⚙ 设置入口（步骤 13）
│        ├─ components/
│        │  ├─ MessageItem.tsx         ✏️ 改：能渲染「工具调用」条目
│        │  ├─ MessageList.tsx         ✏️ 改：messages → items
│        │  ├─ ConfirmCard.tsx         ➕ 新：允许 / 拒绝 卡片
│        │  └─ SettingsPanel.tsx       ➕ 新：可视化设置面板（步骤 13）
```

> 📌 注意:**`esbuild.mjs` / `package.json`(根)/ `tsconfig` 都不用改**。M1 把构建链路搭好了,M2 只是往里加代码和依赖。SDK 会被 esbuild 一起打进 `extension.js`(`platform: 'node'`,没问题)。

---

## 3. 动手前必须懂的概念

慢点读这一节。理解了这 10 个概念,代码只是把它们翻译成 TS。

### 概念 1:这次的主角——agent 的「工具循环」

M1 的后台是「收到消息 → 原样回声 → 结束」,一条直线。M2 的后台是一个**循环**,因为大模型可能需要**借助工具**才能回答:

```
用户:「现在几点？」
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│  把「对话历史 + 可用工具清单」发给 LLM（流式）             │
└─────────────────────────────────────────────────────────┘
  │
  ▼
LLM 边想边吐：可能先吐一段文字，然后说「我要调用 get_current_time」
  │
  ├─ 它没要调工具？ ── 直接把文字流给用户 → 本轮结束 ✅
  │
  └─ 它要调工具？
        │
        ▼
   框架执行该工具的 handler（真正去拿当前时间）
        │
        ▼
   把工具结果作为一条新消息「回填」进历史
        │
        ▼
   带着新历史，再发一次给 LLM ──────┐
        ▲                            │
        └────────────（循环，直到 LLM 不再要工具，只输出文字）
```

关键点:**LLM 自己不执行工具,它只会「请求」调用某个工具并给出参数**;真正去跑工具的是我们的框架。跑完把结果塞回去,LLM 才能据此继续。这一来一回可能重复多次(查完时间又要查别的),所以是个 `while` 循环。这套机制就是「AI agent」之所以叫 agent 的核心。

> 类比:LLM 像个**只会动脑、不会动手的专家**。你问它问题,它说「帮我看下 X 文件」,你(框架)跑去看了告诉它,它再接着分析。M2 就是把这个「跑腿 + 转述」的循环写出来。

### 概念 2:thin adapter——为什么要、隔离什么

不同厂商的 SDK,**做的事一样、长相不一样**:

| | Anthropic | OpenAI / DeepSeek |
| --- | --- | --- |
| 调用 | `client.messages.create(...)` | `client.chat.completions.create(...)` |
| system 提示 | 顶层单独的 `system` 字段 | 混在 `messages` 里(`role:'system'`) |
| 工具声明 | `tools:[{name, description, input_schema}]` | `tools:[{type:'function', function:{...}}]` |
| 工具调用结果 | 用户消息里的 `tool_result` 块 | `role:'tool'` 的独立消息 |
| 流式事件 | `content_block_delta` 等一串事件 | `choices[0].delta` 分片 |

如果让 `loop.ts`(工具循环)直接去碰这些差异,它会被 if/else 撕成两半,以后加 provider 更是灾难。**解决办法:在中间隔一层自己写的薄封装(thin adapter)**,对上提供**统一**的接口,对下各自适配某家 SDK:

```
loop.ts（只认统一接口，永远不知道用的是哪家）
   │  adapter.chat({ system, messages, tools, model }) → AsyncIterable<统一的流事件>
   ▼
LlmAdapter（接口）
   ├─ AnthropicAdapter   → 翻译成 Anthropic 的格式，调它的 SDK
   └─ OpenAiAdapter      → 翻译成 OpenAI 的格式，调它的 SDK（DeepSeek 也走这条，只换 baseURL）
```

为此我们要定义**三组「统一中间格式」**(都放在 `types.ts`,见概念 4):**统一的消息(`ChatTurn`)、统一的流事件(`LlmStreamEvent`)、统一的工具描述(`ToolSpec`)**。各 adapter 负责把它们翻来翻去。这就是「适配器模式」。

### 概念 3:流式 = async generator(`async function*` + `yield` + `for await`)

M1 的 echo 用 `setInterval` 定时 `post` 假装流式。M2 是**真**流式:SDK 一边从网络收到模型的输出,我们一边吐出去。表达「一个会陆续产出很多值的异步过程」,JS 的利器是**异步生成器**:

```ts
// 函数名带 *，且是 async —— 这就是「异步生成器」。
async function* countDown(n: number) {
  while (n > 0) {
    await sleep(100); // 可以 await 异步
    yield n; // 每次 yield「吐出」一个值，调用方能立刻拿到，不必等函数结束
    n--;
  }
}

// 用 for await 逐个消费它吐出的值（边产边收）
for await (const x of countDown(3)) {
  console.log(x); // 3 … 2 … 1（每隔 100ms 来一个）
}
```

对照你熟悉的东西:`yield` 有点像「往一根管子里塞一个值,对方马上能取走」;`for await` 就是「站在管子另一头一个一个接」。我们的 adapter 就是 `async function* chat()`,模型每吐一小段文字就 `yield { type:'text', text }`;`loop.ts` 用 `for await` 接,转手发给前端。**整条链路从头到尾都是流式的**,所以你能看到字一个个冒出来。

> 附录 A 有更细的速查。现在只要记住:`async function*` 定义、`yield` 产出、`for await...of` 消费。

### 概念 4:工具 = 一段「说明书(JSON Schema)」+ 一个 handler

一个工具要让 LLM 会用、让框架能跑,需要四样东西:

```ts
interface ToolSpec {
  name: string; //   工具名，如 'get_current_time'
  description: string; // 给 LLM 看的说明：这工具干嘛、什么时候该用
  inputSchema: object; // 用「JSON Schema」描述参数长什么样（给 LLM 看，也用于校验）
  requiresConfirm?: boolean; // 危险操作？跑之前要不要弹确认
  handler: (input) => Promise<ToolResult>; // 真正干活的函数，返回统一的 ToolResult
}
```

**JSON Schema** 是一种「用 JSON 描述数据形状」的标准。比如「需要一个字符串字段 `command`」写成:

```json
{
  "type": "object",
  "properties": { "command": { "type": "string", "description": "要执行的命令" } },
  "required": ["command"]
}
```

为什么用它?因为**两家 SDK 声明工具参数用的都是 JSON Schema**——我们写一份,adapter 直接塞给各家即可。`handler` 的返回值是 M0 就定义好的 **`ToolResult<T>`**(`{ result, sources? }`)——这就是当初把它放进 `shared` 的意义:工具结果有统一形状,还能带「来源引用」。

所有工具登记在一个 **registry(注册表)** 里(就是一个 `Map<name, ToolSpec>`)。循环要执行工具时,按名字从注册表里取。**工具是可插拔的**:以后 M3 加 `read_file`、将来加查芯片的工具,都只是往注册表里 `register` 一个 `ToolSpec`,**循环代码一行不用动**。

### 概念 5:确认原语 = 「请求 / 响应」配对(依赖注入)

有些工具有副作用(执行命令、删文件),原则是 **write-heavy is gated**(`CLAUDE.md` 硬约束):跑之前必须用户点头。流程是:

```
loop 里准备跑一个 requiresConfirm 工具
   │  await confirm({ id, toolName, summary })   ← loop 在这里「卡住」，等一个 true/false
   ▼
extension 实现的 confirm()：
   ├─ 生成一个 id，post {type:'requestConfirm', id, ...} 给 webview
   └─ 把这个 id 对应的「resolve 函数」存进一张表 pendingConfirms，然后返回一个 Promise（先不 resolve）
                                  │
   webview 弹卡片，用户点「允许」 │
                                  ▼
   webview post {type:'confirmResponse', id, approved:true}
                                  │
   extension 收到 → 从表里按 id 找到那个 resolve → resolve(true)
                                  ▼
   loop 里那个 await 这才返回 true，继续执行工具
```

这里有两个要点:

1. **请求和响应靠 `id` 配对**。可能同时挂着多个待确认,用一张 `Map<id, resolve>` 把「谁在等」记下来,响应回来按 id 找。这是异步编程里非常常见的「把回调变成 Promise」手法。
2. **依赖注入**:`loop.ts`(在 agent-core 里)**不知道 vscode、不知道 webview**,它只接受一个 `confirm: (req) => Promise<boolean>` 函数当参数。具体「怎么弹窗、怎么等回应」由 extension 实现后**注入**进来。这样 agent-core 保持纯净、可测试(测试时注入一个「永远返回 true」的假 confirm 即可)。

> 同理,**API key 也是注入的**:agent-core 不读 SecretStorage,extension 读出来传进去。agent-core 全程不碰 vscode API。

### 概念 6:取消 = AbortController / AbortSignal

用户点「停止」,要能掐断正在进行的网络请求。浏览器/Node 的标准做法是 **AbortController**:

```ts
const controller = new AbortController();
someAsyncCall({ signal: controller.signal }); // 把「信号」交给异步操作
controller.abort(); // 在别处喊停 → 上面那个操作会抛出 AbortError
```

我们每开始一轮对话就 `new AbortController()`,把 `signal` 一路传进 adapter → SDK;收到 `cancelStream` 就 `abort()`。两家 SDK 都支持 `{ signal }` 参数,`abort()` 后流会抛错,我们识别出「这是取消、不是真错误」,安静收尾。

### 概念 7:会话历史与「续答」;为什么要截断

M1 是「一问一答、互不相关」。M2 要**多轮**:模型得看到之前说过什么。所以 extension 维护一个 `history: ChatTurn[]`,每轮把新消息**追加**进去。工具循环里,模型的发言、工具的结果也都追加进 `history`——这样「把结果回填、再问一次」其实就是「带着更长的 history 再调一次 adapter」。

但 history 会越滚越长,而 LLM 有**上下文长度上限**、且**按 token 收费**。所以要做两件防护:

- **单个工具输出过长 → 截断**(比如 `read_file` 读到一个一万行的文件,不能整个塞回去)。M2 简单地按字符数截断 + 标注「已截断」。
- **历史过长 → 压缩**。完整方案是「让 LLM 把旧对话总结成一段摘要」,但那要额外调一次模型。**M2 先只做截断(留最近 N 轮)**,把「摘要压缩」标记为后续优化——别在第一版就把自己卷进去。

### 概念 8:agent-core 是纯 TS——可测试、不碰 vscode

回顾 M0 概念 5:插件分「extension(Node)」和「webview(浏览器)」两个世界。M2 引入的 `agent-core` **两个世界都不属于**,它是一包**纯逻辑**:输入消息、输出事件,不碰文件、不碰 vscode、不碰 DOM。好处:

- **可被 vitest 直接跑**(像 M0 测 `formatTokenUsage` 那样)。我们会写一个用「假 adapter」驱动工具循环的单测,**不花一分钱 API**就能验证循环逻辑对不对(也为 M4 评测打底)。
- **职责清晰**:agent-core 管「怎么和模型对话、怎么调工具」;extension 管「key、确认弹窗、把事件转成 webview 消息」;webview 管「显示」。三层各司其职。

### 概念 9:多 provider 的格式差异与 DeepSeek

我们支持三家:`anthropic` / `openai` / `deepseek`。其中 **DeepSeek 的接口「兼容 OpenAI」**——同样的 `chat.completions` 协议,只是把 `baseURL` 指到 `https://api.deepseek.com`、换个 key 和 model。所以 **adapter 只需写两份**:Anthropic 一份、OpenAI 一份;DeepSeek 复用 OpenAI 那份。工厂函数按 `provider` 选:

```
provider === 'anthropic'            → AnthropicAdapter
provider === 'openai' | 'deepseek'  → OpenAiAdapter（deepseek 时默认填好 deepseek 的 baseURL）
```

> ⚠️ 切了 provider 记得**同时改 model**:`anthropic` 用 `claude-...`,`deepseek` 用 `deepseek-...`。provider 和 model 对不上是新手最常见的 404/400 来源(附录 B)。

### 概念 10:错误与重试;token 用量从哪来

- **错误可读**:SDK 抛的错带 `status`(HTTP 状态码)。我们写一个 `humanizeError` 把它翻成人话:401 → 「key 无效/未设置」、429 → 「被限流,稍后再试」、404 → 「model/baseURL 不对」。前端只显示这句话,不显示一屏红色堆栈。
- **重试**:两家官方 SDK **默认自带重试**(对 429 / 5xx 做指数退避)。我们只要在创建 client 时设 `maxRetries`,不必自己写重试循环。剩下确实失败的,交给 `humanizeError`。
- **token 用量**:不用自己数(也就暂时用不上 tiktoken)——**两家 API 都会在响应里报真实用量**(Anthropic 的 `usage`、OpenAI 的 `usage`)。adapter 把它 `yield` 成一个 `usage` 事件,循环转发给前端显示。

---

## 4. 准备工作

M0/M1 的工具链都还在用,无需重装。M2 只多两件事:

1. **拿一个真 API key**(三选一,有哪个用哪个):
   - Anthropic:<https://console.anthropic.com> → API Keys(开发期首选,工具调用最稳)。
   - OpenAI:<https://platform.openai.com> → API keys。
   - DeepSeek:<https://platform.deepseek.com> → API keys(最便宜,兼容 OpenAI)。
   > key 只会存进 VS Code 的 **SecretStorage**(M1 已做的 `Embed Agent: Set API Key` 命令),不进任何配置文件、不进 git。

2. **新增的 npm 包**(下一节用 `pnpm add` 装):`@anthropic-ai/sdk`、`openai`。无需任何系统级工具。

> 💡 没有 key 也能推进:`agent-core` 的**单元测试用假 adapter**,不需要联网/不花钱(步骤 9)。只有第 12 步「F5 端到端真对话」才需要 key。

---

## 5. 动手:逐步搭建

> 约定同 M0/M1:命令都在项目根 `D:\MyCode\Embed-agent` 下跑;「文件:`xxx`」= 新建或覆盖该文件。建议**严格按步骤顺序**——后面的文件会 import 前面的。

### 步骤 1 · 改 shared 协议(3 处小改)

回忆 M1:**改协议先改 `shared`**,前后端共用,改完两端的类型同时更新。M2 要动三处,都是为了「显示工具调用」和「通用确认」:

1. `toolCallStart` / `toolCallResult` 各加一个 `id`——前端要靠 id 把「开始」和「结束」对应起来(一轮可能并发多个工具)。
2. `requestConfirm` 从「只带一条 `command` 字符串」改成**通用形状**(`toolName` + `summary`)——M1 时只想着「确认执行命令」,现在要确认**任意工具**,带上工具名 + 一句人话摘要更合适。

**文件:`packages/shared/src/index.ts`**——把 `ExtToWebview` 里这三条替换成下面这样(其余不动):

```typescript
// ---- 方向二:Extension(后台)──► Webview(界面)----
export type ExtToWebview =
  // 回答的一小片增量文本(流式输出,一片一片来);界面把 text 追加到当前气泡。
  | { type: 'streamDelta'; text: string }
  // agent 开始调用某个工具了;id 用于和下面的 result 配对,name 是工具名。
  | { type: 'toolCallStart'; id: string; name: string }
  // 某次工具调用结束;id 对应上面的 start,ok 表示成功与否。
  | { type: 'toolCallResult'; id: string; name: string; ok: boolean }
  // 本轮回答彻底结束(流式输出完了)。无字段;界面可借此重新启用输入框。
  | { type: 'assistantDone' }
  // agent 想执行一个需要用户点头的操作,请界面弹确认卡片。
  // id:之后用户的 confirmResponse 靠它对应回来;
  // toolName:要调用的工具名;summary:一句人话说明它要干什么(原样给用户看清再决定)。
  | { type: 'requestConfirm'; id: string; toolName: string; summary: string }
  // 出错了(LLM 报 429 / 超时、配置缺失等);message 是人类可读的说明。
  | { type: 'error'; message: string }
  // 本轮 / 累计 token 用量;input、output 分别是输入、输出 token 数。
  | { type: 'tokenUsage'; input: number; output: number };
```

> `WebviewToExt`(前端发给后端的)和 `ToolResult` / `Source` / `AgentConfig` / `formatTokenUsage` **都不用改**——M0/M1 早就定好了。这次只动了 `ExtToWebview` 的三行。

**运行 → 你应该看到**:暂时不用跑,改完 shared 后端两端会同时「报错变多」(因为旧代码还用着旧字段),这是正常的,后面步骤会把两端都改到位。

### 步骤 2 · agent-core 的依赖

给 `agent-core` 包装 LLM SDK 和共享类型。`--filter` 指定只装到这个包:

```powershell
pnpm --filter @embed-agent/agent-core add @anthropic-ai/sdk openai
# 工作区内部包要用 workspace 协议（否则 pnpm 去 registry 找会 404）
pnpm --filter @embed-agent/agent-core add @embed-agent/shared@workspace:*
```

装完 `packages/agent-core/package.json` 大致长这样(**版本以你实际装上的为准**,下面只是示意):

```json
{
  "name": "@embed-agent/agent-core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.98.0",
    "@embed-agent/shared": "workspace:*",
    "openai": "^6.39.0"
  }
}
```

> ⚠️ 同 M1 的坑:① 内部包必须 `@embed-agent/shared@workspace:*`,直接 `add @embed-agent/shared` 会 404。② pnpm 可能提示 `Ignored build scripts`,不影响,无需处理。

**运行 → 你应该看到**:

```powershell
pnpm install
```

无报错;`agent-core/package.json` 多出 `dependencies`。

### 步骤 3 · 核心类型(`types.ts`)

这是 M2 的「`shared` 时刻」——adapter、循环、registry 都依赖这一份契约。它定义概念 2 说的**三组统一中间格式** + 几个配套类型。

**文件:`packages/agent-core/src/types.ts`**

```typescript
import type { ToolResult } from '@embed-agent/shared';

// ========== 1) 统一的「工具调用请求」==========
// LLM 说「我要调 name 工具,参数是 input」;id 是这次调用的唯一标识。
export interface ToolCall {
  id: string;
  name: string;
  input: unknown; // 模型给的参数(从 JSON 解析来);用 unknown 逼你用前先收窄类型
}

// ========== 2) 统一的「一条对话消息」==========
// 这是 provider 无关的中间格式;两个 adapter 各自把它翻译成自家 SDK 的消息格式。
// 可辨识联合(靠 role 当标签),和 shared 里的消息协议是同一个 TS 模式。
export type ChatTurn =
  | { role: 'user'; content: string } // 用户说的话
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] } // 模型说的话(可能还附带「要调哪些工具」)
  | { role: 'tool'; toolCallId: string; content: string }; // 某次工具调用的结果(toolCallId 对应上面的 ToolCall.id)

// ========== 3) 统一的「工具描述」==========
export interface ToolSpec {
  name: string;
  description: string; // 给 LLM 看:这工具干嘛、何时用
  inputSchema: Record<string, unknown>; // JSON Schema(object),描述参数形状
  requiresConfirm?: boolean; // true = 执行前必须用户确认
  handler: (input: unknown) => Promise<ToolResult>; // 真正干活;返回 shared 的统一 ToolResult
}

// ========== 4) 统一的「流事件」(adapter 边收边吐这些)==========
export type LlmStreamEvent =
  | { type: 'text'; text: string } // 一小片回答文字
  | { type: 'toolCall'; call: ToolCall } // 模型完整地请求了一次工具调用
  | { type: 'usage'; input: number; output: number }; // 本次请求的 token 用量

// adapter 的输入:一次「请把这些消息+工具发给模型」的请求
export interface LlmChatRequest {
  system: string;
  messages: ChatTurn[];
  tools: ToolSpec[];
  model: string;
  signal?: AbortSignal; // 取消信号(概念 6)
}

// ========== 5) adapter 接口(loop 只认这个,不认具体厂商)==========
export interface LlmAdapter {
  chat(req: LlmChatRequest): AsyncIterable<LlmStreamEvent>;
}

// ========== 6) 循环吐给上层(extension)的事件 ==========
// 和 LlmStreamEvent 不同:这是「整个 agent 循环」对外的事件,含工具开始/结束/结束/错误。
// extension 会把它们一一映射成 shared 的 ExtToWebview 发给前端。
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'toolStart'; id: string; name: string }
  | { type: 'toolEnd'; id: string; name: string; ok: boolean }
  | { type: 'usage'; input: number; output: number }
  | { type: 'done' } // 本轮彻底结束(模型不再要工具)
  | { type: 'error'; message: string };

// ========== 7) 确认原语(依赖注入,概念 5)==========
export interface ConfirmRequest {
  id: string;
  toolName: string;
  summary: string;
}
export type ConfirmFn = (req: ConfirmRequest) => Promise<boolean>;
```

> 这一份看着多,其实就是把概念 1、2、4、5、6 落成 TS。后面每个文件都会 `import` 它。先囫囵读懂每个类型「代表什么」,具体怎么用看后面。

### 步骤 4 · 工具注册表 + 两个演示工具

#### 4.1 注册表

就是一个带「防重名」的 `Map`。

**文件:`packages/agent-core/src/registry.ts`**

```typescript
import type { ToolSpec } from './types';

// 工具注册表:登记所有可用工具,循环按名字取用。
export class ToolRegistry {
  private tools = new Map<string, ToolSpec>();

  register(spec: ToolSpec): void {
    if (this.tools.has(spec.name)) {
      throw new Error(`工具重名:${spec.name}`);
    }
    this.tools.set(spec.name, spec);
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  // 给 adapter:把所有工具的描述发给 LLM(只用到 name/description/inputSchema)
  specs(): ToolSpec[] {
    return [...this.tools.values()];
  }
}
```

#### 4.2 两个演示工具

M2 的交付要求「给一个假工具,验证循环 + 确认」。我们给两个,正好覆盖两种情况:

- `get_current_time`:**无参数、无需确认**——验证最朴素的工具循环。
- `run_demo_command`:**带参数、需要确认**——验证确认原语(它**不真的执行命令**,只是假装,纯演示;真正受控的 `run_command` 是 M3 的事)。

**文件:`packages/agent-core/src/tools/demo.ts`**

```typescript
import type { ToolSpec } from '../types';

// 工具①:返回当前时间。无参数、无副作用、无需确认。
export const getCurrentTime: ToolSpec = {
  name: 'get_current_time',
  description: '返回当前的日期与时间(ISO 8601 格式)。当用户问“现在几点 / 今天几号”时调用。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => ({ result: new Date().toISOString() }),
};

// 工具②:演示「需要确认」的受控操作。它并不真执行命令,只是回显,纯粹用来验证确认原语。
export const runDemoCommand: ToolSpec = {
  name: 'run_demo_command',
  description: '【演示用】假装执行一条命令并返回结果。用于演示“需要用户确认”的受控操作。',
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string', description: '要执行的命令' } },
    required: ['command'],
    additionalProperties: false,
  },
  requiresConfirm: true, // ← 关键:执行前会触发确认卡片
  handler: async (input) => {
    const { command } = input as { command: string };
    return { result: `(demo) 假装执行了:${command}\n退出码:0` };
  },
};

export const demoTools: ToolSpec[] = [getCurrentTime, runDemoCommand];
```

> `additionalProperties: false` 是给 LLM 的暗示「别瞎传多余字段」,能减少幻觉参数。`handler` 返回的 `{ result: ... }` 就是 M0 定义的 `ToolResult`(`sources` 可选,这俩演示工具用不上)。

### 步骤 5 · 错误处理 + system prompt

#### 5.1 错误人话化 + 识别取消

**文件:`packages/agent-core/src/errors.ts`**

```typescript
// 判断一个错误是不是「用户主动取消」——取消不算真错误,要安静收尾。
export function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.name === 'AbortError' || e.name === 'APIUserAbortError' || /abort/i.test(e.message))
  );
}

// 把 SDK 抛的错翻成「人话」,只给用户看这一句。
export function humanizeError(e: unknown): string {
  const err = e as { status?: number; message?: string };
  switch (err?.status) {
    case 401:
      return 'API key 无效或未设置。请运行命令「Embed Agent: Set API Key」。';
    case 403:
      return '没有访问该模型/接口的权限(403)。检查 key 的额度与权限。';
    case 404:
      return '模型或接口不存在(404)。检查「设置」里的 model 与 baseURL 是否匹配当前 provider。';
    case 429:
      return '触发提供商限流(429),已自动重试仍失败。请稍后再试。';
    case 500:
    case 503:
    case 529:
      return '提供商服务暂时不可用,请稍后再试。';
    default:
      return `请求失败:${err?.message ?? String(e)}`;
  }
}
```

#### 5.2 通用 system prompt

本阶段是**通用助手**,**绝不注入任何领域(嵌入式/芯片)信息**(`Phase1-plan.md` 的护栏)。

**文件:`packages/agent-core/src/prompt.ts`**

```typescript
export const SYSTEM_PROMPT = `你是 Embed Agent,一个运行在 VS Code 里的通用编程助手。

工作方式:
- 用简洁、专业的中文回答。
- 当你需要外部信息或需要执行某个动作时,调用提供给你的工具,不要凭空编造结果。
- 调用工具前后,简短说明你正在做什么,让用户能看懂你的步骤。
- 代码一律用 markdown 代码块给出,并标注语言。
- 如果不确定,就说明你的不确定,不要硬猜。`;
```

### 步骤 6 · Anthropic adapter(先做这家)

这是第一份具体 adapter。它做三件事:① 把统一格式翻成 Anthropic 格式;② 调 SDK 的流式接口;③ 把 Anthropic 的事件翻回统一的 `LlmStreamEvent`。

**文件:`packages/agent-core/src/adapters/anthropic.ts`**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import type {
  ChatTurn,
  LlmAdapter,
  LlmChatRequest,
  LlmStreamEvent,
  ToolSpec,
} from '../types';

export function createAnthropicAdapter(apiKey: string, baseURL?: string): LlmAdapter {
  // maxRetries:SDK 自带对 429/5xx 的指数退避重试(概念 10),不用我们自己写。
  const client = new Anthropic({ apiKey, maxRetries: 3, ...(baseURL ? { baseURL } : {}) });

  return {
    async *chat(req: LlmChatRequest): AsyncIterable<LlmStreamEvent> {
      // 开流。stream:true 返回一个可 for await 的原始事件流;signal 用于取消。
      const stream = await client.messages.create(
        {
          model: req.model,
          max_tokens: 4096, // Anthropic 必填:本次最多生成多少 token
          stream: true, // ← 必须!否则返回的是整条消息而不是事件流，下面的 for await 会失败
          system: req.system, // Anthropic 的 system 是顶层字段
          messages: toAnthropicMessages(req.messages),
          tools: toAnthropicTools(req.tools),
        },
        { signal: req.signal },
      );

      // 工具调用的参数是「流式 JSON 片段」一段段来的,得自己拼起来。
      let pending: { id: string; name: string; json: string } | null = null;
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const event of stream) {
        switch (event.type) {
          case 'message_start':
            inputTokens = event.message.usage.input_tokens;
            break;
          case 'content_block_start':
            // 模型开了一个「工具调用块」:记下 id/name,开始攒它的参数 JSON
            if (event.content_block.type === 'tool_use') {
              pending = { id: event.content_block.id, name: event.content_block.name, json: '' };
            }
            break;
          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              yield { type: 'text', text: event.delta.text }; // 普通回答文字 → 立刻吐出去
            } else if (event.delta.type === 'input_json_delta' && pending) {
              pending.json += event.delta.partial_json; // 工具参数的 JSON 片段 → 攒着
            }
            break;
          case 'content_block_stop':
            // 工具调用块结束:把攒好的 JSON 解析成对象,吐出一个完整的 toolCall
            if (pending) {
              const input = pending.json ? JSON.parse(pending.json) : {};
              yield { type: 'toolCall', call: { id: pending.id, name: pending.name, input } };
              pending = null;
            }
            break;
          case 'message_delta':
            outputTokens = event.usage.output_tokens; // 累计输出 token
            break;
        }
      }
      yield { type: 'usage', input: inputTokens, output: outputTokens };
    },
  };
}

// ----- 把统一格式翻成 Anthropic 格式 -----

function toAnthropicTools(tools: ToolSpec[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

function toAnthropicMessages(turns: ChatTurn[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const turn of turns) {
    if (turn.role === 'user') {
      out.push({ role: 'user', content: turn.content });
    } else if (turn.role === 'assistant') {
      if (turn.toolCalls && turn.toolCalls.length > 0) {
        // 助手又说话又调工具:拼成 [文本块?, 工具块, 工具块…]
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (turn.content) blocks.push({ type: 'text', text: turn.content });
        for (const c of turn.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: c.id,
            name: c.name,
            input: c.input as Record<string, unknown>,
          });
        }
        out.push({ role: 'assistant', content: blocks });
      } else {
        out.push({ role: 'assistant', content: turn.content });
      }
    } else {
      // 工具结果:Anthropic 要求把 tool_result 放进「紧跟其后的一条 user 消息」里。
      // 所以把连续的多个工具结果合并进同一条 user 消息。
      const block: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: turn.toolCallId,
        content: turn.content,
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        (last.content as Anthropic.ContentBlockParam[]).push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    }
  }
  return out;
}
```

> 这份是 M2 最「绕」的一段,核心难点就两处:① **工具参数靠 `input_json_delta` 流式拼 JSON**,要在 `content_block_stop` 时 `JSON.parse`;② **工具结果要合并进一条 user 消息**(Anthropic 的硬性要求,否则下一轮请求会被拒)。读不懂可以先照抄,跑通后回头看。

### 步骤 7 · OpenAI / DeepSeek adapter + 工厂

#### 7.1 OpenAI adapter

同一个 `LlmAdapter` 接口,换成 OpenAI 的协议。DeepSeek 复用它。

**文件:`packages/agent-core/src/adapters/openai.ts`**

```typescript
import OpenAI from 'openai';
import type { ChatTurn, LlmAdapter, LlmChatRequest, LlmStreamEvent, ToolSpec } from '../types';

export function createOpenAiAdapter(apiKey: string, baseURL?: string): LlmAdapter {
  const client = new OpenAI({ apiKey, maxRetries: 3, ...(baseURL ? { baseURL } : {}) });

  return {
    async *chat(req: LlmChatRequest): AsyncIterable<LlmStreamEvent> {
      const stream = await client.chat.completions.create(
        {
          model: req.model,
          messages: toOpenAiMessages(req.system, req.messages),
          tools: toOpenAiTools(req.tools),
          tool_choice: 'auto', // 让模型自己决定要不要调工具
          stream: true,
          stream_options: { include_usage: true }, // 让最后一片带上 token 用量
        },
        { signal: req.signal },
      );

      // OpenAI 的工具调用按 index 分片下发(name 一片、arguments 几片),按下标攒起来。
      const calls: { id: string; name: string; args: string }[] = [];

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (choice?.delta?.content) {
          yield { type: 'text', text: choice.delta.content };
        }
        for (const tc of choice?.delta?.tool_calls ?? []) {
          const slot = (calls[tc.index] ??= { id: '', name: '', args: '' });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
        // 带 include_usage 时,最后会有一片 choices 为空、只带 usage
        if (chunk.usage) {
          yield {
            type: 'usage',
            input: chunk.usage.prompt_tokens,
            output: chunk.usage.completion_tokens,
          };
        }
      }

      // 流结束后,把攒好的工具调用一次性吐出
      for (const c of calls) {
        if (!c.name) continue;
        yield { type: 'toolCall', call: { id: c.id, name: c.name, input: c.args ? JSON.parse(c.args) : {} } };
      }
    },
  };
}

// ----- 翻成 OpenAI 格式 -----

function toOpenAiTools(tools: ToolSpec[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

function toOpenAiMessages(
  system: string,
  turns: ChatTurn[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  // OpenAI 的 system 是 messages 里的第一条
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
  ];
  for (const turn of turns) {
    if (turn.role === 'user') {
      out.push({ role: 'user', content: turn.content });
    } else if (turn.role === 'assistant') {
      if (turn.toolCalls && turn.toolCalls.length > 0) {
        out.push({
          role: 'assistant',
          content: turn.content || null,
          tool_calls: turn.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.input) },
          })),
        });
      } else {
        out.push({ role: 'assistant', content: turn.content });
      }
    } else {
      // OpenAI:每个工具结果是一条独立的 role:'tool' 消息(和 Anthropic 不同,不用合并)
      out.push({ role: 'tool', tool_call_id: turn.toolCallId, content: turn.content });
    }
  }
  return out;
}
```

> 对比步骤 6 能直观看到概念 2 说的差异:system 的位置、工具声明的包法(`type:'function'`)、工具结果的形态(独立 `role:'tool'` vs 合并进 user)。两份 adapter 各自消化这些差异,**对 loop 暴露的接口完全一样**。

#### 7.2 工厂:按 provider 选 adapter

**文件:`packages/agent-core/src/adapters/index.ts`**

```typescript
import type { AgentConfig } from '@embed-agent/shared';
import type { LlmAdapter } from '../types';
import { createAnthropicAdapter } from './anthropic';
import { createOpenAiAdapter } from './openai';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

export function createAdapter(config: AgentConfig, apiKey: string): LlmAdapter {
  switch (config.provider) {
    case 'anthropic':
      return createAnthropicAdapter(apiKey, config.baseURL || undefined);
    case 'openai':
      return createOpenAiAdapter(apiKey, config.baseURL || undefined);
    case 'deepseek':
      // DeepSeek 兼容 OpenAI:没填 baseURL 就默认指向 deepseek
      return createOpenAiAdapter(apiKey, config.baseURL || DEEPSEEK_BASE_URL);
  }
}
```

### 步骤 8 · agent 工具循环(`loop.ts`,核心)

把概念 1 的流程图翻成代码。这是 M2 的心脏。

**文件:`packages/agent-core/src/loop.ts`**

```typescript
import type { ToolResult } from '@embed-agent/shared';
import type { AgentEvent, ChatTurn, ConfirmFn, LlmAdapter, ToolCall } from './types';
import type { ToolRegistry } from './registry';
import { SYSTEM_PROMPT } from './prompt';
import { humanizeError, isAbortError } from './errors';

const MAX_TOOL_RESULT_CHARS = 8000; // 单个工具结果回填上限,超了截断(概念 7)

export interface RunAgentOptions {
  adapter: LlmAdapter;
  registry: ToolRegistry;
  model: string;
  // 调用方(extension)已把本轮 user 消息 push 进 history;loop 会把
  // 模型发言 / 工具结果继续追加进同一个数组,实现多轮记忆(概念 7)。
  history: ChatTurn[];
  confirm: ConfirmFn; // 依赖注入的确认函数(概念 5)
  signal?: AbortSignal; // 取消信号(概念 6)
}

export async function* runAgent(opts: RunAgentOptions): AsyncIterable<AgentEvent> {
  const { adapter, registry, model, history, confirm, signal } = opts;
  const tools = registry.specs();

  // 多步循环:模型可能先调工具,拿结果后再说话,可能反复多轮,直到不再调工具(概念 1)。
  while (true) {
    if (signal?.aborted) return;

    let assistantText = '';
    const toolCalls: ToolCall[] = [];

    // ① 把当前历史发给模型,边收边吐
    try {
      for await (const ev of adapter.chat({ system: SYSTEM_PROMPT, messages: history, tools, model, signal })) {
        if (ev.type === 'text') {
          assistantText += ev.text;
          yield { type: 'text', text: ev.text };
        } else if (ev.type === 'toolCall') {
          toolCalls.push(ev.call);
        } else if (ev.type === 'usage') {
          yield { type: 'usage', input: ev.input, output: ev.output };
        }
      }
    } catch (e) {
      if (isAbortError(e)) return; // 用户取消:安静收尾
      yield { type: 'error', message: humanizeError(e) };
      return;
    }

    // ② 记录模型这一轮的发言(以及它想调的工具)
    if (toolCalls.length > 0) {
      history.push({ role: 'assistant', content: assistantText, toolCalls });
    } else {
      // 没要调工具 → 本轮结束
      history.push({ role: 'assistant', content: assistantText });
      yield { type: 'done' };
      return;
    }

    // ③ 逐个执行工具。务必保证「每个 tool_use 都配一条 tool_result」,
    //    否则下一轮请求结构非法(尤其 Anthropic 会直接报错)。
    for (const call of toolCalls) {
      yield { type: 'toolStart', id: call.id, name: call.name };

      let text: string;
      let ok = true;
      const spec = registry.get(call.name);

      if (signal?.aborted) {
        text = '已取消。';
        ok = false;
      } else if (!spec) {
        text = `未知工具:${call.name}`;
        ok = false;
      } else if (spec.requiresConfirm && !(await confirm({ id: call.id, toolName: call.name, summary: summarize(call.input) }))) {
        text = '用户拒绝了该操作。';
        ok = false;
      } else {
        try {
          text = stringifyResult(await spec.handler(call.input));
        } catch (e) {
          text = `工具执行失败:${(e as Error).message}`;
          ok = false;
        }
      }

      yield { type: 'toolEnd', id: call.id, name: call.name, ok };
      history.push({ role: 'tool', toolCallId: call.id, content: cap(text) });
    }

    if (signal?.aborted) return; // 工具跑完若已取消,就不再请求模型
    // 否则进入下一轮 while:带着工具结果再问模型,让它续答
  }
}

// ----- 小工具 -----

// 给确认卡片用的一句话摘要:命令类工具直接显示命令,其余显示 JSON。
function summarize(input: unknown): string {
  if (input && typeof input === 'object' && 'command' in input) {
    return String((input as { command: unknown }).command);
  }
  return JSON.stringify(input);
}

// 把 ToolResult 变成喂回模型的字符串;带 sources 时附上来源(对应「输出契约」)。
function stringifyResult(r: ToolResult): string {
  const body = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
  if (!r.sources?.length) return body;
  const src = r.sources.map((s) => `- ${s.file}${s.lines ? `:${s.lines}` : ''}`).join('\n');
  return `${body}\n\n来源:\n${src}`;
}

function cap(s: string): string {
  return s.length <= MAX_TOOL_RESULT_CHARS ? s : `${s.slice(0, MAX_TOOL_RESULT_CHARS)}\n…(已截断)`;
}
```

> 对着概念 1 的流程图读这段:`while` 是外层循环;`for await` 收模型输出(①);`if toolCalls.length===0` 是出口(②);`for (call of toolCalls)` 跑工具并回填(③),其中 `requiresConfirm` 那行就是确认原语的落点。**第 ③ 步「每个工具必配一条结果」是正确性关键**——取消/拒绝/失败也都会 push 一条结果,保证历史结构合法。

### 步骤 9 · 出口 + 单元测试(检查点)

#### 9.1 重新导出公共 API

**文件:`packages/agent-core/src/index.ts`**(覆盖那行占位)

```typescript
export * from './types';
export { ToolRegistry } from './registry';
export { runAgent, type RunAgentOptions } from './loop';
export { createAdapter } from './adapters';
export { SYSTEM_PROMPT } from './prompt';
export { demoTools, getCurrentTime, runDemoCommand } from './tools/demo';
export { humanizeError, isAbortError } from './errors';
```

#### 9.2 用「假 adapter」测循环(不烧 API)

这是概念 8 的兑现:不联网、不花钱,验证工具循环逻辑。假 adapter 第一轮要求调 `get_current_time`,第二轮给最终答复。

**文件:`packages/agent-core/src/loop.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { runAgent } from './loop';
import { ToolRegistry } from './registry';
import type { AgentEvent, ChatTurn, LlmAdapter } from './types';

// 假 adapter:第 1 次调用 → 要求调工具;第 2 次 → 给最终文字。完全离线。
function stubAdapter(): LlmAdapter {
  let round = 0;
  return {
    async *chat() {
      round += 1;
      if (round === 1) {
        yield { type: 'text', text: '让我查一下时间。' };
        yield { type: 'toolCall', call: { id: 't1', name: 'get_current_time', input: {} } };
        yield { type: 'usage', input: 10, output: 5 };
      } else {
        yield { type: 'text', text: '现在时间已获取,回答完毕。' };
        yield { type: 'usage', input: 20, output: 8 };
      }
    },
  };
}

describe('runAgent 工具循环', () => {
  it('调用工具后能拿结果续答,并把历史补全', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'get_current_time',
      description: '',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ result: '2026-05-24T00:00:00Z' }),
    });

    const history: ChatTurn[] = [{ role: 'user', content: '现在几点?' }];
    const events: AgentEvent[] = [];
    for await (const ev of runAgent({
      adapter: stubAdapter(),
      registry,
      model: 'stub',
      history,
      confirm: async () => true, // 测试里一律放行
    })) {
      events.push(ev);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain('toolStart');
    expect(types).toContain('toolEnd');
    expect(types[types.length - 1]).toBe('done'); // 最后一定是 done
    // 历史被补全:有「助手要调工具」和「工具结果」两类
    expect(history.some((t) => t.role === 'tool')).toBe(true);
    expect(history.some((t) => t.role === 'assistant' && t.toolCalls?.length)).toBe(true);
  });
});
```

**运行 → 你应该看到**:

```powershell
pnpm typecheck   # 0 errors（agent-core 全部类型对得上）
pnpm test        # M0 的用例 + 这个新用例，全绿
```

> 🎉 到这里,**agent-core 这包独立成立了**——逻辑自洽、有测试、不依赖 vscode。下面把它接进插件。

### 步骤 10 · extension 接线:删 echo,接 runAgent

#### 10.1 让 extension 依赖 agent-core

```powershell
pnpm --filter embed-agent add @embed-agent/agent-core@workspace:*
pnpm install
```

装完 `packages/extension/package.json` 的 `dependencies` 会多一行 `"@embed-agent/agent-core": "workspace:*"`(挨着已有的 `@embed-agent/shared`)。

#### 10.2 重写 ChatViewProvider

把 M1 的 echo 后台换成真正的 agent 循环。`getHtml` / `makeNonce` / `resolveWebviewView` 的 HTML 部分**原样保留**(M1 已经写好),只换「消息处理 + 后台」那部分。

**文件:`packages/extension/src/ChatViewProvider.ts`**(整份替换)

```typescript
import * as vscode from 'vscode';
import type { WebviewToExt, ExtToWebview, AgentConfig, LlmProvider } from '@embed-agent/shared';
import {
  ToolRegistry,
  createAdapter,
  runAgent,
  demoTools,
  type ChatTurn,
  type ConfirmRequest,
} from '@embed-agent/agent-core';

const SECRET_KEY = 'embed-agent.apiKey';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'embed-agent.chat';

  private view?: vscode.WebviewView;
  private history: ChatTurn[] = []; // 多轮对话记忆(概念 7)
  private readonly registry = new ToolRegistry();
  private abort?: AbortController; // 当前这轮的取消器(概念 6)
  private readonly pendingConfirms = new Map<string, (approved: boolean) => void>(); // 概念 5
  private readonly totalUsage = { input: 0, output: 0 }; // 累计 token

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    // 注册演示工具。M3 会在这里继续 register 真正的只读工具(read_file 等)。
    for (const tool of demoTools) this.registry.register(tool);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage((msg: WebviewToExt) => this.onMessage(msg));
  }

  private post(message: ExtToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  private onMessage(msg: WebviewToExt): void {
    switch (msg.type) {
      case 'userMessage':
        void this.handleUserMessage(msg.text);
        break;
      case 'cancelStream':
        this.abort?.abort(); // 触发取消;runAgent 会识别并安静收尾
        this.output.appendLine('[user] 取消');
        break;
      case 'confirmResponse': {
        // 把用户的「允许/拒绝」交给正在 await 的那个 confirm(按 id 配对,概念 5)
        const resolve = this.pendingConfirms.get(msg.id);
        if (resolve) {
          resolve(msg.approved);
          this.pendingConfirms.delete(msg.id);
        }
        this.output.appendLine(`[confirm] ${msg.id} -> ${msg.approved}`);
        break;
      }
    }
  }

  private async handleUserMessage(text: string): Promise<void> {
    this.output.appendLine(`[user] ${text}`);

    const apiKey = await this.context.secrets.get(SECRET_KEY);
    if (!apiKey) {
      this.post({ type: 'error', message: '未设置 API key。请运行命令「Embed Agent: Set API Key」。' });
      this.post({ type: 'assistantDone' });
      return;
    }

    const config = this.readConfig();
    const adapter = createAdapter(config, apiKey);
    this.history.push({ role: 'user', content: text });
    this.abort = new AbortController();

    try {
      for await (const ev of runAgent({
        adapter,
        registry: this.registry,
        model: config.model,
        history: this.history,
        confirm: (req) => this.askConfirm(req),
        signal: this.abort.signal,
      })) {
        switch (ev.type) {
          case 'text':
            this.post({ type: 'streamDelta', text: ev.text });
            break;
          case 'toolStart':
            this.output.appendLine(`[tool] ${ev.name} 开始`);
            this.post({ type: 'toolCallStart', id: ev.id, name: ev.name });
            break;
          case 'toolEnd':
            this.output.appendLine(`[tool] ${ev.name} ${ev.ok ? '成功' : '失败'}`);
            this.post({ type: 'toolCallResult', id: ev.id, name: ev.name, ok: ev.ok });
            break;
          case 'usage':
            this.totalUsage.input += ev.input;
            this.totalUsage.output += ev.output;
            this.post({ type: 'tokenUsage', input: this.totalUsage.input, output: this.totalUsage.output });
            break;
          case 'error':
            this.post({ type: 'error', message: ev.message });
            break;
          case 'done':
            break;
        }
      }
    } finally {
      this.post({ type: 'assistantDone' });
      this.abort = undefined;
      // 收尾:若还有没回应的确认(比如中途取消),一律按「拒绝」释放,避免 loop 永远卡住
      for (const resolve of this.pendingConfirms.values()) resolve(false);
      this.pendingConfirms.clear();
    }
  }

  // 确认原语的「后端实现」:发 requestConfirm,返回一个 Promise,等 confirmResponse 回来再 resolve。
  private askConfirm(req: ConfirmRequest): Promise<boolean> {
    return new Promise((resolve) => {
      this.pendingConfirms.set(req.id, resolve);
      this.post({ type: 'requestConfirm', id: req.id, toolName: req.toolName, summary: req.summary });
    });
  }

  private readConfig(): AgentConfig {
    const cfg = vscode.workspace.getConfiguration('embed-agent');
    return {
      provider: cfg.get<LlmProvider>('llmProvider', 'anthropic'),
      model: cfg.get<string>('model', 'claude-opus-4-7'),
      baseURL: cfg.get<string>('baseURL', '') || undefined,
    };
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.css'),
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} https: data:`,
    ].join('; ');

    return `<!doctype html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>Embed Agent</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
```

> 这一个文件把 M2 后端的概念全用上了:`runAgent`(循环)+ `createAdapter`(provider)+ `askConfirm`(确认原语,`pendingConfirms` 配对)+ `AbortController`(取消)+ `history`(多轮)+ `humanize` 过的错误。注意 `extension.ts` **完全不用改**——它 M1 就把 provider/视图/命令/SecretStorage 配齐了。

> 💡 **更省事的替代(可选)**:确认也可以不走 webview,直接用 `vscode.window.showWarningMessage('要执行 X 吗?', { modal: true }, '允许')` 弹**原生模态框**。本文按 `Phase1-plan.md` 的设计走 webview 卡片(顺带教「请求/响应配对」),但原生弹窗在面板被折叠时也能用,工程上同样合理。

### 步骤 11 · webview:显示工具调用 + 确认卡片

流式聊天主链路前端**一行不用改**(M1 的回报)。要新增的是:把「工具调用」显示成时间线里的一个条目、弹「确认卡片」、底部显示 token 用量。

#### 11.1 store:消息模型加入「工具条目」

M1 的 `messages` 只有 user/assistant。现在时间线里会穿插「工具在跑」的条目,所以把消息模型升级成**联合类型** `ChatItem`(要么是一条普通消息,要么是一条工具条目),并处理新消息。

**文件:`packages/webview/src/store.ts`**(整份替换)

```typescript
import { create } from 'zustand';
import type { ExtToWebview } from '@embed-agent/shared';
import { postToExt, getPersistedState, setPersistedState } from './vscodeApi';

// 时间线里的一项:要么是普通气泡(user/assistant),要么是一条工具调用记录。
export type ChatItem =
  | { id: string; role: 'user' | 'assistant'; text: string }
  | { id: string; role: 'tool'; name: string; status: 'running' | 'ok' | 'error' };

interface PersistedState {
  items: ChatItem[];
}

interface ConfirmState {
  id: string;
  toolName: string;
  summary: string;
}

interface ChatState {
  items: ChatItem[];
  streaming: boolean;
  error: string | null;
  tokenUsage: { input: number; output: number } | null;
  confirm: ConfirmState | null; // 当前是否有待确认的请求
  send: (text: string) => void;
  stop: () => void;
  respondConfirm: (approved: boolean) => void;
  receive: (msg: ExtToWebview) => void;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

const initial = getPersistedState<PersistedState>();

export const useChat = create<ChatState>((set, get) => ({
  items: initial?.items ?? [],
  streaming: false,
  error: null,
  tokenUsage: null,
  confirm: null,

  send: (text) => {
    const trimmed = text.trim();
    if (!trimmed || get().streaming) return;
    set((s) => ({
      items: [...s.items, { id: uid(), role: 'user', text: trimmed }],
      streaming: true,
      error: null,
    }));
    postToExt({ type: 'userMessage', text: trimmed });
  },

  stop: () => {
    postToExt({ type: 'cancelStream' });
    set({ streaming: false });
  },

  respondConfirm: (approved) => {
    const c = get().confirm;
    if (!c) return;
    postToExt({ type: 'confirmResponse', id: c.id, approved });
    set({ confirm: null });
  },

  receive: (msg) => {
    switch (msg.type) {
      case 'streamDelta':
        // 规则:把增量追加到「最后一条 assistant 气泡」;若最后一条不是 assistant
        //（比如刚插了个工具条目),就新开一个 assistant 气泡。这条规则自动处理了
        // 「文字 → 工具 → 又文字」的穿插显示。
        set((s) => {
          const items = s.items.slice();
          const last = items[items.length - 1];
          if (last && last.role === 'assistant') {
            items[items.length - 1] = { ...last, text: last.text + msg.text };
          } else {
            items.push({ id: uid(), role: 'assistant', text: msg.text });
          }
          return { items };
        });
        break;
      case 'toolCallStart':
        set((s) => ({
          items: [...s.items, { id: msg.id, role: 'tool', name: msg.name, status: 'running' }],
        }));
        break;
      case 'toolCallResult':
        set((s) => ({
          items: s.items.map((it) =>
            it.role === 'tool' && it.id === msg.id ? { ...it, status: msg.ok ? 'ok' : 'error' } : it,
          ),
        }));
        break;
      case 'requestConfirm':
        set({ confirm: { id: msg.id, toolName: msg.toolName, summary: msg.summary } });
        break;
      case 'assistantDone':
        set({ streaming: false });
        break;
      case 'error':
        set({ error: msg.message, streaming: false });
        break;
      case 'tokenUsage':
        set({ tokenUsage: { input: msg.input, output: msg.output } });
        break;
    }
  },
}));

// 持久化:折叠/展开侧边栏后能恢复(同 M1)
useChat.subscribe((state) => {
  setPersistedState({ items: state.items } satisfies PersistedState);
});
```

> 那条 `streamDelta` 的「追加到最后一条 assistant,否则新开一个」规则很关键:它让「模型说话 → 调工具 → 再说话」自然显示成「气泡 → 工具条 → 新气泡」,不需要额外状态机。

#### 11.2 组件改造

**文件:`packages/webview/src/components/MessageItem.tsx`**(整份替换:支持工具条目)

```tsx
import type { ChatItem } from '../store';
import { Markdown } from './Markdown';

export function MessageItem({ item }: { item: ChatItem }) {
  // 工具调用条目:一行小标签,带状态图标
  if (item.role === 'tool') {
    const icon = item.status === 'running' ? '⏳' : item.status === 'ok' ? '✅' : '⚠️';
    return (
      <div className="mb-2 text-xs opacity-80">
        <span className="rounded bg-codebg px-2 py-1">
          {icon} 工具 <code>{item.name}</code>
          {item.status === 'running' ? ' 执行中…' : ''}
        </span>
      </div>
    );
  }

  // 普通气泡(同 M1)
  const isUser = item.role === 'user';
  return (
    <div className="mb-3">
      <div className="mb-1 text-xs font-semibold opacity-70">{isUser ? '你' : 'Embed Agent'}</div>
      <div className={isUser ? 'rounded bg-input px-2 py-1 text-sm' : 'text-sm leading-relaxed'}>
        {isUser ? <span className="whitespace-pre-wrap">{item.text}</span> : <Markdown text={item.text} />}
      </div>
    </div>
  );
}
```

**文件:`packages/webview/src/components/MessageList.tsx`**(把 `messages` 改成 `items`)

```tsx
import { useEffect, useRef } from 'react';
import { useChat } from '../store';
import { MessageItem } from './MessageItem';

export function MessageList() {
  const items = useChat((s) => s.items);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items]);

  return (
    <div className="flex-1 overflow-y-auto px-3 py-2">
      {items.length === 0 && (
        <p className="mt-8 text-center text-sm opacity-60">发一条消息开始对话。</p>
      )}
      {items.map((it) => (
        <MessageItem key={it.id} item={it} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
```

**文件:`packages/webview/src/components/ConfirmCard.tsx`**(新建:允许 / 拒绝 卡片)

```tsx
import { useChat } from '../store';

export function ConfirmCard() {
  const confirm = useChat((s) => s.confirm);
  const respond = useChat((s) => s.respondConfirm);
  if (!confirm) return null;

  return (
    <div className="mx-3 mb-2 rounded border border-focus bg-input p-2 text-xs">
      <div className="mb-2">
        Agent 想调用工具 <code>{confirm.toolName}</code>:
        <div className="mt-1 whitespace-pre-wrap opacity-80">{confirm.summary}</div>
      </div>
      <div className="flex justify-end gap-2">
        <button className="rounded bg-btn2 px-3 py-1 text-btn2-fg" onClick={() => respond(false)}>
          拒绝
        </button>
        <button className="rounded bg-btn px-3 py-1 text-btn-fg" onClick={() => respond(true)}>
          允许
        </button>
      </div>
    </div>
  );
}
```

**文件:`packages/webview/src/App.tsx`**(整份替换:挂上确认卡片 + token 页脚)

```tsx
import { useEffect } from 'react';
import { formatTokenUsage } from '@embed-agent/shared';
import { useChat } from './store';
import { onExtMessage } from './vscodeApi';
import { MessageList } from './components/MessageList';
import { InputBar } from './components/InputBar';
import { ConfirmCard } from './components/ConfirmCard';

export function App() {
  const receive = useChat((s) => s.receive);
  const error = useChat((s) => s.error);
  const usage = useChat((s) => s.tokenUsage);

  useEffect(() => onExtMessage(receive), [receive]);

  return (
    <div className="flex h-screen flex-col text-fg">
      <header className="border-b border-panel px-3 py-2 text-sm font-medium">Embed Agent</header>
      <MessageList />
      {error && (
        <div className="mx-3 mb-2 rounded border border-err-border bg-err px-2 py-1 text-xs">
          {error}
        </div>
      )}
      <ConfirmCard />
      {usage && (
        <div className="px-3 pb-1 text-right text-xs opacity-60">
          token:{formatTokenUsage(usage.input, usage.output)}
        </div>
      )}
      <InputBar />
    </div>
  );
}
```

> `InputBar.tsx` **不用改**——它只用到 `streaming` / `send` / `stop`,这些都还在。注意这里终于用上了 M0 写的 `formatTokenUsage`:当初为「有东西可测」造的小函数,现在派上真实用场。

**运行 → 你应该看到**(先过类型 + 构建):

```powershell
pnpm typecheck   # 0 errors（两端都改到位了）
pnpm build       # 三件套照常产出；extension.js 里已打进 SDK
```

### 步骤 12 · 跑起来 + 自检

先设好 key(只需一次):

1. **F5** 启动扩展开发宿主。
2. `Ctrl+Shift+P` → `Embed Agent: Set API Key` → 粘贴你的真 key。
3. 若用 OpenAI/DeepSeek:打开「设置」搜 `embed-agent`,把 `llmProvider` 改成对应值,并把 `model` 改成该家的模型名(如 DeepSeek 填 `deepseek-chat`、baseURL 留空会自动用官方地址)。

> 💡 上面第 2、3 步也可以**全部在步骤 13 的可视化设置面板里点点点完成**(点聊天右上角 ⚙),不必碰命令面板和设置文件——若你已做完步骤 13,直接用面板更省事。

然后逐项验:

1. **普通对话(★ tracer bullet)**:输入「用三句话介绍一下你自己」→ 助手气泡**逐字**冒出**真模型**的回答;底部出现 token 用量。
2. **工具循环**:输入「现在几点?」→ 面板出现「⏳ 工具 `get_current_time` 执行中…」→ 变「✅」→ 模型用**真实当前时间**继续作答。
3. **确认原语**:输入「用 run_demo_command 执行 `ls -la`」→ 弹出「允许 / 拒绝」卡片。
   - 点**拒绝** → 工具不执行,模型会说「操作被拒绝」之类。
   - 再试一次点**允许** → 出现工具条 → 模型转述那条假结果。
4. **取消**:发一个长问题,流式途中点「停止」→ 立刻中断。
5. **错误可读**:清掉 key(`Embed Agent: Clear API Key`)再发消息 → 面板显示「未设置 API key…」这句人话,而不是红色堆栈。把 `model` 故意改成 `not-a-real-model` → 显示 404 那句人话。
6. **Output 可观测**:「输出」面板选 `Embed Agent` 频道,能看到 `[user]` / `[tool] xxx 开始/成功` / `[confirm]` 日志。
7. **主题自适配**(沿用 M1):切明/暗主题,面板与代码高亮跟着变。

🎉 全过 → M2 完成,Phase 1 的 ★ tracer bullet 达成。

---

### 步骤 13 · 可视化设置面板(追加:在面板里配置 provider / model / key)

> ⚙ 这一步是 M2 核心跑通**之后**追加的体验改进:与其让用户去命令面板 + VS Code 设置里来回切,不如在聊天面板右上角放个 ⚙,点开就能可视化地选 provider、填 model/baseURL、设 API key。它**复用** M1/M2 已有的 type-safe RPC,只是多加几条消息;**`agent-core` 完全不参与**——这纯属「配置读写」,只在 `shared`(协议)+ `extension`(读写 VS Code 设置 / SecretStorage)+ `webview`(表单)之间打通。

两条原则:

- **key 只写不读**:面板永远不显示已存的 key,后端只回传「是否已设置」(`hasApiKey`)。换 key 就输新的,留空 = 不改。这是处理敏感信息的基本素养——别让密钥有任何回流到界面的机会。
- **复用既有存储**:provider/model/baseURL 写进 VS Code 设置(等价于在「设置」里改);key 进 SecretStorage(和命令 `Set API Key` 同一处)。命令入口仍保留,二者等价。

#### 13.1 shared:加几条配置消息

**文件:`packages/shared/src/index.ts`**——`WebviewToExt` 末尾追加 4 条,`ExtToWebview` 末尾追加 1 条:

```typescript
// WebviewToExt(界面 → 后台)末尾新增:
  // 打开设置面板时,向后台索取当前配置(provider/model/baseURL + 是否已设置 key)。
  | { type: 'getConfig' }
  // 保存「非敏感」配置(写进 VS Code 设置)。
  | { type: 'saveConfig'; provider: LlmProvider; model: string; baseURL: string }
  // 设置 API key(存进 SecretStorage;key 永不回传前端)。
  | { type: 'setApiKey'; key: string }
  // 清除 API key。
  | { type: 'clearApiKey' };

// ExtToWebview(后台 → 界面)末尾新增:
  // 当前配置回传前端(hasApiKey 只表示「是否已设置」,绝不回传 key 本身)。
  | { type: 'configState'; provider: LlmProvider; model: string; baseURL: string; hasApiKey: boolean };
```

> 提醒:追加联合成员时,记得把原来「最后一条」结尾的 `;` 去掉(每个成员以 `|` 开头,只有真正的最后一条以 `;` 收尾)。

#### 13.2 extension:读写配置

**文件:`packages/extension/src/ChatViewProvider.ts`**——`onMessage` 的 switch 里(`confirmResponse` 之后)加 4 个 case:

```typescript
      // ↓↓↓ 可视化设置面板用的几条消息 ↓↓↓
      case 'getConfig':
        void this.sendConfigState();
        break;
      case 'saveConfig':
        void this.saveConfig(msg.provider, msg.model, msg.baseURL);
        break;
      case 'setApiKey':
        void this.storeApiKey(msg.key);
        break;
      case 'clearApiKey':
        void this.clearApiKey();
        break;
```

再加 4 个方法(放在 `readConfig` 旁边即可):

```typescript
  // 把当前配置回传前端。⚠️ 只回传「是否已设置 key」(hasApiKey),绝不回传 key 本身。
  private async sendConfigState(): Promise<void> {
    const cfg = this.readConfig();
    const hasApiKey = !!(await this.context.secrets.get(SECRET_KEY));
    this.post({
      type: 'configState',
      provider: cfg.provider,
      model: cfg.model,
      baseURL: cfg.baseURL ?? '',
      hasApiKey,
    });
  }

  // 保存「非敏感」配置到 VS Code 用户设置(等价于在「设置」里改 provider/model/baseURL)。
  private async saveConfig(provider: LlmProvider, model: string, baseURL: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('embed-agent');
    await cfg.update('llmProvider', provider, vscode.ConfigurationTarget.Global);
    await cfg.update('model', model, vscode.ConfigurationTarget.Global);
    await cfg.update('baseURL', baseURL, vscode.ConfigurationTarget.Global);
    this.output.appendLine(
      `[config] 已保存:provider=${provider} model=${model} baseURL=${baseURL || '(默认)'}`,
    );
    await this.sendConfigState(); // 回传最新状态给面板
  }

  // 存 API key 到 SecretStorage(加密;不写设置文件)。空输入视为「不改」。
  private async storeApiKey(key: string): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) return;
    await this.context.secrets.store(SECRET_KEY, trimmed);
    this.output.appendLine('[config] API key 已保存到 SecretStorage');
    void vscode.window.showInformationMessage('Embed Agent:API key 已保存。');
    await this.sendConfigState();
  }

  // 清除已保存的 API key。
  private async clearApiKey(): Promise<void> {
    await this.context.secrets.delete(SECRET_KEY);
    this.output.appendLine('[config] API key 已清除');
    await this.sendConfigState();
  }
```

> `getConfiguration('embed-agent').update(键, 值, ConfigurationTarget.Global)` 就是「往用户设置里写一项」,效果和你手动在「设置」界面改一样(会落进 settings.json)。`context.secrets` 是 SecretStorage,`store/get/delete` 都是异步,所以这些方法都 `async`。

#### 13.3 webview:设置面板的状态(独立 store)

单独开一个 store,跟聊天 store 互不干扰——它只关心「配置」。

**文件:`packages/webview/src/settings.ts`**(新建)

```typescript
import { create } from 'zustand';
import type { ExtToWebview, LlmProvider } from '@embed-agent/shared';
import { postToExt } from './vscodeApi';

interface SettingsState {
  open: boolean; // 设置面板是否展开
  provider: LlmProvider;
  model: string;
  baseURL: string;
  hasApiKey: boolean; // 后台是否已存了 key(只知道有没有,拿不到 key 本身)
  openPanel: () => void;
  closePanel: () => void;
  setProvider: (p: LlmProvider) => void;
  setModel: (m: string) => void;
  setBaseURL: (u: string) => void;
  save: () => void; // 保存 provider/model/baseURL
  setApiKey: (key: string) => void; // 存 key
  clearApiKey: () => void; // 清除 key
  receive: (msg: ExtToWebview) => void; // 接收 configState
}

export const useSettings = create<SettingsState>((set, get) => ({
  open: false,
  provider: 'anthropic',
  model: '',
  baseURL: '',
  hasApiKey: false,

  openPanel: () => {
    postToExt({ type: 'getConfig' }); // 打开时拉一次最新配置
    set({ open: true });
  },
  closePanel: () => set({ open: false }),

  setProvider: (provider) => set({ provider }),
  setModel: (model) => set({ model }),
  setBaseURL: (baseURL) => set({ baseURL }),

  save: () => {
    const { provider, model, baseURL } = get();
    postToExt({ type: 'saveConfig', provider, model, baseURL });
  },
  setApiKey: (key) => postToExt({ type: 'setApiKey', key }),
  clearApiKey: () => postToExt({ type: 'clearApiKey' }),

  receive: (msg) => {
    // 只认 configState,其余消息(streamDelta 等)忽略
    if (msg.type === 'configState') {
      set({
        provider: msg.provider,
        model: msg.model,
        baseURL: msg.baseURL,
        hasApiKey: msg.hasApiKey,
      });
    }
  },
}));
```

#### 13.4 webview:设置面板组件

**文件:`packages/webview/src/components/SettingsPanel.tsx`**(新建)

```tsx
import { useState } from 'react';
import type { LlmProvider } from '@embed-agent/shared';
import { useSettings } from '../settings';

// 各 provider 的推荐模型(给 model 输入框当占位提示 + 「用推荐值」按钮)
const MODEL_HINT: Record<LlmProvider, string> = {
  anthropic: 'claude-opus-4-7',
  openai: 'gpt-4o',
  deepseek: 'deepseek-chat',
};

export function SettingsPanel() {
  const s = useSettings();
  // key 单独用本地状态:它不进全局 store(也就不会被持久化/回显)
  const [keyInput, setKeyInput] = useState('');

  if (!s.open) return null;

  // 点「保存」:先存 provider/model/baseURL;若填了新 key 再存 key。
  const onSave = () => {
    s.save();
    if (keyInput.trim()) {
      s.setApiKey(keyInput.trim());
      setKeyInput('');
    }
  };

  return (
    // absolute inset-0:盖住整个 webview(根容器有 relative);z-10 浮在聊天之上
    <div className="absolute inset-0 z-10 flex flex-col overflow-y-auto bg-editor p-4 text-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold">设置</h2>
        <button className="rounded bg-btn2 px-2 py-1 text-xs text-btn2-fg" onClick={s.closePanel}>
          关闭
        </button>
      </div>

      {/* provider 下拉 */}
      <label className="mb-1 font-medium">大模型提供商</label>
      <select
        className="mb-3 rounded border border-input-border bg-input p-2 text-input-fg outline-none focus:border-focus"
        value={s.provider}
        onChange={(e) => s.setProvider(e.target.value as LlmProvider)}
      >
        <option value="anthropic">Anthropic(Claude)</option>
        <option value="openai">OpenAI</option>
        <option value="deepseek">DeepSeek(便宜 · 国内可直连)</option>
      </select>

      {/* model 输入 + 一键填推荐值 */}
      <label className="mb-1 font-medium">模型名</label>
      <input
        className="mb-1 rounded border border-input-border bg-input p-2 text-input-fg outline-none focus:border-focus"
        value={s.model}
        placeholder={MODEL_HINT[s.provider]}
        onChange={(e) => s.setModel(e.target.value)}
      />
      <button
        className="mb-3 self-start text-xs text-link underline"
        onClick={() => s.setModel(MODEL_HINT[s.provider])}
      >
        用推荐值:{MODEL_HINT[s.provider]}
      </button>

      {/* baseURL */}
      <label className="mb-1 font-medium">自定义 API 地址(baseURL,可留空)</label>
      <input
        className="mb-3 rounded border border-input-border bg-input p-2 text-input-fg outline-none focus:border-focus"
        value={s.baseURL}
        placeholder="留空用官方默认;DeepSeek 留空即自动指向官方"
        onChange={(e) => s.setBaseURL(e.target.value)}
      />

      {/* api key(密码框,不回显已存的 key) */}
      <label className="mb-1 font-medium">
        API Key{' '}
        {s.hasApiKey ? (
          <span className="text-xs opacity-70">(已设置 ✅;留空则不修改)</span>
        ) : (
          <span className="text-xs opacity-70">(未设置 ⚠️)</span>
        )}
      </label>
      <input
        type="password"
        className="mb-1 rounded border border-input-border bg-input p-2 text-input-fg outline-none focus:border-focus"
        value={keyInput}
        placeholder={s.hasApiKey ? '已存;如需更换在此输入新 key' : 'sk-… 粘贴你的 key'}
        onChange={(e) => setKeyInput(e.target.value)}
      />
      {s.hasApiKey && (
        <button
          className="mb-3 self-start text-xs text-link underline"
          onClick={() => {
            s.clearApiKey();
            setKeyInput('');
          }}
        >
          清除已保存的 key
        </button>
      )}

      <div className="mt-2 flex justify-end gap-2">
        <button className="rounded bg-btn px-4 py-1.5 text-btn-fg" onClick={onSave}>
          保存
        </button>
      </div>

      <p className="mt-4 text-xs opacity-60">
        provider / model / baseURL 写入 VS Code 设置;API key 加密存入 SecretStorage(不写入设置文件、不回传界面)。
      </p>
    </div>
  );
}
```

> 这里的 `bg-editor`/`bg-input`/`text-link` 等类名都来自 M1 在 `styles.css` 里把 Tailwind 颜色映射到 VS Code 主题变量,所以面板**自动明暗自适配**,不用额外写样式。

#### 13.5 webview:把 ⚙ 接进 App

**文件:`packages/webview/src/App.tsx`**(在步骤 11 的基础上:头部加 ⚙、根容器加 `relative`、后台消息**分发给两个 store**)

```tsx
import { useEffect } from 'react';
import { formatTokenUsage } from '@embed-agent/shared';
import { useChat } from './store';
import { useSettings } from './settings';
import { onExtMessage, postToExt } from './vscodeApi';
import { MessageList } from './components/MessageList';
import { InputBar } from './components/InputBar';
import { ConfirmCard } from './components/ConfirmCard';
import { SettingsPanel } from './components/SettingsPanel';

export function App() {
  const chatReceive = useChat((s) => s.receive);
  const settingsReceive = useSettings((s) => s.receive);
  const openSettings = useSettings((s) => s.openPanel);
  const error = useChat((s) => s.error);
  const usage = useChat((s) => s.tokenUsage);

  // 订阅后台消息,分发给两个 store(聊天 store 处理流式/工具,设置 store 处理 configState)
  useEffect(() => {
    return onExtMessage((msg) => {
      chatReceive(msg);
      settingsReceive(msg);
    });
  }, [chatReceive, settingsReceive]);

  // 启动时拉一次配置(让设置面板有初值、并能提示是否已设 key)
  useEffect(() => {
    postToExt({ type: 'getConfig' });
  }, []);

  return (
    // relative:让 SettingsPanel 的 absolute inset-0 能盖住整个面板
    <div className="relative flex h-screen flex-col text-fg">
      <header className="flex items-center justify-between border-b border-panel px-3 py-2">
        <span className="text-sm font-medium">Embed Agent</span>
        <button
          className="rounded px-2 py-0.5 text-base hover:bg-input"
          title="设置"
          onClick={openSettings}
        >
          ⚙
        </button>
      </header>
      <MessageList />
      {error && (
        <div className="mx-3 mb-2 rounded border border-err-border bg-err px-2 py-1 text-xs">
          {error}
        </div>
      )}
      <ConfirmCard />
      {usage && (
        <div className="px-3 pb-1 text-right text-xs opacity-60">
          token:{formatTokenUsage(usage.input, usage.output)}
        </div>
      )}
      <InputBar />
      <SettingsPanel />
    </div>
  );
}
```

> 一条消息要被两个 store 都看到,做法就是在订阅回调里**依次调用两个 `receive`**;各自的 `receive` 只挑自己关心的消息处理、其余忽略。这比把所有状态塞进一个大 store 更清晰。

**运行 → 你应该看到**:

```powershell
pnpm typecheck   # 0 errors
pnpm build       # 三件套照常产出
```

F5 → 点聊天右上角 **⚙** → 选 `DeepSeek`、点「用推荐值」、把 key 粘进密码框 → **保存** → 点「关闭」回到聊天。设置已落盘(写进了 VS Code 设置 + SecretStorage),下次 F5 仍在;密码框永远不会回显你已存的 key。

---

## 6. M2 验收清单

对照 `Phase1-plan.md` 的 M2 任务,逐条打勾:

- [ ] `pnpm install` 装上 `@anthropic-ai/sdk` / `openai`,无报错
- [ ] `pnpm typecheck` → 0 errors
- [ ] `pnpm test` → M0 用例 + agent 循环单测全绿(单测**不联网**)
- [ ] `pnpm lint` → 无 error
- [ ] `pnpm build` → 三件套产出,`extension.js` 含 SDK
- [ ] **LLM thin adapter**:`chat() → AsyncIterable`,流式;Anthropic + OpenAI 两份,工厂按 provider 选
- [ ] **多 provider**:Anthropic 跑通;切 DeepSeek(OpenAI 兼容 + baseURL)也能流式对话
- [ ] **工具注册 + 分发循环**:`tool_use → 执行 → 回填 tool_result → 续答` 多步可用(演示工具验证)
- [ ] **确认原语**:`requiresConfirm` 工具执行前弹卡片;拒绝则不执行(走 `requestConfirm`/`confirmResponse`)
- [ ] **会话状态**:多轮记得上文;单工具输出过长会截断
- [ ] **通用 system prompt**:不含任何领域(嵌入式)注入
- [ ] **token 用量**回传并显示;**错误**人类可读(401/404/429);**取消**能中断当前流
- [ ] F5 端到端:普通对话 + 「现在几点」工具循环 + 确认卡片 全部走通
- [ ] **可视化设置面板(步骤 13)**:点 ⚙ 能选 provider / 填 model·baseURL / 设 key;保存即生效;密码框不回显已存 key;切 DeepSeek 后能正常对话
- [ ] CI 三平台仍绿(推上 GitHub 后)
- [ ] 提交:`git add . && git commit -m "feat: M2 Agent 对话核心(LLM + 流式 + 工具框架)+ 可视化设置面板"`

> ⚠️ CI 提醒:`@anthropic-ai/sdk` / `openai` 装进了 `agent-core`,`@embed-agent/agent-core` 装进了 `extension`——确认更新后的 `pnpm-lock.yaml` 一起提交,否则 CI 的 `--frozen-lockfile` 会失败。CI **不跑真 API**(没 key),靠 `pnpm test` 的离线单测保证 agent 逻辑;真对话只在本地 F5 验。

---

## 附录 A · async generator / for await / AbortSignal 速查

### 异步生成器(本项目流式的基石)

```ts
// 定义:async + function*。yield 产出值,可 await 异步。
async function* gen() {
  yield 'a'; // 产出一个值,消费方立刻拿到
  await sleep(10);
  yield 'b';
}

// 消费:for await … of,一个一个接
for await (const x of gen()) console.log(x); // a … b
```

- `yield` ≈ 「往管子塞一个值,对方马上取走」;函数在此**暂停**,下次迭代再继续。
- `for await (const x of 异步可迭代)` ≈ 站在管子另一头逐个接,自动等异步。
- 一个异步生成器**返回值的类型**就是 `AsyncIterable<产出值类型>`——这正是 `LlmAdapter.chat` 的返回类型。
- 链式转发:loop 用 `for await` 接 adapter 吐的值,自己再 `yield` 给上层——流式从头贯到尾。

### Promise 化一个回调(确认原语用到)

```ts
// 把「未来某时刻别处会调用的回调」变成一个可 await 的 Promise:
function ask(): Promise<boolean> {
  return new Promise((resolve) => {
    pending.set(id, resolve); // 先把 resolve 存起来
    sendRequest(id); // 发出请求;此刻 Promise 还没 resolve,await 处会一直等
  });
}
// 别处收到响应时:pending.get(id)(true) —— 这一调,上面的 await 才返回
```

### AbortController / AbortSignal(取消)

```ts
const ctrl = new AbortController();
fetch(url, { signal: ctrl.signal }); // 把信号交给异步操作
ctrl.abort(); // 在别处喊停 → 上面操作抛 AbortError
ctrl.signal.aborted; // boolean:是否已被取消(循环里可主动检查)
```

---

## 附录 B · 常见报错与排查(M2 专属)

| 现象 | 多半原因 | 处理 |
| --- | --- | --- |
| 面板报「未设置 API key」 | 没设 / 清过 key | `Ctrl+Shift+P` → `Embed Agent: Set API Key` |
| 报 401 | key 错 / 过期 / 不属于该 provider | 重设 key;确认 key 与 `llmProvider` 是同一家 |
| 报 404(模型/接口不存在) | **provider 与 model 不匹配**(最常见) | provider=anthropic 用 `claude-...`;deepseek 用 `deepseek-...`;别混 |
| 报 429 | 触发限流 | SDK 已自动重试;仍失败就等会儿,或换账号/额度 |
| DeepSeek 连不上 / 走了官方 OpenAI | baseURL 没设对 | provider 选 `deepseek` 会自动指向 `api.deepseek.com`;别又手填一个 OpenAI 的 baseURL 覆盖掉 |
| 工具循环卡住、模型不调用工具 | 工具 `description` 太含糊 | 把 description 写清楚「干嘛、何时用」;确认 `inputSchema` 合法 |
| 工具参数解析报 `JSON.parse` 错 | 模型偶尔吐了非法 JSON 片段 | 多为偶发;可在 adapter 的 parse 处加 try/catch 兜底(M2 先不强求) |
| 续答时 Anthropic 报「tool_use 没配 tool_result」 | 历史里漏了工具结果 | 确认 loop 第③步「每个 call 都 push 一条 tool 结果」没被改坏 |
| 确认卡片不出现 | 折叠了侧边栏 / 工具没标 `requiresConfirm` | 展开面板;确认工具 `requiresConfirm:true`;或改用原生弹窗(步骤 10 注) |
| 点「停止」没反应 | `signal` 没传到 SDK | 确认 `runAgent` 收到 `this.abort.signal` 且 adapter 把它传进 `create(..., { signal })` |
| 多轮对话「失忆」 | history 被清/没复用 | 确认 `this.history` 是**实例字段**、跨消息复用,且 loop 是 push 进同一个数组 |
| `pnpm build` 报 SDK 相关打包错 | esbuild 偶遇某依赖的动态 require | 一般可忽略警告;真报错可把该子依赖加进 `esbuild.mjs` 的 `external`,或升级 SDK |
| token 用量不显示(DeepSeek) | 该端点没回 usage | 非致命;部分兼容端点不返回 usage,显示会缺失,属正常 |

> 调后端用 Output 频道 + 调试控制台;调前端在面板里右键 **Open Webview Developer Tools**(同 M1)。

---

## 附录 C · 名词表(M2 新增)

- **agent loop(工具循环)**:模型请求工具 → 框架执行 → 结果回填 → 模型续答,反复直到无工具调用的主循环。
- **adapter(适配器)**:隔离不同 LLM 厂商 SDK 差异的薄封装,对上提供统一接口。
- **async generator(异步生成器)**:`async function*`,用 `yield` 陆续产出值;本项目流式的载体。
- **AsyncIterable**:能被 `for await...of` 消费的对象;异步生成器的返回类型。
- **tool call / tool_use / tool_result**:模型「请求调用工具」/ 工具调用块 / 工具结果回填,三家叫法略不同。
- **JSON Schema**:用 JSON 描述数据形状的标准;本项目用来声明工具参数。
- **ToolRegistry(注册表)**:登记所有 `ToolSpec` 的 `Map`,可插拔。
- **确认原语(confirm primitive)**:受控操作执行前征求用户同意的机制(`requestConfirm`/`confirmResponse`)。
- **依赖注入**:把「确认弹窗、API key」等外部能力作为参数传进 agent-core,使其保持纯净可测。
- **AbortController / AbortSignal**:标准的「取消异步操作」机制。
- **system prompt**:给模型设定身份与工作方式的开场指令(本阶段为通用助手,无领域注入)。
- **provider**:LLM 提供商(anthropic / openai / deepseek);DeepSeek 兼容 OpenAI 协议。

---

## 下一步:M3 预告

M2 把「框架 + 假工具」搭好后,进 **M3 · 通用工具(领域无关)**——往注册表里加几个**真**工具,证明工具回路在真实工程里端到端可用:

- `read_file(path, range?)`:限定在 workspace 内;大文件按行截断;返回带 `Source`(对应输出契约)。
- `list_dir(path)`:忽略 `node_modules/`、`.git/`、`dist/`。
- `search_in_workspace(pattern)`:ripgrep 驱动,结果带「文件:行号」。
- 全部**只读**,走统一 `ToolResult`;直接 `registry.register(...)` 接进 M2 的循环,**循环代码一行不用动**(这就是 M2 把工具做成可插拔的回报)。
- (可选)受**确认**的 `run_command`:用 M2 的确认原语端到端验一次真正的受控操作。

> 这些工具会跑在 extension 里(要碰文件系统),所以它们的 `ToolSpec` 定义在 `extension`,`register` 进同一个 `ChatViewProvider.registry`。届时同样可以给出 M3 的手把手文档。

---

_文档版本:v0.1 · 随 M2 实施修订。_
