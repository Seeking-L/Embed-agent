import * as vscode from 'vscode';
import type { WebviewToExt, ExtToWebview } from '@embed-agent/shared';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  // 必须和 package.json 里 views 声明的 id 一致
  static readonly viewId = 'embed-agent.chat';

  private view?: vscode.WebviewView;
  private streamTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  // 视图第一次显示（或重建）时被调用
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

    view.webview.options = {
      enableScripts: true, // 允许跑我们的 main.js
      // 只允许从 dist 加载本地资源（main.js / main.css）
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };

    view.webview.html = this.getHtml(view.webview);

    // 收到 webview 的消息（类型来自 shared，编译期保证只处理这几种）
    view.webview.onDidReceiveMessage((msg: WebviewToExt) => this.onMessage(msg));
  }

  // 给 webview 发消息：只能发 ExtToWebview 里定义的类型
  private post(message: ExtToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  private onMessage(msg: WebviewToExt): void {
    switch (msg.type) {
      case 'userMessage':
        this.output.appendLine(`[user] ${msg.text}`);
        this.echo(msg.text);
        break;
      case 'cancelStream':
        this.stopEcho();
        this.output.appendLine('[user] 取消');
        break;
      case 'confirmResponse':
        // M1 还没有需要确认的操作，先记日志，M2/M3 再用
        this.output.appendLine(`[confirm] ${msg.id} -> ${msg.approved}`);
        break;
    }
  }

  // M1 占位「后台」：把用户输入分片回声，模拟流式输出。
  // M2 会把这里换成真正的 LLM 流（同样是 streamDelta → assistantDone）。
  private echo(text: string): void {
    this.stopEcho();
    const reply =
      `你说的是：\n\n> ${text}\n\n` +
      '（M1 阶段这是 **echo 占位**，M2 会接上真正的大模型。）\n\n' +
      '```ts\nconst hello = "world"; // 顺便验证 shiki 代码高亮\n```';
    // 按每 ~8 个字符切片；s 标志让 . 匹配换行，u 处理 Unicode
    const chunks = reply.match(/.{1,8}/gsu) ?? [reply];
    let i = 0;
    this.streamTimer = setInterval(() => {
      if (i >= chunks.length) {
        this.stopEcho();
        this.post({ type: 'tokenUsage', input: text.length, output: reply.length });
        this.post({ type: 'assistantDone' });
        return;
      }
      this.post({ type: 'streamDelta', text: chunks[i++] });
    }, 40);
  }

  private stopEcho(): void {
    if (this.streamTimer) {
      clearInterval(this.streamTimer);
      this.streamTimer = undefined;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    // 本地文件必须转成 webview 专用 URI 才能加载
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.css'),
    );
    // CSP：默认全禁；脚本只放行带 nonce 的；样式放行我们的文件 + 行内（shiki 要）
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
