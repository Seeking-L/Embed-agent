# 开发进度与路线图 · Development Status & Roadmap

> 本文是**进度快照**:记录「现在到哪了、下一步做什么」。
> **权威计划**仍以 [`Phase1-plan.md`](./Phase1-plan.md)(Phase 1 计划)和 [`Embed-AI-Agent-开发规划.md`](./Embed-AI-Agent-开发规划.md)(总体规划)为准 —— 本文只做汇总与状态标注,细节请点进对应文档。
>
> 状态图例:✅ 完成 · 🚧 进行中 · ⬜ 未开始 · ❄️ 冻结
>
> 最后更新:2026-05-24

---

## 一、当前定位

项目重新定位为**通用嵌入式开发助手**(复现 CubeMX),但**嵌入式方向待同事确认可行性前先冻结**。当前阶段(**Phase 1**)只做**与领域无关的「可对话 agent」底座**——聊天 + 与 LLM 多轮流式对话 + 可插拔工具框架 + 多 provider。这套底盘日后无论接什么领域能力都能复用。

详见 [`Phase1-plan.md` §〇 范围](./Phase1-plan.md)。

---

## 二、整体里程碑

Phase 1 拆成 5 个里程碑(M0 → M4),其中 **M1 + M2 合起来是「Tracer bullet」**:能在面板里和 LLM 流式多轮对话,主链路即被验证。

| 里程碑 | 内容                 | 关键产物                                                                | 状态             |
| ------ | -------------------- | ----------------------------------------------------------------------- | ---------------- |
| **M0** | 工程脚手架           | monorepo、构建、lint、CI、共享类型                                      | ✅ 已完成        |
| **M1** | 插件骨架 + Chat 面板 | 激活、命令、Webview(React)、type-safe RPC、配置、SecretStorage、日志    | ✅ 已完成        |
| **M2** | Agent 对话核心       | LLM adapter(多 provider)、流式、工具注册 + 分发、会话状态、**确认原语** | ⬜ 下一步        |
| ★      | **Tracer bullet**    | 面板里和 LLM 流式多轮对话(M1 + M2)                                      | 🚧 M1 就位,待 M2 |
| **M3** | 通用工具             | `read_file` / `list_dir` / `search_in_workspace`(只读);可选受控命令     | ⬜ 未开始        |
| **M4** | 评测 + 验收          | 通用对话评测集 + harness                                                | ⬜ 未开始        |

里程碑依赖与详细任务见 [`Phase1-plan.md` §一、§二](./Phase1-plan.md)。

---

## 三、已完成:M0 工程脚手架 ✅

一个「能编译、能测试、能检查、能持续集成」的空架子已就位。手把手过程见 [`Phase1/M0-工程脚手架-详细文档.md`](./Phase1/M0-工程脚手架-详细文档.md)。

- **monorepo** — pnpm workspace,4 个包:
  - `shared` ✅ — 核心类型(`ToolResult`/`Source` 工具契约、`AgentConfig`/`LlmProvider` 配置、`WebviewToExt`/`ExtToWebview` 消息协议)+ 1 个 vitest 用例。
  - `extension` ✅ — 插件本体;M0 是最小入口,**M1 已扩展**为侧边栏聊天视图 + 命令 + 配置 + SecretStorage + Output(见 §四)。
  - `webview` ✅ — M0 占位,**M1 已实现** React 聊天界面(见 §四)。
  - `agent-core` ❄️ — 占位(M2 起填 LLM 调度与工具系统)。
- **构建/检查链** — esbuild 打包(`dist/extension.js`)、`tsc` 类型检查、ESLint 9 flat config、Prettier。
- **调试** — `.vscode/launch.json`,F5 启动「扩展开发宿主」。
- **CI** — GitHub Actions 三平台(Windows/macOS/Linux)跑 typecheck/lint/test/build。
- **许可证** — Apache 2.0(`../LICENSE`)。

本地验收命令全部通过(`install` / `typecheck` / `test` / `build` / `lint` / `format`)。

> 待远端最终确认:推送后 **CI 三平台绿勾**(本地全部已通过)。

---

## 四、已完成:M1 · 插件骨架 + Chat 面板 ✅

聊天主链路已打通:**侧边栏 Chat 面板 → 发消息 → 后台流式回 → 前端 markdown 渲染**(本阶段后台是 echo 占位)。手把手见 [`Phase1/M1-插件骨架与Chat面板-详细文档.md`](./Phase1/M1-插件骨架与Chat面板-详细文档.md)。

- **侧边栏视图** — `ChatViewProvider`(`WebviewView`,活动栏入口),非编辑器 Panel。
- **Webview(React)** — React 18 + Zustand 状态 + Tailwind v4(跟随 VS Code 明暗主题)+ react-markdown + shiki(v4,JS 引擎绕开 wasm)代码高亮。
- **type-safe RPC** — `acquireVsCodeApi()` 封装,前后端共用 `shared` 的 `WebviewToExt` / `ExtToWebview`;流式 `streamDelta` → `assistantDone`,可「停止」(`cancelStream`),显示 token 用量。
- **命令** — `embed-agent.openChat` / `setApiKey` / `clearApiKey`;**API key 走 `SecretStorage`**,不进普通设置。
- **配置 + 可观测** — `llmProvider` / `model` / `baseURL`;Output channel `Embed Agent` 打印激活耗时(< 1s)与配置。
- **构建** — esbuild 出两个 bundle(extension + webview)+ Tailwind CLI 编 CSS;F5 已配 `preLaunchTask` 自动构建。

本地验收全部通过(`typecheck` / `lint` / `test` / `build` / frozen-install);webview 另经模拟 DOM 冒烟验证(挂载 + 输入→流式→markdown→shiki 高亮全链路)。待人工确认:**按 F5** 实际跑通侧边栏面板。

### 下一步:M2 · Agent 对话核心 ⬜

把 echo 后台换成**真正的 LLM 流** + **工具框架**——前端协议不变(仍是 `streamDelta` / `assistantDone` / `tokenUsage`)。要点(完整见 [`Phase1-plan.md` §二 · M2](./Phase1-plan.md)):LLM thin adapter(必须流式;先 Anthropic,OpenAI 分支覆盖 DeepSeek)、工具注册 + dispatch loop、会话状态/超长截断、token 计费、错误可读 + 重试、取消、**确认原语**(`requestConfirm` 通道 M1 已留好)。M1 + M2 合并达成 ★ Tracer bullet。

---

## 五、Phase 1 出口标准(DoD)

来自 [`Phase1-plan.md` §〇](./Phase1-plan.md),作为 Phase 1 的验收口径:

| 类别              | 指标                                                    |
| ----------------- | ------------------------------------------------------- |
| 可用性            | 团队成员在各自机器(Win/macOS/Linux)都能跑起来           |
| **Tracer bullet** | 聊天面板里能和 LLM 多轮**流式**对话                     |
| 多 provider       | 可切 Anthropic / OpenAI / DeepSeek;key 走 SecretStorage |
| 工具回路          | agent 能调用通用工具(读文件)并用结果作答,过程 UI 可见   |
| 受控操作          | 危险操作走确认(confirm 原语)                            |
| 体验              | 流式 + 可取消 + 错误可读 + token 用量显示               |
| 评测              | 通用对话评测集(≥ 15 任务)通过率 ≥ 85%                   |
| 性能              | 插件激活 < 1s                                           |

---

## 六、已冻结清单(嵌入式方向确认后再启用)❄️

下列原 Zephyr-中心能力**暂不做**,届时作为「工具」接进 M2 框架即可,底座无需改动(见 [`Phase1-plan.md` §六](./Phase1-plan.md)):

- `ProjectMeta` / `get_project_meta`(工程识别)
- `lookup_binding` / `lookup_kconfig` / `list_boards`(知识查询)
- `search_zephyr_docs` / `search_zephyr_samples` + RAG 索引(`hw-index`)
- `run_west` / `get_last_build_log`(构建工具)
- `hw-data` 包、Zephyr 源码镜像、按版本隔离的索引

数据来源的取舍分析见 [`STM32_数据来源汇总.md`](./STM32_数据来源汇总.md)。

---

## 参考文档

- [运行指南 / Getting Started](./GETTING-STARTED.md) — 把项目跑起来
- [Phase 1 计划](./Phase1-plan.md) — 本阶段权威计划
- [总体开发规划](./Embed-AI-Agent-开发规划.md) — 架构 / 技术选型 / 护栏
- [M0 脚手架详细文档](./Phase1/M0-工程脚手架-详细文档.md)
- [STM32 数据来源汇总](./STM32_数据来源汇总.md)
- [CLAUDE.md](../CLAUDE.md) — 工程约束与约定
- [README](../README.md)
