// ============================================================================
// tools/read_file.test.ts —— read_file 工具的单测
// ----------------------------------------------------------------------------
// 这一份会"真"写一些文件到操作系统临时目录(`mkdtemp` 创建,`afterAll` 清掉),
// 然后让 read_file 去读它们,断言行为。不联网、不依赖任何固定路径,可跨平台跑。
//
// 覆盖的几条关键路径:
//   1) ✅ 正常读取小文件 —— 内容能读到、sources 标对路径
//   2) ✅ 越界路径 —— 返回"拒绝:"开头(不抛异常,保证 loop 不会崩)
//   3) ✅ start_line + limit 分段读 —— 行号正确 + 截断尾带"start_line=N+1 续读"提示
//   4) ✅ 二进制文件 —— 头部含 NUL 直接拒读(避免乱码塞进 LLM 上下文)
//   5) ✅ start_line 超过文件总行数 —— 拒绝(给 LLM 明确反馈)
//
// 【vitest 知识点】
//   beforeAll :describe 内所有用例运行前,跑一次(异步用 async + await)
//   afterAll  :全跑完后清理(关键:别给 CI 临时目录留垃圾)
//   expect(s).toMatch(/正则/)  :字符串匹配正则
//   expect(arr).toContain(x)   :数组/字符串包含 x
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createReadFileTool } from './read_file';

describe('read_file 工具', () => {
  // 临时工作目录,所有用例共享。`!` 是 TS 的"非空断言":告诉编译器"我保证 beforeAll
  // 跑完之前这变量不会被读"。这里 beforeAll 一定先于 it 执行,所以安全。
  let workspaceRoot!: string;

  beforeAll(async () => {
    // mkdtemp 在系统 tmp 下造一个唯一目录(后缀随机),返回它的绝对路径。
    // 比 'os.tmpdir() + fixedName' 安全得多——避免多个并行测试相互踩。
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'embed-agent-m3-'));
    // 写一个 hello.txt 给"基础读取"用例
    await writeFile(path.join(workspaceRoot, 'hello.txt'), 'hello world\n', 'utf-8');
  });

  afterAll(async () => {
    // 测试结束后递归删除整个临时目录。force: true 让"删不存在的目录"不抛错。
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('能读到合法文件,且 sources 带相对路径', async () => {
    const tool = createReadFileTool({ workspaceRoot, allowedRoots: [workspaceRoot] });
    const out = await tool.handler({ path: 'hello.txt' });
    // 内容里应该包含原文(可能被 cat -n 前缀包装,但 'hello world' 子串一定在)
    expect(String(out.result)).toContain('hello world');
    // sources[0].file 是相对路径
    expect(out.sources?.[0]?.file).toBe('hello.txt');
  });

  it('越界路径:返回"拒绝:"开头的结果(不抛异常)', async () => {
    const tool = createReadFileTool({ workspaceRoot, allowedRoots: [workspaceRoot] });
    // '../../../etc/passwd' 在 resolve 后会落到 workspaceRoot 外
    const out = await tool.handler({ path: '../../../etc/passwd' });
    expect(String(out.result)).toMatch(/^拒绝:/);
  });

  it('start_line + limit 分段读:行号正确,尾部带 start_line=N+1 续读提示', async () => {
    const tool = createReadFileTool({ workspaceRoot, allowedRoots: [workspaceRoot] });
    // 写一个 10 行的文件:line1 ~ line10
    // Array.from({length:10}, (_, i) => `line${i+1}`) → ['line1', ..., 'line10']
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    await writeFile(path.join(workspaceRoot, 'lines.txt'), lines, 'utf-8');

    // 从第 4 行起读 3 行 → 应该展示 line4 / line5 / line6
    const out = await tool.handler({ path: 'lines.txt', start_line: 4, limit: 3 });
    const txt = String(out.result);

    // 元数据头部:展示 4-6 行
    expect(txt).toContain('展示 4-6 行');
    // 包含 line4 ~ line6,不包含 line7(被切走了)
    expect(txt).toContain('line4');
    expect(txt).toContain('line6');
    expect(txt).not.toContain('line7');
    // 截断尾部带 start_line=7 续读提示(下一段从 7 开始)
    expect(txt).toContain('start_line=7');
    // sources.lines 标对了范围
    expect(out.sources?.[0]?.lines).toBe('4-6');
  });

  it('二进制文件:头部含 NUL 字节直接拒读', async () => {
    const tool = createReadFileTool({ workspaceRoot, allowedRoots: [workspaceRoot] });
    // 写 5 字节:H \0 i ! \n —— 第 2 字节是 NUL,二进制嗅探应识别出来
    // Buffer.from([..]) 用整数数组造一个 Buffer。
    await writeFile(
      path.join(workspaceRoot, 'bin.dat'),
      Buffer.from([0x48, 0x00, 0x69, 0x21, 0x0a]),
    );
    const out = await tool.handler({ path: 'bin.dat' });
    // 拒绝消息以"拒绝:"开头,且提及"二进制"
    expect(String(out.result)).toMatch(/^拒绝:.*二进制/);
  });

  it('start_line 超过文件总行数:拒绝', async () => {
    const tool = createReadFileTool({ workspaceRoot, allowedRoots: [workspaceRoot] });
    // hello.txt 只有 1 行,start_line=999 远超
    const out = await tool.handler({ path: 'hello.txt', start_line: 999 });
    expect(String(out.result)).toMatch(/^拒绝:.*超过文件总行数/);
  });
});
