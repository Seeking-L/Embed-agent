<div align="center">

# Embed AI Agent

**AI-native, cross-vendor "CubeMX + Copilot" for embedded development — open source.**
**AI 原生、跨厂商的开源「CubeMX + Copilot」嵌入式开发助手。**

![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)
![Status](https://img.shields.io/badge/status-Phase_1_M1_complete-green)
![VS Code](https://img.shields.io/badge/VS_Code-%5E1.85-007ACC?logo=visualstudiocode&logoColor=white)
![Built with](https://img.shields.io/badge/TypeScript-pnpm_monorepo-3178C6?logo=typescript&logoColor=white)

**[English](#english) · [简体中文](#简体中文)**

</div>

---

## English

### What is this

**Embed AI Agent** is an open-source **VS Code extension** whose primary interface is an AI agent that assists **general embedded development** — the long-term goal is an open alternative to **STM32CubeMX + Copilot**: describe what you want in natural language, and the agent configures chips/boards and generates framework code.

> ⚠️ **Current focus (2026-05):** the embedded capabilities (chip configuration, code generation, Zephyr data) are **temporarily frozen** pending feasibility confirmation. We are first building the **domain-agnostic conversational-agent foundation**: chat + multi-turn **streaming** LLM + a pluggable **tool framework** + multiple providers (Anthropic / OpenAI / DeepSeek). Zephyr is used only as an **open hardware data source** for reference — the product is **not tied to Zephyr**.

👉 See the **[Development Status & Roadmap](doc/ROADMAP.md)** for where we are and what's next.

### Why it's different

1. **Cross-vendor** — built on Zephyr's DTS + Kconfig abstraction, not locked to ST / Nordic / NXP.
2. **AI-native** — the agent drives the configuration flow; it is not "an IDE plugin with a chat box bolted on".
3. **Configuration as conversation** — you describe intent in natural language, the agent edits config & source, and the UI is the **visualization & audit layer** for the agent's actions.

### Core design principles

- **Tool-driven, not context-stuffing** — knowledge is fetched on demand via tool calls, not stuffed into the prompt.
- **Diff-first, not autonomous-write** — every file change is shown as a diff and only applied after you approve it.
- **Read-heavy is free, write-heavy is gated** — reading your project is free; writing files / running commands / flashing devices requires per-step confirmation.

### What it does NOT do

Rewrite the Zephyr toolchain (`west`/`cmake`/`dtc` — it only wraps them), write drivers, build a register editor, or act as a kernel tutor / debugger.

### Tech stack

TypeScript · pnpm workspace (monorepo) · esbuild · vitest · ESLint + Prettier · VS Code API ≥ 1.85 · React 18 + Zustand + Tailwind v4 + react-markdown + shiki (webview, M1) · Anthropic / OpenAI SDK with a thin streaming adapter. Models: `claude-opus-4-7` (dev), `claude-sonnet-4-6` (prod), `claude-haiku-4-5` (cheap subtasks). **Bring your own API key** (stored in VS Code SecretStorage; telemetry off by default).

The monorepo has four packages — `shared` (shared types, the source of truth for the RPC/tool contracts), `extension` (the VS Code extension host: sidebar chat view, commands, config, SecretStorage), `webview` (the React chat UI, done in M1), plus the `agent-core` placeholder (M2).

### Quick start

```bash
pnpm install
pnpm build
# then press F5 → click the Embed Agent icon in the Activity Bar → Chat panel
```

For prerequisites, full commands, and troubleshooting, see **[Getting Started](doc/GETTING-STARTED.md)**.

### Documentation

- 🚀 [Getting Started](doc/GETTING-STARTED.md) — get the project running locally
- 🗺️ [Development Status & Roadmap](doc/ROADMAP.md) — current progress & next steps
- 📐 [Overall Plan](doc/Embed-AI-Agent-开发规划.md) — architecture, tech choices, phased roadmap, guardrails _(in Chinese)_
- 📋 [Phase 1 Plan](doc/Phase1-plan.md) — the conversational-agent foundation _(in Chinese)_
- 🛠️ [M0 Scaffold Walkthrough](doc/Phase1/M0-工程脚手架-详细文档.md) — step-by-step setup _(in Chinese)_
- 💬 [M1 Plugin Skeleton + Chat Panel Walkthrough](doc/Phase1/M1-插件骨架与Chat面板-详细文档.md) — sidebar webview, RPC, streaming _(in Chinese)_
- 🔌 [STM32 Data Sources](doc/STM32_数据来源汇总.md) — why Zephyr DTS/bindings is the primary data source _(in Chinese)_
- 🤖 [CLAUDE.md](CLAUDE.md) — conventions & guardrails for AI assistants and contributors

### License

[Apache 2.0](LICENSE).

<div align="right">(<a href="#embed-ai-agent">↑ back to top</a>)</div>

---

## 简体中文

### 这是什么

**Embed AI Agent** 是一个开源的 **VS Code 插件**,以 AI agent 为主入口,辅助**通用嵌入式开发**;长期目标是开源版的 **「STM32CubeMX + Copilot」**:你用自然语言描述意图,agent 帮你配置芯片/板子、生成框架代码。

> ⚠️ **当前方向(2026-05):** 嵌入式专属能力(芯片配置、代码生成、Zephyr 数据)在同事确认可行性前**暂时冻结**。我们先做**与领域无关的「可对话 agent」底座**:聊天 + 与 LLM 多轮**流式**对话 + 可插拔**工具框架** + 多 provider(Anthropic / OpenAI / DeepSeek)。Zephyr 仅作为**开源硬件数据源**参考借鉴,产品**不绑定 Zephyr**。

👉 进度与下一步见 **[开发进度与路线图](doc/ROADMAP.md)**。

### 三个差异化支点

1. **跨厂商** — 基于 Zephyr 的 DTS + Kconfig 抽象,不绑死 ST / Nordic / NXP。
2. **AI 原生** — agent 主导配置流程,不是「加了 chat 框的 IDE 插件」。
3. **配置即对话** — 你用自然语言描述意图,agent 操作配置与源码;UI 是 agent 行为的**可视化与审计层**。

### 核心设计原则

- **Tool-driven, not context-stuffing** — 知识通过 tool call 按需查询,不塞进 prompt。
- **Diff-first, not autonomous-write** — 任何文件改动先生成 diff,你 Apply 才落盘。
- **Read-heavy is free, write-heavy is gated** — 读工程自由;写文件 / 执行命令 / 烧录设备必须单步确认。

### 明确不做

不重写 Zephyr 工具链(`west`/`cmake`/`dtc`,只封装)、不做 driver、不做寄存器编辑器、不做内核教学 / 调试器。

### 技术栈

TypeScript · pnpm workspace(monorepo)· esbuild · vitest · ESLint + Prettier · VS Code API ≥ 1.85 · React 18 + Zustand + Tailwind v4 + react-markdown + shiki(webview,M1 完成)· Anthropic / OpenAI SDK,中间隔一层自写的流式 adapter。模型:`claude-opus-4-7`(开发期)、`claude-sonnet-4-6`(生产)、`claude-haiku-4-5`(廉价子任务)。**用户自带 API key**(存于 VS Code SecretStorage;默认零遥测)。

monorepo 有 4 个包 —— `shared`(共享类型,RPC / 工具契约的事实来源)、`extension`(VS Code 插件本体:侧边栏聊天视图、命令、配置、SecretStorage)、`webview`(React 聊天界面,M1 完成),以及占位的 `agent-core`(M2)。

### 快速开始

```bash
pnpm install
pnpm build
# 然后按 F5 → 活动栏 Embed Agent 图标 → 侧边栏 Chat 面板
```

环境要求、完整命令与排错见 **[运行指南](doc/GETTING-STARTED.md)**。

### 文档导航

- 🚀 [运行指南](doc/GETTING-STARTED.md) — 把项目在本地跑起来
- 🗺️ [开发进度与路线图](doc/ROADMAP.md) — 当前进度与下一步
- 📐 [总体开发规划](doc/Embed-AI-Agent-开发规划.md) — 架构、技术选型、分阶段路线、护栏
- 📋 [Phase 1 计划](doc/Phase1-plan.md) — 通用对话 agent 底座
- 🛠️ [M0 脚手架详细文档](doc/Phase1/M0-工程脚手架-详细文档.md) — 手把手搭建
- 💬 [M1 插件骨架 + Chat 面板详细文档](doc/Phase1/M1-插件骨架与Chat面板-详细文档.md) — 侧边栏 webview、RPC、流式
- 🔌 [STM32 数据来源汇总](doc/STM32_数据来源汇总.md) — 为何以 Zephyr DTS/bindings 为主数据源
- 🤖 [CLAUDE.md](CLAUDE.md) — 给 AI 助手与贡献者的约定和护栏

### 许可证

[Apache 2.0](LICENSE)。

<div align="right">(<a href="#embed-ai-agent">↑ 回到顶部</a>)</div>
