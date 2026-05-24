// 'vscode' 是宿主提供的 API,不需要安装运行时,只装了类型(@types/vscode)。
import * as vscode from 'vscode';
// 从本地共享包导入——这一行能跑通,就证明 monorepo 链接成功了。
import { formatTokenUsage } from '@embed-agent/shared';

// 插件被激活时,VS Code 调用这个函数。
export function activate(context: vscode.ExtensionContext): void {
  console.log('Embed Agent 已激活');

  // 注册命令:命令 id 必须和 package.json 里声明的一致。
  const disposable = vscode.commands.registerCommand('embed-agent.hello', () => {
    vscode.window.showInformationMessage(`Embed Agent 已就绪!(token: ${formatTokenUsage(0, 0)})`);
  });

  // 把命令登记到 subscriptions,插件卸载时自动清理。
  context.subscriptions.push(disposable);
}

// 插件关闭时调用,M0 暂时不需要做事。
export function deactivate(): void {}
