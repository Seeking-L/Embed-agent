# `web_fetch` —— 抓取网页转 Markdown

> 状态:✅ 已实现 | 最近同步:M4 | 代码位置:`packages/agent-core/src/tools/web_fetch.ts`(单测 `web_fetch.test.ts`)
>
> 选型依据:[`../写文件-网络-grep-实现对比与选型.md`](../写文件-网络-grep-实现对比与选型.md) §3。配套待办:[`待办-web_search与browser_action.md`](./待办-web_search与browser_action.md)。

## 1. 一句话总结

让 LLM 查阅【公开】网页:给一个 URL,抓 HTML → 剔除 script/style/导航/页脚等噪声 → 转成 Markdown 正文返回(并把 URL 作为来源)。出网操作,执行前需用户确认。

## 2. 接口契约

- **`name`**:`web_fetch`
- **`description`(给 LLM 看)**:抓 http/https 网页转 Markdown;强调只抓静态 HTML、拒内网/本机/云元数据地址、跨域重定向不自动跟随、需确认。原文见代码。
- **`inputSchema`**:

  | 参数 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | `url` | string | ✅ | — | 要抓取的网址(http 会自动升级 https) |
  | `max_length` | number | | 100000 | 返回 Markdown 最大字符数(范围 500–200000) |

- **返回**(`ToolResult`):`result` = `[已抓取 <url>]` 头 + 清理后的 Markdown(超长截断带 `…(已截断)`);`sources:[{file: 最终URL}]` → loop 自动追加「来源:\n- <url>」。
- **`requiresConfirm`**:**true**(网络 = 数据出本机,隐私红线)。loop 的确认卡片会显示参数(含 URL)。

## 3. 设计要点(= 选型文档结论的落地)

- **形态学 Claude Code 的 WebFetch**(抓取 → 转干净 markdown → 返回),但**两点关键不同**:
  1. **不做有损摘要**:Claude Code 会把网页喂给小模型摘要后只返回摘要(有损,且削弱来源引用)。我们**返回清理后的 markdown 原文 + URL 作为 sources**,守住「输出契约」。
  2. **本地自实现、不依赖托管后端**:三家的搜索/抓取都绑各自的云(我们多 provider 含 DeepSeek 用不了)→ 用 Node 18+ 内置 `fetch` + `cheerio` + `turndown` 自己做。
- **清洗逻辑抄 Cline 的 `UrlContentFetcher`**:`cheerio.load(html)` → 删 `script/style/noscript/nav/footer/header/iframe/svg` → `turndown` 转 md。但**不用 puppeteer 真浏览器**(那是为抓 JS 渲染页 + 截图;我们只要静态 HTML,`fetch` 足够,省掉几百 MB Chromium)。
- **SSRF 防护(`assertPublicUrl`)**——网页抓取最大的安全风险:
  - http 自动升级 https;只放行 http/https(挡 `file:`/`ftp:`/`data:`);
  - 解析主机名拿到真实 IP,**拒绝内网/环回/链路本地/云元数据**(逐一枚举 IPv4/IPv6 段,含经典 SSRF 目标 `169.254.169.254`);主机名解析**所有** A/AAAA 记录,任一私有就拒(防 DNS 重绑定);
  - **跨域重定向不自动跟随**(`redirect: 'manual'`),把新地址当数据返回让模型再发一次(抄 Claude Code,也防 SSRF)。
- **护栏**:`AbortController` 15s 超时;原始 HTML > 5 MB 解析前就拒(防巨页撑爆 cheerio);非 HTML/文本 content-type 拒。
- **错误即数据**:超时/网络错/HTTP 4xx-5xx/被拒,都返回成「文本结果」而非抛异常,让模型能据此调整。

## 4. 核心代码节选

- `assertPublicUrl(url)`:URL 解析 + http→https + 协议白名单 + `isPrivateIP` 判定(literal IP 直接判,主机名走 `dns.lookup({all:true})`)。
- `createWebFetchTool().handler`:① `assertPublicUrl` → ② `fetch(redirect:'manual', signal)` → ③ 3xx 重定向即数据 → ④ status/content-type 闸门 → ⑤ 5MB 闸门 → ⑥ cheerio 删噪声 + turndown → ⑦ 截断 → ⑧ 返回 + sources。

> 详细逐行注释见 `web_fetch.ts`。

## 5. 测试

- 位置:`packages/agent-core/src/tools/web_fetch.test.ts`(9 例,完全离线)。
- `assertPublicUrl`:用 **IP 字面量**测(不触发 DNS、不联网)——放行公网 IP 并升级 https;拦环回/内网/`169.254.169.254`/localhost/`[::1]`;拦非 http(s) 协议;非法 URL 抛错。
- handler:`vi.stubGlobal('fetch', …)` 喂构造好的 `Response`——正常抓取转 md(并验证 `<script>` 被删)、内网地址不调 fetch 直接拒、重定向即数据、非 HTML content-type 拒、`max_length` 截断。

## 6. 已知局限 / 后续 TODO

- **只抓静态 HTML、不执行 JS**:重度依赖前端渲染的页面可能内容很少(需要时再考虑 Cline 的 puppeteer 路线)。
- **无缓存**:Claude Code 有 15 分钟 URL 缓存,我们 v1 未做。
- SSRF 是「尽力而为」:DNS 在校验后、真正连接前理论上可能再变(TOCTOU);更强需在校验后锁定 IP 再连。
- **`web_search` / `browser_action` 未做**,见 [`待办-web_search与browser_action.md`](./待办-web_search与browser_action.md)(搜索后端三家都不可直接抄,需另选外部 API 或走 MCP)。
- 新增依赖:`cheerio` / `turndown` / `@types/turndown`(`fetch` 用 Node 18+ 内置,无需 node-fetch)。
