// ============================================================================
// tools/read_file.ts —— 工具①:按需读取文件文本(带行号、支持分段)
// ----------------------------------------------------------------------------
// 【这工具是干什么的】
// 让 LLM 能"看见"用户工程下的文本文件——源码、配置、markdown、yaml……
// 它**不**读 PDF(交给 read_pdf)、**不**读二进制(.elf/.bin)、**不**列目录
// (交给 list_files)。任务单一,边界清晰,LLM 看 description 就知道何时调用。
//
// 【核心设计:三层闸门 + cat -n 行号 + "下一步"截断尾】
// 详见 M3 详细文档 §3 概念 5。简版:
//   L1 文件大小 stat.size > 20 MB    → 直接拒读(基本上是误读日志/二进制)
//   二进制嗅探  peek 头 512 字节有 NUL → 拒读(避开 .elf/.bin)
//   L2 行窗口   切出 > limit(默认 1500)行 → 按行截,末尾标 start_line=N+1
//   L3 字节兜底 输出 > 400 KB        → 按字节截(防一行 30 万字符撑爆)
//
// 输出格式:
//   [文件 vendor/.../boards.txt 共 9821 行,展示 1-1500 行]
//
//        1\t# Generic STM32F103C8 (Blue Pill)
//        2\t# ...
//        ...
//     1500\tGenF1.menu.upload_method...
//
//   …(已截断;还剩 8321 行。下一段请用 start_line=1501 续读,或改用 grep 类工具定位)
//
// 调用方(loop.ts::stringifyResult)会自动追加来源:`vendor/.../boards.txt:1-1500`。
//
// 【TS / Node 知识点速记】
//   `import { readFile, stat, open } from 'node:fs/promises'`
//     Promise 版的 fs API,所有方法返回 Promise,用 await 就行(比老式 callback 好用很多)。
//
//   `Buffer`(Node 内置):一段二进制字节数组。`Buffer.byteLength(s, 'utf-8')` 算 UTF-8
//     字节数(中文一个字 3 字节,跟 `s.length`(UTF-16 码元数)不一样)。
//
//   `?? ` 是「空值合并」:`a ?? b` 在 a 是 null/undefined 时返回 b,空字符串/0/false 不触发
//     —— 比 `||` 更精确。
//
//   `Math.max(1, Math.floor(x ?? 1))`:把可能不存在/可能是小数的值"夹"成"≥1 的整数"。
// ============================================================================

import { readFile, stat, open } from 'node:fs/promises';
import type { ToolSpec } from '../types';
import {
  resolveSafe,
  toDisplayPath,
  PathOutOfRangeError,
  type FsToolConfig,
} from './paths';

// ============================================================================
// 几个常量 —— 全是"经验值",每一个的取舍详见 M3 详细文档 §3 概念 5。
// ----------------------------------------------------------------------------
// 改它们之前请确认:① system prompt 里的"分段读"门槛(50 KB / 1500 行)和这里一致;
//                  ② loop.ts::MAX_TOOL_RESULT_CHARS 必须 ≥ 本工具的最大输出(400 KB)。
// ============================================================================

/** L1:文件大小硬上限,超了直接拒读(单位:字节)。 */
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

/** L3:输出字节兜底,超了按字节切(防止一行特别长的文件撑爆)。 */
const MAX_BYTES = 400 * 1024; // 400 KB

/** L2:默认行窗口大小(`limit` 没传时用这个值)。 */
const MAX_LINES_DEFAULT = 1500;

/** L2:`limit` 参数的硬上限,防 LLM 瞎传 9999999。 */
const MAX_LINES_HARD = 5000;

/** 二进制嗅探:peek 头 N 字节,内含 NUL 即判二进制。 */
const BINARY_PEEK_BYTES = 512;

// ============================================================================
// createReadFileTool —— 工厂函数,接受 FsToolConfig,返回一个 ToolSpec
// ----------------------------------------------------------------------------
// 为什么是"工厂"而不是"常量"?见 M3 文档 §3 概念 2:
//   - get_current_time 不需要外部配置(直接 export const)。
//   - read_file 必须带"允许读哪些目录"的配置,而这个配置只有 extension(碰得到
//     vscode.workspace)能给。所以暴露一个工厂,let extension 在 register 时
//     `createReadFileTool({ workspaceRoot, allowedRoots })`。
//
// `handler` 是"闭包":它捕获了外层 cfg,后续每次调用都能用到那份配置——
// 这是 JS 闭包最经典、最实用的用法。
// ============================================================================
export function createReadFileTool(cfg: FsToolConfig): ToolSpec {
  return {
    name: 'read_file',

    // description 是 LLM 看到的"说明书"。务必把"何时调用 / 参数语义 / 返回什么 /
    // 不要怎么用"都写清楚,否则 LLM 要么不用、要么乱用(见 M3 概念 4)。
    description: `读取工作区或允许范围内文件的纯文本内容,带行号、支持分段。

用途:查看源码、配置、文档(.md / .yaml / .json / .c / .h / .ts 等)。
参数:
  - path(必填):相对工作区根的路径(如 "vendor/arduino-core-stm32/boards.txt"),
                也可以是绝对路径,但必须落在允许的根目录内。
  - start_line(可选,默认 1):从第几行开始读,1-based。
  - limit(可选,默认 ${MAX_LINES_DEFAULT},硬上限 ${MAX_LINES_HARD}):最多读多少行。

返回格式:
  - 头部一行元数据:[文件 <相对路径> 共 N 行,展示 a-b 行]
  - 之后是 cat -n 风格的内容:每行以"行号 + tab"开头(行号是元数据,**不属于文件本体**)。
  - 行数超过 limit 或字节超过 ${Math.floor(MAX_BYTES / 1024)} KB 时,末尾会标注
    「…(已截断,下一段请用 start_line=N 续读)」。

注意:
  - 大文件(> 50 KB)请优先用 start_line + limit 分段读,不要整读。
  - 本工具不读 PDF / 二进制文件(.elf / .bin / .hex);请改用 read_pdf 或先 list_files 查看扩展名。
  - 单文件超过 ${MAX_FILE_SIZE / 1024 / 1024} MB 会被直接拒读。`,

    // inputSchema 是 JSON Schema:LLM 据此知道该传什么参数。
    // additionalProperties: false 是关键 —— 卡死"只能传这几个键",防 LLM 加多余字段。
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径(相对工作区根,或允许范围内的绝对路径)',
        },
        start_line: {
          type: 'number',
          description: '起始行号(1-based,默认 1)',
        },
        limit: {
          type: 'number',
          description: `最多读多少行(默认 ${MAX_LINES_DEFAULT},上限 ${MAX_LINES_HARD})`,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },

    // handler:真正干活的函数。input 类型是 unknown(来自 LLM 的 JSON,事先无法知道
    // 具体形状),用 `as { ... }` 收窄成期望的形状再用。这是 ToolSpec 接口的契约。
    handler: async (input) => {
      const { path: p, start_line, limit } = input as {
        path: string;
        start_line?: number;
        limit?: number;
      };

      // ────────────────────────────────────────────────────────────────────
      // ① 路径安全(所有 fs 工具的统一入口)
      // ────────────────────────────────────────────────────────────────────
      // resolveSafe 会:解析成绝对路径 → 处理 ../ → 必须落在 allowedRoots 下。
      // 越界时抛 PathOutOfRangeError,我们捕获并转成"拒绝:..."文本结果——
      // 这样 LLM 拿到的是"工具说不行",而不是"工具崩了",可以继续向用户解释。
      let abs: string;
      try {
        abs = resolveSafe(p, cfg);
      } catch (e) {
        if (e instanceof PathOutOfRangeError) {
          return { result: `拒绝:${e.message}` };
        }
        // 真意外:让它继续往上抛(loop.ts 会兜成「工具执行失败」)
        throw e;
      }

      // ────────────────────────────────────────────────────────────────────
      // ② 类型检查 + L1 文件大小硬闸门
      // ────────────────────────────────────────────────────────────────────
      // stat 拿元信息(大小、类型、mtime…)。我们只用到 isDirectory + size。
      // 注意:如果文件不存在,stat 会抛 ENOENT,loop 兜底为"工具执行失败"——
      // 这是好事:LLM 据此知道该先 list_files 看看。
      const st = await stat(abs);
      if (st.isDirectory()) {
        return { result: `拒绝:${p} 是目录,请改用 list_files。` };
      }
      if (st.size > MAX_FILE_SIZE) {
        return {
          result:
            `拒绝:${p} 大小 ${(st.size / 1024 / 1024).toFixed(1)} MB,` +
            `超过单文件 ${MAX_FILE_SIZE / 1024 / 1024} MB 限制。\n` +
            `建议:用 list_files 探明、grep 类工具(M4 起)精确定位,或自行拆分文件后再读。`,
        };
      }

      // ────────────────────────────────────────────────────────────────────
      // ③ 二进制嗅探:peek 头 512 字节,扫到 NUL(0x00)即判二进制
      // ────────────────────────────────────────────────────────────────────
      // 简单粗暴但够用:`.elf`/`.bin`/`.o`/`.png` 等几乎都在头几十字节内就有 NUL。
      // 漏网之鱼:Intel HEX(`.hex`,全 ASCII)、`.map` 等编译产物—— prompt 教 LLM 别读。
      //
      // 必须用 try/finally 关 fh,否则一旦 read 抛错就泄漏 fd(文件句柄不会自动释放)。
      const fh = await open(abs, 'r');
      try {
        // Buffer.alloc(N) 分配 N 字节、内容全 0 的 Buffer。
        const peek = Buffer.alloc(BINARY_PEEK_BYTES);
        // fh.read(buffer, offset, length, position):从 position 读 length 字节进 buffer。
        //   - position=0 表示从文件开头读;
        //   - bytesRead 是真实读到的字节数(可能 < length,文件比 512 字节还小时)。
        const { bytesRead } = await fh.read(peek, 0, BINARY_PEEK_BYTES, 0);
        // subarray(0, bytesRead) 取真实读到的那段(剩下还是 alloc 时的 0,会误判)。
        // .includes(0) 检查是否含 NUL 字节。
        if (peek.subarray(0, bytesRead).includes(0)) {
          return {
            result:
              `拒绝:${p} 看起来是二进制文件(头 ${bytesRead} 字节含 NUL)。\n` +
              `PDF 请用 read_pdf;其它二进制本工具不支持。`,
          };
        }
      } finally {
        // 无论 try 里发生什么(正常完成 / 抛错 / 提前 return)都必须关。
        await fh.close();
      }

      // ────────────────────────────────────────────────────────────────────
      // ④ 参数归一化:start_line ≥ 1、limit 夹在 [1, MAX_LINES_HARD]
      // ────────────────────────────────────────────────────────────────────
      // LLM 可能传:undefined / 0 / -5 / 1.7 / 999999。这里统一夹成合法值。
      //   - `?? 1`:undefined 时用 1;
      //   - `Math.floor(...)`:浮点变整数;
      //   - `Math.max(1, ...)`:确保 ≥ 1;
      //   - `Math.min(HARD, ...)`:确保不超硬上限。
      const startLine = Math.max(1, Math.floor(start_line ?? 1));
      const lineLimit = Math.min(
        MAX_LINES_HARD,
        Math.max(1, Math.floor(limit ?? MAX_LINES_DEFAULT)),
      );

      // ────────────────────────────────────────────────────────────────────
      // ⑤ 读全文(L1 已限 ≤ 20 MB,内存可控)
      // ────────────────────────────────────────────────────────────────────
      // 为什么不流式读?因为我们要按行切片,流式读还得自己缓冲分行,代码复杂得多;
      // 而 20 MB 的文件一次 readFile 在现代机器上没问题(几十毫秒)。
      const full = await readFile(abs, 'utf-8');

      // split('\n') 按换行切:'a\nb\nc' → ['a', 'b', 'c'](3 段)
      //                       'a\nb\nc\n' → ['a', 'b', 'c', ''](4 段,末尾多个空串)
      // POSIX 文件大多以 \n 结尾,会多出末尾的空串——pop 掉,行数才和 `cat -n` 一致。
      const allLines = full.split('\n');
      if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
        allLines.pop();
      }
      const totalLines = allLines.length;

      // 显示用路径(`vendor/foo.c`,不是 `D:\\proj\\vendor\\foo.c`)
      const displayPath = toDisplayPath(abs, cfg.workspaceRoot);

      // ────────────────────────────────────────────────────────────────────
      // ⑥ 空文件特例
      // ────────────────────────────────────────────────────────────────────
      // 如果不特殊处理,下面的 startIdx(0) >= totalLines(0) 会触发"start_line 越界"
      // 的拒绝消息,但其实不是用户错——是文件真的空。给一个友好提示。
      if (totalLines === 0) {
        return {
          result: `[文件 ${displayPath} 是空文件]`,
          sources: [{ file: displayPath }],
        };
      }

      // ────────────────────────────────────────────────────────────────────
      // ⑦ L2 行窗口切片
      // ────────────────────────────────────────────────────────────────────
      // startLine 是 1-based(给 LLM 看的),startIdx 是 0-based(用来索引数组)。
      const startIdx = startLine - 1;
      if (startIdx >= totalLines) {
        return {
          result: `拒绝:start_line=${startLine} 超过文件总行数 ${totalLines}。`,
        };
      }
      // Math.min:防止 startIdx + lineLimit 超过文件末尾。
      const endIdxExclusive = Math.min(totalLines, startIdx + lineLimit);
      // slice(start, end):取 [start, end) 区间。
      const lineSlice = allLines.slice(startIdx, endIdxExclusive);
      // 实际展示的最后一行的"行号"(1-based)
      const lastLineNum = startIdx + lineSlice.length;
      // 是否在 L2 触发了截断
      const lineTruncated = endIdxExclusive < totalLines;

      // ────────────────────────────────────────────────────────────────────
      // ⑧ 格式化为 cat -n 风格:`     1\thello world`
      // ────────────────────────────────────────────────────────────────────
      // padStart(6):把字符串左侧补空格到 6 字符宽。
      //   "1".padStart(6) → "     1"(5 空格 + 1)
      //   "999999".padStart(6) → "999999"
      // 6 宽足够覆盖 100 万行内的所有文件,对齐美观。
      // 行号后用 \t(tab),让"行号到哪里结束"对 LLM 无歧义。
      let body = lineSlice
        .map((line, i) => `${String(startIdx + i + 1).padStart(6)}\t${line}`)
        .join('\n');

      // ────────────────────────────────────────────────────────────────────
      // ⑨ L3 字节闸门(防一行特别长的 minified JS / SVG 撑爆)
      // ────────────────────────────────────────────────────────────────────
      // 注意:Buffer.byteLength(s, 'utf-8') 算 UTF-8 字节数;
      //       s.slice(0, N) 是按 UTF-16 码元切——对纯 ASCII 一致,中文会有些误差,
      //       但 LLM 容错性很强,不追求完美 UTF-8 边界。
      let byteTruncated = false;
      if (Buffer.byteLength(body, 'utf-8') > MAX_BYTES) {
        body = body.slice(0, MAX_BYTES);
        byteTruncated = true;
      }

      // ────────────────────────────────────────────────────────────────────
      // ⑩ 组装输出:元数据头 + 内容 + "下一步"截断尾
      // ────────────────────────────────────────────────────────────────────
      // 头部一行让 LLM 第一时间知道"文件多大、自己看的是哪段"。
      // 尾部"下一步"是关键:Cline / Claude Code 都验证过,有这条提示 LLM 会主动续读;
      // 没这条提示 LLM 容易"放弃"或"瞎补"。
      const header =
        `[文件 ${displayPath} 共 ${totalLines} 行,` +
        `展示 ${startLine}-${lastLineNum} 行]\n\n`;

      let footer = '';
      if (lineTruncated) {
        const remaining = totalLines - lastLineNum;
        footer =
          `\n\n…(已截断;还剩 ${remaining} 行。` +
          `下一段请用 start_line=${lastLineNum + 1} 续读,或改用 grep 类工具精确定位)`;
      } else if (byteTruncated) {
        footer =
          `\n\n…(已截断:输出超过 ${Math.floor(MAX_BYTES / 1024)} KB,` +
          `请缩小 limit 或用 grep 类工具定位)`;
      }

      // 返回 ToolResult:
      //   result —— 拼成的整段文本(LLM 看到的就是这个);
      //   sources —— 来源引用,loop.ts::stringifyResult 会自动追加成"来源:\n- file:lines"
      //              到 result 末尾(M2 步骤 8 实现的"输出契约")。
      //              这里 lines 写成 "1-1500",最终用户看到 `vendor/foo.txt:1-1500`。
      return {
        result: header + body + footer,
        sources: [{ file: displayPath, lines: `${startLine}-${lastLineNum}` }],
      };
    },
  };
}
