// ============================================================================
// tools/propose_file_edit.test.ts —— 写文件工具的单测(离线;propose 用 stub)
// ----------------------------------------------------------------------------
// 真实的 propose(展示 diff + 落盘)在 extension 里、要 vscode,这里测不到。但 agent-core
// 这层的逻辑——路径安全、read-before-edit、模糊匹配算 newContent、把请求交给 propose、
// 按 propose 的返回值组织结果——全是纯逻辑,用一个「假 propose」就能完整覆盖。
//
// 关键断言:本工具【绝不自己写盘】。我们用临时文件验证:即便 propose 返回「已应用」,
// 磁盘上的文件也【没被本工具改动】(真正落盘是 extension 的 propose 实现干的,不在测试范围)。
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createProposeFileEditTool } from './propose_file_edit';
import type { ProposeFn, ProposeEditRequest } from '../types';

describe('propose_file_edit 工具', () => {
  let workspaceRoot!: string;

  beforeAll(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'embed-agent-edit-'));
    await writeFile(path.join(workspaceRoot, 'app.ts'), 'const a = 1;\nconst b = 2;\n', 'utf-8');
  });

  afterAll(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  // 一个「假 propose」:记录收到的请求,并按构造时给定的返回值(应用/放弃)兑现。
  function stubPropose(applied: boolean): { fn: ProposeFn; reqs: ProposeEditRequest[] } {
    const reqs: ProposeEditRequest[] = [];
    const fn: ProposeFn = async (req) => {
      reqs.push(req);
      return applied;
    };
    return { fn, reqs };
  }

  const cfg = () => ({ workspaceRoot, allowedRoots: [workspaceRoot] });

  it('正常修改:算出正确的 newContent 交给 propose,返回「已应用」+ sources.lines', async () => {
    const { fn, reqs } = stubPropose(true);
    const tool = createProposeFileEditTool(cfg(), fn, () => true /* 已读过 */);
    const out = await tool.handler({
      path: 'app.ts',
      edits: [{ old_string: 'a = 1', new_string: 'a = 42' }],
    });

    // propose 被调用一次,且 newContent 是改完后的完整内容
    expect(reqs).toHaveLength(1);
    expect(reqs[0].newContent).toBe('const a = 42;\nconst b = 2;\n');
    expect(reqs[0].isNewFile).toBe(false);
    // 结果文案 + sources
    expect(String(out.result)).toMatch(/已应用/);
    expect(out.sources?.[0]?.file).toBe('app.ts');
    expect(out.sources?.[0]?.lines).toBeDefined();
  });

  it('本工具不写盘:即便 propose 返回 applied,磁盘文件仍未被本工具改动', async () => {
    const { fn } = stubPropose(true);
    const tool = createProposeFileEditTool(cfg(), fn, () => true);
    await tool.handler({ path: 'app.ts', edits: [{ old_string: 'b = 2', new_string: 'b = 99' }] });
    // 落盘是 extension 的 propose 实现负责;stub 没写盘 → 文件应保持原样
    const onDisk = await readFile(path.join(workspaceRoot, 'app.ts'), 'utf-8');
    expect(onDisk).toBe('const a = 1;\nconst b = 2;\n');
  });

  it('read-before-edit:没读过该文件 → 拒绝,且不调用 propose', async () => {
    const { fn, reqs } = stubPropose(true);
    const tool = createProposeFileEditTool(cfg(), fn, () => false /* 没读过 */);
    const out = await tool.handler({
      path: 'app.ts',
      edits: [{ old_string: 'a = 1', new_string: 'a = 2' }],
    });
    expect(String(out.result)).toMatch(/^拒绝:.*先用 read_file/);
    expect(reqs).toHaveLength(0); // 没读过就不该走到 propose
  });

  it('用户放弃:propose 返回 false → 返回「未改动」', async () => {
    const { fn } = stubPropose(false);
    const tool = createProposeFileEditTool(cfg(), fn, () => true);
    const out = await tool.handler({
      path: 'app.ts',
      edits: [{ old_string: 'a = 1', new_string: 'a = 2' }],
    });
    expect(String(out.result)).toMatch(/放弃|未改动/);
  });

  it('找不到要改的内容:返回 fuzzyMatch 的报错(且不调 propose)', async () => {
    const { fn, reqs } = stubPropose(true);
    const tool = createProposeFileEditTool(cfg(), fn, () => true);
    const out = await tool.handler({
      path: 'app.ts',
      edits: [{ old_string: '不存在的内容', new_string: 'x' }],
    });
    expect(String(out.result)).toMatch(/找不到/);
    expect(reqs).toHaveLength(0);
  });

  it('文件不存在:拒绝', async () => {
    const { fn } = stubPropose(true);
    const tool = createProposeFileEditTool(cfg(), fn, () => true);
    const out = await tool.handler({
      path: 'nope.ts',
      edits: [{ old_string: 'x', new_string: 'y' }],
    });
    expect(String(out.result)).toMatch(/^拒绝:文件不存在/);
  });

  it('写入红线目录(.git / node_modules 等):拒绝,且不调 propose', async () => {
    const { fn, reqs } = stubPropose(true);
    const tool = createProposeFileEditTool(cfg(), fn, () => true);
    for (const p of ['.git/config', 'node_modules/lib/x.js', 'build/out.js']) {
      const out = await tool.handler({ path: p, edits: [{ old_string: 'a', new_string: 'b' }] });
      expect(String(out.result), p).toMatch(/^拒绝:.*禁止写入/);
    }
    expect(reqs).toHaveLength(0); // 红线路径根本不该走到 propose
  });

  it('越界路径:拒绝', async () => {
    const { fn } = stubPropose(true);
    const tool = createProposeFileEditTool(cfg(), fn, () => true);
    const out = await tool.handler({
      path: '../../../etc/passwd',
      edits: [{ old_string: 'root', new_string: 'x' }],
    });
    expect(String(out.result)).toMatch(/^拒绝:/);
  });
});
