# `search_files` —— 用 ripgrep 按正则搜文件内容(grep)

> 状态:✅ 已实现 | 最近同步:M4 | 代码位置:`packages/agent-core/src/tools/search_files.ts`(单测 `search_files.test.ts`)
>
> 选型依据:[`../写文件-网络-grep-实现对比与选型.md`](../写文件-网络-grep-实现对比与选型.md) §4(结论:以 Cline 的 ripgrep service 为蓝本)。

## 1. 一句话总结

让 LLM 在「不知道某符号/字符串在哪个文件」时,用 ripgrep 按【正则】搜出 `file:line` + 上下文。它是「先 grep 定位、再 read_file 精读」工作流的入口——`read_file` 对大文件会截断,必须靠它定位关键字。只读,不需确认。

## 2. 接口契约

- **`name`**:`search_files`
- **`description`(给 LLM 看)**:用 ripgrep 按正则搜索;强调【Rust 正则】(无 lookahead/反向引用、字面花括号要转义);默认上限 300 条 / 0.25 MB;已自动排除 node_modules/dist 等噪声目录。原文见代码。
- **`inputSchema`**:

  | 参数 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | `pattern` | string | ✅ | — | 搜索正则(Rust 语法) |
  | `path` | string | | `"."` | 搜索目录(相对工作区根 / 允许范围内绝对路径),递归 |
  | `file_pattern` | string | | `"*"` | glob 过滤,如 `*.c` / `*.{h,c}` |

- **返回**(`ToolResult`):`result` 是按文件分组的 `│` 前缀文本(头部 `Found N results.`,命中行 + 各 1 行上下文);`sources` 每个命中文件一条 `{ file, lines }`(`lines` 取该文件首个命中行)。
- **`requiresConfirm`**:false(读操作,`CLAUDE.md`「read-heavy is free」)。

## 3. 设计要点

- **蓝本 = Cline `services/ripgrep/index.ts`**:`rg --json` 模式 + `readline` 逐行解析;**双重封顶**(`MAX_RESULTS=300` 条 / `MAX_RIPGREP_MB=0.25`);命中按文件分组的 `│` 输出。常量与 Cline 1:1。
- **三处相对 Cline 的改造**:
  1. **ripgrep 路径靠注入**(`GrepToolConfig = FsToolConfig & { ripgrepPath }`)——agent-core 不依赖 vscode;extension 用 `resolveRipgrepPath()`(优先 `vscode.env.appRoot` 下 VS Code 自带的 rg,兜底 PATH)注入。
  2. **`stdin: 'ignore'`**(抄 Codex `spawn.rs`):否则 ripgrep 的「读 stdin」启发式可能让进程永久阻塞。
  3. **★ `--no-ignore` + 固定噪声 glob**:本项目把 `vendor/` 与 `MeterialsForResearch/`(=两个 allowedRoots 调研资料根)写进了 `.gitignore`,而 ripgrep 默认会跳过 gitignore 目录 → 那样就搜不到调研资料。故关掉 ignore,改用 `NOISE_EXCLUDES`(node_modules/.git/dist/out/coverage/*.vsix)过滤垃圾。
- **跨平台**:`crlfDelay: Infinity`(Windows 上拆开的 `\r\n` 也当一个换行,保证每行 JSON 可 `JSON.parse`);路径统一 `toDisplayPath` 转 posix 相对。
- **不用 `vscode.workspace.findTextInFiles`**:那会让本工具依赖 vscode、破坏「纯 TS 可离线单测」。用 `child_process.spawn` 起 rg(node 内置,被禁的只有 vscode)。

## 4. 核心代码节选

- `execRipgrep`:`spawn(rg, args, { stdio:['ignore','pipe','pipe'] })` + `readline` 收集;到 `MAX_STREAM_LINES`(=1500)就 `proc.kill()`(跨平台版 `head`);按退出码 0/1=正常、其它=错误。
- `parseRipgrepJson`:只看 `match` / `context` 事件。**易错点**:rg 按行序吐事件,「前文」(before-context)**先于** match 到达 → 用 `pendingBefore` 缓冲,等 match 来再挂上;「后文」(行号 > 命中行)直接挂当前命中。
- `formatResults`:`│` 分组输出 + **边拼边算字节**的封顶(用带标签的 `break outer` 跨多层跳出)。

> 详细逐行注释见 `search_files.ts`。

## 5. 测试

- 位置:`packages/agent-core/src/tools/search_files.test.ts`。
- 策略:**不 spawn 真实 rg**(CI 三平台不保证 PATH 有 rg),而是把纯函数 `parseRipgrepJson` / `formatResults` 拎出来,喂「rg --json 的原始行」/`SearchResult[]` 断言。
- 覆盖:match+前后 context 配对、坏行跳过、非 UTF-8 行兜空串、`│` 分组、`Found N`/`Found 1`/`Showing first 300` 头部、sources 去重。spawn/readline 那层靠 F5 手动联调。

## 6. 已知局限 / 后续 TODO

- **`output_mode` 只做了「content + 上下文」一种**;Claude Code 的 `files_with_matches` / `count` 三模式未做(起步够用,旋钮以后再加)。
- 未暴露 `-i`(忽略大小写)/ `multiline` / `--type` 等旋钮。
- `--no-ignore` 是全局的:除 `NOISE_EXCLUDES` 外不再尊重任何 `.gitignore`/`.ignore`。因为关掉 gitignore 后可能搜到本被忽略的密钥文件,`NOISE_EXCLUDES` 已额外排除 `.env*` / `*.pem` / `*.key` / `*.p12` / `id_rsa*` / `*.tfstate` 等敏感文件(dotfile 另由 ripgrep 默认跳过隐藏文件兜底)。若将来想「尊重 gitignore 但仍搜 vendor」,需更细的策略。
- `RG_TIMEOUT_MS=30s` 是我们加的兜底(Cline 无);超大库可能触发。
- 上下文归属:命中行的「后文」只取紧邻的 ±`CONTEXT_LINES` 行;否则会把远处下一条命中的「前文」错挂过来(已修)。
