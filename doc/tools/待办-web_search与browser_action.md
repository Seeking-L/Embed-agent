# 待办:`web_search` 与 `browser_action`(本阶段暂不实现)

> 状态:🟡 **设计待办(暂不实现)** | 最近同步:M4 网络工具阶段 | 代码位置:尚无
>
> 本文是**占位 + 设计交底**:记录这两个网络工具**为什么先不做**、**将来做时按什么方案做**、以及**做之前要先拍板什么**。决策依据见 [`../写文件-网络-grep-实现对比与选型.md`](../写文件-网络-grep-实现对比与选型.md) §三。
>
> 与本批一起落地的网络工具是 **`web_fetch`**(已实现,见 [`web_fetch-抓取网页转markdown.md`](./web_fetch-抓取网页转markdown.md));`web_search` 与 `browser_action` 按用户决定**推后**。

---

## 1. 为什么先不做

### `web_search`(网页搜索)

**核心障碍:没有现成可抄的搜索后端。** 三个参考项目的 `web_search` 全部绑死各自的**托管后端**,我们一个都用不了:

| 项目 | 搜索后端 | 我们能用吗 |
| --- | --- | --- |
| Claude Code | Anthropic 托管(且仅美国可用) | ❌ 绑 Anthropic |
| Codex | OpenAI Responses API(仅 OpenAI provider) | ❌ 绑 OpenAI,我们多 provider(含 DeepSeek) |
| Cline | Cline 自家云(需 Cline 账号 token) | ❌ 绑 Cline 云 |

所以 `web_search` 对我们**不是「抄哪家」的技术问题,而是「引入哪个外部搜索 API」的产品决策**——大多要 API key、要付费、要处理限流。在「领域无关对话底座」阶段,**本地资料按需读(grep + read_file)是主路径**,联网搜索优先级低,**先不引这个外部依赖**。

### `browser_action`(Puppeteer 真浏览器)

Cline 的 `browser_action` 是「真浏览器 + 截图喂视觉模型 + 点坐标操作网页 UI」。对**通用对话底座 / 未来的嵌入式开发助手**而言:

- **用不上**:我们不需要操作网页 UI、不做端到端 Web 测试;
- **太重**:要拉 Chromium(几百 MB)、要视觉模型读截图、一次只能一个动作、还要管「launch 开头 / close 结尾」的状态机;
- 与产品定位(`CLAUDE.md`:嵌入式开发助手,tool-driven 读本地资料)无关。

**结论:`browser_action` 大概率永久不做**,除非将来出现「跑起来看渲染结果」这类明确需求。

---

## 2. 将来要做时,按什么方案做

### `web_search` 的三条路线(做之前选一条)

1. **外部搜索 API(自实现一个 `web_search` 工具)**
   - 候选:**Tavily**(专为 LLM 设计,返回已清洗摘要,最省事)、Brave Search API、Bing Web Search、Google Custom Search、SerpAPI、DuckDuckGo(免 key 但易限流)。
   - 形态:`web_search{ query, allowed_domains?, blocked_domains? }`(参数对齐 Claude Code / Cline 的通用形状),返回 `{title, url, snippet}` 列表,`sources` 填各结果 URL。
   - key 走 SecretStorage(同 LLM key),`requiresConfirm: true`(出网)。
   - 注意:`allowed_domains` 与 `blocked_domains` 二选一,不可同时给(三家一致约定)。

2. **交给 MCP(不自实现)**
   - 接一个外部 **MCP search server**,我们的 `ToolRegistry` 只做桥接。
   - 依据:Claude Code / Cline 的工具描述都写了「**有 MCP 的网络工具就优先用 MCP**」(限制更少)。这也契合 [`../开源Agent工具设计调研.md`](../开源Agent工具设计调研.md) §四「朝 MCP 兼容形态靠」的方向。
   - 等 `ToolRegistry` 具备 MCP 兼容能力后,这是**零自维护成本**的路线。

3. **先做「站内搜 + web_fetch」组合代替**
   - 很多场景(查某框架文档)其实是「已知文档站,定位某页」。可以先靠 `web_fetch` 抓已知 URL + 模型自己拼 URL,**绕过通用搜索**。

> **推荐**:优先看路线 2(MCP)是否就绪;否则路线 1 选 **Tavily**(对 LLM 最友好)。

### `browser_action`(若真要做)

- 直接参考 Cline `services/browser/BrowserSession.ts` + `BrowserToolHandler.ts`:`puppeteer-core` + 受管 Chromium,动作集 `launch/click/type/scroll_down/scroll_up/close`,每步回「截图 + console 日志」,**一条消息一个动作**,launch 开头 / close 结尾,「浏览器开着时只能用 browser_action」。
- 需要**视觉能力的模型**(读截图)。
- `requiresConfirm` / Auto-Approve:出网 + 可点击,默认手动确认。

---

## 3. 做之前要先拍板(Decision Gate)

实现 `web_search` 之前,必须先定:

- [ ] 走 **MCP** 还是**自实现外部 API**?(见 §2 路线)
- [ ] 若自实现:选哪个搜索服务商?谁出 key/费用?限流怎么处理?
- [ ] 隐私红线(`CLAUDE.md`):query 会发到第三方搜索服务,是否需要在 UI 明示 + 默认确认?

实现 `browser_action` 之前:

- [ ] 是否真有「操作网页 / 看渲染结果」的需求?(没有就别做)
- [ ] 目标模型是否具备视觉能力?

---

## 4. 验收标准(将来实现时)

通用(两者都适用):

- 工具 `description` 写清用途/参数/返回/边界(对齐 `doc/tools/README.md` 模板与 `CLAUDE.md`「工具描述纪律」)。
- 返回 `ToolResult` 带 `sources`(`web_search` 填各结果 URL)。
- 出网操作 `requiresConfirm: true`,或走 Auto-Approve 分类开关。
- agent-core 不 `import vscode`;需要的外部能力(API key、网络策略)走依赖注入。
- 离线单测覆盖(网络部分用 stub / mock)。
- 落地后:把本文的 🟡 行在 `doc/tools/README.md` 索引表改成 ✅,并补正式工具文档。

---

> 📌 本文是**待办占位**,不是已实现工具。真正动手前先过 §3 的 Decision Gate。
