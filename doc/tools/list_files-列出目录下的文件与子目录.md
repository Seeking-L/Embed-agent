# `list_files` —— 列出目录下的文件与子目录(不递归)

> 状态:✅ 已实现|最近同步:M3|代码位置:`packages/agent-core/src/tools/list_files.ts`(+ 守门员 `tools/paths.ts`)

## 1. 一句话总结

让 LLM 在读文件之前先「探明目录里有什么」——某文件是 PDF 还是 `.c`?有没有同名 `.h`/`.c` 配对?文件多大(决定要不要分段读)?当用户问「工程里有哪些文件」,或 agent 不确定路径、需要先侦察目录结构时被调用。**只列一层,不递归。**

## 2. 接口契约

- **`name`**:`list_files`
- **`description`(给 LLM 看的原文)**:

  ```
  列出工作区或允许范围内某个目录的文件与子目录(不递归)。

  用途:在读文件之前先探明目录里有什么、文件是不是 PDF、有没有同名的 .h/.c 配对等。
  参数:
    - path(可选,默认 "."):要列出的目录路径(相对工作区根,或允许范围内的绝对路径)。
  返回:每行一条,形如:
    - "[D] subdir/"   表示子目录
    - "[F] file.txt   1.2 KB"   表示文件 + 大小(KB / MB)
  最多返回 200 条;超出会标注「…(已截断)」。

  提示:看到大文件(> 50 KB / > 1500 行)时,read_file 时记得用 start_line + limit 分段读。
  ```

- **`inputSchema`**:

  | 参数 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | `path` | string | ❌ | `"."` | 目录路径;不填 = 列工作区根 |

  `additionalProperties: false`;无 `required`(`path` 可选)。

- **返回(`ToolResult`)**:
  - `result`(string):每行一条,目录在前(`[D] name/`)、文件在后(`[F] name   size`),空目录返回 `(空目录)`,超 200 条尾部标注 `…(已截断,共 N 条,只显示前 200)`。
  - `sources`:`[{ file: '相对路径/' }]`(末尾带 `/`,提示这是目录)。
  - **拒绝**通过 `result` 返回(`拒绝:` 开头),不抛异常:越界路径、或对「非目录」调用(让 LLM 改用 `read_file`)。

- **`requiresConfirm`**:`false`。只读,无需确认。

## 3. 设计要点

- **工厂函数 + `FsToolConfig` 注入**:与 `read_file` 同款,allowedRoots 由 extension 注入(见 [`read_file`](./read_file-按行号分段读取工作区文件.md) 文档的设计要点 1)。
- **故意不递归**:三个理由——① 一次性 dump 整棵 `node_modules`/`vendor` 会撑爆上下文且大多无关;② LLM 自己会「看到子目录再 list 一次」,跟真人逛文件夹一样;③ 跨多层定位(`**/*.c`)留给 M4 的 `find_files`。
- **`[F]` 带文件大小**:这是和 `read_file`「大文件分段读」配合的关键 —— LLM 看到 `[F] stm32f103xb.h   812.0 KB` 就知道该用 `start_line`+`limit` 分段,而不是整读。description 末尾也直接点这条提示。
- **`readdir(..., { withFileTypes: true })`**:一次拿到 `Dirent`(带 `isDirectory()`/`isFile()`),不用对每个名字再 `stat` 判类型;但 `Dirent` 不带 size,所以对**文件**仍单独 `stat` 取大小。
- **目录在前 + 字母序**:`localeCompare` 对中文/Unicode 也合理,给 LLM 看更整齐。
- **`MAX_ENTRIES = 200` 截断**:防超大目录把上下文占满。

## 4. 核心代码节选

**排序(目录在前,再字母序)+ 拼行(文件带大小)**:

```ts
const entries = await readdir(abs, { withFileTypes: true });
entries.sort((a, b) => {
  if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1; // 目录在前
  return a.name.localeCompare(b.name);                                       // 再字母序
});

const lines: string[] = [];
let count = 0;
for (const e of entries) {
  if (count >= MAX_ENTRIES) {                          // 超 200 条截断
    lines.push(`…(已截断,共 ${entries.length} 条,只显示前 ${MAX_ENTRIES})`);
    break;
  }
  if (e.isDirectory()) {
    lines.push(`[D] ${e.name}/`);
  } else {
    const size = (await stat(path.join(abs, e.name))).size; // Dirent 无 size,单独 stat
    lines.push(`[F] ${e.name}   ${formatSize(size)}`);      // formatSize: B/KB/MB
  }
  count++;
}
```

> 路径安全校验(`resolveSafe`)、非目录拒绝、`formatSize` 实现详见代码。

## 5. 测试

- 单测位置:目前 `list_files` 无独立单测;路径安全这条公共命脉由 `tools/paths.test.ts` 覆盖(`resolveSafe` 的 6 个用例,`read_file` / `list_files` / `read_pdf` 共用同一守门员)。
- 手动验证场景(F5 调试宿主):
  - 「列一下当前文件夹有什么」→ `[D]`/`[F]` 列表、目录在前、文件带大小
  - 越界路径 → `拒绝:` 开头
  - 对文件(非目录)调用 → `拒绝:… 不是目录,请改用 read_file`
- TODO:补一份 `list_files.test.ts`(用临时目录造结构,断言排序 / 大小格式 / 200 截断)。

## 6. 已知局限 / 后续 TODO

- **不过滤忽略项** ⚠️:`node_modules/`、`.git/`、`dist/` 等都会被列出,**不读 `.gitignore`**。在真实工程里对这些大目录 `list_files` 会瞬间撞 200 上限、挤掉有用条目、白烧 token。计划:加硬编码 ignore 列表(轻量)或读 `.gitignore` + `ignore` 包(正规,配合 M4)。
- **无独立单测**(见上)。
- **不递归**:设计如此;跨层定位留给 M4 `find_files`。
- **多根工作区只认第一个**:`allowedRoots` 基于 `workspaceFolders[0]`(见 `ChatViewProvider.buildFsConfig`),multi-root 的其它文件夹读不到。
