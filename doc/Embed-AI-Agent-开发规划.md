# Embed AI Agent for VS Code — 总体开发规划

> **一句话**:一个 VS Code 插件,以 AI Agent 为主入口,面向**通用嵌入式开发**,复现 CubeMX 的「配置芯片/板子 + 生成框架代码」能力;**借鉴 Zephyr 的开源硬件数据**作为跨厂商数据源。
>
> 版本:v2.0(通用版,2026-05 重订,取代 Zephyr-中心初稿)。配套:[`Phase1-plan.md`](./Phase1-plan.md)(现行 Phase 1 计划)、[`STM32_数据来源汇总.md`](./STM32_数据来源汇总.md)(数据来源分析)、根 `CLAUDE.md`(工程约束)。

---

## 〇、当前状态与重要前提(先读)

- **产品定位**:通用嵌入式开发助手(开源版「CubeMX + Copilot」),不绑定任何单一 RTOS/厂商。
- **Zephyr 的角色**:**开源硬件数据源 + 参考实现**(DTS/bindings/board 定义开源、有 schema、机器友好),**不是运行时,也不是产品本身**。
- **待定的关键决策**:生成代码的**目标平台**——厂商 HAL/裸机、Zephyr 运行时、还是多后端可切——**尚未确定**,取决于嵌入式团队的可行性评估。在此之前,**与「芯片配置 / 代码生成 / Zephyr 数据」相关的工作全部冻结**。
- **当前在做**:Phase 1 —— 领域无关的「可对话 agent」底座,详见 [`Phase1-plan.md`](./Phase1-plan.md)。

> 本文是**总体愿景与路线**;冻结阶段(Phase 2+)只给方向、不锁细节(因输出目标未定)。Phase 1 的可执行细节在 `Phase1-plan.md`。

---

## 一、项目定位

**一句话描述**:为嵌入式工程师提供一个可对话的、最终可视化的硬件配置与开发助手,跨厂商,以 VS Code 插件形式分发。

**三个差异化支点**

1. **跨厂商** — 不绑死 ST/Nordic/NXP;借助 Zephyr 等开源硬件描述做跨厂商抽象。
2. **AI 原生** — agent 主导配置与生成流程,不是「加了 chat 框的 IDE 插件」。
3. **配置即对话** — 自然语言描述意图,agent 操作配置与源码(目标格式视最终选定平台);UI 是 agent 行为的可视化与审计层。

**与 CubeMX 的关系**:对标其核心价值(可视化配置 → 生成初始化代码),但做到**开源、跨厂商、AI 驱动、不依赖闭源数据**。

**明确不做**

- 不重新发明底层构建工具链(cmake/ninja/make,目标若含 Zephyr 则 west/dtc)——封装,不替代。
- 不做底层 driver(交给上游)。
- 不做芯片级寄存器编辑器(用户不该直接看寄存器)。
- 不做 RTOS 内核教学/调试器(交给现有工具)。

---

## 二、为什么以 Zephyr 数据为主数据源

复现 CubeMX 需要权威的「芯片硬件描述」(引脚复用、外设、时钟、内存)。各来源对比(详见 [`STM32_数据来源汇总.md`](./STM32_数据来源汇总.md)):

- **CubeMX 内部数据**:最全,但闭源、格式无文档、有合规风险 → **绝不打包/分发**,仅本地对照。
- **Zephyr DTS + bindings**:Apache 2.0、**有完整 schema**、厂商工程师上游维护、对 LLM 友好 → **首选**。
- **modm-devices**(BSD):跨厂商统一格式 → 交叉验证/补充。
- **CMSIS-SVD**:寄存器级,后期需要再用。

**结论**:主用 Zephyr 数据,辅以 modm/SVD 做对照与补充。

---

## 三、整体架构(规划)

五层(框架通用,数据/工具可插拔):

```
Presentation (VS Code 插件)
  Chat 面板 · Diff viewer · 状态栏 · (后期) 可视化配置 UI
        ↕
Agent Core
  LLM 调度(多 provider)· 工具分发与权限 · 对话状态 · Diff 生成与确认
        ↕
Tool Layer
  Project tools(读写工程) · Knowledge tools(查硬件数据) · Build tools(封装构建) · (后期) Hardware tools
        ↕
Data Layer
  开源硬件数据(Zephyr DTS/bindings 为主,modm/SVD 辅) · 用户工程
        ↕
External Tooling
  cmake · ninja · gdb · openocd ·(目标含 Zephyr 时:west · dtc)
```

**核心设计原则(贯穿所有阶段)**

- **Tool-driven, not context-stuffing**:领域知识通过 tool call 按需查,不塞 prompt。
- **Diff-first, not autonomous-write**:任何文件修改先出 diff,用户 Apply 才落盘。
- **Read-heavy is free, write-heavy is gated**:读自由;写文件/执行命令/烧录必须单步确认。
- **数据版本绑定**:硬件数据按来源版本(如 Zephyr release tag)切分索引。

> 这几条已在 Phase 1 底座的工具框架与确认原语中先行落地(领域无关版)。

---

## 四、技术栈(已定型,勿重新选型)

- **插件层**:TypeScript · pnpm(workspace)· esbuild · vitest + `@vscode/test-electron` · ESLint + Prettier · VS Code API ≥ 1.85(用 LM API 则 ≥ 1.90)。
- **Webview**:React 18 · Zustand · Tailwind + VS Code theme vars · `acquireVsCodeApi()` 包一层 type-safe RPC · react-markdown + shiki。
- **Agent Core**:`@anthropic-ai/sdk`(主)/ OpenAI SDK(备,**含 DeepSeek** —— OpenAI 兼容 + 自定义 baseURL);自写 thin adapter 隔离 provider;**必须流式**;tiktoken 计费。
- **数据层(后期)**:sqlite-vec(本地向量库)· embedding 用本地 bge-small-en 或 OpenAI `text-embedding-3-small` · `yaml` 解析 bindings · DTS 自写轻量 parser + `dtc` 兜底 · Kconfig 调 `kconfiglib`(Python 子进程)· `simple-git` 拉数据源镜像。

**模型**:开发期 `claude-opus-4-7`(工具调用准);生产默认 `claude-sonnet-4-6`;廉价子任务 `claude-haiku-4-5`;省钱可选 DeepSeek(`deepseek-v4-flash/pro`)。用户自带 key、可切 provider。

**工程化(monorepo)**

```
embed-agent/
├── packages/
│   ├── extension/    # VS Code 插件本体 (TS)
│   ├── webview/      # Chat & UI (React)
│   ├── agent-core/   # LLM 调度 & 工具系统 (TS)
│   ├── shared/       # 共享类型
│   └── hw-data/      # (后期) 硬件数据索引与查询 (TS + Python helper)
├── tools/
│   ├── build-hw-index.ts   # (后期) 构建硬件知识库索引(Zephyr 等)
│   └── eval/               # Agent 能力评测
└── pnpm-workspace.yaml
```

> 当前底座只含前 4 个包(见 `Phase1-plan.md`);`hw-data` 等属冻结阶段。

---

## 五、分阶段路线(重订)

| 阶段        | 目标                              | 状态                           |
| ----------- | --------------------------------- | ------------------------------ |
| **Phase 0** | 准备与验证                        | 进行中(卡点见下)               |
| **Phase 1** | 可对话 agent 底座(领域无关)       | **现行**,详见 `Phase1-plan.md` |
| **Phase 2** | 嵌入式知识能力(只读)              | 冻结(待方向确认)               |
| **Phase 3** | 配置 + 代码生成(复现 CubeMX 核心) | 冻结                           |
| **Phase 4** | 可视化 UI                         | 规划                           |
| **Phase 5** | 扩展与打磨                        | 持续                           |

### Phase 0 — 准备与验证

- **确认产品方向与输出目标可行性**(裸机 HAL / Zephyr / 多后端)—— **当前最大卡点**,由嵌入式团队评估。
- 跑通参考工程全流程;评估 LLM 对硬件知识的「裸」准确率(证明 RAG 必要性)。
- 法律:许可证(建议 Apache 2.0),确认绝不引入 CubeMX 派生数据。

### Phase 1 — 可对话 agent 底座(现行)

领域无关的对话底座:聊天面板 + LLM 多轮流式 + 可插拔工具框架 + 通用工具(读工作区文件)+ 多 provider。**这套底盘无论输出目标如何都复用。** 细节见 `Phase1-plan.md`。

### Phase 2 — 嵌入式知识能力(冻结)

只读:查芯片/板子硬件数据(Zephyr DTS/bindings)、解释配置项、给配置建议;输出带 source citation;不写文件。

### Phase 3 — 配置 + 代码生成(冻结,复现 CubeMX 核心)

引脚/时钟/外设配置 → 生成框架/初始化代码(**输出目标依 Phase 0 结论**);所有写入走 diff-first + 确认;从 CubeMX `.ioc` 迁移作为亮点(尽力转换,非 1:1)。

### Phase 4 — 可视化 UI

Board 信息面板、配置 inspector、引脚表等;UI 与 agent 双向同步(UI 操作 = 可 replay 的 agent action)。

### Phase 5 — 扩展与打磨

更多厂商验证、Marketplace 发布、串口/RTT、多工程、i18n、文档。

---

## 六、数据策略

| 来源                  | 许可       | 用途                     | 优先级     |
| --------------------- | ---------- | ------------------------ | ---------- |
| Zephyr DTS + bindings | Apache 2.0 | 主硬件数据 + 配置 schema | ⭐⭐⭐⭐⭐ |
| modm-devices          | BSD        | 跨厂商对照/补充          | ⭐⭐⭐     |
| CMSIS-SVD             | 开放       | 寄存器级(后期)           | 补充       |
| CubeMX XML            | 半开放     | **仅本地对照,绝不打包**  | 合规风险   |

- **索引按来源版本隔离**;存储在 `~/.embed-agent/`(镜像 + 各版本索引 + config)。
- 查询走 sqlite-vec 向量 + 精确查找(如按 `compatible` 直接定位 binding)。

---

## 七、关键护栏(硬约束)

- **写入**:agent 改动一律走 propose → diff → 用户 Apply,不直接落盘;允许/禁止写的路径**按目标平台配置**(例:禁止写数据源镜像、`.git/`、构建产物)。
- **命令执行**:仅白名单(随目标工具链而定,如 `cmake --build`;目标含 Zephyr 则 `west build/flash/...`,后者需确认);**不允许 shell pipe / `&&` / 重定向**。
- **法律红线**:不打包/分发任何 CubeMX 派生数据;不用厂商私有/EULA 资源;用户代码未经同意不上传第三方(含 LLM provider,遥测默认关闭)。许可建议 Apache 2.0;警惕 GPL 依赖。
- **输出契约**:Knowledge 工具返回带 source citation(file + lines/section),agent 回复引用来源。
- **隐私**:API key 用 VS Code SecretStorage;默认零遥测,未来 telemetry 须 opt-in 且不传代码;给企业用户私有 LLM 网关选项。
- **跨平台**:Win/macOS/Linux 都测;注意路径分隔符、shell 差异、Python/venv 探测(Windows 历史坑)。

---

## 八、风险与缓解

| 风险                              | 影响 | 缓解                                               |
| --------------------------------- | ---- | -------------------------------------------------- |
| 输出目标方向迟迟未定              | 高   | Phase 0 优先解决;Phase 1 底座与目标无关,先产出价值 |
| LLM 准确率 / 工具调用不达预期     | 高   | RAG + tool 优先于 fine-tune;评测体系早建           |
| 数据源版本变更打破索引            | 中   | 索引按版本隔离,CI 跑多版本                         |
| 法律合规                          | 高   | 决不碰 CubeMX 数据,早定许可                        |
| 跨厂商 HAL 生成复杂度(若走该路线) | 高   | 先单厂商做深,再横向;或借 Zephyr 抽象               |
| 用户对「AI 改我代码」反感         | 中   | Diff-first,所有写入确认                            |
| 插件性能拖累 VS Code              | 中   | 重计算放子进程;严格激活预算                        |

---

## 九、成功标准

- **Phase 1**:对话底座团队成员本地可跑;能流式多轮对话 + 调通用工具;通用评测集达标。
- **Phase 2/3(解冻后)**:在标准任务上达成可用的查询/生成完成率(届时定量)。
- **长期(1 年)**:1000+ install;≥ 3 个厂商体验过关;形成稳定 contributor 圈。

---

## 附录:Zephyr 数据 / 输出相关的坑(Phase 2+ 备查)

> 当项目用 Zephyr 数据、或以 Zephyr 为输出目标时注意(数据源知识,非当前底座):

- `CONFIG_FOO=y` ≠ `CONFIG_FOO="y"`(后者是字符串)。
- overlay 要放对位置(`app.overlay` / `<board>.overlay`)。
- `pinctrl-0` 与 `pinctrl-names = "default"` 缺一不可。
- HWM v1 vs v2(Zephyr 3.7+)board 目录结构不同。
- Zephyr 3.5+ 的 sysbuild 使 multi-image 工程结构有别。
- Windows 上 west 的 venv 是历史坑。

---

_文档版本:v2.0(通用版)· 随实际进展持续更新。原 Zephyr-中心初稿已并入本文重订。_
