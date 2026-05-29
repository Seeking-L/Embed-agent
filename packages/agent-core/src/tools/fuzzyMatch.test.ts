// ============================================================================
// tools/fuzzyMatch.test.ts —— 模糊匹配 + 应用引擎的单测(纯函数,完全离线)
// ----------------------------------------------------------------------------
// 这一份不碰文件系统、不联网——fuzzyMatch 是纯函数,给输入断输出即可,跑得飞快。
// 覆盖 4 级匹配阶梯 + 唯一性 + replace_all + 各种边界(空 old_string、换行修正、多条顺序编辑)。
// ============================================================================

import { describe, it, expect } from 'vitest';
import { applyEdits, findMatch } from './fuzzyMatch';

describe('findMatch 4 级模糊匹配阶梯', () => {
  it('T1 精确匹配:能找到,且区间正好是 old_string 长度(不多含换行)', () => {
    const content = 'const x = 1;\nconst y = 2;\n';
    const m = findMatch(content, 'const y = 2;');
    expect(m).toHaveLength(1);
    expect(m[0].tier).toBe(1);
    // 精确级:end - start === old_string.length
    expect(m[0].end - m[0].start).toBe('const y = 2;'.length);
  });

  it('T2 逐行去空白:整行尾部空白差异 → 精确不中、逐行 trim 命中(tier 2)', () => {
    // 文件第 1 行结尾有多余空格,old_string 没有 → "x = 1;\ny = 2;" 不是连续子串
    //(";" 和 "\n" 之间隔着空格),精确匹配落空;逐行 trim 后两行都相等 → tier 2。
    // (注:若 old_string 是某行的连续子串,会被 tier 1 直接命中,所以这里用整行 + 尾部空白来逼出 tier 2。)
    const content = 'x = 1;   \ny = 2;\n';
    const m = findMatch(content, 'x = 1;\ny = 2;');
    expect(m).toHaveLength(1);
    expect(m[0].tier).toBe(2);
  });

  it('T3 块锚点:≥3 行,首尾行对上、中间漂移也能命中(tier 3)', () => {
    const content = ['if (cond) {', '  doSomethingDifferent();', '}'].join('\n');
    // old 的中间行和文件不同,但首行 "if (cond) {"、末行 "}"、行数都对上 → tier 3
    const search = ['if (cond) {', '  doOriginalThing();', '}'].join('\n');
    const m = findMatch(content, search);
    expect(m).toHaveLength(1);
    expect(m[0].tier).toBe(3);
  });

  it('T4 Unicode 归一化:花引号/破折号也能对上 ASCII(tier 4)', () => {
    // 文件里是 ASCII 直引号,old_string 用了花引号 → 前三级不中,归一化后命中
    const content = "const s = 'hello';\n";
    const search = 'const s = ‘hello’;'; // ‘ ’ = 花单引号
    const m = findMatch(content, search);
    expect(m).toHaveLength(1);
    expect(m[0].tier).toBe(4);
  });

  it('多处命中:精确级返回全部、互不重叠', () => {
    const content = 'a;\na;\na;\n';
    const m = findMatch(content, 'a;');
    expect(m.length).toBe(3);
  });

  it('找不到:返回空数组', () => {
    expect(findMatch('hello\n', 'nope')).toEqual([]);
  });
});

describe('applyEdits 应用编辑', () => {
  it('单条精确替换', () => {
    const r = applyEdits('let a = 1;\n', [{ old_string: 'a = 1', new_string: 'a = 2' }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.newContent).toBe('let a = 2;\n');
      expect(r.appliedCount).toBe(1);
    }
  });

  it('不唯一且未设 replace_all:报错(不乱改)', () => {
    const r = applyEdits('x\nx\n', [{ old_string: 'x', new_string: 'y' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/不唯一/);
  });

  it('replace_all:替换全部', () => {
    const r = applyEdits('x\nx\nx\n', [{ old_string: 'x', new_string: 'y', replace_all: true }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newContent).toBe('y\ny\ny\n');
  });

  it('找不到:报错,且提示别带行号前缀', () => {
    const r = applyEdits('hello\n', [{ old_string: 'world', new_string: 'x' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/找不到/);
      expect(r.error).toMatch(/行号前缀/);
    }
  });

  it('多条顺序编辑:第 2 条作用在第 1 条结果上', () => {
    const r = applyEdits('foo\n', [
      { old_string: 'foo', new_string: 'bar' },
      { old_string: 'bar', new_string: 'baz' }, // 命中第 1 条插入的 bar
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.newContent).toBe('baz\n');
      expect(r.appliedCount).toBe(2);
    }
  });

  it('空 old_string + 空文件:视为写入全文', () => {
    const r = applyEdits('', [{ old_string: '', new_string: 'brand new content' }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newContent).toBe('brand new content');
  });

  it('空 old_string + 非空文件:报错(插入点不明)', () => {
    const r = applyEdits('existing\n', [{ old_string: '', new_string: 'x' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/为空/);
  });

  it('换行修正:按行命中(tier 2)、new_string 无尾换行时不黏连下一行', () => {
    // 第 1 行尾部有空格 → "x = 1;\ny = 2;" 不是连续子串 → 走 tier 2,命中区间含末尾 \n;
    // new_string 不带尾换行。修正逻辑应补回 \n,保证 "z = 3;" 仍独占一行
    //(不被黏成 "B = 2;z = 3;")。
    const content = 'x = 1;   \ny = 2;\nz = 3;\n';
    const r = applyEdits(content, [{ old_string: 'x = 1;\ny = 2;', new_string: 'A = 1;\nB = 2;' }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.newContent).toBe('A = 1;\nB = 2;\nz = 3;\n');
    }
  });

  it('整行删除(new_string 空)+ 按行命中(tier 2):不留空行', () => {
    // 回归用例:之前换行修正会无脑补 \n,导致删除的行变成一个空行。
    // 第 2/3 行有缩进 → old_string 走 tier 2;new_string 为空 = 删除这两行。
    const content = 'keepA\n  foo\n  bar\nkeepB\n';
    const r = applyEdits(content, [{ old_string: 'foo\nbar', new_string: '' }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 应干净删除,不留 'keepA\n\nkeepB\n' 那样的空行
      expect(r.newContent).toBe('keepA\nkeepB\n');
    }
  });

  it('编辑列表为空:报错', () => {
    const r = applyEdits('x', []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/为空/);
  });
});
