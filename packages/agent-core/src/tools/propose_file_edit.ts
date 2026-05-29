// ============================================================================
// tools/propose_file_edit.ts —— 工具:对一个【已存在】文件提出精确字符串替换(写文件)
// ----------------------------------------------------------------------------
// 【这工具是干什么的】
// 这是 agent 第一个「会动手改东西」的工具。模型给出一组「把 old_string 换成 new_string」
// 的编辑(edits 数组),本工具:
//   ① 校验路径安全 + read-before-edit(必须先 read_file 读过该文件);
//   ② 读出文件原文,用模糊匹配引擎(fuzzyMatch.ts)算出「改完后的完整内容」newContent;
//   ③ 【★ 关键:不写盘】把改动交给 extension,在 VS Code 原生 diff 编辑器里展示,
//      用户点「应用」才落盘——这就是 CLAUDE.md 的硬红线「Diff-first, not autonomous-write」。
//
// 【设计取舍 = 选型文档的结论】(doc/写文件-网络-grep-实现对比与选型.md §2)
//   - 模型接口学 Claude Code 的 Edit:old_string / new_string(精确替换),但允许一次传**多条**
//     (JSON 数组)——这样白拿了 Cline「多块改动」的效率,又免掉它「解析 SEARCH/REPLACE
//     文本标记」的全部复杂度(原生 function-calling 直接给我们结构化数组)。
//   - apply 算法用 fuzzyMatch.ts 的多级模糊匹配(抄 Cline + Codex):精确匹配不中时逐级放宽。
//   - 流程学 Cline 的 diff-first(本工具调注入的 propose,由 extension 走原生 diff viewer + Apply)。
//   - **不**抄 Codex 的 apply_patch 自定义格式(那要专门微调过的模型,通用 Claude/GPT 会格式错乱)。
//
// 【为什么 requiresConfirm 不设(=false)?】
//   因为「diff 卡片 + Apply 按钮」本身就是确认。如果再设 requiresConfirm,loop 会先弹一个
//   通用 yes/no 卡片,然后本工具又弹一个 diff 卡片 —— 双重确认,体验很差。所以这里
//   不走 loop 的通用确认,改由 handler 内部 await 注入的 propose() 来「带 diff 地确认」。
//
// 【范围:本工具只改【已存在】文件】新建文件留给将来的 propose_new_file
//   (见 doc/tools/待办-…;原因:read-before-edit 对不存在的文件无意义,且整文件写入的
//    心智契约和「精确替换」不同,分开更清晰)。
// ============================================================================

import { stat, readFile } from 'node:fs/promises';
import type { ToolSpec, ProposeFn } from '../types';
import type { ToolResult } from '@embed-agent/shared';
import { resolveSafe, toDisplayPath, PathOutOfRangeError, type FsToolConfig } from './paths';
import { applyEdits, getLineNumberFromCharIndex, type Edit } from './fuzzyMatch';

/** 单文件大小上限(字节);超过就拒改(基本是误把日志/二进制当源码改)。 */
const MAX_EDIT_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

// 【写入红线】这些目录里的文件【永远不许改】(对齐 CLAUDE.md 硬约束「永远禁止写:.git/**、
// build/**」+ 常识)。allowedRoots 只管「能不能【访问】」;这里再加一道「能不能【写】」的拒绝
// (deny 优先于 allow)。改 .git/config 或 .git/hooks 是本地代码执行风险;node_modules / 构建
// 产物改了也只会坏事。
const WRITE_DENY_SEGMENTS = new Set(['.git', 'node_modules', 'build', 'dist', 'out', 'coverage']);

/** 给定展示用相对路径(posix),判断它是否落在写入红线目录内(任一路径段命中即拒)。 */
function isWriteDenied(displayPath: string): boolean {
  return displayPath.split('/').some((seg) => WRITE_DENY_SEGMENTS.has(seg));
}

// 给每次「修改提议」生成一个会话内唯一 id(webview 靠它把 diff 卡片的响应配对回来)。
// 用一个模块级自增计数器即可——只需「唯一」,不需要和模型的 tool_use id 关联。
let proposeSeq = 0;

// ============================================================================
// createProposeFileEditTool —— 工厂函数
// ----------------------------------------------------------------------------
// 参数:
//   cfg     :路径安全配置(allowedRoots / workspaceRoot),同其它 fs 工具;
//   propose :★ 依赖注入。由 extension 实现「展示 diff + 等用户 Apply + 落盘」,返回
//             Promise<是否已应用>。agent-core 这边绝不碰 vscode、绝不写盘(见 types.ts ProposeFn)。
//   wasRead :可选。给 read-before-edit 用——传一个「这个绝对路径本会话 read_file 读过吗?」
//             的判定函数。不传则跳过该校验(比如单测里不关心读没读过)。
// ============================================================================
export function createProposeFileEditTool(
  cfg: FsToolConfig,
  propose: ProposeFn,
  wasRead?: (absPath: string) => boolean,
): ToolSpec {
  return {
    name: 'propose_file_edit',

    description: `对一个【已存在】的文件提出修改(diff-first:先在 VS Code 里展示 diff,用户点「应用」才真正写入)。

何时用:你已经用 read_file 看过某文件、确定要改它时。
参数:
  - path(必填):要修改的文件(相对工作区根),必须是【已存在】的文件。
  - edits(必填):一组改动的数组,按顺序依次应用。每项:
      · old_string:要被替换掉的原文。必须能在文件里找到(允许空白略有出入,会模糊匹配)。
        ⚠️【最重要】不要把 read_file 输出里的行号前缀(形如 "   42\\t")写进 old_string!只写文件真实文本。
      · new_string:替换成的新文本。
      · replace_all(可选):为 true 时替换**所有**匹配;否则要求 old_string 在文件里**唯一**
        (不唯一会报错,请补更多上下文行使其唯一)。

要点:
  - 改文件【之前必须先用 read_file 读过它】,否则会被拒绝(防止凭印象瞎改)。
  - 多条 edits 按数组顺序生效,后一条作用在前一条改完的结果上。
  - 本工具只负责【提出】改动;是否落盘由用户在 diff 里点「应用 / 放弃」决定,你不要假设一定会被接受。
  - 新建文件暂不支持(本工具只改已存在文件)。`,

    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '要修改的文件路径(相对工作区根),必须已存在',
        },
        edits: {
          type: 'array',
          minItems: 1,
          description: '一组改动,按顺序依次应用',
          items: {
            type: 'object',
            properties: {
              old_string: {
                type: 'string',
                description: '要被替换的原文(须与文件内容一致;勿带 read_file 的行号前缀)',
              },
              new_string: { type: 'string', description: '替换成的新文本' },
              replace_all: {
                type: 'boolean',
                description: 'true=替换全部匹配;否则要求 old_string 唯一',
              },
            },
            required: ['old_string', 'new_string'],
            additionalProperties: false,
          },
        },
      },
      required: ['path', 'edits'],
      additionalProperties: false,
    },

    // 注意:不设 requiresConfirm —— diff 卡片本身就是确认(见文件顶部说明)。

    handler: async (input): Promise<ToolResult> => {
      const { path: p, edits } = (input as { path?: string; edits?: Edit[] }) ?? {};

      // ── 参数防御 ──
      if (!p || typeof p !== 'string') {
        return { result: '拒绝:path 不能为空。' };
      }
      if (!Array.isArray(edits) || edits.length === 0) {
        return { result: '拒绝:edits 必须是非空数组(至少一条 { old_string, new_string })。' };
      }

      // ── ① 路径安全 ──
      let abs: string;
      try {
        abs = resolveSafe(p, cfg);
      } catch (e) {
        if (e instanceof PathOutOfRangeError) return { result: `拒绝:${e.message}` };
        throw e;
      }
      const display = toDisplayPath(abs, cfg.workspaceRoot);

      // ── ①.5 写入红线:即便在 allowedRoots 内,这些目录也永远不许改(CLAUDE.md 硬约束)──
      if (isWriteDenied(display)) {
        return {
          result: `拒绝:${display} 位于禁止写入的目录(.git / node_modules / build / dist / out / coverage),不允许修改。`,
        };
      }

      // ── ② 文件必须存在且是普通文件(本工具不新建、不改目录)──
      let st;
      try {
        st = await stat(abs);
      } catch {
        return {
          result: `拒绝:文件不存在:${display}。本工具只修改已存在的文件(新建文件暂不支持)。`,
        };
      }
      if (st.isDirectory()) {
        return { result: `拒绝:${display} 是目录,无法编辑。` };
      }
      if (st.size > MAX_EDIT_FILE_SIZE) {
        return {
          result: `拒绝:${display} 大小 ${(st.size / 1024 / 1024).toFixed(1)} MB,超过可编辑上限 ${MAX_EDIT_FILE_SIZE / 1024 / 1024} MB。`,
        };
      }

      // ── ③ read-before-edit:必须先 read_file 读过(wasRead 没传则跳过)──
      if (wasRead && !wasRead(abs)) {
        return {
          result: `拒绝:请先用 read_file 读过 ${display} 再修改(改前先读,避免凭印象瞎改)。`,
        };
      }

      // ── ④ 读原文,跑模糊匹配算出 newContent ──
      const original = await readFile(abs, 'utf-8');
      const res = applyEdits(original, edits);
      if (!res.ok) {
        // res.error 是 fuzzyMatch 给的「教学式」中文错误(含怎么改对的提示),原样回填。
        return { result: res.error, sources: [{ file: display }] };
      }

      // 没产生任何变化(edits 全是 old===new)→ 不必劳烦用户确认。
      if (res.newContent === original) {
        return {
          result: `提示:${display} 应用 edits 后内容没有变化,未提交修改。`,
          sources: [{ file: display }],
        };
      }

      // ── ⑤ 算改动的行号范围(填进 sources.lines,便于 UI 跳转 / 用户核对)──
      const { start, end } = changedLineRange(original, res.newContent);

      // ── ⑥ ★ 交给 extension:展示 diff、等用户 Apply,本工具【不写盘】──
      const id = `edit_${++proposeSeq}`;
      const applied = await propose({
        id,
        path: display,
        absPath: abs,
        originalContent: original,
        newContent: res.newContent,
        isNewFile: false,
        summary: `修改 ${display}(${res.appliedCount} 处编辑,约 ${start}-${end} 行)`,
      });

      // ── ⑦ 回填给模型(务必带 sources)──
      if (!applied) {
        return {
          result: `用户放弃了对 ${display} 的修改,文件未改动。`,
          sources: [{ file: display }],
        };
      }
      return {
        result: `已应用对 ${display} 的修改(${res.appliedCount} 处编辑)。`,
        sources: [{ file: display, lines: `${start}-${end}` }],
      };
    },
  };
}

// ============================================================================
// changedLineRange —— 粗略算出「改动落在新内容的第几行到第几行」
// ----------------------------------------------------------------------------
// 做法:从头找第一个不同的字符,从尾找最后一个不同的字符,再换算成行号。
// 不追求精确的逐块 diff(那是 diff viewer 的活),只为给 sources.lines 一个合理范围。
// ============================================================================
function changedLineRange(before: string, after: string): { start: number; end: number } {
  // 从头找第一个不同的字符下标。
  let i = 0;
  const min = Math.min(before.length, after.length);
  while (i < min && before[i] === after[i]) i++;

  // 从尾往前找最后一个不同(分别在 after / before 里的下标)。
  let a = after.length - 1;
  let b = before.length - 1;
  while (a >= i && b >= i && after[a] === before[b]) {
    a--;
    b--;
  }

  const start = getLineNumberFromCharIndex(after, i);
  const end = getLineNumberFromCharIndex(after, Math.max(i, a));
  return { start, end };
}
