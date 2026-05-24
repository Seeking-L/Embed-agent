# Phase 1 — 可对话 Agent 底座 · 开发计划(通用版)

> **定位(2026-05 重订)**:本项目重新定位为通用嵌入式开发助手(复现 CubeMX),但**嵌入式方向待同事确认可行性前先冻结**。Phase 1 只做**领域无关的「可对话 agent」底座**——聊天 + 与 LLM 多轮对话 + 可插拔工具框架。这套底盘日后无论接什么领域能力都复用。
>
> 配套:`Phase1\M0-工程脚手架-详细文档.md`(M0 手把手)、根 `CLAUDE.md`(约束)。包名/命令统一 `embed-agent`。
>
> ⚠️ 旧版 `Phase1-开发计划.md`(Zephyr-中心、含 lookup_binding/run_west 等)**已被本文取代**,可删除。

---

## 〇、范围

**做**:一个 VS Code 插件 —— 聊天面板 + 与 LLM 多轮**流式**对话 + 可插拔**工具框架** + 几个**通用工具**(读工作区文件)+ 多 provider(Anthropic / OpenAI / DeepSeek,用户自带 key)。

**不做(冻结,等嵌入式方向确认)**:芯片/板子配置、代码生成、Zephyr 数据索引(RAG)、`lookup_binding`/`lookup_kconfig`、`run_west`、`ProjectMeta` 等一切嵌入式专属能力。它们将来作为"工具"接进 M2 的框架即可,**不影响底座设计**(见 §六)。

### 出口标准(DoD)

| 类别              | 指标                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| 可用性            | 团队成员在各自机器(Win/macOS/Linux)都能跑起来                          |
| **Tracer bullet** | 聊天面板里能和 LLM 多轮**流式**对话                                    |
| 多 provider       | 可切 Anthropic / OpenAI / DeepSeek;key 走 SecretStorage;`baseURL` 可填 |
| 工具回路          | agent 能调用通用工具(读文件)并用结果作答;调用过程在 UI 可见            |
| 受控操作          | 危险操作走确认(confirm 原语)——即便本阶段工具少,机制先就位              |
| 体验              | 流式 + 可取消 + 错误可读 + token 用量显示                              |
| 评测              | 通用对话评测集(≥ 15 任务)通过率 ≥ 85%                                  |
| 性能              | 插件激活 < 1s                                                          |

---

## 一、里程碑与依赖

```
M0 脚手架 ──► M1 插件骨架+Chat面板 ──► M2 对话核心(LLM+流式+工具框架) ──► M3 通用工具 ──► M4 评测+验收
                          └──────────── ★ Tracer bullet:能和 LLM 流式对话(M1+M2)────────────┘
```

| ID     | 里程碑               | 关键产物                                                                       | 依赖  | 主要包                   |
| ------ | -------------------- | ------------------------------------------------------------------------------ | ----- | ------------------------ |
| **M0** | 工程脚手架           | monorepo、构建、lint、CI、共享类型                                             | —     | 全部                     |
| **M1** | 插件骨架 + Chat 面板 | 激活、命令、Webview(React)、type-safe RPC、配置、SecretStorage、Output channel | M0    | `extension` `webview`    |
| **M2** | Agent 对话核心       | LLM adapter(多 provider)、流式、工具注册+分发、会话状态、**确认原语**          | M0    | `agent-core`             |
| ★      | **Tracer bullet**    | 在面板里和 LLM 流式多轮对话(还没工具)                                          | M1,M2 | —                        |
| **M3** | 通用工具             | `read_file`/`list_dir`/`search_in_workspace`(只读);可选受控 `run_command`      | M2    | `agent-core` `extension` |
| **M4** | 评测 + 验收          | 通用对话评测集 + harness                                                       | M1–M3 | `tools/eval`             |

> M0 已完成(文档:`Phase1\M0-工程脚手架-详细文档.md`)。**优先打通 M1+M2 的 tracer bullet**:能和 LLM 流式对话,架构主链路即验证。工具(M3)在框架之上增量加。

---

## 二、逐里程碑详细任务

### M1 · 插件骨架 + Chat 面板

**目标**:插件激活,聊天面板能弹出,前后端 type-safe 收发,能显示消息。

- [ ] `extension/package.json` 贡献点:命令 `embed-agent.openChat`、激活事件、配置项
- [ ] 配置项:`llmProvider`、`model`、`baseURL`;**API key 走 `SecretStorage`**,不进普通设置
- [ ] Webview Panel + React 18 挂载;消息列表 + 输入框 + 发送 + **停止**按钮
- [ ] `acquireVsCodeApi()` 封装的 type-safe RPC,前后端共用 `shared` 的 `WebviewToExt`/`ExtToWebview`
- [ ] Output channel `Embed Agent`:打印激活、配置、(后续)tool call
- [ ] react-markdown + shiki:渲染助手输出与代码块高亮
- [ ] 激活时间预算埋点(< 1s)

**交付**:F5 启动 → 开面板 → 发消息 → 后端回 echo → 前端渲染。

### M2 · Agent 对话核心

**目标**:能流式对话、能发起并消费 tool call 的核心循环;含确认原语。

- [ ] LLM thin adapter:`chat(messages, tools, opts) → AsyncIterable<Delta>`;**streaming 必须**。先实现 Anthropic;再加 OpenAI 分支(同一分支即覆盖 **DeepSeek**,靠 `baseURL` + OpenAI 兼容)
- [ ] Tool registry:工具 = `{ name, description, inputSchema(JSON Schema), handler }`;adapter 负责转各 provider 的工具格式
- [ ] Dispatch loop:收到 `tool_use` → 校验入参 → 跑 handler → 回填 `tool_result` → 继续,直到文本终态
- [ ] 会话状态:消息历史;超 N 轮做摘要压缩;单 tool 输出过长截断
- [ ] System prompt 模板(本阶段**通用助手**,不注入任何领域信息)
- [ ] **确认原语**:工具可标 `requiresConfirm`,执行前向 Webview 发 `requestConfirm`,用户允许才跑(为将来受控操作打底)
- [ ] token 用量回传 Webview;provider 错误(429/超时)人类可读 + 重试
- [ ] 取消:`cancelStream` 能中断当前流

**交付**:给一个假工具,能完成「调用→拿结果→续答」多步循环;`requiresConfirm` 工具会弹确认;★ **tracer bullet 达成**。

### M3 · 通用工具(领域无关)

**目标**:加几个通用、安全的工具,证明工具回路端到端可用。

- [ ] `read_file(path, range?)`:限定 workspace;大文件按行截断
- [ ] `list_dir(path)`:忽略 `node_modules/`、`.git/`、`dist/`
- [ ] `search_in_workspace(pattern)`:ripgrep 驱动;结果带文件:行号
- [ ] 全部**只读**,走统一 `ToolResult` 契约;接入 M2 registry
- [ ] (可选)`run_command(cmd)` 受**确认**:用来端到端验证确认原语(白名单 + 不允许 shell pipe/`&&`/重定向)

**交付**:在真实工程里问「帮我看看 `xxx` 文件里写了什么 / 这个目录有哪些文件」,agent 调工具并据此作答。

### M4 · 评测 + 验收

- [ ] 15–20 个**通用对话**任务(prompt + 期望产出要点):分「纯问答」「需调工具(读文件)」「多轮上下文」三类
- [ ] harness:跑全集,统计 任务成功率 / 工具调用次数 / token 消耗
- [ ] 接 CI(或半自动):prompt/模型变更后跑评测
- [ ] 验收:逐条勾掉 §〇 DoD

---

## 三、工具框架规格(通用)

工具返回统一结构(已在 `shared/src/index.ts` 定义):

```typescript
interface ToolResult<T = unknown> {
  result: T;
  sources?: Source[];
}
interface Source {
  file: string;
  lines?: string;
  section?: string;
}
```

| 工具                  | 签名                                       | 确认   | 里程碑 |
| --------------------- | ------------------------------------------ | ------ | ------ |
| `read_file`           | `(path, range?) → ToolResult<string>`      | 否     | M3     |
| `list_dir`            | `(path) → ToolResult<DirEntry[]>`          | 否     | M3     |
| `search_in_workspace` | `(pattern) → ToolResult<Match[]>`          | 否     | M3     |
| `run_command` (可选)  | `(cmd) → ToolResult<{stdout,stderr,code}>` | **是** | M3     |

> 设计要点:工具是**可插拔**的——领域能力(查芯片、生成代码)将来就是往这张表里加几行 + 实现 handler,核心循环不变。

---

## 四、风险与缓解(Phase 1)

| 风险                                           | 缓解                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| Webview ↔ Extension 通信 / RPC 类型走样        | `shared` 统一类型;M1 先做 echo tracer                                     |
| 多 provider 适配(尤其 DeepSeek 工具调用稳定性) | thin adapter 隔离;先 Anthropic 跑通;DeepSeek 用 M4 评测验证工具调用成功率 |
| 流式 + 取消的边界情况                          | 早做 tracer bullet,把流式/取消打磨好再加工具                              |
| 激活慢                                         | 重活放后台;预算埋点                                                       |
| 范围蔓延回嵌入式                               | 本阶段**不注册任何领域工具**;system prompt 不含领域注入                   |

---

## 五、四周建议排期

| 周  | 重点                                               |
| --- | -------------------------------------------------- |
| W1  | M0 收尾 → M1(插件骨架 + 面板 + RPC echo)           |
| W2  | M2(LLM adapter + 流式 + 工具循环)→ ★ tracer bullet |
| W3  | M3(通用工具)接入对话;多 provider(含 DeepSeek)跑通  |
| W4  | M4 评测 + 加固(跨平台 / 取消 / 错误)→ 验收         |

---

## 六、已冻结清单(嵌入式方向确认后再启用)

下列原 Zephyr-中心能力**暂不做**,记录在此备查;届时作为"工具"接进 M2 框架即可,**底座无需改动**:

- `ProjectMeta` / `get_project_meta`(工程识别)
- `lookup_binding` / `lookup_kconfig` / `list_boards`(知识查询)
- `search_zephyr_docs` / `search_zephyr_samples` + RAG 索引(`hw-index`)
- `run_west` / `get_last_build_log`(构建工具)
- `hw-data` 包、Zephyr 源码镜像、按版本隔离的索引

---

## 七、下一步

M0 之后进 **M1 · 插件骨架 + Chat 面板**。需要的话我可以按本计划给出 M1 的手把手文档(同 M0 风格),或直接生成 M0/M1 文件。

---

_文档版本:v1.0(通用版,取代 Zephyr-中心初稿)· 随实施修订。_
