import type { WebviewToExt, ExtToWebview } from '@embed-agent/shared';

// VS Code 注入到 webview 全局的 API。整个 webview 生命周期只能调用一次。
interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

// 往后台发消息：只接受 shared 里定义的合法消息，发错字段编译期就报红。
export function postToExt(message: WebviewToExt): void {
  vscode.postMessage(message);
}

// 订阅后台发来的消息；返回一个「取消订阅」函数（给 useEffect 当清理用）。
export function onExtMessage(handler: (message: ExtToWebview) => void): () => void {
  const listener = (event: MessageEvent) => handler(event.data as ExtToWebview);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

// 轻量持久化：侧边栏折叠再展开时 webview 会重建，用它把消息存回来（概念 9）。
export function getPersistedState<T>(): T | undefined {
  return vscode.getState() as T | undefined;
}
export function setPersistedState(state: unknown): void {
  vscode.setState(state);
}
