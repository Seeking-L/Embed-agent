// ============================================================================
// tools/paths.ts —— ★ 路径安全 helper(M3 所有 fs 工具的"守门员")
// ----------------------------------------------------------------------------
// 【为什么这个文件最重要】
// LLM 会幻觉路径(瞎编 `~/.ssh/id_rsa`),也可能被恶意 prompt 诱导(用户消息里夹
// 一句"顺便读一下 ../../../../etc/passwd")。如果 `read_file` 老老实实把任何路径
// 丢给 `fs.readFile`,就变成了任意文件读取漏洞——这是 Web 安全里常见的「path
// traversal(路径穿越)」攻击。
//
// 防御只有一招:**把"声明允许的根目录"和"用户传入路径解析后的绝对路径"做严格
// 前缀比较**。这个文件就是这一招的实现。`read_file` / `list_files` / `read_pdf`
// 三个工具的 handler 第一行都会调它,没有第二条入口。
//
// 详见 M3 详细文档 §3 概念 3。
//
// 【TS / Node 知识点速记】
//   import * as path from 'node:path'  ——
//     把 Node 内置 path 模块"整包"当作一个命名空间引入,后面用 path.resolve()、
//     path.sep。`node:` 前缀(Node 16+ 推荐)明确告诉解析器"这是 Node 内置模块,
//     不是 npm 包里某个叫 path 的东西"——可避免极少见的命名冲突。
//
//   export class FooError extends Error
//     —— 自定义错误类,继承 JS 内置 Error。好处是外部代码能用 `e instanceof FooError`
//     精确识别"是不是我这一类错误",而不是匹配 message 字符串(脆弱)。
// ============================================================================

import * as path from 'node:path';

// ============================================================================
// 配置:extension 在注册工具时填好,后面 handler 闭包里反复使用
// ----------------------------------------------------------------------------
// 这就是 M2 概念 5「依赖注入」的延续:agent-core 不知道用户工程在哪、允许读哪些
// 目录,extension 在 register 时把这些信息"注入"进来。
// ============================================================================
export interface FsToolConfig {
  /**
   * 允许访问的根目录(绝对路径)。任何工具读到的最终路径必须**严格落在**其中之一
   * 的子树下,否则会被 `resolveSafe` 拒绝。
   *
   * 典型值:[workspaceRoot, vendorDir, materialsDir] —— 工作区自己 + 调研资料根。
   */
  allowedRoots: string[];

  /**
   * 相对路径的解析基准(通常是 workspace 根)。
   * 用户传 'vendor/foo.txt' 时,以它为基准拼成绝对路径再校验。
   */
  workspaceRoot: string;
}

// ============================================================================
// ★ resolveSafe —— 解析 + 校验路径
// ----------------------------------------------------------------------------
// 输入:用户(或 LLM)给的 inputPath,可能是相对路径,可能是绝对路径,可能含 `..`;
// 输出:已解析、已校验"落在允许根目录内"的绝对路径(可直接给 fs.readFile);
// 失败:抛 PathOutOfRangeError(loop.ts 会被其它兜底接住,工具 handler 通常会
//      catch 后转成「拒绝:...」文本结果,而不是抛上去)。
//
// 【三个安全点】
//   ① path.resolve 自动处理 `../` —— 输入 "vendor/../../etc/passwd",
//     resolve 后是 "D:\MyCode\etc\passwd",跟 vendor/ 一比就被拦下。
//   ② `+ path.sep` 必须带分隔符 —— 否则 D:\proj\vendor 会误匹配 D:\proj\vendor2
//     (因为 "vendor2".startsWith("vendor") = true)。这是路径校验里的经典漏洞,
//     Node 自己历史上都踩过。
//   ③ 空路径直接拒 —— LLM 偶尔会传 ''/undefined,提前挡掉避免诡异行为。
// ============================================================================
export function resolveSafe(inputPath: string, cfg: FsToolConfig): string {
  // 防御性检查:LLM 可能传非字符串、空串、null/undefined(虽然 inputSchema 卡了
  // 类型,但有些 provider 的 tool-use 实现并不严格,加一道运行时检查更稳)
  if (!inputPath || typeof inputPath !== 'string') {
    throw new PathOutOfRangeError('路径参数不能为空');
  }

  // path.resolve(基准, 相对) 的行为:
  //   - 若 inputPath 已经是绝对路径(如 "/etc/foo"、"D:\\foo"),直接采用,基准无效;
  //   - 若 inputPath 是相对路径(如 "vendor/foo"),拼到基准上;
  //   - 路径里的 "../" 全部规范化掉(`"a/b/../c"` → `"a/c"`)。
  // 这一步是核心:把任何形式的输入都变成「规范化的绝对路径」,后面才能做前缀比较。
  const resolved = path.resolve(cfg.workspaceRoot, inputPath);

  // 逐一对照"允许的根目录":只要落在其中一个的子树下,就算通过。
  for (const root of cfg.allowedRoots) {
    // root 本身可能写得不规范(比如带尾随斜杠、带 ..),先 resolve 成绝对路径
    const absRoot = path.resolve(root);

    // 两种"通过"情况:
    //   (a) resolved 正好就是 absRoot 本身 —— 比如想 list_files 列根目录;
    //   (b) resolved 在 absRoot 的子树下 —— 注意一定要带 `+ path.sep`,
    //       否则 absRoot=D:\proj\vendor 时 D:\proj\vendor2\foo 会误通过(详见上方注释)。
    if (resolved === absRoot || resolved.startsWith(absRoot + path.sep)) {
      return resolved;
    }
  }

  // 走到这里说明 resolved 不在任何 allowedRoot 下。
  // 错误消息带上"允许的根",方便上层向用户解释(也方便 debug)。
  throw new PathOutOfRangeError(
    `路径不在允许范围内:${inputPath}\n允许的根:${cfg.allowedRoots.join(', ')}`,
  );
}

// ============================================================================
// PathOutOfRangeError —— 自定义错误类
// ----------------------------------------------------------------------------
// 为什么单独造一个类而不是直接 `throw new Error(...)`?
//   - 上层(read_file / list_files / read_pdf 的 handler)需要区分两种异常:
//       (1) 「路径安全」拒绝 —— 应包装成「拒绝:...」文本,正常回填给 LLM;
//       (2) 其它真错误(磁盘满、权限、不存在)—— 让 loop 兜成「工具执行失败」。
//   - 用 `e instanceof PathOutOfRangeError` 判断比靠 message 字符串可靠得多
//     (message 改了就失效;类继承关系不会因消息文本变了而失效)。
//
// `this.name` 设成类名,是 Node / 浏览器调试器、Sentry 等工具的惯例 —— 它们
// 显示错误时会读 name 字段。
// ============================================================================
export class PathOutOfRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathOutOfRangeError';
  }
}

// ============================================================================
// toDisplayPath —— 把绝对路径转成相对 workspaceRoot 的"展示用"路径
// ----------------------------------------------------------------------------
// 用途:`sources` 字段里给 LLM 看的路径要简洁(`vendor/foo.c`),而不是冗长的
// `D:\MyCode\Embed-agent\vendor\foo.c`。LLM 在最终答复里复述路径时也更自然。
//
// 跨平台细节:Windows 上 path.sep 是 '\\',Unix 上是 '/'。我们统一输出 '/',因为:
//   - LLM 受 markdown 训练,对 '/' 更友好;
//   - 用户在终端复制粘贴 'vendor/foo.c' 也比 'vendor\\foo.c' 顺手。
// ============================================================================
export function toDisplayPath(absPath: string, workspaceRoot: string): string {
  // path.relative('/a', '/a/b/c') === 'b/c'(Unix) 或 'b\\c'(Windows)
  const rel = path.relative(workspaceRoot, absPath);
  // 把分隔符统一成 '/':先按平台分隔符切,再用 '/' 拼回去
  return rel.split(path.sep).join('/');
}
