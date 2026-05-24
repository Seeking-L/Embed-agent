import { useEffect } from 'react';
import { useChat } from './store';
import { onExtMessage } from './vscodeApi';
import { MessageList } from './components/MessageList';
import { InputBar } from './components/InputBar';

export function App() {
  const receive = useChat((s) => s.receive);
  const error = useChat((s) => s.error);

  // 挂载时订阅后台消息，卸载时自动取消（onExtMessage 返回的就是取消函数）
  useEffect(() => onExtMessage(receive), [receive]);

  return (
    <div className="flex h-screen flex-col text-fg">
      <header className="border-b border-panel px-3 py-2 text-sm font-medium">Embed Agent</header>
      <MessageList />
      {error && (
        <div className="mx-3 mb-2 rounded border border-err-border bg-err px-2 py-1 text-xs">
          {error}
        </div>
      )}
      <InputBar />
    </div>
  );
}
