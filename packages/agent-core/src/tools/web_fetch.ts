// ============================================================================
// tools/web_fetch.ts —— 工具:抓取一个网页,转成干净的 Markdown 返回
// ----------------------------------------------------------------------------
// 【这工具是干什么的】
// 让 LLM 查阅【公开】网页:在线文档、API 参考、RFC、GitHub README、博客等。给一个 URL,
// 本工具抓 HTML → 剔除 script/style/导航/页脚等噪声 → 转成 Markdown 正文返回。
//
// 【设计取舍 = 选型文档的结论】(doc/写文件-网络-grep-实现对比与选型.md §3)
//   - 形态学 Claude Code 的 WebFetch:抓取 → 转干净 markdown → 返回;但:
//   - 【不做有损摘要】:Claude Code 会把网页喂给一个小模型摘要后只返回摘要(有损,还削弱
//     来源引用)。我们改成【返回清理后的 markdown 原文 + URL 作为 sources】,守住「输出契约」。
//   - 【本地自实现、不依赖托管后端】:Claude Code / Codex / Cline 的搜索/抓取都绑各自的云,
//     我们多 provider(含 DeepSeek)用不了 → 用 Node 18+ 内置 fetch + cheerio + turndown 自己做。
//   - 抓取/清洗的 LOGIC 抄 Cline 的 UrlContentFetcher(cheerio 删噪声 + turndown 转 md),
//     但【不用 puppeteer 真浏览器】(那是为抓 JS 渲染页 + 截图;我们只要静态 HTML,fetch 足够,
//     省掉几百 MB 的 Chromium)。
//
// 【安全:SSRF 防护】(抄 Claude Code 的几条 + 通用 SSRF 加固)
//   网页抓取最大的风险是「服务端请求伪造」(SSRF):模型被诱导去访问内网地址,比如
//   http://169.254.169.254/(云厂商元数据,能偷 IAM 凭证)、http://127.0.0.1:xxxx(本机服务)。
//   防护三连(见 assertPublicUrl):
//     ① http 自动升级 https;只允许 http/https,挡掉 file:/ftp:/data: 等;
//     ② 解析主机名拿到真实 IP,拒绝内网/环回/链路本地/云元数据地址(逐一枚举,见下);
//     ③ 跨域重定向【不自动跟随】,而是把新地址当数据返回,让模型自己再发一次(也防 SSRF)。
//
// 【gated:出网要确认】网络 = 数据出本机(隐私红线),所以 requiresConfirm: true。
//
// 【给 Node 新手的速记】
//   globalThis.fetch       Node 18+ 内置(无需 node-fetch);返回 Response(有 .status/.headers/.text())。
//   AbortController        造一个「取消令牌」;ac.abort() 让 fetch 抛 AbortError → 实现超时。
//   node:dns/promises lookup(host,{all:true})  把主机名解析成 IP 列表(异步)。
//   node:net isIP(s)       判断字符串是不是 IP:返回 4 / 6 / 0(不是 IP)。
// ============================================================================

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import type { ToolSpec } from '../types';
import type { ToolResult } from '@embed-agent/shared';

// ── 常量(超时/上限均为经验值;详见选型文档 §3.3)──
const FETCH_TIMEOUT_MS = 15_000; // 抓取超时(慢的文档 CDN 留够时间)
const DEFAULT_MAX_CHARS = 100_000; // 默认输出上限(~100 KB),仿 read_file 的截断哲学
const MAX_MAX_CHARS = 200_000; // max_length 的硬顶(防模型传 9e9)
const MIN_MAX_CHARS = 500; // max_length 的下限
// 原始 HTML 上限:先看 Content-Length 头能拒就拒,下载后再兜一道;两道都过才喂 cheerio。
// (注:这不是「峰值内存」上限——撒谎/缺失的 Content-Length 仍会先下完才被实际长度拒;
//  它保证的是「>5MB 的正文不会进 cheerio 解析」,内存峰值另受 15s 超时约束。)
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
// 要从 HTML 里删掉的「噪声」标签:脚本/样式/导航/页脚/页眉/内嵌框架/矢量图。
const STRIP_SELECTOR = 'script, style, noscript, nav, footer, header, iframe, svg';
const USER_AGENT = 'Mozilla/5.0 (compatible; EmbedAgent/0.1)';

// ============================================================================
// WebFetchBlockedError —— SSRF / 非法 URL 拦截错误(自定义类,便于上层区分)
// ----------------------------------------------------------------------------
// 和 paths.ts 的 PathOutOfRangeError 同一思路:上层 `e instanceof WebFetchBlockedError`
// 时转成「拒绝:…」文本(正常回填给模型),而不是当成工具崩溃。
// ============================================================================
export class WebFetchBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebFetchBlockedError';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// IP 私有/保留地址判定(SSRF 黑名单)
// ────────────────────────────────────────────────────────────────────────────

/** 把 "a.b.c.d" 解析成 [a,b,c,d];不是合法 IPv4 返回 null。 */
function parseIPv4(ip: string): number[] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null;
}

/** 是不是「内网/环回/链路本地/云元数据」等不该访问的 IPv4。 */
function isPrivateIPv4(ip: string): boolean {
  const p = parseIPv4(ip);
  if (!p) return false;
  const [a, b] = p;
  if (a === 0) return true; // 0.0.0.0/8  本机
  if (a === 127) return true; // 127.0.0.0/8  环回
  if (a === 10) return true; // 10.0.0.0/8  私有
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12  私有
  if (a === 192 && b === 168) return true; // 192.168.0.0/16  私有
  if (a === 169 && b === 254) return true; // 169.254.0.0/16  链路本地(含 .169.254 云元数据!)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10  运营商级 NAT
  return false;
}

/**
 * 把任意写法的 IPv6 展开成 8 组 16 位整数(处理一次 :: 压缩 + 末尾内嵌的点分 IPv4)。
 * 解析不了返回 null。
 *
 * 【为什么必须展开,不能用字符串/正则匹配】(见 review 发现⑨)
 *   WHATWG 的 new URL() 会把 ::ffff:127.0.0.1 规范化成【十六进制】压缩形式 ::ffff:7f00:1。
 *   早先用「点分形式的正则」判 IPv4 映射,等于形同虚设——::ffff:7f00:1 / ::ffff:a9fe:a9fe
 *   这类十六进制写法直接绕过,可达 127.0.0.1 / 169.254.169.254(云元数据)。展开成整数后
 *   按结构判断,才不漏。
 */
function expandIPv6(raw: string): number[] | null {
  let ip = raw.toLowerCase();
  // 末尾若是点分 IPv4(如 ::ffff:1.2.3.4),先转成两组十六进制再展开。
  const lastColon = ip.lastIndexOf(':');
  const tail = ip.slice(lastColon + 1);
  if (tail.includes('.')) {
    const p = parseIPv4(tail);
    if (!p) return null;
    const g6 = ((p[0] << 8) | p[1]).toString(16);
    const g7 = ((p[2] << 8) | p[3]).toString(16);
    ip = ip.slice(0, lastColon + 1) + g6 + ':' + g7;
  }
  const parts = ip.split('::');
  if (parts.length > 2) return null; // :: 最多出现一次
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  let groups: string[];
  if (parts.length === 1) {
    groups = left; // 没有 ::,必须正好 8 组
  } else {
    const fill = 8 - left.length - right.length; // :: 代表的那串 0 组
    if (fill < 0) return null;
    groups = [...left, ...Array<string>(fill).fill('0'), ...right];
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => parseInt(g || '0', 16));
  return nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : nums;
}

/** 从展开后的 IPv6 末两组取出内嵌的 IPv4,按 IPv4 规则判私有。 */
function embeddedV4IsPrivate(g: number[]): boolean {
  const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  return isPrivateIPv4(v4);
}

/** 是不是不该访问的 IPv6(环回/未指定/唯一本地/链路本地/各种内嵌 IPv4 形式)。 */
function isPrivateIPv6(raw: string): boolean {
  const g = expandIPv6(raw);
  if (!g) {
    // 展开失败兜底:至少把压缩形式的环回/未指定挡掉。
    const s = raw.toLowerCase();
    return s === '::1' || s === '::';
  }
  const zeroHead = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0; // 前 5 组全 0
  if (g.every((x) => x === 0)) return true; // ::                未指定
  if (zeroHead && g[5] === 0 && g[6] === 0 && g[7] === 1) return true; // ::1  环回
  // IPv4 映射 ::ffff:a.b.c.d(规范化后是 ::ffff:HHHH:HHHH,认十六进制)
  if (zeroHead && g[5] === 0xffff) return embeddedV4IsPrivate(g);
  // NAT64 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return embeddedV4IsPrivate(g);
  }
  // IPv4 兼容 ::a.b.c.d(已废弃但仍判;前 6 组 0、非 :: / ::1)
  if (zeroHead && g[5] === 0 && (g[6] !== 0 || g[7] > 1)) return embeddedV4IsPrivate(g);
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7   唯一本地(ULA)
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10  链路本地
  return false;
}

function isPrivateIP(ip: string): boolean {
  const fam = isIP(ip); // 4 | 6 | 0
  if (fam === 4) return isPrivateIPv4(ip);
  if (fam === 6) return isPrivateIPv6(ip);
  return false;
}

// ============================================================================
// assertPublicUrl —— 校验并规范化用户/模型给的 URL,确保安全出网
// ----------------------------------------------------------------------------
//  - http → https(Claude Code 行为);只放行 http/https,挡掉 file:/ftp:/data: 等;
//  - 主机若是 IP 字面量,直接判;否则 DNS 解析【所有】地址,任一是内网就拒(防 DNS 重绑定);
//  - 返回规范化后的 https URL 字符串;违规抛 WebFetchBlockedError。
//
//  ⚠️ 这是「尽力而为」:DNS 在校验后、真正连接前理论上可能再变(TOCTOU)。更强的做法是
//     在这里把 IP 锁定后再连——v1 不做,够用。
// ============================================================================
export async function assertPublicUrl(rawUrl: string): Promise<string> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new WebFetchBlockedError(`非法 URL:${rawUrl}`);
  }

  if (u.protocol === 'http:') u.protocol = 'https:'; // 升级
  if (u.protocol !== 'https:') {
    throw new WebFetchBlockedError(`仅支持 http/https,拒绝协议:${u.protocol}`);
  }

  // 去掉 IPv6 字面量外面的方括号 [::1] → ::1
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$/i.test(host)) throw new WebFetchBlockedError('拒绝访问 localhost');

  // 主机就是 IP 字面量 → 直接判(无需 DNS)。
  if (isIP(host)) {
    if (isPrivateIP(host)) throw new WebFetchBlockedError(`拒绝访问内网/保留地址:${host}`);
    return u.toString();
  }

  // 主机名 → 解析所有 A/AAAA 记录;只要有一个落在内网就拒(防 DNS 重绑定到 0.0.0.0 等)。
  let records: { address: string }[];
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw new WebFetchBlockedError(`DNS 解析失败:${host}`);
  }
  if (records.length === 0) throw new WebFetchBlockedError(`无法解析主机:${host}`);
  for (const r of records) {
    if (isPrivateIP(r.address)) {
      throw new WebFetchBlockedError(`拒绝:${host} 解析到内网地址 ${r.address}`);
    }
  }
  return u.toString();
}

// ============================================================================
// createWebFetchTool —— 工厂函数(无需 FsToolConfig:它碰网络、不碰文件系统)
// ============================================================================
export function createWebFetchTool(): ToolSpec {
  // 复用一个 TurndownService 实例(turndown() 本身无状态)。
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

  return {
    name: 'web_fetch',
    requiresConfirm: true, // 出网操作 → 执行前弹确认(loop 会用 summary 显示 URL)

    description: `抓取一个网页(http/https)并返回清理后的 Markdown 正文。

用途:查阅在线文档、API 参考、RFC、GitHub README、博客等【公开】网页。
参数:
  - url(必填):要抓取的网址。http 会自动升级为 https。
  - max_length(可选,默认 ${DEFAULT_MAX_CHARS},范围 ${MIN_MAX_CHARS}–${MAX_MAX_CHARS}):返回 Markdown 的最大字符数,超出截断。
返回:网页正文转成的 Markdown(已剔除 script/style/导航/页脚等噪声)。
注意:
  - 只抓【静态 HTML】、不执行 JavaScript;重度依赖 JS 渲染的页面可能内容很少。
  - 出于安全,拒绝访问内网/本机/云元数据地址(localhost、127.x、10.x、169.254.169.254 等)。
  - 跨域重定向不会自动跟随,而是把新地址返回给你,请用新地址再次调用。
  - 这是联网操作,执行前需要用户确认。`,

    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的网址(http/https)' },
        max_length: {
          type: 'number',
          description: `返回 Markdown 最大字符数(默认 ${DEFAULT_MAX_CHARS},范围 ${MIN_MAX_CHARS}–${MAX_MAX_CHARS})`,
        },
      },
      required: ['url'],
      additionalProperties: false,
    },

    handler: async (input): Promise<ToolResult> => {
      const { url, max_length } = (input as { url?: string; max_length?: number }) ?? {};
      if (!url || typeof url !== 'string') return { result: '拒绝:url 不能为空。' };
      // 归一化 max_length:undefined/0/负数/小数/超大 都夹到 [MIN, MAX]。
      const cap = Math.min(
        MAX_MAX_CHARS,
        Math.max(MIN_MAX_CHARS, Math.floor(max_length ?? DEFAULT_MAX_CHARS)),
      );

      // ── ① SSRF 守门 + http→https ──
      let safeUrl: string;
      try {
        safeUrl = await assertPublicUrl(url);
      } catch (e) {
        if (e instanceof WebFetchBlockedError) return { result: `拒绝:${e.message}` };
        throw e;
      }

      // ── ② fetch(手动处理重定向 + AbortController 超时)──
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(safeUrl, {
          redirect: 'manual', // 不自动跟随重定向(见 ③,防 SSRF)
          signal: ac.signal,
          headers: {
            'user-agent': USER_AGENT,
            accept: 'text/html,application/xhtml+xml,text/plain',
          },
        });
      } catch (e) {
        // 超时/网络错误都返回成「文本结果」(而不是抛),让模型能据此调整,而不是看到一堆堆栈。
        if ((e as Error).name === 'AbortError') {
          return { result: `拒绝:抓取超时(>${FETCH_TIMEOUT_MS / 1000}s):${safeUrl}` };
        }
        return { result: `抓取失败:${(e as Error).message}` };
      } finally {
        clearTimeout(timer);
      }

      // ── ③ 重定向即数据(redirect-as-data):不自动跟随,把新地址返给模型 ──
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) {
          return {
            result: `该请求被重定向(${res.status})但缺少 Location 头,无法继续。`,
            sources: [{ file: safeUrl }],
          };
        }
        const abs = new URL(loc, safeUrl).toString(); // 相对 Location 也解析成绝对
        return {
          result: `该 URL 重定向到了新地址。出于安全未自动跟随。\n如需继续,请用新地址再次调用 web_fetch:\n${abs}`,
          sources: [{ file: abs }],
        };
      }

      // ── ④ HTTP 状态 + content-type 闸门 ──
      if (!res.ok) {
        return {
          result: `抓取失败:HTTP ${res.status} ${res.statusText} — ${safeUrl}`,
          sources: [{ file: safeUrl }],
        };
      }
      const ct = res.headers.get('content-type') ?? '';
      if (ct && !/text\/html|xml|text\/plain/i.test(ct)) {
        return {
          result: `拒绝:目标不是 HTML/文本页面(content-type: ${ct})。`,
          sources: [{ file: safeUrl }],
        };
      }

      // ── ⑤ 读正文 ──
      // 先用 Content-Length 头挡一道(能不下载就不下载);它可能缺失或撒谎,所以下载后再按
      // 实际长度兜一道。注:html.length 是 UTF-16 码元数、非精确字节,作为粗上限够用。
      const declaredLen = Number(res.headers.get('content-length'));
      if (Number.isFinite(declaredLen) && declaredLen > MAX_RESPONSE_BYTES) {
        return {
          result: `拒绝:页面过大(Content-Length ${(declaredLen / 1024 / 1024).toFixed(1)} MB > ${MAX_RESPONSE_BYTES / 1024 / 1024} MB):${safeUrl}`,
          sources: [{ file: safeUrl }],
        };
      }
      const html = await res.text();
      if (html.length > MAX_RESPONSE_BYTES) {
        return {
          result: `拒绝:页面过大(>${MAX_RESPONSE_BYTES / 1024 / 1024} MB):${safeUrl}`,
          sources: [{ file: safeUrl }],
        };
      }

      // ── ⑥ 转 Markdown ──
      // text/plain(robots.txt、RFC .txt、license、原始代码等纯文本)若也走 HTML 管道,会被
      // cheerio 误删 <...> 形状的内容、压扁换行、把 &amp; 解码——破坏「原文」。所以纯文本直接原样返回。
      let md: string;
      if (/text\/plain/i.test(ct) && !/html|xml/i.test(ct)) {
        md = html.trim();
      } else {
        // Cline 的清洗逻辑:cheerio 删噪声 → turndown 转 markdown。
        const $ = cheerio.load(html);
        $(STRIP_SELECTOR).remove();
        const bodyHtml = $('body').html() ?? $.html();
        md = turndown.turndown(bodyHtml).trim();
      }

      // ── ⑦ 截断(仿 read_pdf 的字符截断)──
      let truncated = false;
      if (md.length > cap) {
        md = md.slice(0, cap);
        truncated = true;
      }
      if (!md) md = '(页面正文为空,或全是脚本/样式,已被清理掉)';

      // ── ⑧ 组装 ToolResult;sources 填最终 URL → loop 自动追加「来源:\n- <url>」──
      const header = `[已抓取 ${safeUrl}${truncated ? ',内容已截断' : ''}]\n\n`;
      return {
        result: header + md + (truncated ? '\n\n…(已截断)' : ''),
        sources: [{ file: safeUrl }],
      };
    },
  };
}
