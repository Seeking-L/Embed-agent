// ============================================================================
// MessageList.tsx —— 消息列表 + 自动滚到底
// ----------------------------------------------------------------------------
// 与 M1 几乎一致,只是把字段名从 messages 改成 items(因为现在条目不止「消息」)。
// ============================================================================

import { useEffect, useRef } from 'react';
import { useChat } from '../store';
import { MessageItem } from './MessageItem';

export function MessageList() {
  const items = useChat((s) => s.items);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 新条目进来自动滚到底(useRef ≈ Vue 的模板 ref)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items]);

  return (
    <div className="flex-1 overflow-y-auto px-3 py-2">
      {items.length === 0 && (
        <p className="mt-8 text-center text-sm opacity-60">发一条消息开始对话。</p>
      )}
      {items.map((it) => (
        <MessageItem key={it.id} item={it} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
