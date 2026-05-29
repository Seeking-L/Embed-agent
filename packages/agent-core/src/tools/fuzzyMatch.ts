// ============================================================================
// tools/fuzzyMatch.ts —— ★ 写文件工具的「模糊匹配 + 应用」引擎(纯 TS、零依赖)
// ----------------------------------------------------------------------------
// 【这是干什么的】
// 写文件工具 propose_file_edit 的核心算法层。模型给我们一组「把 old_string 换成
// new_string」的编辑(edits 数组),这个文件负责:
//   ① 在文件原文里**找到** old_string 的位置(精确找不到时,逐级放宽容错);
//   ② 校验**唯一性**(出现多次又没说 replace_all 就报错,避免改错地方);
//   ③ 按编辑**算出改完后的新内容**(newContent)——【注意:本文件不写盘】。
//
// 真正落盘由 extension 在用户点「应用」后做(diff-first 原则,见 types.ts 的 ProposeFn)。
//
// 【为什么需要「模糊」匹配?】
// 模型复述 old_string 时常和文件里的原文**差一点点空白**(缩进多/少了空格、行尾有无
// 空白、Windows 的 \r\n…),还可能把「直引号 '」打成「花引号 '」、把「连字符 -」打成
// 「破折号 —」。如果只做「一字不差的精确匹配」,失败率会很高。于是我们抄两家成熟实现的
// **逐级降档**策略——精确匹配不中,就放宽一点再试:
//   蓝本 1:Cline  apps/vscode/src/core/assistant-message/diff.ts(3 级:精确 → 逐行去空白 → 块锚点)
//   蓝本 2:Codex  codex-rs/apply-patch/src/seek_sequence.rs(额外一级:Unicode 归一化,把花引号/破折号/各种空格折叠回 ASCII)
// 我们把两家合并成 4 级阶梯(见 findMatch)。
//
// 【给 TS 新手的速记】
//   string.indexOf(sub, from)   从 from 处起找子串,找不到返回 -1;
//   string.split('\n')          按换行切成行数组;'a\nb' → ['a','b'];'a\nb\n' → ['a','b','']
//   string.slice(start, end)    取 [start, end) 的子串(end 不含);
//   string.trim() / trimEnd()   去掉首尾 / 仅尾部的空白;
//   Set<number>                 一个「数字集合」,.has(x) 判断是否在集合里(O(1));
//   codePointAt(0)              取字符的 Unicode 码点(数字),如 '—'.codePointAt(0) === 0x2014。
// ============================================================================

// ────────────────────────────────────────────────────────────────────────────
// 对外类型
// ────────────────────────────────────────────────────────────────────────────

/** 一条编辑:把文件里的 old_string 换成 new_string。 */
export interface Edit {
  /** 要被替换掉的原文(必须能在文件里【找到】,允许空白略有出入,见模糊匹配)。 */
  old_string: string;
  /** 替换成的新文本。 */
  new_string: string;
  /** 为 true 时替换**所有**匹配;不传(默认 false)时要求 old_string 在文件里**唯一**。 */
  replace_all?: boolean;
}

/**
 * applyEdits 的结果。用「可辨识联合」表达成功/失败两种形状(靠 ok 字段区分):
 *   - 成功:{ ok: true, newContent, appliedCount }
 *   - 失败:{ ok: false, error }  ——error 是给模型看的中文说明,会原样回填。
 */
export type ApplyResult =
  | { ok: true; newContent: string; appliedCount: number }
  | { ok: false; error: string };

// ────────────────────────────────────────────────────────────────────────────
// Unicode 归一化(精确移植自 Codex 的 normalise(),用于第 4 级模糊匹配)
// ----------------------------------------------------------------------------
// 模型经常把「智能标点」打进 old_string:花引号、各种破折号、不间断空格(NBSP)等。
// 这些字符**看起来**和 ASCII 的 ' " - 空格 一样,但码点不同,精确匹配会失败。
// 归一化的作用:在「第 4 级」比较时,把这些花哨字符**折叠**回对应的 ASCII 再比。
//
// ⚠️ 归一化【只用于比较】,不会写进文件——替换时我们始终从**原文**里切片,绝不把
//    归一化后的文本落盘(避免悄悄改掉用户文件里本就存在的花引号)。
// ────────────────────────────────────────────────────────────────────────────

// 各种「破折号 / 连字符 / 减号」→ ASCII '-'(码点范围 U+2010–U+2015 再加 U+2212)
const DASH = new Set<number>([0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212]);
// 各种「单引号 / 撇号」→ ASCII "'"
const SQUOTE = new Set<number>([0x2018, 0x2019, 0x201a, 0x201b]);
// 各种「双引号」→ ASCII '"'
const DQUOTE = new Set<number>([0x201c, 0x201d, 0x201e, 0x201f]);
// 各种「花哨空格」(NBSP、en/em space、窄空格、表意空格…)→ ASCII ' '
const SPACE = new Set<number>([
  0x00a0, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f,
  0x3000,
]);

/** 把单个字符(按码点)折叠成 ASCII;不在折叠表里的原样返回。 */
function normalizeChar(cp: number): string {
  if (DASH.has(cp)) return '-';
  if (SQUOTE.has(cp)) return "'";
  if (DQUOTE.has(cp)) return '"';
  if (SPACE.has(cp)) return ' ';
  // String.fromCodePoint:码点 → 字符(normalizeChar 的逆操作)。
  return String.fromCodePoint(cp);
}

/** 归一化一整行:先 trim(和 Codex 一致),再逐字符折叠。 */
function normalizeLine(s: string): string {
  let out = '';
  // for...of 遍历字符串会按「码点」逐个取字符(能正确处理 emoji 等 4 字节字符)。
  for (const ch of s.trim()) out += normalizeChar(ch.codePointAt(0)!);
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// 匹配范围
// ----------------------------------------------------------------------------
// [start, end) 是命中区间在原文里的**字符下标**(end 不含)。tier 记录是第几级命中的。
//
// 【关键且易错的「换行归属」语义】(从 Cline 原样继承,务必理解):
//   - tier 1(精确 indexOf):end = start + old_string.length,**不**多含换行;
//   - tier 2/3/4(按行匹配):end 会**包含命中区最后一行的结尾换行 \n**
//     (每命中一行就累加 line.length + 1,那个 +1 就是 \n)。
//   这导致 slice(start, end) 取到的是「若干整行 + 末尾一个 \n」。替换时若 new_string
//   不以 \n 结尾,会把那个 \n 一起吃掉、和下一行黏在一起——applyEdits 里会补回来(见那里)。
// ────────────────────────────────────────────────────────────────────────────
export interface MatchRange {
  start: number;
  end: number;
  tier: 1 | 2 | 3 | 4;
}

/**
 * 给定字符下标,算它在第几行(1-based)。用于把改动位置换算成 sources 的行号范围。
 * 移植自 Cline diff.ts 的 getLineNumberFromCharIndex。
 */
export function getLineNumberFromCharIndex(content: string, charIndex: number): number {
  if (charIndex <= 0) return 1;
  // 截到 charIndex 处,数有几行 → 当前行号。
  return content.substring(0, charIndex).split('\n').length;
}

// ────────────────────────────────────────────────────────────────────────────
// findMatch —— 4 级模糊匹配阶梯,返回「获胜那一级」的**所有**非重叠命中区间
// ----------------------------------------------------------------------------
// 为什么返回「所有」而不是「第一个」?因为上层要:
//   - replace_all:替换全部 → 需要全部区间;
//   - 唯一性校验:出现几次 → 需要计数。
// 阶梯规则:从最严到最宽**逐级尝试**,**第一个**产出 ≥1 个命中的级别即「获胜」,
// 返回它的全部命中(不混级)。
//   T1 精确     :indexOf 全文扫
//   T2 逐行去空白:每行 .trim() 后比(容忍缩进/行尾空白差异)
//   T3 块锚点   :仅 ≥3 行的块——首行 + 末行当锚点,中间不校验(容忍中间漂移)
//   T4 Unicode  :每行归一化(折叠花引号/破折号/花哨空格)后比
// ────────────────────────────────────────────────────────────────────────────
export function findMatch(content: string, search: string): MatchRange[] {
  // 空 old_string 没法定位,交给上层特判(用于「创建新文件」语义)。
  if (search.length === 0) return [];

  // ── T1:精确匹配(Cline 的 indexOf,推广到「找出全部」)──
  {
    const ranges: MatchRange[] = [];
    let from = 0;
    for (;;) {
      const idx = content.indexOf(search, from);
      if (idx === -1) break;
      ranges.push({ start: idx, end: idx + search.length, tier: 1 });
      from = idx + search.length; // 跳过本次命中,保证不重叠
    }
    if (ranges.length > 0) return ranges;
  }

  // ── 下面三级都是「按行」比较,先把原文按行切开,并预存每行的起始字符下标 ──
  const origLines = content.split('\n');
  // offsetOf[k] = 前 k 行(0..k-1)的总字符数(含各自的 \n)= 第 k 行的起始下标。
  // 多算一个 offsetOf[length],方便取「到第 i 行末尾」的下标。
  const offsetOf: number[] = new Array(origLines.length + 1);
  offsetOf[0] = 0;
  for (let k = 0; k < origLines.length; k++) {
    offsetOf[k + 1] = offsetOf[k] + origLines[k].length + 1; // +1 是行尾的 \n
  }
  // 把「原文第 i 行起、共 len 行」换算成 [start, end) 字符区间。
  // end 取 offsetOf[i+len](含最后一行的 \n);但最后一行可能没有 \n(文件末行),
  // 所以用 Math.min 夹到 content.length,避免越界。
  const lineRange = (i: number, len: number): { start: number; end: number } => ({
    start: offsetOf[i],
    end: Math.min(offsetOf[i + len], content.length),
  });

  // 准备 search 的行数组:切行后,若最后一个是空串(old_string 以 \n 结尾的产物),pop 掉。
  const searchLines = search.split('\n');
  if (searchLines.length > 0 && searchLines[searchLines.length - 1] === '') {
    searchLines.pop();
  }
  const n = searchLines.length;
  if (n === 0) return []; // old_string 全是换行 → 无可锚定内容

  // ── T2:逐行去首尾空白后比对(Cline lineTrimmedFallbackMatch)──
  {
    const ranges: MatchRange[] = [];
    for (let i = 0; i + n <= origLines.length; i++) {
      let ok = true;
      for (let j = 0; j < n; j++) {
        if (origLines[i + j].trim() !== searchLines[j].trim()) {
          ok = false;
          break;
        }
      }
      if (ok) {
        ranges.push({ ...lineRange(i, n), tier: 2 });
        i += n - 1; // 跳过整个命中块,保证不重叠
      }
    }
    if (ranges.length > 0) return ranges;
  }

  // ── T3:块锚点(Cline blockAnchorFallbackMatch)——仅对 ≥3 行的块启用 ──
  // 只校验「首行 + 末行 + 行数」,中间行不校验。容忍中间内容漂移,但有误命中风险
  // (靠 diff-first 让用户在 diff 里复核兜底)。<3 行不用此级(太容易误命中)。
  if (n >= 3) {
    const first = searchLines[0].trim();
    const last = searchLines[n - 1].trim();
    const ranges: MatchRange[] = [];
    for (let i = 0; i + n <= origLines.length; i++) {
      if (origLines[i].trim() !== first) continue;
      if (origLines[i + n - 1].trim() !== last) continue; // 中间行不查
      ranges.push({ ...lineRange(i, n), tier: 3 });
      i += n - 1;
    }
    if (ranges.length > 0) return ranges;
  }

  // ── T4:Unicode 归一化后逐行比(Codex normalise)——最宽容的一级 ──
  {
    const normSearch = searchLines.map(normalizeLine);
    const ranges: MatchRange[] = [];
    for (let i = 0; i + n <= origLines.length; i++) {
      let ok = true;
      for (let j = 0; j < n; j++) {
        if (normalizeLine(origLines[i + j]) !== normSearch[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        ranges.push({ ...lineRange(i, n), tier: 4 });
        i += n - 1;
      }
    }
    if (ranges.length > 0) return ranges;
  }

  return []; // 4 级都没命中
}

// ────────────────────────────────────────────────────────────────────────────
// 错误信息(中文,给模型看的——会原样回填进对话,模型据此自我纠正)
// ----------------------------------------------------------------------------
// 设计要点(抄 Cline 的「错误即教学」):错误信息不仅说「错了」,还**告诉模型怎么改对**。
// ────────────────────────────────────────────────────────────────────────────

const ERR_NO_EDITS = '编辑列表为空:请至少提供一条 { old_string, new_string } 编辑。';

/** 把多行字符串压成一行预览(换行显示为 ⏎),并截断到 max 字符,方便放进错误信息。 */
function snippet(s: string, max = 80): string {
  const flat = s.replace(/\n/g, '⏎');
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

// 注意:对外展示用「第 N 条」(N = 数组下标 + 1),对人更友好。
const ERR_NOT_FOUND = (oldStr: string, i: number): string =>
  `第 ${i + 1} 条编辑找不到要替换的内容。请确认 old_string 与文件现有内容一致` +
  `(特别注意:**不要**把 read_file 输出的行号前缀,例如 "   42\\t",写进 old_string)。\n` +
  `未匹配的 old_string(前 80 字符):\n${snippet(oldStr)}`;

const ERR_NOT_UNIQUE = (oldStr: string, count: number, i: number): string =>
  `第 ${i + 1} 条编辑的 old_string 在文件中出现了 ${count} 次,不唯一。\n` +
  `请补充更多上下文(多带几行前后内容)让它唯一,或设置 replace_all: true 替换全部。\n` +
  `重复的 old_string(前 80 字符):\n${snippet(oldStr)}`;

const ERR_EMPTY_OLD = (i: number): string =>
  `第 ${i + 1} 条编辑的 old_string 为空,但目标文件非空。\n` +
  `空 old_string 只用于创建空内容;若要插入内容,请提供包含插入点上下文的 old_string。`;

// ────────────────────────────────────────────────────────────────────────────
// applyEdits —— 把一组编辑依次作用到原文上,算出 newContent
// ----------------------------------------------------------------------------
// 【策略选择:顺序作用在「不断演进的字符串」上】(对照 Claude Code 的 Edit/MultiEdit 语义)
//   每条编辑都作用在「前面所有编辑应用后的结果」上,而不是都对着最初的原文。这样:
//     - 第 N 条可以命中第 N-1 条刚插入的文本(符合模型直觉);
//     - 实现最简单:每条就是「在当前串里找 → 校验次数 → 切片替换」,无需算偏移、排序;
//     - 唯一性校验反映「应用了前面编辑之后」的真实情况。
//   (Cline/Codex 把多块改动一次性应用是为它们的流式场景优化的;我们 edits 数量很小
//    [通常 1~10 条],逐条重扫成本可忽略,却换来「零偏移 bug」。)
//
// 【替换时的换行修正】(承上文 MatchRange 的「换行归属」语义)
//   按行命中的区间(tier 2/3/4)末尾含一个 \n。若 new_string 不以 \n 结尾,直接替换会
//   把这个 \n 吃掉、和下一行黏连。所以:命中是按行级别、且被吃掉的区间以 \n 结尾、而
//   new_string 不以 \n 结尾时,给 new_string 补一个 \n。tier 1(精确)无此问题。
// ────────────────────────────────────────────────────────────────────────────
export function applyEdits(original: string, edits: Edit[]): ApplyResult {
  if (edits.length === 0) return { ok: false, error: ERR_NO_EDITS };

  let content = original; // 「不断演进的字符串」
  let applied = 0;

  for (let e = 0; e < edits.length; e++) {
    const { old_string, new_string } = edits[e];
    const replaceAll = edits[e].replace_all === true;

    // —— 特例:old_string 为空 ——
    // 仅当文件本身为空时,视为「写入全文」(创建空文件后填内容的语义);
    // 文件非空却给空 old_string,插入点不明确,报错。
    if (old_string.length === 0) {
      if (content.length === 0) {
        content = new_string;
        applied++;
        continue;
      }
      return { ok: false, error: ERR_EMPTY_OLD(e) };
    }

    // —— 特例:old === new(无操作)——仍要求能找到(否则说明模型搞错了文件状态)。
    if (old_string === new_string) {
      if (findMatch(content, old_string).length === 0) {
        return { ok: false, error: ERR_NOT_FOUND(old_string, e) };
      }
      applied++;
      continue;
    }

    // —— 正常:找命中 → 校验次数 → 替换 ——
    const matches = findMatch(content, old_string);
    if (matches.length === 0) {
      return { ok: false, error: ERR_NOT_FOUND(old_string, e) };
    }
    if (matches.length > 1 && !replaceAll) {
      return { ok: false, error: ERR_NOT_UNIQUE(old_string, matches.length, e) };
    }

    // replace_all 命中多处时,**从后往前**(按 start 降序)逐个切片替换:
    // 先改靠后的,靠前那些区间的下标就不会因为前面的替换而错位。
    const targets = replaceAll ? [...matches] : [matches[0]];
    targets.sort((a, b) => b.start - a.start); // 降序

    for (const m of targets) {
      const consumed = content.slice(m.start, m.end);
      let ns = new_string;
      // 换行修正(仅按行命中的级别):被吃掉的区间以 \n 结尾,但 new_string 没有 → 补一个,
      // 否则会把替换内容和下一行黏连。
      // ⚠️ 但「整行删除」(new_string 为空)必须排除:此时若补 \n,删掉的行会留下一个空行。
      //    ns 为空时,slice 前后直接拼接本就保留了周围的换行,无需也不该再补。
      if (ns.length > 0 && m.tier !== 1 && consumed.endsWith('\n') && !ns.endsWith('\n')) {
        ns += '\n';
      }
      content = content.slice(0, m.start) + ns + content.slice(m.end);
    }
    applied++;
  }

  return { ok: true, newContent: content, appliedCount: applied };
}
