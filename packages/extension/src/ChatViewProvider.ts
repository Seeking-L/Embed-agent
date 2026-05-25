// ============================================================================
// ChatViewProvider.ts —— 侧边栏聊天视图的「后端」
// ----------------------------------------------------------------------------
// M1 时这里是「echo 占位」。M2 把它换成真正的 agent:
//   收到用户消息 → 读 key/配置 → 造 adapter → 跑 runAgent(工具循环)
//   → 把循环吐出的 AgentEvent 一一翻成 ExtToWebview 发给前端。
//
// 它还负责三件 agent-core「不该知道」的事(所以由这里实现、注入进 runAgent):
//   - API key:从 VS Code 的 SecretStorage 读;
//   - 确认弹窗:把 requestConfirm 发给 webview,等用户点了 confirmResponse 再 resolve;
//   - 取消:用 AbortController,收到 cancelStream 就 abort()。
// HTML 外壳(getHtml / CSP / nonce)与 M1 完全一样,原样保留。
// ============================================================================

import * as vscode from 'vscode';
import type { WebviewToExt, ExtToWebview, AgentConfig, LlmProvider } from '@embed-agent/shared';
import {
  ToolRegistry,
  createAdapter,
  runAgent,
  demoTools,
  type ChatTurn,
  type ConfirmRequest,
} from '@embed-agent/agent-core';

// API key 在 SecretStorage 里的存储键(和 extension.ts 里 setApiKey 用的一致)。
const SECRET_KEY = 'embed-agent.apiKey';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  // 必须和 package.json 里 views 声明的 id 一致
  static readonly viewId = 'embed-agent.chat';

  private view?: vscode.WebviewView;
  // 多轮对话记忆:每轮把用户消息/模型发言/工具结果都追加进来,下一轮带着它再问模型。
  private history: ChatTurn[] = [];
  // 工具注册表:构造时塞入演示工具。M3 会在这里继续 register 真实的只读工具。
  private readonly registry = new ToolRegistry();
  // 当前这一轮的「取消器」。点停止 → abort()。
  private abort?: AbortController;
  // 待确认请求表:key 是请求 id,value 是「兑现这个 Promise 的 resolve 函数」。
  // 用户的 confirmResponse 回来时,按 id 找到对应 resolve 调用它(见 askConfirm)。
  private readonly pendingConfirms = new Map<string, (approved: boolean) => void>();
  // 累计 token 用量(跨整个会话累加)。
  private readonly totalUsage = { input: 0, output: 0 };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    // 注册演示工具。M3 会在这里继续 register 真正的只读工具(read_file 等)。
    for (const tool of demoTools) this.registry.register(tool);
  }

  // 视图第一次显示(或折叠后重建)时被调用
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage((msg: WebviewToExt) => this.onMessage(msg));
  }

  // 给 webview 发消息:只能发 ExtToWebview 里定义的类型(编译期保证不发错)
  private post(message: ExtToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  private onMessage(msg: WebviewToExt): void {
    switch (msg.type) {
      case 'userMessage':
        // handleUserMessage 是 async,这里不 await(让它在后台跑);void 表示「故意不等它」
        void this.handleUserMessage(msg.text);
        break;
      case 'cancelStream':
        this.abort?.abort(); // 触发取消;runAgent 会识别并安静收尾
        this.output.appendLine('[user] 取消');
        break;
      case 'confirmResponse': {
        // 用户点了确认卡片的「允许/拒绝」。按 id 找到正在等待的那个 Promise,兑现它。
        const resolve = this.pendingConfirms.get(msg.id);
        if (resolve) {
          resolve(msg.approved);
          this.pendingConfirms.delete(msg.id);
        }
        this.output.appendLine(`[confirm] ${msg.id} -> ${msg.approved}`);
        break;
      }
      // ↓↓↓ 可视化设置面板用的几条消息 ↓↓↓
      case 'getConfig':
        void this.sendConfigState();
        break;
      case 'saveConfig':
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

  // 处理一条用户消息:这是 M2 后端的主流程。
  private async handleUserMessage(text: string): Promise<void> {
    this.output.appendLine(`[user] ${text}`);

    // 1) 读 key。没有就友好提示,别让请求带着空 key 去撞 401。
    const apiKey = await this.context.secrets.get(SECRET_KEY);
    if (!apiKey) {
      this.post({
        type: 'error',
        message: '未设置 API key。请运行命令「Embed Agent: Set API Key」。',
      });
      this.post({ type: 'assistantDone' });
      return;
    }

    // 2) 读配置,造 adapter,把用户消息记进历史,准备取消器。
    const config = this.readConfig();
    const adapter = createAdapter(config, apiKey);
    this.history.push({ role: 'user', content: text });
    this.abort = new AbortController();

    // 3) 跑工具循环,把每个事件翻成发给前端的消息。
    try {
      for await (const ev of runAgent({
        adapter,
        registry: this.registry,
        model: config.model,
        history: this.history,
        confirm: (req) => this.askConfirm(req), // ← 注入确认实现
        signal: this.abort.signal,
      })) {
        switch (ev.type) {
          case 'text':
            this.post({ type: 'streamDelta', text: ev.text });
            break;
          case 'toolStart':
            this.output.appendLine(`[tool] ${ev.name} 开始`);
            this.post({ type: 'toolCallStart', id: ev.id, name: ev.name });
            break;
          case 'toolEnd':
            this.output.appendLine(`[tool] ${ev.name} ${ev.ok ? '成功' : '失败'}`);
            this.post({ type: 'toolCallResult', id: ev.id, name: ev.name, ok: ev.ok });
            break;
          case 'usage':
            this.totalUsage.input += ev.input;
            this.totalUsage.output += ev.output;
            this.post({
              type: 'tokenUsage',
              input: this.totalUsage.input,
              output: this.totalUsage.output,
            });
            break;
          case 'error':
            this.post({ type: 'error', message: ev.message });
            break;
          case 'done':
            break;
        }
      }
    } finally {
      // 不管正常结束还是异常,都收尾:告诉前端「这轮完了」+ 清理。
      this.post({ type: 'assistantDone' });
      this.abort = undefined;
      // 若还有没回应的确认(比如中途取消),一律按「拒绝」释放,避免 loop 永远卡在 await。
      for (const resolve of this.pendingConfirms.values()) resolve(false);
      this.pendingConfirms.clear();
    }
  }

  // 确认原语的「后端实现」:发 requestConfirm 给前端,返回一个 Promise;
  // 等前端的 confirmResponse 回来(在 onMessage 里),才 resolve 这个 Promise。
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

  // 从 VS Code 设置里读 provider / model / baseURL,拼成 AgentConfig。
  private readConfig(): AgentConfig {
    const cfg = vscode.workspace.getConfiguration('embed-agent');
    return {
      provider: cfg.get<LlmProvider>('llmProvider', 'anthropic'),
      model: cfg.get<string>('model', 'claude-opus-4-7'),
      baseURL: cfg.get<string>('baseURL', '') || undefined,
    };
  }

  // ----- 可视化设置面板:配置的读 / 写(在 M1 的命令入口之外,多一个面板入口)-----

  // 把当前配置回传前端。⚠️ 只回传「是否已设置 key」(hasApiKey),绝不回传 key 本身。
  private async sendConfigState(): Promise<void> {
    const cfg = this.readConfig();
    const hasApiKey = !!(await this.context.secrets.get(SECRET_KEY));
    this.post({
      type: 'configState',
      provider: cfg.provider,
      model: cfg.model,
      baseURL: cfg.baseURL ?? '',
      hasApiKey,
    });
  }

  // 保存「非敏感」配置到 VS Code 用户设置(等价于在「设置」里改 provider/model/baseURL)。
  private async saveConfig(provider: LlmProvider, model: string, baseURL: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('embed-agent');
    await cfg.update('llmProvider', provider, vscode.ConfigurationTarget.Global);
    await cfg.update('model', model, vscode.ConfigurationTarget.Global);
    await cfg.update('baseURL', baseURL, vscode.ConfigurationTarget.Global);
    this.output.appendLine(
      `[config] 已保存:provider=${provider} model=${model} baseURL=${baseURL || '(默认)'}`,
    );
    await this.sendConfigState(); // 回传最新状态给面板
  }

  // 存 API key 到 SecretStorage(加密;不写设置文件)。空输入视为「不改」。
  private async storeApiKey(key: string): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) return;
    await this.context.secrets.store(SECRET_KEY, trimmed);
    this.output.appendLine('[config] API key 已保存到 SecretStorage');
    void vscode.window.showInformationMessage('Embed Agent:API key 已保存。');
    await this.sendConfigState();
  }

  // 清除已保存的 API key。
  private async clearApiKey(): Promise<void> {
    await this.context.secrets.delete(SECRET_KEY);
    this.output.appendLine('[config] API key 已清除');
    await this.sendConfigState();
  }

  // ----- 以下 HTML 外壳与 M1 相同(CSP + nonce + 引入 main.js/main.css)-----

  private getHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.css'),
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} https: data:`,
    ].join('; ');

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

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
