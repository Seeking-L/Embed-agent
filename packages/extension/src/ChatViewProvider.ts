// ============================================================================
// ChatViewProvider.ts —— 侧边栏聊天视图的「后端」
// ----------------------------------------------------------------------------
// 【一句话回顾】M1 → M2 的变化:
//   M1 时这里是「echo 占位」——把用户消息原样当成助手回答吐回去。
//   M2 把它换成「真 agent」:
//     收到用户消息 → 读 API key / 用户配置 → 造对应 provider 的 adapter
//                  → 跑 runAgent(工具循环,见 doc §3 概念 1)
//                  → 把循环吐出的 AgentEvent 一一翻成 ExtToWebview 发给前端。
//
// 【为什么这些事不直接放进 agent-core?】
//   agent-core 是「纯 TS」(见 doc 概念 8):它不依赖 vscode、不读文件、不弹窗。
//   于是以下三件「外部能力」由 extension 实现,通过参数「注入」给 agent-core
//   (见 doc 概念 5「依赖注入」):
//     - API key   :extension 从 SecretStorage 读出明文,作为参数传给 adapter;
//     - 确认弹窗  :extension 实现 confirm(req)→Promise<boolean>,内部把
//                  requestConfirm 发给 webview、等 confirmResponse 回来再 resolve;
//     - 取消(stop):extension 持有 AbortController,把 signal 喂给 runAgent;
//                  用户点「停止」 → abort()(见 doc 概念 6)。
//
// 【这个类的 5 件事】(对照 doc 10.2 的概览):
//   ① 接收 webview 消息(onMessage):区分用户消息 / 取消 / 确认响应,各自路由;
//   ② 真正处理用户消息(handleUserMessage):读 key → 造 adapter → 跑 runAgent
//      → 把循环吐出的事件翻成发给前端的消息;
//   ③ 实现确认原语(askConfirm):把「await confirm()」变成「发 requestConfirm +
//      等 confirmResponse」(见 doc 概念 5 的请求/响应配对);
//   ④ 保管会话状态:history(多轮记忆)、pendingConfirms(待确认表)、
//      abort(取消器)、totalUsage(token 累计);
//   ⑤ (M1 原样保留)resolveWebviewView / getHtml / makeNonce:webview 的 HTML 外壳与 CSP。
//
// 【附带】可视化设置面板(见 doc 步骤 13)的后端 4 个 case + 4 个方法:
//   getConfig / saveConfig / setApiKey / clearApiKey ——它们和工具循环无关,
//   纯属「配置读写」,但都走同一条 RPC 通道,所以放在同一个 onMessage 里。
// ============================================================================

// VS Code 插件 API。只能在 Node 端(extension 进程)用,webview 进程禁用。
// `import * as vscode`:把整包当一个命名空间引入,后面用 vscode.window.xxx。
import * as vscode from 'vscode';
// Node 内置 path 模块——拼接 allowedRoots 时要用 path.join,跨平台。
// 用 `node:` 前缀明确"这是 Node 内置,不是 npm 包"。
import * as path from 'node:path';
// 同步判断文件是否存在——给 resolveRipgrepPath 探测 VS Code 自带的 rg 二进制路径用。
import { existsSync } from 'node:fs';

// 共享协议:同一份 TS 类型前后端共用(改协议先改 shared,是 M1 立下的规矩)。
//   WebviewToExt :前端 → 后端的消息(用户输入、取消、确认响应、配置面板请求…);
//   ExtToWebview :后端 → 前端的消息(流式增量、工具事件、token 用量、确认请求…);
//   AgentConfig  :用户配置(provider / model / baseURL)的 TS 形状;
//   LlmProvider  :'anthropic' | 'openai' | 'deepseek' 的字面量联合类型。
// `import type { … }`:只在编译期借用类型,运行时不会引入运行代码——纯类型、零开销。
import type { WebviewToExt, ExtToWebview, AgentConfig, LlmProvider } from '@embed-agent/shared';

// agent-core 的公共出口。值导入(运行时也要)+ 类型导入(仅编译期)写在一起:
//   ToolRegistry   :工具注册表,带「防重名」的 Map(见 doc 步骤 4.1);
//   createAdapter  :工厂函数,按 provider 选 Anthropic / OpenAI adapter(见 doc 步骤 7.2);
//   runAgent       :★ 核心工具循环,async generator(见 doc 步骤 8、概念 1);
//   type ChatTurn  :provider 无关的「一条对话消息」(user / assistant / tool 可辨识联合);
//   type ConfirmRequest:确认请求的形状 { id, toolName, summary }(见 doc 概念 5)。
import {
  ToolRegistry,
  createAdapter,
  runAgent,
  // ★ M3:真实只读工具的工厂函数 + 路径安全配置类型
  //   它们都是「工厂」而非「常量」——必须先给 allowedRoots / workspaceRoot 才能造出
  //   实际的 ToolSpec(见 doc §3 概念 2「工厂模式」)。
  createReadFileTool,
  createListFilesTool,
  createReadPdfTool,
  // ★ M4:写文件 / grep / 网络工具的工厂 + 写文件确认原语的请求类型。
  createSearchFilesTool,
  createProposeFileEditTool,
  createWebFetchTool,
  type FsToolConfig,
  type ProposeEditRequest,
  type ChatTurn,
  type ConfirmRequest,
} from '@embed-agent/agent-core';

// SecretStorage 里存储 API key 用的「键名」。
// 用一个常量收口:写一处、改一处——避免后面手抖打错键名导致 key 读不出来。
// 该键名要与 extension.ts 里 Set/Clear API Key 命令使用的键名保持一致。
const SECRET_KEY = 'embed-agent.apiKey';

// ============================================================================
// 【M4 diff-first】「提议内容」的只读虚拟文档 scheme
// ----------------------------------------------------------------------------
// 写文件遵循 CLAUDE.md「Diff-first, not autonomous-write」:改动落盘前,先在 VS Code 原生
// diff 编辑器里展示给用户。diff 的左右两侧都用「虚拟只读文档」承载(落盘前【绝不碰磁盘】):
//   - 做法抄 Cline:把文档内容用 base64 塞进 URI 的 query 里,provider 解码即可——
//     无状态、不需要 Map 缓存(内容不同 → URI 不同 → 不会串)。
//   - 这个 scheme 注册一次(见 ChatViewProvider 构造函数),进程内全局有效;虚拟文档天然只读。
const DIFF_SCHEME = 'embed-agent-diff';

// 无状态 content provider:把 uri.query 当 base64 解码成文档内容。
const diffContentProvider: vscode.TextDocumentContentProvider = {
  provideTextDocumentContent(uri: vscode.Uri): string {
    return Buffer.from(uri.query, 'base64').toString('utf-8');
  },
};

// 造一个「装着指定内容」的虚拟只读文档 URI:形如  embed-agent-diff:<显示名>?<base64 内容>。
// 转义 % # ?(它们会破坏 Uri.parse 对 scheme 部分的解析;真正的内容放在 query 里)。
function virtualUri(displayName: string, content: string): vscode.Uri {
  const safeName = displayName.replace(/%/g, '%25').replace(/#/g, '%23').replace(/\?/g, '%3F');
  return vscode.Uri.parse(`${DIFF_SCHEME}:${safeName}`).with({
    query: Buffer.from(content, 'utf-8').toString('base64'),
  });
}

// 【类的定义】VS Code 注册「侧边栏 webview」必须实现 WebviewViewProvider 接口,
// 接口只规定一个方法 resolveWebviewView。我们把所有状态(history / abort / registry …)
// 也放在这个类里——extension.ts 在 activate() 里 new 一次本类,然后
// registerWebviewViewProvider 注册给 VS Code;视图打开时 VS Code 调用 resolveWebviewView。
//
// 【对 Vue 开发者的类比】可以把这个类粗略当成一个「Vue 组件的 setup 持久层」:
//   constructor ≈ setup() 里初始化的代码;
//   private 字段 ≈ ref/reactive(只在「这个组件」生命周期内活着);
//   resolveWebviewView ≈ onMounted(挂载时初始化 DOM/事件);
//   onMessage ≈ 自定义事件总线的回调。
// 区别:这是 OOP class,this 必须搞清楚指向(下面会反复出现「为什么要箭头函数」)。
export class ChatViewProvider implements vscode.WebviewViewProvider {
  // 必须与 package.json 里 contributes.views.<container> 的 id 完全一致。
  // VS Code 靠这个字符串把「视图位置」和「Provider 实例」配对。
  // static  :类级字段(不依赖某个实例,通过 ChatViewProvider.viewId 访问);
  // readonly:声明后不可再赋值,防止有人不小心把它改成别的字符串。
  static readonly viewId = 'embed-agent.chat';

  // 视图实例。在 resolveWebviewView 调用之前为 undefined,所以类型用 `?`。
  // `private`:只允许类内部访问(TS 编译期限制;约等于 Java 的 private)。
  // `?:`     :可选字段,等价于 `view: vscode.WebviewView | undefined`。
  private view?: vscode.WebviewView;

  // 多轮对话记忆(见 doc 概念 7):
  //   每轮把「用户消息 / 模型发言 / 工具结果」push 进同一个数组;
  //   下一轮把整个 history 再发给模型,模型才能「记得」上下文。
  //   这是「实例字段」,跨多次 handleUserMessage 复用——这就是「多轮对话」的物理依据。
  // 类型 ChatTurn[] 已经能容纳 user / assistant / tool 三种角色(可辨识联合)。
  private history: ChatTurn[] = [];

  // 工具注册表。构造函数里注册 read_file / list_files / read_pdf 三个只读工具。
  // 将来加更多工具(grep_file / propose_file_edit …)时,
  // 继续 register 即可——loop.ts 一行不动。这就是「工具可插拔」(见 doc 概念 4)的回报。
  // `readonly`:这个变量名永远指向同一个 Map 实例;Map 内部仍可被 register 添加成员。
  private readonly registry = new ToolRegistry();

  // 当前这一轮的「取消器」(见 doc 概念 6):
  //   - 每条新用户消息进来时 new 一个;
  //   - 把 abort.signal 一路传给 runAgent → adapter → SDK;
  //   - 用户点「停止」 → abort.abort() → SDK 抛 AbortError → loop 安静收尾。
  // 平时(没有在跑的请求)它是 undefined,所以可选(?)。
  private abort?: AbortController;

  // 待确认请求的对照表(见 doc 概念 5「请求 / 响应配对」):
  //   key   = requestConfirm.id;
  //   value = 那个 Promise 的 resolve 函数(参数 boolean:true 同意 / false 拒绝)。
  // askConfirm 创建 Promise 时把 resolve 存进来,然后 await 那个 Promise 等响应;
  // 用户点完按钮发回 confirmResponse,onMessage 里按 id 找到 resolve 调用它,
  // 那一刻 askConfirm 里的 await 才返回,loop 继续往下走。
  //
  // 为什么用 Map 而不是普通对象?
  //   - Map 的键能保留任意字符串、不会和 Object 原型属性冲突;
  //   - 迭代顺序明确;
  //   - delete 干净,不会留 undefined 残留。
  private readonly pendingConfirms = new Map<string, (approved: boolean) => void>();

  // 累计 token 用量(整个会话累加,不是单轮的)。
  //   - input  :请求送给模型的 token 数(prompt + history + tools);
  //   - output :模型生成的 token 数。
  // 每来一个 usage 事件就累加,然后把「最新总量」整体发给前端展示。
  // `readonly` 锁的是变量名;对象内部的字段还能被 `+=` 修改。
  private readonly totalUsage = { input: 0, output: 0 };

  // 【M4 diff-first】待 Apply/Reject 的「修改提议」配对表(和 pendingConfirms 完全同构):
  //   key = requestApplyDiff.id;value = 那个 Promise 的 resolve(applied:boolean)。
  private readonly pendingApplies = new Map<string, (applied: boolean) => void>();

  // 每个挂起提议对应「已打开的 diff 右侧 URI」,用户响应后据此精确关掉那个 diff tab。
  private readonly openDiffUris = new Map<string, vscode.Uri>();

  // 【read-before-edit】本会话被 read_file 读过的文件(绝对路径)集合。
  //   read_file 注册时传了 onRead 回调往里 add;propose_file_edit 改文件前查它「必须已读过」。
  private readonly readFiles = new Set<string>();

  // 【M4 写文件确认原语的「后端实现」】注入给 propose_file_edit(见 agent-core types.ts 的 ProposeFn)。
  //   四步:打开原生 diff → 发 requestApplyDiff 让前端弹卡片 → 等用户点 Apply/Reject → 关 diff;
  //   若 Apply,【此刻才】把 newContent 写盘(diff-first:落盘只发生在这一步)。
  //   写成箭头函数字段是为了把 this 绑死(它会被工具 handler 在「别处」调用,普通方法的 this 会丢)。
  private readonly propose = async (req: ProposeEditRequest): Promise<boolean> => {
    const fileName = path.basename(req.absPath);
    // 左右两侧都是只读虚拟文档:左=原文,右=提议内容。用户改不了,只能在卡片上 Apply/Reject。
    const leftUri = virtualUri(`${fileName}(原始)`, req.originalContent);
    const rightUri = virtualUri(`${fileName}(提议)`, req.newContent);
    const title = `${req.path}:原始 ↔ Embed Agent 提议(只读预览)`;
    // preview:false → 让它成为稳定 tab(否则下一个 diff 会顶掉它)。
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, {
      preview: false,
      preserveFocus: false,
    });
    this.openDiffUris.set(req.id, rightUri);

    // 把「等用户点按钮」包装成挂起的 Promise(和 askConfirm 同一套路:存 resolve、发消息、等响应)。
    const applied = await new Promise<boolean>((resolve) => {
      this.pendingApplies.set(req.id, resolve);
      this.post({ type: 'requestApplyDiff', id: req.id, path: req.path, summary: req.summary });
    });

    await this.closeDiffTab(req.id);
    if (applied) await this.writeProposed(req); // ★ 落盘只在用户点了 Apply 之后发生
    return applied;
  };

  // 【构造函数】由 extension.ts 在 activate() 里 new ChatViewProvider(context, output)。
  //
  // 参数前加 `private readonly` 是 TS 的「参数属性」简写——
  //   等价于:
  //     private readonly context: vscode.ExtensionContext;
  //     constructor(context) { this.context = context; }
  // 大幅减少样板代码,大型类里特别好用。
  //
  // context :插件运行时上下文(里面有 secrets / extensionUri / globalState …);
  // output  :插件自己的 Output 频道(用户在「输出」面板里能看到我们写的日志)。
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    // 注册 M3 的真实只读工具(read_file / list_files / read_pdf)。
    // (M2 的演示工具 get_current_time / run_demo_command 已在 M3 移除。)
    //
    // 为什么要在构造函数里就注册,而不是等 resolveWebviewView?
    //   - registry 是「实例字段」,在视图打开前就要可用(虽然实际不会被用,
    //     但保持"构造时立刻就绪"的不变量,代码更好理解)。
    //   - FsToolConfig 依赖的 workspaceRoot 在插件激活时就已确定(vscode.workspace
    //     当前能拿到);不需要等用户消息进来才计算。
    const fsCfg = this.buildFsConfig();
    // read_file 注册时传 onRead 回调:每读到一个文件就记进 readFiles(给 propose_file_edit
    // 的 read-before-edit 校验用)。
    this.registry.register(
      createReadFileTool(fsCfg, (abs) => this.readFiles.add(this.pathKey(abs))),
    );
    this.registry.register(createListFilesTool(fsCfg));
    this.registry.register(createReadPdfTool(fsCfg));

    // ★ M4 新工具:
    //   - search_files(grep):注入 ripgrep 路径(agent-core 不碰 vscode);
    //   - web_fetch:无需配置(碰网络、不碰文件系统);
    //   - propose_file_edit:注入 ProposeFn(this.propose)+ read-before-edit 判定(查 readFiles)。
    this.registry.register(
      createSearchFilesTool({ ...fsCfg, ripgrepPath: this.resolveRipgrepPath() }),
    );
    this.registry.register(createWebFetchTool());
    this.registry.register(
      createProposeFileEditTool(fsCfg, this.propose, (abs) =>
        this.readFiles.has(this.pathKey(abs)),
      ),
    );

    // 注册「提议内容」的只读虚拟文档 provider(diff 两侧靠它取内容,落盘前不碰磁盘)。
    this.context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffContentProvider),
    );

    this.output.appendLine(
      `[tools] M3/M4 工具已注册,allowedRoots = ${fsCfg.allowedRoots.join(' | ')}`,
    );
  }

  // ============================================================================
  // 【M3 新增】组装"允许读哪些目录"的配置
  // ----------------------------------------------------------------------------
  // agent-core 不能 `import 'vscode'`(M2 概念 8 的护栏),所以"当前 workspace 是哪
  // 个目录"这种信息必须由 extension 算好后注入。这就是"依赖注入"的具体应用。
  //
  // allowedRoots 默认包含三个:
  //   ① workspace 根本身(用户工程,LLM 能读源码 / 配置 / doc/)
  //   ② <workspace>/vendor/         —— 第三方/上游镜像(嵌入式方向解冻后会有大量内容)
  //   ③ <workspace>/MeterialsForResearch/ —— 调研用大文件(PDF/图)
  //
  // 即使这两个目录暂时不存在也无所谓:
  //   - resolveSafe 只校验"字符串前缀",不要求实际存在;
  //   - read_file/list_files 真正访问时若不存在,fs 会抛 ENOENT,loop 自然兜成
  //    「工具执行失败」,LLM 据此告诉用户"目录不存在,请确认"。
  //
  // 【没打开工作区时怎么办】vscode.workspace.workspaceFolders 可能是 undefined / 空数组
  //(用户直接打开 VS Code 没有 File→Open Folder);此时退回到插件目录本身,保证
  // resolveSafe 不会因为 workspaceRoot 缺失而崩。
  // ============================================================================
  private buildFsConfig(): FsToolConfig {
    // workspaceFolders 是一个数组(多根工作区支持多个);[0] 取第一个;`?.` 防 undefined。
    // .uri.fsPath 把 vscode.Uri 转成系统路径字符串(Windows 是 'D:\\...')。
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // ?? 是空值合并:workspaceFolder 是 undefined 时用插件自己的目录兜底。
    const workspaceRoot = workspaceFolder ?? this.context.extensionUri.fsPath;
    return {
      workspaceRoot,
      allowedRoots: [
        workspaceRoot,
        path.join(workspaceRoot, 'vendor'),
        path.join(workspaceRoot, 'MeterialsForResearch'),
      ],
    };
  }

  // 【生命周期】VS Code 在「视图第一次显示」或「视图重建」时调用本方法。
  // 折叠侧边栏再展开时,view 实例可能被销毁后重建,所以每次都要重新挂消息回调。
  resolveWebviewView(view: vscode.WebviewView): void {
    // 把 view 实例存起来,后续 post 时要用。
    this.view = view;

    // 配置 webview:
    //   enableScripts       :webview 默认不能跑 JS,我们要跑 React,所以打开;
    //   localResourceRoots  :安全限制——webview 默认只允许加载来自插件目录的资源;
    //                        把 dist/ 设为白名单根,我们打包好的 main.js / main.css
    //                        都在 dist/webview/ 下,能被加载。
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };

    // 真正「渲染页面」的一步:把 HTML 外壳字符串塞给 webview。
    // 这一句一执行,前端的 main.js 就会被加载,React 就 render 起来。
    view.webview.html = this.getHtml(view.webview);

    // 注册「收到 webview 消息」的回调。从前端 postToExt 发来的消息都会触发它。
    // 这里用箭头函数包一层,是为了「保留 this」——
    //   直接传 this.onMessage 时,回调内部的 this 在 VS Code 调用栈里可能是 undefined
    //   (JS 经典坑;Vue 的 methods 里你也遇到过类似的「事件回调里 this 丢失」)。
    view.webview.onDidReceiveMessage((msg: WebviewToExt) => this.onMessage(msg));
  }

  // 【小工具】给 webview 发消息,统一收口。包一下有两个好处:
  //   1) 类型卡死:参数必须是 ExtToWebview 联合里的一员,发错字段编译就报错;
  //   2) 容错:view 还没初始化时 `?.` 让它无声失败(理论上不会发生)。
  // postMessage 返回 Promise<boolean>,这里我们不关心结果,用 `void` 显式丢弃,
  // 避免「未处理的 Promise」lint 警告。
  private post(message: ExtToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  // 【消息总路由】收到 webview 消息后分发到具体处理。
  //
  // 因为 WebviewToExt 是可辨识联合(用 `type` 字段当标签),
  // `switch (msg.type)` 后 TS 会自动「窄化」msg 的形状——
  //   在 `case 'userMessage'` 分支里,msg 已经被收窄成有 `.text` 的那一支,
  //   写 `msg.text` 时编辑器有提示、类型也对得上。
  private onMessage(msg: WebviewToExt): void {
    switch (msg.type) {
      case 'userMessage':
        // handleUserMessage 是 async(返回 Promise),但 onMessage 本身签名是同步 void。
        // 这里不 await(让它在后台跑),用 `void` 显式标注「我故意不等」;
        // 如果在这里 await,VS Code 会等本次消息处理完再派下一条,无谓阻塞。
        void this.handleUserMessage(msg.text);
        break;

      case 'cancelStream':
        // 触发取消:runAgent 内部会从 SDK 抛 AbortError,
        // errors.ts 的 isAbortError 识别后让 loop 安静 return(不发 error 事件)。
        // `?.` 因为 abort 平时是 undefined(用户在没消息时也可能误点停止)。
        this.abort?.abort();
        // ★ 关键(见 review 发现⑥):若此刻正卡在「等用户点 确认/diff 卡片」上,runAgent 正
        //   await 在工具 handler 里、for-await 还没结束 → handleUserMessage 的 finally 也跑不到。
        //   loop 在 await handler 期间又不检查 abort 标志。所以光 abort() 会卡死,必须在这里
        //   【就地】把挂起的卡片一律兑现成「拒绝/放弃」,让那个 await 返回、loop 收尾。
        this.resolvePendingCards();
        this.output.appendLine('[user] 取消');
        break;

      case 'confirmResponse': {
        // 用户点了确认卡片的「允许 / 拒绝」。把那个正在 await 的 Promise 兑现。
        //
        // 这里多了一对 `{ … }`:给 case 加块级作用域,目的有二:
        //   1) 里面声明的 const resolve 不会泄漏到外层 switch;
        //   2) 避免和其它 case 重名(JS 中 case 默认共享一个作用域,常见踩坑点)。
        const resolve = this.pendingConfirms.get(msg.id);
        if (resolve) {
          // approved === true → 同意;false → 拒绝。
          // resolve(...) 这一调,askConfirm 里挂起的 await 就拿到值返回。
          resolve(msg.approved);
          // 用完即删:Map 不留过期 entry,也避免重复 resolve
          // (Promise 二次 resolve 是 no-op,但形式上不好看)。
          this.pendingConfirms.delete(msg.id);
        }
        this.output.appendLine(`[confirm] ${msg.id} -> ${msg.approved}`);
        break;
      }

      case 'applyDiffResponse': {
        // 用户在 diff 卡片上点了「应用 / 放弃」。兑现对应的挂起 Promise(propose 里在等它)。
        // 和 confirmResponse 同款机制,只是配的是 pendingApplies。
        const resolveApply = this.pendingApplies.get(msg.id);
        if (resolveApply) {
          resolveApply(msg.apply);
          this.pendingApplies.delete(msg.id);
        }
        this.output.appendLine(`[diff] ${msg.id} -> ${msg.apply ? '应用' : '放弃'}`);
        break;
      }

      // ↓↓↓ 可视化设置面板用的几条消息(见 doc 步骤 13)↓↓↓
      //   getConfig    :面板打开时来拉「当前配置 + 是否已设 key」;
      //   saveConfig   :保存 provider / model / baseURL 到 VS Code 用户设置;
      //   setApiKey    :存 key 到 SecretStorage(只写不读);
      //   clearApiKey  :删 key。
      // 这些和 agent-core / 工具循环都无关——纯属「面板配置」走的额外消息通道,
      // 复用了 M1/M2 的 type-safe RPC,所以放在同一个 onMessage 里。
      case 'getConfig':
        void this.sendConfigState();
        break;
      case 'saveConfig':
        // msg 已被 TS 收窄成「saveConfig 分支」,有 provider / model / baseURL 三个字段。
        void this.saveConfig(msg.provider, msg.model, msg.baseURL);
        break;
      case 'setApiKey':
        void this.storeApiKey(msg.key);
        break;
      case 'clearApiKey':
        void this.clearApiKey();
        break;
    }
  }

  // ============================================================================
  // 【主流程】处理一条用户消息——M2 后端的核心,整个函数对应 doc 概念 1 的流程图。
  //
  //   private :类外不能调用;
  //   async   :函数体内可以 await,函数自身返回 Promise<void>(没有具体返回值)。
  //
  // 高层流程:
  //   ① 读 API key,没有就报错退出;
  //   ② 读配置 → 造 adapter → 把用户消息 push 进 history → new 一个 AbortController;
  //   ③ for await 跑 runAgent,把循环吐出的每个事件翻成 ExtToWebview 发给前端;
  //   ④ finally 收尾:无论怎么结束都发 assistantDone、清理 abort、释放挂起的确认。
  // ============================================================================
  private async handleUserMessage(text: string): Promise<void> {
    this.output.appendLine(`[user] ${text}`);

    // —— ① 读 key ——
    // 没有就友好提示,别让请求带着空 key 撞 401。
    // secrets.get 是异步:VS Code 要去解密 SecretStorage,所以 await。
    // 返回 Promise<string | undefined>——没存过就是 undefined。
    const apiKey = await this.context.secrets.get(SECRET_KEY);
    if (!apiKey) {
      // 发 error(前端弹错误条)+ assistantDone(前端解锁输入框 / 关 spinner)。
      // 顺序:先 error 让用户看到,再 done 让 UI 恢复正常状态。
      this.post({
        type: 'error',
        message: '未设置 API key。请运行命令「Embed Agent: Set API Key」。',
      });
      this.post({ type: 'assistantDone' });
      return; // 提前返回,后面的步骤就不跑了
    }

    // —— ② 读配置,造 adapter,把用户消息记进历史,准备取消器 ——
    const config = this.readConfig();
    // createAdapter 是 agent-core 的工厂(见 doc 步骤 7.2)。
    // 它按 provider 内部选 Anthropic 或 OpenAI 那份具体 adapter;
    // key 在这里**只**作为参数传进去,不会写进任何文件、不会发出去。
    const adapter = createAdapter(config, apiKey);
    // 把本轮用户消息 append 到 history(实例字段,跨多轮存活)。
    // loop.ts 内部还会继续往这个数组里 push 模型发言、工具结果(传的是引用)。
    // 这就是「下一轮请求带着完整上下文」的物理依据(见 doc 概念 7)。
    this.history.push({ role: 'user', content: text });
    // 每轮 new 一个 AbortController;旧的(若存在)会被 GC 掉。
    this.abort = new AbortController();

    // —— ③ 跑工具循环,把每个事件翻成发给前端的消息 ——
    //
    // try/finally:不管循环里发生什么(正常结束、异常、被 cancel),
    // finally 都会执行——确保「告诉前端这轮完了 + 清理状态」一定会发生。
    // 这是非常关键的健壮性保障:没有 finally,异常情况下前端会一直停留在「streaming」状态。
    try {
      // 【流式消费】for await (const ev of asyncIterable):
      //   - 一次取一个值,期间自动等异步;
      //   - runAgent 返回 AsyncIterable<AgentEvent>(见 doc 概念 3 的 async generator)。
      // 这一行展开来就是:adapter 边收 LLM 流式响应、loop 边吐 AgentEvent、我们边发给前端。
      // 整条链路从模型 → SDK → adapter → loop → 这里 → webview 都是「边产边收」,
      // 所以用户能看到字一个个冒出来。
      for await (const ev of runAgent({
        adapter,
        registry: this.registry,
        model: config.model,
        history: this.history,
        // ← 注入确认实现(见 doc 概念 5):
        //   loop 里碰到需确认的工具会 `await confirm(req)`;
        //   我们这里把它「实现」成「发个 requestConfirm 给前端、等响应」。
        //   用箭头函数包一下,是为了在 askConfirm 里访问到正确的 this(类方法的常见绑定写法)。
        confirm: (req) => this.askConfirm(req),
        // ← 注入取消信号:loop 内部把它传给 adapter → SDK;
        //   abort() 后 SDK 抛 AbortError,loop 识别后 return,这里 for await 自然结束。
        signal: this.abort.signal,
      })) {
        // AgentEvent 也是可辨识联合,switch(ev.type) 同样会收窄类型。
        switch (ev.type) {
          case 'text':
            // 模型吐了一小段文字 → 流式发给前端,前端追加到当前助手气泡。
            // 前端的「追加到最后一条 assistant 气泡,否则新开一个」规则在 store.ts 里实现,
            // 自动处理「文字 → 工具 → 又文字」的穿插显示。
            this.post({ type: 'streamDelta', text: ev.text });
            break;
          case 'reasoning':
            // 思考型模型的"思考过程"片段(目前 DeepSeek thinking / R1 等会触发)。
            // 同时做两件事:
            //   ① post 给 webview,前端在助手气泡里渲染可折叠的「💭 思考过程」区;
            //   ② append 到 Output 面板,方便不开 webview 也能 debug 看模型思路。
            // 注意:即便前端选择不展示这段(比如未来加开关关闭),loop 也已经把它
            // 累加进 ChatTurn.reasoningContent → 下一轮请求自动带上,DeepSeek 不再 400。
            this.post({ type: 'reasoningDelta', text: ev.text });
            this.output.append(ev.text); // append 而不是 appendLine:片段流式拼接
            break;
          case 'toolStart':
            // 框架开始执行某个工具 → 前端时间线插一行「⏳ 工具 xxx 执行中」。
            this.output.appendLine(`[tool] ${ev.name} 开始`);
            this.post({ type: 'toolCallStart', id: ev.id, name: ev.name });
            break;
          case 'toolEnd':
            // 工具结束 → 前端把那一行的图标改成 ✅ 或 ⚠️。
            // ok === false 包括「被拒绝 / 超时 / 抛错 / 未知工具」等所有未成功的情况。
            this.output.appendLine(`[tool] ${ev.name} ${ev.ok ? '成功' : '失败'}`);
            this.post({ type: 'toolCallResult', id: ev.id, name: ev.name, ok: ev.ok });
            break;
          case 'usage':
            // 累计到 totalUsage,把「最新总量」整体发给前端。
            // 注意是 `+=` 累加,因为一轮多步可能有多个 usage 事件(每步一个)。
            this.totalUsage.input += ev.input;
            this.totalUsage.output += ev.output;
            this.post({
              type: 'tokenUsage',
              input: this.totalUsage.input,
              output: this.totalUsage.output,
            });
            break;
          case 'error':
            // 错误已被 agent-core 的 humanizeError 翻成人话(见 doc 概念 10),
            // 这里只负责转发——前端不该看到一堆红色堆栈,只看一句可读的话。
            this.post({ type: 'error', message: ev.message });
            break;
          case 'done':
            // 工具循环正式结束(模型不再要工具)。事件本身无字段;
            // 我们靠 finally 里的 assistantDone 解锁前端,不在这里 post。
            // 这里只是为了让 switch 覆盖所有 ev.type 分支(exhaustive),
            // TS 才不会报「未处理的 case」警告。
            break;
        }
      }
    } finally {
      // —— ④ 收尾 —— 不管正常结束还是抛异常,都会跑这一段:
      //
      // 1) assistantDone:前端解锁输入框、关流式 spinner——必须发,否则 UI 永远卡 streaming;
      this.post({ type: 'assistantDone' });
      // 2) abort 置空:下一轮再 new 一个新的;
      this.abort = undefined;
      // 3) 兜底:把任何还悬挂的 确认/diff 卡片一律以「拒绝/放弃」兑现(belt-and-suspenders;
      //    正常路径下它们早被用户点击兑现了)。真正打破「Stop 时卡死」靠的是 cancelStream 里
      //    提前调用同一个清理——见 resolvePendingCards 的说明。
      this.resolvePendingCards();
    }
  }

  // 【取消/收尾兜底】把所有还悬挂的「确认卡片」「diff 卡片」一律以 false(拒绝/放弃)兑现,
  // 关掉残留的 diff tab,并清空两张配对表。
  //
  // 为什么必须能「在取消时」单独调用,而不能只放在 handleUserMessage 的 finally 里:
  //   用户点 Stop 时,runAgent 可能正 `await` 在某个工具 handler 里(propose_file_edit 等着
  //   propose() 返回、或某工具等着 confirm() 返回),此时 for-await 还没结束 → finally 跑不到;
  //   loop 在 await handler 期间也不检查 abort 标志。于是只有在这里【就地】兑现挂起的 Promise,
  //   那个 await 才会返回、handler 完成、loop 发现已 aborted 后正常退出(否则永久卡死)。
  private resolvePendingCards(): void {
    for (const resolve of this.pendingConfirms.values()) resolve(false);
    this.pendingConfirms.clear();
    for (const [id, resolve] of this.pendingApplies) {
      resolve(false);
      void this.closeDiffTab(id);
    }
    this.pendingApplies.clear();
  }

  // read-before-edit 的 Set 键规整:Windows 文件系统大小写不敏感,read_file('Src/App.ts') 与
  // propose_file_edit('src/app.ts') 指同一文件却是两个不同字符串。这里在 win32 上统一小写,
  // 保证「读过」能被认出来,否则会误判「没读过」而拒绝一个合法编辑(见 review 发现⑧)。
  private pathKey(abs: string): string {
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  }

  // 【确认原语的「后端实现」】(见 doc 概念 5)
  //
  // loop 在跑需要确认的工具前会 `await confirm(req)`,那一刻我们要:
  //   1) 创建一个 Promise,先不 resolve;把它的 resolve 函数存进 pendingConfirms;
  //   2) 把 requestConfirm 发给前端,弹卡片;
  //   3) 把这个 Promise 返回出去——loop 那一行 await 就「卡」在这里。
  // 等用户点了允许 / 拒绝,前端发回 confirmResponse,在 onMessage 里我们按 id 找到
  // resolve 并调用它,此时 loop 那行 await 才返回 true/false,继续执行。
  //
  // 【关键技巧】这是异步编程里非常经典的「把回调变 Promise」——
  // new Promise((resolve) => { ... }) 里先把 resolve 存起来,以后在「另一个时空」(消息回调里)
  // 找出来调用,Promise 就在那一刻兑现。附录 A 有更细的速查。
  private askConfirm(req: ConfirmRequest): Promise<boolean> {
    return new Promise((resolve) => {
      this.pendingConfirms.set(req.id, resolve);
      this.post({
        type: 'requestConfirm',
        id: req.id,
        toolName: req.toolName,
        summary: req.summary,
      });
    });
  }

  // ===== 【M4】写文件 diff-first 的三个辅助方法 =====

  // 把提议内容写入磁盘——【只在用户点 Apply 后】被 propose 调用。
  // 用 vscode.workspace.fs.writeFile:整文件原子写,无论文件是否在编辑器里打开都行,且不会触发
  // 编辑器的「保存时自动格式化」——diff-first 要「所见即所得地落盘用户已审阅过的内容」。
  private async writeProposed(req: ProposeEditRequest): Promise<void> {
    const uri = vscode.Uri.file(req.absPath);
    if (req.isNewFile) {
      // 新建文件:先确保父目录存在(fs.writeFile 不会自动建目录)。
      //(当前 propose_file_edit 只改已存在文件,isNewFile 恒为 false;此分支为将来的
      //  propose_new_file 预留。)
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(req.absPath)));
    }
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(req.newContent));
    // 落盘后把文件展示出来,让用户立刻看到结果。
    await vscode.window.showTextDocument(uri, { preview: false });
  }

  // 关掉某条提议对应的 diff tab(按右侧虚拟 URI 精确匹配,避免误关别的 diff)。
  // 抄 Cline 的 closeAllDiffViews,但用 modified(右侧)的 scheme + uri 精确定位本条。
  private async closeDiffTab(id: string): Promise<void> {
    const rightUri = this.openDiffUris.get(id);
    this.openDiffUris.delete(id);
    const tabs = vscode.window.tabGroups.all
      .flatMap((tg) => tg.tabs)
      .filter(
        (tab) =>
          tab.input instanceof vscode.TabInputTextDiff &&
          tab.input.modified.scheme === DIFF_SCHEME &&
          (!rightUri || tab.input.modified.toString() === rightUri.toString()),
      );
    for (const tab of tabs) {
      try {
        await vscode.window.tabGroups.close(tab);
      } catch {
        /* 用户可能已手动关掉,忽略 */
      }
    }
  }

  // 定位 ripgrep 二进制:优先用 VS Code 自带的 rg(随编辑器分发,无需额外依赖),
  // 找不到就退回 PATH 上的 rg。search_files 工具靠它(agent-core 不碰 vscode,路径由这里注入)。
  private resolveRipgrepPath(): string {
    const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const candidates = [
      path.join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', exe),
      path.join(vscode.env.appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return exe; // 兜底:PATH 上的 rg
  }

  // 【读用户配置】从 VS Code 用户设置里读 provider / model / baseURL,拼成统一的 AgentConfig。
  //
  // vscode.workspace.getConfiguration('embed-agent') 会拿到「以 embed-agent. 为前缀」
  // 的所有设置项的访问器,后面用 cfg.get<T>('键名', 默认值) 一条条读。
  // 键名要与 package.json 里 contributes.configuration 声明的键一致(M1 时配的)。
  private readConfig(): AgentConfig {
    const cfg = vscode.workspace.getConfiguration('embed-agent');
    return {
      // cfg.get<T>('键名', 默认值):带泛型让返回值类型对齐 T;没设过就用默认值。
      // <LlmProvider> 是 TS 的「类型断言式泛型」:告诉编译器「我知道这个返回值是这个联合类型」。
      provider: cfg.get<LlmProvider>('llmProvider', 'anthropic'),
      model: cfg.get<string>('model', 'claude-opus-4-7'),
      // 空字符串视为「没填」→ 转 undefined,这样 adapter 工厂会用默认 baseURL。
      // 「'' || undefined」是 JS 小 idiom:空串 falsy,所以 || 返回右边的 undefined。
      baseURL: cfg.get<string>('baseURL', '') || undefined,
    };
  }

  // ===== 可视化设置面板:配置的读 / 写(见 doc 步骤 13)=====
  //  这一组方法和工具循环无关,纯属「在面板里改了什么 → 写进 VS Code 设置 / SecretStorage」。
  //  M1 留下的「Set API Key」命令面板入口仍保留,二者等价。

  // 把当前配置「回传」前端。
  // ⚠️ 只回 hasApiKey(布尔),绝不回传 key 本身——密钥不能回流到 UI,
  // 这是处理敏感信息的底线(参考 doc §13 开头的两条原则)。
  private async sendConfigState(): Promise<void> {
    const cfg = this.readConfig();
    // `!!x` 把任意值转成布尔:undefined / '' → false,非空字符串 → true。
    const hasApiKey = !!(await this.context.secrets.get(SECRET_KEY));
    this.post({
      type: 'configState',
      provider: cfg.provider,
      model: cfg.model,
      // baseURL 可能是 undefined;前端期望字符串,所以 `?? ''` 兜成空串。
      // `?? ''` 是「空值合并」:只对 null / undefined 触发(空串不会触发,和 || 不同)。
      baseURL: cfg.baseURL ?? '',
      hasApiKey,
    });
  }

  // 保存「非敏感」配置到 VS Code 用户设置。
  //
  // ConfigurationTarget 决定写到哪一层:
  //   Global          :用户级 settings.json(对所有工作区生效;就是「设置」里的「用户」标签);
  //   Workspace       :仅当前工作区;
  //   WorkspaceFolder :多根工作区里某一个文件夹。
  // update 是异步:VS Code 要落盘 settings.json,所以全部 await。
  private async saveConfig(provider: LlmProvider, model: string, baseURL: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('embed-agent');
    await cfg.update('llmProvider', provider, vscode.ConfigurationTarget.Global);
    await cfg.update('model', model, vscode.ConfigurationTarget.Global);
    await cfg.update('baseURL', baseURL, vscode.ConfigurationTarget.Global);
    this.output.appendLine(
      `[config] 已保存:provider=${provider} model=${model} baseURL=${baseURL || '(默认)'}`,
    );
    // 保存完再回传一次最新状态,让面板里的字段(比如「已设置 ✅」标记)同步刷新。
    await this.sendConfigState();
  }

  // 存 API key 到 SecretStorage(VS Code 的加密存储,跨重启留存)。
  // 空输入视为「不改」——这样面板上「留空 = 保留原 key」的语义才能实现。
  private async storeApiKey(key: string): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) return; // 全空白 → 不动
    await this.context.secrets.store(SECRET_KEY, trimmed);
    this.output.appendLine('[config] API key 已保存到 SecretStorage');
    // 右下角弹一个通知,让用户有「操作成功」的反馈;
    // showInformationMessage 返回 Promise(用户点了哪个按钮),这里我们不关心 → void 丢弃。
    void vscode.window.showInformationMessage('Embed Agent:API key 已保存。');
    await this.sendConfigState();
  }

  // 删除已保存的 API key。下次发消息会走「未设置 key」的友好提示分支。
  private async clearApiKey(): Promise<void> {
    await this.context.secrets.delete(SECRET_KEY);
    this.output.appendLine('[config] API key 已清除');
    await this.sendConfigState();
  }

  // ===== 以下 HTML 外壳与 M1 完全相同:返回一段 <html>,套 CSP 并加载 main.js / main.css =====

  // 生成 webview 的 HTML 字符串。
  //
  // 【为什么要这么麻烦?】webview 默认就是网页环境,
  // 若不限制就可能加载到不该加载的脚本;VS Code 强烈建议用 nonce + 白名单约束。
  // 这就是下面 CSP(Content Security Policy)的作用——网页安全里的标准做法。
  private getHtml(webview: vscode.Webview): string {
    // 每次 resolveWebviewView 重新生成一个随机 nonce(随机串)。
    // 下面 CSP 里 `script-src 'nonce-${nonce}'`,只允许带这个 nonce 的 <script> 标签执行,
    // 防止任何被注入的脚本运行(哪怕是同源)。
    const nonce = makeNonce();
    // asWebviewUri:把磁盘路径转成 webview 能 fetch 的 URL(https + 特殊路径)。
    // 直接给 file:// 路径在 webview 里加载不了,必须经过这个转换——VS Code 的安全机制。
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.css'),
    );
    // 拼 CSP 字符串。每条用「; 」分隔:
    //   default-src 'none'              默认啥都不让加(最严的兜底);
    //   style-src vscode 自家 + inline   VS Code 主题变量靠 inline 样式注入,所以放行;
    //   script-src 只允许带 nonce 的    我们的 React 入口 <script> 会带 nonce;
    //   font-src vscode 自家域          让代码块的等宽字体能加载;
    //   img-src  允许 vscode + https + data:  给 markdown 图片 / SVG 留余地。
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} https: data:`,
    ].join('; ');

    // 模板字符串 `<!doctype html>...`:JS 多行字符串,${} 内可嵌表达式。
    // 注意 `<script nonce="${nonce}">`:nonce 和上面 CSP 里的同一个,否则 script 不会执行。
    return `<!doctype html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>Embed Agent</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

// 【独立函数】生成 32 字节的随机字符串当 CSP nonce。
//
// 不用 crypto.randomUUID() 的原因:我们想要 alnum(字母数字)、长度可控,
// 且这个用途「防止注入的 <script> 通过 CSP」对随机性的要求并不密码学级别——
// 每次 resolveWebviewView 都换一个新的,做到「不可预测」即可。
function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
