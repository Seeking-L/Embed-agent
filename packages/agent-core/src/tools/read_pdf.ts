// ============================================================================
// tools/read_pdf.ts —— 工具③:读取 PDF 文件的纯文本(抽取版面)
// ----------------------------------------------------------------------------
// 【为什么单独一个工具,而不是把 PDF 解析塞进 read_file】
// 详见 M3 详细文档 §3 概念 6。简版:
//   1) 心智契约不同:read_file 承诺"读什么得什么";read_pdf 内部做了大量启发式
//      抽取(段落顺序、表格、图注),结果**可能与 PDF 原版面不完全一致**——把这两
//      件事分开,LLM 看到 read_pdf 就知道"这是抽取过的、可能有损"。
//   2) pdf-parse 体积不小(~1 MB),独立成工具便于将来做"按需注册"。
//
// 【pdf-parse 局限】
//   - 只抽**文本**,**对扫描件 PDF 完全无效**(那种是图像,要 OCR)。
//   - 复杂版面(原理图、表格)的抽取结果**顺序可能错乱**。所以 prompt 教 LLM
//     遇到内容乱序时优先依赖工程里的结构化资料(board.yaml 等),而不是 PDF。
//
// 【TS / Node 知识点速记】
//   `import pdf from 'pdf-parse'`(default import)
//     pdf-parse 是 CommonJS 老包,它的导出方式是 `module.exports = function pdf(...)`。
//     在 ESM/TS 工程里,**必须用 default import**(`import pdf from`),不能写
//     `import { pdf } from 'pdf-parse'`(那是具名导入,这个包根本没那个具名 export)。
//     如果遇到 `pdf is not a function`,十有八九是 import 写错了。
// ============================================================================

import { readFile } from 'node:fs/promises';
import pdf from 'pdf-parse';
import type { ToolSpec } from '../types';
import {
  resolveSafe,
  toDisplayPath,
  PathOutOfRangeError,
  type FsToolConfig,
} from './paths';

/** 抽出的文本最大字符数;超了就截。PDF 抽出的文本可能很长(几百页),粗暴截断够用。 */
const MAX_CHARS = 30000;

// ============================================================================
// createReadPdfTool —— 工厂函数,生产 read_pdf 工具
// ----------------------------------------------------------------------------
// 同样是"闭包接收 cfg"模式(见 read_file.ts)。
// ============================================================================
export function createReadPdfTool(cfg: FsToolConfig): ToolSpec {
  return {
    name: 'read_pdf',

    description: `读取 PDF 文件的文本内容(抽取纯文本,丢失版面)。

用途:读芯片手册、板子原理图、规格书等 PDF 资料。
参数:
  - path(必填):PDF 文件路径(相对工作区根,或允许范围内的绝对路径)。
返回:抽取的纯文本 + 总页数;超过 ${MAX_CHARS} 字会被截断。
注意:
  - 仅适用于"有文本层"的 PDF;扫描件(图像 PDF)抽出来会是空字符串。
  - 复杂版面(原理图、表格)的抽取结果**顺序可能错乱**——
    如果发现内容像被打乱,优先尝试用户工程里的结构化资料(如 board.yaml),
    或建议用户提供更清晰的来源。`,

    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'PDF 文件路径(相对工作区根,或允许范围内的绝对路径)',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },

    handler: async (input) => {
      const { path: p } = input as { path: string };

      // ① 路径安全(沿用 paths.ts 的守门员)
      let abs: string;
      try {
        abs = resolveSafe(p, cfg);
      } catch (e) {
        if (e instanceof PathOutOfRangeError) {
          return { result: `拒绝:${e.message}` };
        }
        throw e;
      }

      // ② 整文件读进 Buffer(pdf-parse 要的就是 Buffer)
      // 不用指定编码——PDF 本来就是二进制,readFile 不传第二个参数返回的就是 Buffer。
      const buf = await readFile(abs);

      // ③ 解析。pdf-parse 返回 { text, numpages, info, metadata, version, ... }
      // 我们只关心 text 和 numpages;info/metadata 经常是空对象,不展示。
      // 注意:`pdf()` 是异步,会扫整个文件(几十~几百毫秒,取决于页数)。
      const data = await pdf(buf);

      // ④ 截断。`text ?? ''` 兜底——极少数 PDF 抽不出文本,data.text 可能是 undefined。
      let text = data.text ?? '';
      let truncated = false;
      if (text.length > MAX_CHARS) {
        text = text.slice(0, MAX_CHARS);
        truncated = true;
      }

      // ⑤ 拼输出:前置一行元数据(总页数 + 是否截断),让 LLM 知道整体规模。
      // 这一点和 read_file 的"头部元数据"是同一种心法:让 LLM 第一时间知道"我看到的是
      // 全部还是片段"。
      const header = `[PDF 共 ${data.numpages} 页,${truncated ? '已截断' : '完整抽取'}]\n\n`;

      return {
        result: header + text + (truncated ? '\n\n…(已截断)' : ''),
        sources: [{ file: toDisplayPath(abs, cfg.workspaceRoot) }],
      };
    },
  };
}
