// ============================================================================
// tools/search_files.ts —— 工具:用 ripgrep 在允许范围内按【正则】搜索文件内容(grep)
// ----------------------------------------------------------------------------
// 【这工具是干什么的】
// 让 LLM 在「不知道某个符号/字符串在哪个文件」时定位它。read_file 对大文件会截断
// (一个 800 KB 的头文件根本读不全),必须先用 grep 把关键字定位到 file:line,再用
// read_file 精读那一段。它和 list_files / read_file 共同构成「先探、再定位、再精读」工作流。
//
// 【蓝本:Cline 的 ripgrep service】(apps/vscode/src/services/ripgrep/index.ts)
//   - 后端用 ripgrep(rg)的 `--json` 模式:每命中一处吐一行 JSON,我们 readline 逐行解析;
//   - 双重封顶:最多 300 条结果 / 0.25 MB 输出,超了就停(防止把上下文撑爆);
//   - 按文件分组、`│` 前缀的输出格式(对 LLM 很友好)。
// 【相对 Cline 的两处改造】
//   ① ripgrep 二进制路径由 extension【注入】(agent-core 不依赖 vscode),见 GrepToolConfig;
//   ② 抄 Codex 的反卡死技巧:spawn 时把子进程 stdin 设成 'ignore'
//      (否则 ripgrep 的「读 stdin」启发式可能让进程永久阻塞);
//   ③ ★ 默认带 `--no-ignore`:因为本项目把 vendor/ 与 MeterialsForResearch/ 写进了
//      .gitignore,而它们又恰恰是 allowedRoots 里的「调研资料根」。ripgrep 默认会跳过
//      gitignore 的目录 → 那样就搜不到调研资料了。所以我们关掉 ignore,改用一份固定的
//      「噪声排除」glob 列表(node_modules/.git/dist/...)来过滤垃圾。
//
// 【为什么不用 vscode.workspace.findTextInFiles?】那会让本工具依赖 vscode,破坏
// agent-core「纯 TS、可离线单测」的护栏。child_process.spawn 一个 rg 进程则没这个问题
// ——node:child_process 是 Node 内置,agent-core 可以用(被禁的只有 vscode)。
//
// 【给 TS / Node 新手的速记】
//   spawn(cmd, args, opts)        起一个子进程;stdio:['ignore','pipe','pipe'] = 不要 stdin、
//                                 stdout/stderr 走管道(我们读)。
//   readline.createInterface({input}) 把一个可读流按「行」切开,逐行触发 'line' 事件。
//   crlfDelay: Infinity           把跨数据块拆开的 \r\n 也当成一个换行(Windows 必需,
//                                 否则一行 JSON 可能被拆成两半,JSON.parse 崩)。
//   new Promise((resolve,reject)=>…) 把「基于事件的异步」(子进程)包装成可 await 的 Promise。
// ============================================================================

import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import * as path from 'node:path';
import type { ToolSpec } from '../types';
import type { ToolResult } from '@embed-agent/shared';
import { resolveSafe, toDisplayPath, PathOutOfRangeError, type FsToolConfig } from './paths';

// ── 常量:除 RG_TIMEOUT_MS 外,均与 Cline 1:1。改语义前先同步 loop.ts 的 MAX_TOOL_RESULT_CHARS(500_000)──

/** 结果条数硬上限(超过则只展示前 300,并提示缩小搜索范围)。 */
const MAX_RESULTS = 300;

/** rg --json 的「行数」上限 = 300 × 5(假设每条结果最多约 5 行)。到顶就 kill 掉 rg,相当于跨平台版 head。 */
const MAX_STREAM_LINES = MAX_RESULTS * 5;

/** 输出字节上限(0.25 MB)。边拼边算,超了就截断并提示。 */
const MAX_RIPGREP_MB = 0.25;
const MAX_BYTE_SIZE = MAX_RIPGREP_MB * 1024 * 1024; // = 262144

/** 每条命中带几行上下文(命中行前后各 1 行)。⚠️ Cline 源码用 1(其注释写 2 是过时的)。 */
const CONTEXT_LINES = 1;

/** rg 超时兜底(我们加的,Cline 没有):超大库 / 病态正则下不至于挂死。 */
const RG_TIMEOUT_MS = 30_000;

/**
 * 噪声排除 glob:即便关掉 .gitignore(--no-ignore),也别去搜这些「肯定是垃圾」的目录/文件。
 * 用 `!` 前缀表示「排除」;放在用户的 file_pattern 之后,ripgrep 规则「后者优先」,确保它们被排掉。
 */
const NOISE_EXCLUDES = [
  '!**/node_modules/**',
  '!**/.git/**',
  '!**/dist/**',
  '!**/out/**',
  '!**/coverage/**',
  '!**/*.vsix',
  // 因为我们用了 --no-ignore(关掉 .gitignore),要顺手挡住「常被 gitignore 的敏感文件」,
  // 否则可能把密钥/凭证搜出来回传给 LLM provider(违反隐私红线)。
  // 注:.env 等 dotfile 默认就被 ripgrep 当隐藏文件跳过(我们没传 --hidden);这里再补一层
  // 针对【非隐藏】的密钥文件(server.pem / app.key 之类),双保险。
  '!**/.env',
  '!**/.env.*',
  '!**/*.pem',
  '!**/*.key',
  '!**/*.p12',
  '!**/*.pfx',
  '!**/*.keystore',
  '!**/id_rsa*',
  '!**/*.tfstate',
];

// search_files 比普通 fs 工具多一样东西:ripgrep 可执行文件的路径(由 extension 注入)。
export type GrepToolConfig = FsToolConfig & { ripgrepPath: string };

// 解析 --json 后,一条命中的中间结构(命中行 + 前后上下文)。导出供单测构造输入。
export interface SearchResult {
  filePath: string; // rg 给出的路径(我们传了绝对搜索根 → 这里是绝对路径)
  line: number; // 命中行号(1-based)
  match: string; // 命中行原文(含末尾 \n)
  beforeContext: string[];
  afterContext: string[];
}

// ============================================================================
// createSearchFilesTool —— 工厂函数,接受 GrepToolConfig,返回 ToolSpec
// ----------------------------------------------------------------------------
// 和 read_file / list_files 同样的「闭包捕获 cfg」模式;只是 cfg 多了 ripgrepPath。
// ============================================================================
export function createSearchFilesTool(cfg: GrepToolConfig): ToolSpec {
  return {
    name: 'search_files',

    description: `用 ripgrep 在允许范围内按【正则】搜索文件内容,返回 file:line + 上下文。

何时用:不确定某个符号/字符串在哪个文件时,先用本工具定位到具体行,再用 read_file 精读那一段。
参数:
  - pattern(必填):正则表达式。【Rust regex 语法】——不支持 lookahead/lookbehind/反向引用(\\1);
    字面花括号要转义(查 interface{} 要写 interface\\{\\})。默认大小写敏感。
  - path(可选,默认 "."):搜索目录(相对工作区根,或允许范围内的绝对路径),会递归搜索其子目录。
  - file_pattern(可选,默认 "*"):glob 过滤,只搜匹配的文件,例:"*.c" / "*.{h,c}" / "**/*.ts"。

返回:按文件分组,每行以 │ 前缀;最多 ${MAX_RESULTS} 条 / ${MAX_RIPGREP_MB} MB,超出会提示缩小范围。
已自动排除 node_modules / dist 等噪声目录。`,

    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: '正则(Rust 语法;无 lookahead/反向引用;字面花括号要转义)',
        },
        path: { type: 'string', description: '搜索目录,默认 "."(工作区根)' },
        file_pattern: { type: 'string', description: 'glob 过滤,如 "*.c";默认 "*"(全部)' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },

    // 不设 requiresConfirm(= false):grep 是只读操作(CLAUDE.md「read-heavy is free」)。

    handler: async (input): Promise<ToolResult> => {
      const {
        pattern,
        path: p = '.',
        file_pattern,
      } = (input as { pattern?: string; path?: string; file_pattern?: string }) ?? {};

      // ── 防御:pattern 必填且非空(模型偶尔会无视 schema 漏传)──
      if (!pattern || typeof pattern !== 'string') {
        return { result: '拒绝:pattern(搜索正则)不能为空。' };
      }

      // ── ① 路径安全:把搜索根限制在 allowedRoots 内 ──
      let absDir: string;
      try {
        absDir = resolveSafe(p, cfg);
      } catch (e) {
        if (e instanceof PathOutOfRangeError) return { result: `拒绝:${e.message}` };
        throw e; // 真意外 → 交给 loop 兜成「工具执行失败」
      }

      // ── ② 跑 rg,拿 --json 原始行 ──
      // argv 顺序讲究:--no-ignore 关闭 .gitignore(否则搜不到 vendor/);用户的 file_pattern
      // 在前、NOISE_EXCLUDES 在后(ripgrep「后者优先」,保证噪声目录被排除)。
      const args = [
        '--json',
        '-e',
        pattern,
        '--no-ignore', // 见顶部说明 ③
        '--glob',
        file_pattern || '*',
        ...NOISE_EXCLUDES.flatMap((g) => ['--glob', g]),
        '--context',
        String(CONTEXT_LINES),
        absDir,
      ];

      let rawLines: string[];
      try {
        rawLines = await execRipgrep(cfg.ripgrepPath, args);
      } catch (e) {
        return { result: `搜索失败:${(e as Error).message}` };
      }

      // ── ③ 解析 --json → SearchResult[] ──
      const results = parseRipgrepJson(rawLines);
      if (results.length === 0) {
        const dir = toDisplayPath(absDir, cfg.workspaceRoot);
        return {
          result: `未找到匹配:/${pattern}/  (目录 ${dir || '.'}/,glob ${file_pattern || '*'})`,
        };
      }

      // ── ④ 格式化 │ 分组输出 + 双重封顶 ──
      return formatResults(results, cfg, absDir);
    },
  };
}

// ============================================================================
// execRipgrep —— spawn rg + readline 逐行收集;到行数上限就 kill(跨平台版 head)
// ----------------------------------------------------------------------------
// rg 退出码约定:0 = 有匹配;1 = 无匹配(**不是错误**);2(或其它)= 真出错(如正则非法)。
// ============================================================================
function execRipgrep(rgPath: string, args: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    // ★ stdin 设 'ignore' —— 抄 Codex spawn.rs:否则 rg 可能尝试读 stdin 而永久阻塞。
    const proc = spawn(rgPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    const lines: string[] = [];
    let count = 0;
    let killed = false; // 是不是被我们(到上限/超时)主动杀掉的
    let stderr = '';

    const timer = setTimeout(() => {
      killed = true;
      proc.kill();
    }, RG_TIMEOUT_MS);

    rl.on('line', (line) => {
      if (count < MAX_STREAM_LINES) {
        lines.push(line);
        count++;
      } else {
        // 到流式行上限:主动杀掉 rg(相当于 `| head`),避免它把整个大库全吐出来。
        killed = true;
        proc.kill();
      }
    });

    proc.stderr!.on('data', (d) => {
      stderr += String(d);
    });

    // spawn 本身失败(如 rg 路径不对)→ 这里报错。
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 ripgrep(${rgPath}):${err.message}`));
    });

    // 进程结束:在 stdout/stderr 都关闭、拿到退出码后触发。
    proc.on('close', (code) => {
      clearTimeout(timer);
      // killed:被我们杀的(code 为 null + 信号);0/1:正常(有/无匹配);其它:真错误。
      if (killed || code === 0 || code === 1 || code === null) {
        resolve(lines);
      } else {
        reject(new Error(`ripgrep 退出码 ${code}${stderr ? `:${stderr.trim()}` : ''}`));
      }
    });
  });
}

// ============================================================================
// parseRipgrepJson —— 严格按 Cline 的 match/context 配对逻辑解析 --json
// ----------------------------------------------------------------------------
// rg --json 每行是一个事件对象,type ∈ {begin, match, context, end, summary}。
// 我们只关心 match(命中行)与 context(上下文行),其余忽略。
//
// ⚠️ 易错点:rg 是按【文件内行序】吐事件的,所以「命中行的前一行」(before-context)
//    会**先于** match 事件到达——此时还没有「当前命中」可挂靠。所以要用一个
//    pendingBefore 缓冲区暂存这些「前文」,等下一条 match 来了再挂上去。
//    after-context(行号 > 命中行)则在 match 之后到达,直接挂到当前命中即可。
// ============================================================================
export function parseRipgrepJson(lines: string[]): SearchResult[] {
  const results: SearchResult[] = [];
  let cur: SearchResult | null = null;
  let pendingBefore: string[] = []; // 暂存「下一条 match 的前文」

  for (const line of lines) {
    if (!line) continue;
    // 单行坏掉(rg 偶发非 JSON 输出)就跳过,不要让一行毁掉整个结果。
    let ev: RgEvent;
    try {
      ev = JSON.parse(line) as RgEvent;
    } catch {
      continue;
    }

    if (ev.type === 'begin') {
      // 新文件开始:清掉缓冲,避免把上一个文件的上下文带过来。
      pendingBefore = [];
    } else if (ev.type === 'match') {
      if (cur) results.push(cur);
      cur = {
        filePath: ev.data?.path?.text ?? '',
        line: ev.data?.line_number ?? 0,
        // 非 UTF-8 行时 rg 改吐 data.lines.bytes(base64),text 为 undefined → 兜成空串。
        match: ev.data?.lines?.text ?? '',
        beforeContext: pendingBefore, // 把先到的前文挂上
        afterContext: [],
      };
      pendingBefore = [];
    } else if (ev.type === 'context') {
      const txt = ev.data?.lines?.text ?? '';
      const ln = ev.data?.line_number ?? 0;
      // ⚠️ 只有「紧贴当前命中行之后 CONTEXT_LINES 行以内」的才算后文。
      //   更远的(行号远大于命中行)其实是【下一条命中的前文】——rg 会先吐它,再吐下一条 match。
      //   若不设这个上界,就会把下一条的前文错挂到当前命中,而下一条的前文反而丢了。
      if (cur && ln > cur.line && ln <= cur.line + CONTEXT_LINES) {
        cur.afterContext.push(txt);
      } else {
        // 否则视为「下一条命中的前文」,先缓冲
        pendingBefore.push(txt);
      }
    }
    // end / summary:忽略
  }
  if (cur) results.push(cur);
  return results;
}

// rg --json 事件的最小类型(只声明我们用到的字段;其余字段不管)。
interface RgEvent {
  type: 'begin' | 'match' | 'context' | 'end' | 'summary';
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
}

// ============================================================================
// formatResults —— 按文件分组的 │ 输出 + 双重封顶(条数 / 字节,边拼边算)
// ----------------------------------------------------------------------------
// 输出样例(对 LLM 友好):
//   Found 2 results.
//
//   src/app.ts
//   │----
//   │function processData(data) {
//   │  // TODO: handle errors
//   │  return data;
//   │----
// ============================================================================
export function formatResults(
  results: SearchResult[],
  cfg: GrepToolConfig,
  absDir: string,
): ToolResult {
  // 头部:命中数 ≥ 上限时换成「只显示前 300」的提示。
  let output =
    results.length >= MAX_RESULTS
      ? `Showing first ${MAX_RESULTS} of ${MAX_RESULTS}+ results. Use a more specific search if necessary.\n\n`
      : `Found ${results.length === 1 ? '1 result' : `${results.length.toLocaleString()} results`}.\n\n`;

  // 把绝对路径换算成展示用 posix 相对路径,再按文件分组(只取前 MAX_RESULTS 条)。
  const grouped = new Map<string, SearchResult[]>();
  for (const r of results.slice(0, MAX_RESULTS)) {
    const abs = path.isAbsolute(r.filePath) ? r.filePath : path.resolve(absDir, r.filePath);
    const rel = toDisplayPath(abs, cfg.workspaceRoot);
    const arr = grouped.get(rel) ?? [];
    arr.push(r);
    grouped.set(rel, arr);
  }

  let byteSize = Buffer.byteLength(output, 'utf8');
  let limitReached = false;

  // sources:每个文件一条(去重),lines 取该文件第一条命中的行号。
  // 这样「来源:」段简洁(一文件一行),逐行明细则在上面的 │ 正文里。
  const sources: { file: string; lines: string }[] = [];

  // 用带标签的 for + break outer 处理「跨多层循环的字节封顶」。
  //
  // ★ 关键(见 review 发现⑤):先把一个文件的【正文】拼进 block、确认至少 1 行放得下,
  //   才提交「文件头 + 正文 + 收尾」并 push 一条 source。否则会出现「光秃秃的文件头没正文」、
  //   或「sources 里引用了一个正文被整段截掉的文件」(误导模型去引用它没看过的内容)。
  outer: for (const [rel, fileResults] of grouped) {
    const fileHeader = `${rel}\n│----\n`;
    const closing = '│----\n\n';
    const headerBytes = Buffer.byteLength(fileHeader, 'utf8');
    const closingBytes = Buffer.byteLength(closing, 'utf8');

    let block = ''; // 该文件的正文(各命中的 │ 行 + 结果间的 │---- 分隔)
    let blockBytes = 0;
    let wroteLine = false; // 该文件是否至少有 1 行成功放入

    for (const r of fileResults) {
      const allLines = [...r.beforeContext, r.match, ...r.afterContext];

      // 先把这一条命中的所有行拼好、算好字节(预算要把 header + closing 也预留进去)。
      let resultStr = '';
      let resultBytes = 0;
      let resultFit = true;
      for (const ln of allLines) {
        const s = `│${(ln ?? '').trimEnd()}\n`; // trimEnd 去掉 rg 的尾 \n / 尾部空白;│ 后无空格
        const b = Buffer.byteLength(s, 'utf8');
        if (byteSize + headerBytes + blockBytes + resultBytes + b + closingBytes >= MAX_BYTE_SIZE) {
          resultFit = false;
          limitReached = true;
          break;
        }
        resultStr += s;
        resultBytes += b;
      }
      if (!resultFit) break; // 这一条放不下了 → 停止累加该文件后续结果

      // 结果之间(从第 2 条起)加 │---- 分隔。
      let sep = '';
      if (wroteLine) {
        sep = '│----\n';
        const sepBytes = Buffer.byteLength(sep, 'utf8');
        if (
          byteSize + headerBytes + blockBytes + sepBytes + resultBytes + closingBytes >=
          MAX_BYTE_SIZE
        ) {
          limitReached = true;
          break;
        }
      }
      block += sep + resultStr;
      blockBytes += Buffer.byteLength(sep, 'utf8') + resultBytes;
      wroteLine = true;
    }

    // 只有该文件至少放进了一条结果,才提交 header + 正文 + 收尾,并记一条 source。
    if (wroteLine) {
      output += fileHeader + block + closing;
      byteSize += headerBytes + blockBytes + closingBytes;
      sources.push({ file: rel, lines: String(fileResults[0].line) });
    }
    if (limitReached) break outer;
  }

  if (limitReached) {
    const msg = `\n[Results truncated due to exceeding the ${MAX_RIPGREP_MB}MB size limit. Please use a more specific search pattern.]`;
    if (byteSize + Buffer.byteLength(msg, 'utf8') < MAX_BYTE_SIZE) output += msg;
  }

  return { result: output.trim(), sources };
}
