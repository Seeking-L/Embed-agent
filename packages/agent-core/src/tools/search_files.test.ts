// ============================================================================
// tools/search_files.test.ts —— grep 工具的单测(离线、不依赖系统装没装 rg)
// ----------------------------------------------------------------------------
// 设计取舍:`createSearchFilesTool` 的 handler 要 spawn 真实 ripgrep,而 CI(Win/mac/Linux
// 三平台)不保证 PATH 上有 rg。所以这里**不测 spawn**,而是把两个纯函数拎出来测:
//   - parseRipgrepJson:喂「rg --json 的原始行」,断言能正确解析出命中 + 上下文配对;
//   - formatResults  :喂 SearchResult[],断言 │ 分组格式、头部、sources、字节封顶。
// 这两块是 grep 的「逻辑核心」,纯函数、确定性强,任何平台都能跑。
// spawn/readline 那层很薄,留给 F5 手动联调验证。
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  parseRipgrepJson,
  formatResults,
  type SearchResult,
  type GrepToolConfig,
} from './search_files';

// 造一份「rg --json」的原始输出行(就是 rg 真会吐的那种,每行一个 JSON 事件)。
function rgLine(obj: unknown): string {
  return JSON.stringify(obj);
}

const cfg: GrepToolConfig = {
  workspaceRoot: '/ws',
  allowedRoots: ['/ws'],
  ripgrepPath: 'rg', // 这两个测试不真的 spawn,所以路径随意
};

describe('parseRipgrepJson 解析 rg --json', () => {
  it('match + 前后 context 正确配对', () => {
    const lines = [
      rgLine({ type: 'begin', data: { path: { text: '/ws/src/app.ts' } } }),
      rgLine({
        type: 'context',
        data: {
          path: { text: '/ws/src/app.ts' },
          lines: { text: 'function f() {\n' },
          line_number: 41,
        },
      }),
      rgLine({
        type: 'match',
        data: {
          path: { text: '/ws/src/app.ts' },
          lines: { text: '  // TODO: x\n' },
          line_number: 42,
          submatches: [{ match: { text: 'TODO' }, start: 5, end: 9 }],
        },
      }),
      rgLine({
        type: 'context',
        data: {
          path: { text: '/ws/src/app.ts' },
          lines: { text: '  return 1;\n' },
          line_number: 43,
        },
      }),
      rgLine({ type: 'end', data: { path: { text: '/ws/src/app.ts' } } }),
    ];
    const results = parseRipgrepJson(lines);
    expect(results).toHaveLength(1);
    expect(results[0].line).toBe(42);
    expect(results[0].match).toContain('TODO');
    // 行号 41 < 42 → 归入前文;43 > 42 → 归入后文
    expect(results[0].beforeContext[0]).toContain('function f');
    expect(results[0].afterContext[0]).toContain('return 1');
  });

  it('坏行(非 JSON)被跳过,不影响其它结果', () => {
    const lines = [
      'this is not json',
      rgLine({
        type: 'match',
        data: { path: { text: '/ws/a.txt' }, lines: { text: 'hit\n' }, line_number: 1 },
      }),
    ];
    const results = parseRipgrepJson(lines);
    expect(results).toHaveLength(1);
  });

  it('非 UTF-8 行(lines.text 缺失)兜成空串,不崩', () => {
    const lines = [
      rgLine({ type: 'match', data: { path: { text: '/ws/bin' }, lines: {}, line_number: 1 } }),
    ];
    const results = parseRipgrepJson(lines);
    expect(results[0].match).toBe('');
  });
});

describe('formatResults │ 分组输出', () => {
  const mk = (filePath: string, line: number, text: string): SearchResult => ({
    filePath,
    line,
    match: text + '\n',
    beforeContext: [],
    afterContext: [],
  });

  it('头部 + 文件分组 + │ 前缀 + sources(一文件一条)', () => {
    const results = [
      mk('/ws/src/a.ts', 10, 'const a = 1;'),
      mk('/ws/src/a.ts', 20, 'const b = 2;'),
    ];
    const out = formatResults(results, cfg, '/ws');
    const txt = String(out.result);
    expect(txt).toContain('Found 2 results.');
    expect(txt).toContain('src/a.ts'); // posix 相对路径
    expect(txt).toContain('│const a = 1;');
    expect(txt).toContain('│----');
    // sources:同一文件去重成一条,lines 取首个命中行
    expect(out.sources).toHaveLength(1);
    expect(out.sources?.[0]).toEqual({ file: 'src/a.ts', lines: '10' });
  });

  it('单条结果:头部用 "Found 1 result."', () => {
    const out = formatResults([mk('/ws/x.ts', 1, 'x')], cfg, '/ws');
    expect(String(out.result)).toContain('Found 1 result.');
  });

  it('超过 300 条:头部提示「只显示前 300」', () => {
    const many = Array.from({ length: 350 }, (_, i) => mk(`/ws/f${i}.ts`, 1, `m${i}`));
    const out = formatResults(many, cfg, '/ws');
    expect(String(out.result)).toContain('Showing first 300 of 300+ results');
  });
});
