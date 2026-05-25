# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目状态

**早期阶段:M0 脚手架 + M1 Chat 面板 + M2 对话核心已完成。** pnpm monorepo 已起:`packages/shared` 有共享类型 + 1 个 vitest 用例;`packages/extension` 注册**侧边栏 Webview 聊天视图**(`ChatViewProvider`)、命令(`openChat`/`setApiKey`/`clearApiKey`)、配置项、SecretStorage、Output channel、激活计时;`packages/webview` 是 **React 18 + Zustand + Tailwind v4 + react-markdown + shiki** 的聊天界面,经 type-safe RPC 与后台收发;`packages/agent-core` 是 **LLM thin adapter(Anthropic + OpenAI/DeepSeek)+ 流式工具循环 `runAgent` + `ToolRegistry` + 确认原语**(纯 TS、不依赖 vscode、带离线单测)。M2 已把 M1 的 **echo 占位**换成**真 LLM 流式多轮对话 + 工具调用循环**(达成 ★ tracer bullet);演示工具 `get_current_time`/`run_demo_command` 验证回路,真实只读工具留给 M3。聊天面板右上角 **⚙ 可视化设置面板**(`webview/settings.ts` + `components/SettingsPanel.tsx`)可视化配置 provider/model/baseURL 并设 key(走 `configState`/`saveConfig`/`setApiKey` 等 RPC;key 只写不读、存 SecretStorage)。`pnpm build` 产出 `dist/extension.js`(已打进 SDK)+ `dist/webview/main.js` + `main.css`,F5 可调试。文档(`doc/`)仍是设计的**事实来源**。命令现状:`test` / `typecheck` / `lint` / `build` / `format` 均可跑,仅 `get-embed` 待补(详见「命令」)。

**定位(2026-05 更新)**:本项目是**通用嵌入式开发助手**(复现 CubeMX:自然语言配置芯片/板子 + 生成框架代码),面向普通嵌入式开发者;**Zephyr 仅作开源硬件数据源/参考**借鉴,产品不绑定 Zephyr。包名/命令统一 **`embed-agent`**(仓库目录仍叫 `Zephyr-agent`)。

**当前方向**:嵌入式方向待同事确认可行性前**冻结**(芯片配置 / 代码生成 / Zephyr 数据),先做**领域无关的「可对话 agent」底座**(聊天 + LLM 多轮流式 + 可插拔工具框架 + 多 provider 含 DeepSeek)。

**关键文档(事实来源)**:

- `doc/Embed-AI-Agent-开发规划.md` — 总体规划(架构、技术选型、分阶段路线、护栏)
- `doc/Phase1-plan.md` — 现行 Phase 1 计划(通用对话底座)
- `doc/Phase1/M0-工程脚手架-详细文档.md` — M0 脚手架手把手
- `doc/Phase1/M1-插件骨架与Chat面板-详细文档.md` — M1 插件骨架 + 侧边栏 Chat 面板手把手
- `doc/Phase1/M2-Agent对话核心-详细文档.md` — M2 LLM + 流式 + 工具框架手把手(已实现并验证)
- `doc/STM32_数据来源汇总.md` — 数据来源分析(为何以 Zephyr DTS/bindings 为主数据源)

> ⚠️ 下面的"架构 / 技术栈 / 护栏 / Zephyr 领域速记"多为**最终产品(含嵌入式能力)**的设计;其中芯片/Zephyr 相关部分属**已冻结阶段**,当前底座只用到通用部分。

## 这是什么

一个 **VS Code 插件**,以 AI Agent 为主入口,辅助**通用嵌入式开发**(复现 CubeMX,借 Zephyr 开源数据);长期目标是开源版「CubeMX + Copilot」。三个差异化支点:

1. **跨厂商** — 基于 Zephyr 的 DTS + Kconfig 抽象,不绑死 ST/Nordic/NXP。
2. **AI 原生** — agent 主导配置流程,不是「加了 chat 框的 IDE 插件」。
3. **配置即对话** — 用户用自然语言描述意图,agent 操作配置与源码(具体格式视目标平台);UI 是 agent 行为的可视化与审计层。

**明确不做**:不重写 Zephyr 工具链(west/cmake/dtc,只封装)、不做 driver、不做寄存器编辑器、不做内核教学/调试器。

## 核心设计原则(写任何代码前先内化)

- **Tool-driven, not context-stuffing** — Zephyr 知识通过 tool call 按需查询,不塞进 prompt。保准确、压成本、防幻觉。
- **Diff-first, not autonomous-write** — 任何文件修改先生成 diff,经 VS Code 原生 diff viewer 展示,用户 Apply 才落盘。禁止「自主多步执行后再报告」。
- **Read-heavy is free, write-heavy is gated** — 读用户工程自由;写文件、执行命令、烧录设备必须单步确认。
- **版本绑定** — 所有 Zephyr 知识(bindings/docs/samples)按 Zephyr release tag 切分索引,跟随用户工程 `west.yml` 锁定的版本。

## 架构(规划)

五层:Presentation(VS Code 插件 + Webview)→ Agent Core(LLM 调度、tool dispatch、权限、diff 流程)→ Tool Layer(Project / Knowledge / Build / Hardware tools)→ Data Layer(Zephyr 源码镜像、bindings 索引、docs 索引、用户工程)→ External Tooling(west/cmake/dtc/ninja/gdb/openocd)。详见规划文档 §2。

规划的 monorepo 结构:

```
packages/
  extension/    # VS Code 插件本体 (TS)
  webview/      # Chat & UI (React)
  agent-core/   # LLM 调度 & 工具系统 (TS)
  shared/       # 共享类型
  hw-data/      # (后期) 硬件数据索引与查询 (TS + Python helper)
tools/
  build-hw-index.ts  # (后期) 构建硬件知识库索引(Zephyr 等)
  eval/              # Agent 能力评测
```

**当前实况(与上图的差距)**:现有 4 个包——`shared`、`extension`、`webview`、`agent-core`。`webview` 已是完整 React 聊天界面(M1 完成:React 18 + Zustand + Tailwind v4 + react-markdown + shiki);`agent-core` 已实现 M2 核心(`src/{types,loop,registry,prompt,errors}.ts` + `adapters/{anthropic,openai,index}.ts` + `tools/demo.ts`,带 `loop.test.ts` 离线单测;依赖 `@anthropic-ai/sdk`、`openai`);`hw-data` 与 `tools/` 尚未创建。包用 pnpm workspace 串联,新增包须命名 `@embed-agent/<name>`、互相以 `workspace:*` 依赖(见 `extension` 依赖 `shared` 的写法)。CI 在 `.github/workflows/ci.yml`(Win/macOS/Linux 三平台跑 typecheck/lint/test/build);许可证 Apache 2.0(`LICENSE`)。

`packages/shared/src/index.ts` 是核心契约的**单一事实来源**(改协议先改这里,前后端共用):

- `ToolResult<T>` / `Source` — 工具返回统一形状,带来源引用(对应「输出契约」)。
- `WebviewToExt` / `ExtToWebview` — Webview↔Extension 的 `postMessage` 消息协议,可辨识联合(按 `type` 分支):用户消息、流式增量 `streamDelta`、工具调用进度、确认原语 `requestConfirm`/`confirmResponse`、取消、token 用量等。
- `AgentConfig` / `LlmProvider` — 用户配置与 provider 选择(`anthropic` / `openai` / `deepseek`;DeepSeek 复用 OpenAI SDK + `baseURL`)。
- `ProjectMeta` — 嵌入式工程元数据,属**已冻结**部分,当前底座不用。

## 技术栈(已定型,勿重新选型)

- **插件**:TypeScript · pnpm(workspace)· esbuild(构建)· vitest + `@vscode/test-electron`(测试)· ESLint + Prettier · VS Code API ≥ 1.85(用 Language Model API 则 ≥ 1.90)。
- **Webview**:React 18 · Zustand · Tailwind + VS Code theme variables(自动适配明暗)· `acquireVsCodeApi()` 包一层 type-safe RPC · react-markdown + shiki。
- **Agent Core**:`@anthropic-ai/sdk`(主)/ OpenAI SDK(备),中间隔一层自写 thin adapter;**必须流式**(streaming);tiktoken 计费。Prompt 模板按 Anthropic 优化。
- **数据**:sqlite-vec(本地向量库)· embedding 用 `text-embedding-3-small` 或 BGE-small-en · `yaml`(eemeli/yaml)解析 bindings · DTS 自写轻量 parser + `dtc` 兜底 · Kconfig 调 Zephyr `kconfiglib`(Python 子进程,不重写)· `simple-git` 拉取 Zephyr 镜像。

**模型**:MVP 开发期 `claude-opus-4-7`(工具调用准、debug 省);生产默认 `claude-sonnet-4-6`;廉价子任务 `claude-haiku-4-5`。用户自带 key,settings 里可切 provider。

## 命令

包管理用 **pnpm 10**(workspace);脚本都在根 `package.json`。

**先装依赖**:`pnpm install`。⚠️ 已知坑:`pnpm-lock.yaml` 曾与 `extension/package.json` 漂移,且 `node_modules` 跨机器/复制后符号链接易失效(表现为「模块找不到」)。遇到 frozen-lockfile 报错或模块缺失时:`pnpm install --no-frozen-lockfile`(非交互/CI 环境前置 `CI=true`,pnpm 会重建 `node_modules`)。

**当前可用**:

- 测试:`pnpm test`(= `vitest run`)。单测:`pnpm test <文件路径片段>` 或 `pnpm test -t "<用例名>"`。
- 类型检查:`pnpm typecheck`(= `tsc --noEmit -p tsconfig.json`,覆盖 `packages/*/src`)。
- 构建:`pnpm build`(= `node esbuild.mjs && tailwindcss …`)→ 打**两个** bundle:`extension/src/extension.ts` → `dist/extension.js`(node/cjs、`vscode` external),`webview/src/main.tsx` → `dist/webview/main.js`(browser/iife、生产 minify);再用 Tailwind CLI 编出 `dist/webview/main.css`。`pnpm watch`(concurrently 同跑 esbuild + Tailwind 两个监听)增量重打包。
- Lint:`pnpm lint`(flat config `eslint.config.mjs` + typescript-eslint;忽略 `dist`/`node_modules`)。
- 格式化:`pnpm format`(`prettier --write .`,**原地改写**全仓未忽略文件,含 `doc/` 中文文档;`.prettierrc` = 单引号/分号/printWidth 100/trailingComma all;未设 `proseWrap`,故不重排段落换行。无 `.prettierignore`)。

**尚不可用(M0 待补)**:

- `pnpm get-embed` → `node scripts/get-embed.mjs`:`scripts/` 目录与脚本**尚不存在**,会直接报错。

VS Code 插件调试:F5 启动 Extension Development Host(`launch.json` 已配 `preLaunchTask: build` 自动构建)→ 活动栏 Embed Agent 图标 → 侧边栏 Chat 面板;改 webview 后在调试宿主里重载即可。

获取数据源(**嵌入式方向解冻后**才需要;含后期 `hw-index build` 索引 CLI):

```
git clone https://github.com/zephyrproject-rtos/zephyr   # 主数据源:dts/bindings、dts/arm/st、doc、samples、boards
git clone https://github.com/modm-io/modm-devices         # 跨厂商对照(BSD)
```

## 安全与合规红线(硬约束)

**写入护栏** — agent 改动一律走 `propose_file_edit` / `propose_multi_file_change`(整组事务),不能直接落盘。

- 允许写:`<workspace>` 下的 `src/**`、`boards/**`、`dts/**`、`prj.conf`、`*.overlay`、`CMakeLists.txt`、`Kconfig*`。
- 永远禁止写:`<zephyr_base>/**`(不动 Zephyr 源)、`<workspace>/.git/**`、`<workspace>/build/**`。
- 二次确认:删除文件、改 `west.yml`、改 `CMakeLists.txt` 的 board 设置。

**命令护栏** — 仅白名单:`west build` / `flash` / `debug` / `update`(后三者需确认)、`cmake --build`。其余命令须显式请求授权。**不允许 shell pipe / `&&` / 重定向。**

**法律红线** — 不打包、不分发任何 CubeMX 派生数据;不用厂商私有/EULA 资源;用户代码未经同意不上传第三方(含 LLM provider,遥测默认关闭)。代码许可建议 Apache 2.0(与 Zephyr 一致);GPL 依赖会污染整个项目,需警觉。

**输出契约** — Knowledge 工具返回须带 source citation(file + lines/section);agent 回复用户时引用来源,便于核验。

**隐私** — API key 用 VS Code SecretStorage(不写明文配置);默认零遥测,未来 telemetry 必须 opt-in 且不上传代码。

## Zephyr 领域速记

- **三大配置支柱**:Devicetree/DTS(描述硬件)、Kconfig(开启软件功能,如 `CONFIG_FOO=y`)、CMake/west(编排构建)。
- **关键词**:overlay(只描述改动,不重写整树)、binding(YAML schema,配置格式的真相)、pinctrl(引脚复用)、`compatible`(节点类型标识)。
- **数据策略**:主用 Zephyr DTS + bindings(Apache 2.0、schema 完整、ST 工程师上游维护);modm-devices(BSD)做跨厂商对照;CubeMX XML 仅本地对照,**绝不打包**。
- **常见坑**(agent 生成配置时注意):`CONFIG_FOO=y` ≠ `CONFIG_FOO="y"`(后者是字符串);overlay 要放对位置(`app.overlay` / `<board>.overlay`);`pinctrl-names = "default"` 易漏;HWM v1 vs v2(Zephyr 3.7+)board 目录结构不同;Zephyr 3.5+ 的 sysbuild 使 multi-image 工程结构有别;Windows 上 west 的 venv 是历史坑。
