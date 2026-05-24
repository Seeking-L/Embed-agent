import * as vscode from 'vscode';
import { ChatViewProvider } from './ChatViewProvider';

const SECRET_KEY = 'embed-agent.apiKey';

export function activate(context: vscode.ExtensionContext): void {
  const t0 = Date.now(); // 激活计时（DoD 要求 < 1s）

  const output = vscode.window.createOutputChannel('Embed Agent');
  context.subscriptions.push(output);
  output.appendLine('Embed Agent 激活中…');
  logConfig(output);

  // 配置变化时打日志（以后用来热更新 provider）
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('embed-agent')) {
        output.appendLine('配置已变化：');
        logConfig(output);
      }
    }),
  );

  // 注册侧边栏聊天视图
  const provider = new ChatViewProvider(context, output);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider),
  );

  // 命令：打开聊天 = 聚焦那个视图。<viewId>.focus 是 VS Code 自动生成的命令。
  context.subscriptions.push(
    vscode.commands.registerCommand('embed-agent.openChat', () => {
      void vscode.commands.executeCommand('embed-agent.chat.focus');
    }),
  );

  // 命令：设置 / 清除 API key（走 SecretStorage，不写明文配置）
  context.subscriptions.push(
    vscode.commands.registerCommand('embed-agent.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: '输入 LLM API Key',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'sk-…（只存到 VS Code SecretStorage，不进设置文件）',
      });
      if (key) {
        await context.secrets.store(SECRET_KEY, key);
        output.appendLine('API key 已保存到 SecretStorage。');
        void vscode.window.showInformationMessage('Embed Agent：API key 已保存。');
      }
    }),
    vscode.commands.registerCommand('embed-agent.clearApiKey', async () => {
      await context.secrets.delete(SECRET_KEY);
      output.appendLine('API key 已清除。');
      void vscode.window.showInformationMessage('Embed Agent：API key 已清除。');
    }),
  );

  output.appendLine(`Embed Agent 激活完成，耗时 ${Date.now() - t0} ms。`);
}

export function deactivate(): void {}

function logConfig(output: vscode.OutputChannel): void {
  const cfg = vscode.workspace.getConfiguration('embed-agent');
  const provider = cfg.get<string>('llmProvider', 'anthropic');
  const model = cfg.get<string>('model', '');
  const baseURL = cfg.get<string>('baseURL', '');
  output.appendLine(`  provider = ${provider}`);
  output.appendLine(`  model    = ${model || '(默认)'}`);
  output.appendLine(`  baseURL  = ${baseURL || '(官方默认)'}`);
}
