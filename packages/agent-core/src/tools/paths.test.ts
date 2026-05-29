// ============================================================================
// tools/paths.test.ts —— 路径安全 helper 的单测
// ----------------------------------------------------------------------------
// 不依赖磁盘上的真文件,纯字符串/逻辑测试。
//
// 为什么这一份这么重要?因为 resolveSafe 是 M3 所有 fs 工具的"第一道门",一旦写错,
// 整套安全护栏失效。这里的 6 个用例覆盖了 path traversal 攻击的常见姿势:
//   1) 合法相对路径 → 应通过
//   2) 合法 vendor 子路径 → 应通过
//   3) `../../` 穿越 → 应拒绝
//   4) 绝对路径在允许范围外 → 应拒绝
//   5) 类前缀攻击(vendor2 ≠ vendor) → 应拒绝(这是历史 CVE 模式,踩点测试)
//   6) 空路径 → 应拒绝
//
// 【vitest 知识点速记】
//   describe(...) :一组相关用例的容器(只是分组,无业务含义)
//   it(...)       :一个用例
//   expect(x).toBe(y)  :严格相等(===)
//   expect(fn).toThrow(类型):调用 fn 时应抛某类异常
// ============================================================================

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { resolveSafe, PathOutOfRangeError } from './paths';

describe('resolveSafe', () => {
  // path.resolve('/tmp/proj') —— 在 Unix 是 '/tmp/proj',在 Windows 会被解析成
  // 'C:\\tmp\\proj'(当前盘根下的相对路径)。我们只关心字符串前缀比较,实际路径
  // 不需要真实存在(这是纯逻辑测试)。
  const workspaceRoot = path.resolve('/tmp/proj');
  const vendor = path.resolve('/tmp/proj/vendor');
  const cfg = { workspaceRoot, allowedRoots: [workspaceRoot, vendor] };

  it('相对路径在 workspace 根下:通过', () => {
    // resolveSafe 应该把 'src/foo.ts' 解析到 workspaceRoot + 'src/foo.ts'
    expect(resolveSafe('src/foo.ts', cfg)).toBe(
      path.resolve(workspaceRoot, 'src/foo.ts'),
    );
  });

  it('相对路径落到 vendor 下:通过', () => {
    expect(resolveSafe('vendor/cmsis/foo.h', cfg)).toBe(
      path.resolve(workspaceRoot, 'vendor/cmsis/foo.h'),
    );
  });

  it('../ 穿越到 workspace 外:拒绝', () => {
    // 经典 path traversal:'../../etc/passwd' resolve 后落到 workspaceRoot 外。
    // expect(fn).toThrow(类型) 需要把"调用 fn"包成一个无参箭头函数。
    expect(() => resolveSafe('../../etc/passwd', cfg)).toThrow(PathOutOfRangeError);
  });

  it('绝对路径不在允许范围:拒绝', () => {
    // /etc/passwd(Unix)或 C:\\etc\\passwd(Windows path.resolve 的结果)都不在
    // /tmp/proj 或 /tmp/proj/vendor 下,应被拒。
    expect(() => resolveSafe('/etc/passwd', cfg)).toThrow(PathOutOfRangeError);
  });

  it('类前缀攻击 vendor2 不能假装是 vendor:拒绝', () => {
    // ★ 这条最重要 —— 验证 resolveSafe 里 `startsWith(absRoot + path.sep)` 必须带分隔符。
    // 如果开发者不小心写成 `startsWith(absRoot)`,/tmp/proj/vendor2 会误通过
    //(因为 'vendor2'.startsWith('vendor') === true)。
    const cfg2 = { workspaceRoot, allowedRoots: [vendor] };
    const sneakyAbsPath = path.resolve('/tmp/proj/vendor2/foo');
    expect(() => resolveSafe(sneakyAbsPath, cfg2)).toThrow(PathOutOfRangeError);
  });

  it('空路径:拒绝', () => {
    // 防御性检查:LLM 偶尔会传空串/null/undefined。
    expect(() => resolveSafe('', cfg)).toThrow(PathOutOfRangeError);
  });
});
