// ============================================================================
// App.tsx —— 根组件
// ----------------------------------------------------------------------------
// 挂了:消息列表、错误条、确认卡片、token 页脚、输入框,以及 M2 新增的
// 「设置面板」(头部 ⚙ 打开)。后台消息分发给「聊天」和「设置」两个 store。
// ============================================================================

import { useEffect } from 'react';
import { formatTokenUsage } from '@embed-agent/shared';
import { useChat } from './store';
import { useSettings } from './settings';
import { onExtMessage, postToExt } from './vscodeApi';
import { MessageList } from './components/MessageList';
import { InputBar } from './components/InputBar';
import { ConfirmCard } from './components/ConfirmCard';
import { ApplyDiffCard } from './components/ApplyDiffCard';
import { SettingsPanel } from './components/SettingsPanel';

export function App() {
  const chatReceive = useChat((s) => s.receive);
  const settingsReceive = useSettings((s) => s.receive);
  const openSettings = useSettings((s) => s.openPanel);
  const error = useChat((s) => s.error);
  const usage = useChat((s) => s.tokenUsage);

  // 订阅后台消息,分发给两个 store(各取所需:聊天 store 处理流式/工具,设置 store 处理 configState)
  useEffect(() => {
    return onExtMessage((msg) => {
      chatReceive(msg);
      settingsReceive(msg);
    });
  }, [chatReceive, settingsReceive]);

  // 启动时拉一次配置(让头部能据此提示是否已设 key、设置面板有初值)
  useEffect(() => {
    postToExt({ type: 'getConfig' });
  }, []);

  return (
    // relative:让 SettingsPanel 的 absolute inset-0 能盖住整个面板
    <div className="relative flex h-screen flex-col text-fg">
      <header className="flex items-center justify-between border-b border-panel px-3 py-2">
        <span className="text-sm font-medium">Embed Agent</span>
        <button
          className="rounded px-2 py-0.5 text-base hover:bg-input"
          title="设置"
          onClick={openSettings}
        >
          ⚙
        </button>
      </header>
      <MessageList />
      {error && (
        <div className="mx-3 mb-2 rounded border border-err-border bg-err px-2 py-1 text-xs">
          {error}
        </div>
      )}
      <ConfirmCard />
      <ApplyDiffCard />
      {usage && (
        <div className="px-3 pb-1 text-right text-xs opacity-60">
          token:{formatTokenUsage(usage.input, usage.output)}
        </div>
      )}
      <InputBar />
      <SettingsPanel />
    </div>
  );
}
