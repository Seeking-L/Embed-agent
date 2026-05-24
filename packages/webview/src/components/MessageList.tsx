import { useEffect, useRef } from 'react';
import { useChat } from '../store';
import { MessageItem } from './MessageItem';

export function MessageList() {
  const messages = useChat((s) => s.messages);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 新消息进来自动滚到底（useRef ≈ Vue 的模板 ref）
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto px-3 py-2">
      {messages.length === 0 && (
        <p className="mt-8 text-center text-sm opacity-60">
          发一条消息开始对话（M1 阶段后台只会原样回声）。
        </p>
      )}
      {messages.map((m) => (
        <MessageItem key={m.id} message={m} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
