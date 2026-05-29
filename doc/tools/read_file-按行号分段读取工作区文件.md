# `read_file` —— 按行号分段读取工作区文件

> 状态:✅ 已实现|最近同步:M3|代码位置:`packages/agent-core/src/tools/read_file.ts`(+ 守门员 `tools/paths.ts`)

## 1. 一句话总结

让 LLM 读到工作区(及允许范围)内**文本文件**的内容,带 `cat -n` 行号、支持 `start_line` + `limit` 分段读。当用户问「某文件里写了什么」「这段代码怎么实现的」,或 agent 需要基于真实文件作答时被调用。**不读 PDF(交 `read_pdf`)、不读二进制、不列目录(交 `list_files`)**——职责单一。

## 2. 接口契约

- **`name`**:`read_file`
- **`description`(给 LLM 看的原文)**:

  ```
  读取工作区或允许范围内文件的纯文本内容,带行号、支持分段。

  用途:查看源码、配置、文档(.md / .yaml / .json / .c / .h / .ts 等)。
  参数:
    - path(必填):相对工作区根的路径(如 "vendor/arduino-core-stm32/boards.txt"),
                  也可以是绝对路径,但必须落在允许的根目录内。
    - start_line(可选,默认 1):从第几行开始读,1-based。
    - limit(可选,默认 1500,硬上限 5000):最多读多少行。

  返回格式:
    - 头部一行元数据:[文件 <相对路径> 共 N 行,展示 a-b 行]
    - 之后是 cat -n 风格的内容:每行以"行号 + tab"开头(行号是元数据,不属于文件本体)。
    - 行数超过 limit 或字节超过 400 KB 时,末尾会标注「…(已截断,下一段请用 start_line=N 续读)」。

  注意:
    - 大文件(> 50 KB)请优先用 start_line + limit 分段读,不要整读。
    - 本工具不读 PDF / 二进制文件(.elf / .bin / .hex);请改用 read_pdf 或先 list_files 查看扩展名。
    - 单文件超过 20 MB 会被直接拒读。
  ```

- **`inputSchema`**:

  | 参数 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | `path` | string | ✅ | — | 文件路径(相对工作区根,或允许范围内的绝对路径) |
  | `start_line` | number | ❌ | `1` | 起始行号,**1-based** |
  | `limit` | number | ❌ | `1500` | 最多读多少行,硬上限 `5000` |

  `additionalProperties: false`(只接受上面三个键,LLM 加别的字段会被 SDK 拒)。

- **返回(`ToolResult`)**:
  - `result`(string):`元数据头 + cat -n 正文 + 可选截断尾`。例:

    ```
    [文件 vendor/foo/boards.txt 共 9821 行,展示 1-1500 行]

         1	# Generic STM32F103C8 (Blue Pill)
       ...
      1500	GenF1.menu.upload_method...

    …(已截断;还剩 8321 行。下一段请用 start_line=1501 续读,或改用 grep 类工具精确定位)
    ```
  - `sources`:`[{ file: '相对路径', lines: 'a-b' }]`。`loop.ts::stringifyResult` 会自动把它拼成「来源:\n- 相对路径:a-b」追加到结果末尾 → LLM 在最终答复里能引用到**具体行范围**。
  - **拒绝**也通过 `result` 返回(`拒绝:…` 开头),**不抛异常**——这样 loop 不会把会话推向错误流,LLM 能继续向用户解释。

- **`requiresConfirm`**:`false`。只读操作,符合 CLAUDE.md「read-heavy is free」,无需确认。

## 3. 设计要点

- **工厂函数而非常量**(`createReadFileTool(cfg)`):工具需要「允许读哪些目录」(`FsToolConfig`),而这个配置只有 extension(碰得到 `vscode.workspace`)能给。所以暴露工厂,extension 在注册时注入 —— 这是依赖注入,也是 agent-core 不依赖 `vscode` 的关键(见 M3 文档概念 2)。
- **三层闸门 + 二进制嗅探**(对应 CLAUDE.md「write-heavy is gated」的读侧表亲,防失控):

  | 层 | 触发 | 动作 |
  | --- | --- | --- |
  | L1 文件大小 | `stat.size > 20 MB` | 直接拒读(基本是误读日志/二进制) |
  | 二进制嗅探 | 头 512 字节含 NUL | 拒读(拦 `.elf/.bin/.o`) |
  | L2 行窗口 | 切片 > `limit`(默认 1500)行 | 截断,尾部给 `start_line=N+1` 续读提示 |
  | L3 字节兜底 | 输出 > 400 KB | 按字节截(防单行超长的 minified JS/SVG 撑爆) |

- **行号 + tab 前缀**:沿用 Claude Code 的 `cat -n` 风格。行号让后续 `Edit` / `propose_file_edit`(M4)能稳定定位;tab 让「行号到哪结束」对 LLM 无歧义。description 里明确「行号是元数据,不属于文件本体」,避免 LLM 把行号复制进答复。
- **截断尾部明写「下一步」**:`start_line=N+1 续读` / `grep 类工具`。这是让 LLM **主动续读**而非「放弃 / 瞎补」的关键策略,业界(Claude Code / Cline / Codex)都验证过(见 M3 文档概念 5)。
- **路径安全统一走 `resolveSafe`**(`tools/paths.ts`):handler 第一行就校验,前缀比较 + `path.sep` 防 `vendor2` 假冒 `vendor`,详见 `paths.ts` 与 M3 文档概念 3。

## 4. 核心代码节选

只截最能体现设计的两段,其余详见 `read_file.ts`。

**① 三层闸门的执行顺序**(handler 主干):

```ts
const st = await stat(abs);
if (st.isDirectory()) return { result: `拒绝:${p} 是目录,请改用 list_files。` };
if (st.size > MAX_FILE_SIZE) return { result: `拒绝:… 超过单文件 20 MB 限制。…` }; // L1

// 二进制嗅探:peek 头 512 字节,扫到 NUL 即拒(用 try/finally 关 fd,防句柄泄漏)
const fh = await open(abs, 'r');
try {
  const peek = Buffer.alloc(BINARY_PEEK_BYTES);
  const { bytesRead } = await fh.read(peek, 0, BINARY_PEEK_BYTES, 0);
  if (peek.subarray(0, bytesRead).includes(0)) return { result: `拒绝:… 二进制文件 …` };
} finally {
  await fh.close();
}
```

**② cat -n 格式化 + 「下一步」截断尾**:

```ts
// padStart(6) 把行号补到 6 字符宽对齐;\t 分隔行号与正文
let body = lineSlice
  .map((line, i) => `${String(startIdx + i + 1).padStart(6)}\t${line}`)
  .join('\n');

const header = `[文件 ${displayPath} 共 ${totalLines} 行,展示 ${startLine}-${lastLineNum} 行]\n\n`;
let footer = '';
if (lineTruncated) {
  footer = `\n\n…(已截断;还剩 ${totalLines - lastLineNum} 行。下一段请用 start_line=${lastLineNum + 1} 续读,或改用 grep 类工具精确定位)`;
}
return { result: header + body + footer, sources: [{ file: displayPath, lines: `${startLine}-${lastLineNum}` }] };
```

> 参数归一化(`start_line`/`limit` 夹到合法区间)、空文件特例、L3 字节截断等详见代码。

## 5. 测试

- 单测位置:`packages/agent-core/src/tools/read_file.test.ts`(+ 路径安全 `tools/paths.test.ts`)
- 覆盖场景:
  - ✅ 正常读小文件:内容读到 + `sources[0].file` 是相对路径
  - ✅ 越界路径(`../../../etc/passwd`):返回 `拒绝:` 开头(**不抛异常**)
  - ✅ `start_line=4, limit=3` 分段读:头部「展示 4-6 行」、含 line4~6 不含 line7、尾部带 `start_line=7`、`sources.lines === '4-6'`
  - ✅ 二进制文件(含 NUL):返回 `拒绝:…二进制`
  - ✅ `start_line` 超过总行数:返回 `拒绝:…超过文件总行数`
  - `paths.test.ts` 另覆盖 6 例路径安全(含 `vendor2` 类前缀攻击的历史 CVE 模式)

## 6. 已知局限 / 后续 TODO

- **不递归**:只读单个文件;遍历目录是 `list_files` 的事,跨多层定位留给 M4 的 `find_files`/`grep_file`。
- **二进制嗅探有盲区**:Intel HEX(`.hex`)、`.map`、`.lst` 是纯 ASCII 文本,头 512 字节无 NUL,嗅探拦不住 —— 靠 system prompt 提醒 LLM 别读(见 M3 附录 B)。
- **L3 按字节切可能切坏 UTF-8 边界**:不追求完美边界,LLM 容错足够;真要精确按 token 截断留到 M5。
- **非 UTF-8 编码不支持**:GB18030 等会乱码;后续可加 `encoding` 参数或 `chardet` 嗅探(M5)。
- **无 mtime 去重缓存**:Cline 有「同文件重复读时复用」,M3 会话短,优先级低,暂不做。
