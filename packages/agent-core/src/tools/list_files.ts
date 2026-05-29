// ============================================================================
// tools/list_files.ts —— 工具②:列出某目录下的文件与子目录(不递归)
// ----------------------------------------------------------------------------
// 【这工具是干什么的】
// 让 LLM 在"读文件之前先探明目录里有什么"——文件是 PDF 还是 .c?有没有同名的 .h
// 配对?整个 vendor/ 下大概是个什么结构?
//
// 配合 read_file 形成"先 list_files、再 read_file"的工作流(M3 详细文档 §3 概念 4
// 的"工具描述纪律"和 §5 步骤 7.2 的 system prompt 都会强化这个模式)。
//
// 【为什么不递归】
// 不递归是有意为之:
//   1) 一次性 dump 整棵 node_modules / vendor/ 树会撑爆上下文,且大部分内容无关;
//   2) LLM 自己会判断"看到子目录,再调一次 list_files 看里面"——和真人逛文件夹一样;
//   3) M4 会加 glob / find 类工具(`find_files('**/*.c')`)做"跨多层定位"。
//
// 【输出格式】每行一条,目录在前、字母序:
//     [D] subdir/
//     [D] vendor/
//     [F] README.md   12.3 KB
//     [F] package.json   1.2 KB
//
//   [D] = 目录,后面带 `/`(LLM 一眼看出是目录,不会误调 read_file);
//   [F] = 文件,带大小(LLM 据此判断"要不要分段读")—— 这是与 M3 read_file
//          "大文件分段"配合的关键设计。
// ============================================================================

import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolSpec } from '../types';
import {
  resolveSafe,
  toDisplayPath,
  PathOutOfRangeError,
  type FsToolConfig,
} from './paths';

/** 单次返回的最大条目数,防止把整个 node_modules 倒出来。 */
const MAX_ENTRIES = 200;

// ============================================================================
// createListFilesTool —— 工厂函数,生产 list_files 工具
// ----------------------------------------------------------------------------
// 和 read_file 同样的"闭包接收 cfg"模式(见 read_file.ts 的注释)。
// ============================================================================
export function createListFilesTool(cfg: FsToolConfig): ToolSpec {
  return {
    name: 'list_files',

    description: `列出工作区或允许范围内某个目录的文件与子目录(不递归)。

用途:在读文件之前先探明目录里有什么、文件是不是 PDF、有没有同名的 .h/.c 配对等。
参数:
  - path(可选,默认 "."):要列出的目录路径(相对工作区根,或允许范围内的绝对路径)。
返回:每行一条,形如:
  - "[D] subdir/"   表示子目录
  - "[F] file.txt   1.2 KB"   表示文件 + 大小(KB / MB)
最多返回 ${MAX_ENTRIES} 条;超出会标注「…(已截断)」。

提示:看到大文件(> 50 KB / > 1500 行)时,read_file 时记得用 start_line + limit 分段读。`,

    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '目录路径,默认 "."(工作区根)',
        },
      },
      // 注意:这里没有 required —— path 是可选的(不传 = 列工作区根)
      additionalProperties: false,
    },

    handler: async (input) => {
      // input 可能是 undefined(模型干脆没传任何参数),用 `?? {}` 兜底成空对象,
      // 然后解构时 `path: p = '.'` 给一个默认值。两层兜底,任何输入都不会崩。
      const { path: p = '.' } = (input as { path?: string }) ?? {};

      // ① 路径安全
      let abs: string;
      try {
        abs = resolveSafe(p, cfg);
      } catch (e) {
        if (e instanceof PathOutOfRangeError) {
          return { result: `拒绝:${e.message}` };
        }
        throw e;
      }

      // ② 必须是目录
      const st = await stat(abs);
      if (!st.isDirectory()) {
        return { result: `拒绝:${p} 不是目录,请改用 read_file。` };
      }

      // ③ readdir 拿条目
      // `{ withFileTypes: true }` 让返回的是 Dirent[]( 带 isDirectory()/isFile() ),
      // 而不是单纯的字符串数组——一次拿到类型,**不用对每个名字再 stat 一次**判类型,效率高。
      // 但 Dirent 不带 size,文件大小还要单独 stat(见下)。
      const entries = await readdir(abs, { withFileTypes: true });

      // ④ 排序:目录在前(用户视觉上更清晰)、然后字母序
      // sort 的 comparator:返回负数=a 在前;正数=b 在前;0=相等。
      entries.sort((a, b) => {
        // 一个是目录、一个不是 → 目录在前
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        // 同类型 → 按名字字母序(localeCompare 对 Unicode/汉字也合理)
        return a.name.localeCompare(b.name);
      });

      // ⑤ 拼输出行
      const lines: string[] = [];
      let count = 0;
      for (const e of entries) {
        // 截断:超过 MAX_ENTRIES 就打个标记走人(防 node_modules 这种巨型目录)
        if (count >= MAX_ENTRIES) {
          lines.push(`…(已截断,共 ${entries.length} 条,只显示前 ${MAX_ENTRIES})`);
          break;
        }
        if (e.isDirectory()) {
          // 末尾加 `/` 是惯例,LLM 一眼就知道这是目录
          lines.push(`[D] ${e.name}/`);
        } else {
          // 文件单独 stat 拿 size(Dirent 不带);这一步是同步的(对每个文件一次系统调用),
          // 200 个文件总共也就几十毫秒,不优化。
          // path.join(abs, e.name):跨平台拼路径(Windows 自动用 \,Unix 用 /)。
          const size = (await stat(path.join(abs, e.name))).size;
          lines.push(`[F] ${e.name}   ${formatSize(size)}`);
        }
        count++;
      }

      // ⑥ 输出 + 来源
      // sources.file 末尾加 `/`,提示 LLM"这是个目录"(读 sources 也能看出来)
      return {
        result: lines.length > 0 ? lines.join('\n') : '(空目录)',
        sources: [{ file: toDisplayPath(abs, cfg.workspaceRoot) + '/' }],
      };
    },
  };
}

// ============================================================================
// formatSize —— 把字节数变成人类可读字符串
// ----------------------------------------------------------------------------
// 阈值用 1024(KiB 体系)而不是 1000(KB),贴近文件系统的实际计量。
// 显示一位小数:"12.3 KB" 比 "12 KB"/"12345 B" 都更友好。
// ============================================================================
function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
