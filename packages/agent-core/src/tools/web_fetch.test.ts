// ============================================================================
// tools/web_fetch.test.ts —— web_fetch 工具的单测(离线;fetch 用 stub)
// ----------------------------------------------------------------------------
// 两块:
//   1) SSRF 守门(assertPublicUrl):用【IP 字面量】测,不触发 DNS、也不联网——
//      内网/环回/云元数据/非 http(s) 协议都应被拦;公网 IP 应放行并把 http 升成 https。
//   2) handler 主流程:用 vi.stubGlobal 把全局 fetch 换成假的,喂构造好的 Response,
//      验证 markdown 清洗、重定向即数据、content-type 闸门、截断。用公网 IP 1.1.1.1
//      当 url(IP 字面量 → 跳过 DNS),所以全程不联网。
// ============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createWebFetchTool, assertPublicUrl, WebFetchBlockedError } from './web_fetch';

describe('assertPublicUrl SSRF 守门', () => {
  it('放行公网 IP,并把 http 升级为 https', async () => {
    await expect(assertPublicUrl('http://1.1.1.1/path')).resolves.toBe('https://1.1.1.1/path');
  });

  it('拦截环回 / 内网 / 云元数据 / localhost', async () => {
    for (const bad of [
      'http://127.0.0.1/',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/', // 云元数据,经典 SSRF 目标
      'http://localhost:8080/',
      'http://[::1]/',
    ]) {
      await expect(assertPublicUrl(bad), bad).rejects.toBeInstanceOf(WebFetchBlockedError);
    }
  });

  it('拦截 IPv4 映射的 IPv6 十六进制写法(回归:曾可绕过到 127.0.0.1 / 云元数据)', async () => {
    for (const bad of [
      'http://[::ffff:7f00:1]/', // = 127.0.0.1(URL 规范化后的十六进制写法)
      'http://[::ffff:127.0.0.1]/', // 点分写法(URL 会规范成上面的十六进制)
      'http://[::ffff:a9fe:a9fe]/', // = 169.254.169.254 云元数据
    ]) {
      await expect(assertPublicUrl(bad), bad).rejects.toBeInstanceOf(WebFetchBlockedError);
    }
  });

  it('放行公网 IPv6(确保 SSRF 加固没误伤正常地址)', async () => {
    await expect(assertPublicUrl('http://[2606:4700:4700::1111]/')).resolves.toContain(
      '2606:4700:4700::1111',
    );
  });

  it('拦截非 http(s) 协议', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toBeInstanceOf(
      WebFetchBlockedError,
    );
    await expect(assertPublicUrl('ftp://example.com/')).rejects.toBeInstanceOf(
      WebFetchBlockedError,
    );
  });

  it('非法 URL 抛错', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toBeInstanceOf(WebFetchBlockedError);
  });
});

describe('web_fetch handler', () => {
  afterEach(() => {
    vi.unstubAllGlobals(); // 还原被 stub 的全局 fetch
  });

  it('正常抓取:HTML 转 markdown,剔除 script,sources 带最终 URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            '<html><body><h1>Hello Title</h1><p>Body text.<script>evil()</script></p></body></html>',
            { status: 200, headers: { 'content-type': 'text/html' } },
          ),
      ),
    );
    const out = await createWebFetchTool().handler({ url: 'http://1.1.1.1/' });
    const txt = String(out.result);
    expect(txt).toContain('Hello Title');
    expect(txt).toContain('Body text.');
    expect(txt).not.toContain('evil'); // <script> 被 cheerio 删掉
    expect(out.sources?.[0]?.file).toBe('https://1.1.1.1/'); // http 升级成 https
  });

  it('内网地址:handler 直接返回「拒绝」(不调用 fetch)', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const out = await createWebFetchTool().handler({ url: 'http://169.254.169.254/' });
    expect(String(out.result)).toMatch(/^拒绝:/);
    expect(f).not.toHaveBeenCalled();
  });

  it('重定向即数据:3xx 不自动跟随,把新地址返回', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, {
            status: 301,
            headers: { location: 'https://example.org/moved' },
          }),
      ),
    );
    const out = await createWebFetchTool().handler({ url: 'http://1.1.1.1/' });
    expect(String(out.result)).toContain('https://example.org/moved');
    expect(String(out.result)).toMatch(/重定向/);
  });

  it('非 HTML content-type:拒绝', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('%PDF-1.4 ...', {
            status: 200,
            headers: { 'content-type': 'application/pdf' },
          }),
      ),
    );
    const out = await createWebFetchTool().handler({ url: 'http://1.1.1.1/' });
    expect(String(out.result)).toMatch(/^拒绝:.*HTML/);
  });

  it('截断:max_length 生效,尾部带「已截断」', async () => {
    const big = '<html><body>' + '<p>word</p>'.repeat(500) + '</body></html>';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(big, { status: 200, headers: { 'content-type': 'text/html' } }),
      ),
    );
    const out = await createWebFetchTool().handler({ url: 'http://1.1.1.1/', max_length: 50 });
    expect(String(out.result)).toContain('…(已截断)');
  });
});
