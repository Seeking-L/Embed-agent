// ============================================================================
// MessageItem.tsx —— 渲染时间线里的一项
// ----------------------------------------------------------------------------
// M2 起一项可能是「工具调用条目」或「普通气泡」,所以先按 role 分流渲染。
// ============================================================================

import type { ChatItem } from '../store';
import { Markdown } from './Markdown';

export function MessageItem({ item }: { item: ChatItem }) {
  // 工具调用条目:一行小标签,带状态图标(执行中 / 成功 / 失败)
  if (item.role === 'tool') {
    const icon = item.status === 'running' ? '⏳' : item.status === 'ok' ? '✅' : '⚠️';
    return (
      <div className="mb-2 text-xs opacity-80">
        <span className="rounded bg-codebg px-2 py-1">
          {icon} 工具 <code>{item.name}</code>
          {item.status === 'running' ? ' 执行中…' : ''}
        </span>
      </div>
    );
  }

  // 普通气泡(同 M1):用户消息用纯文本,助手消息用 markdown 渲染
  const isUser = item.role === 'user';
  return (
    <div className="mb-3">
      <div className="mb-1 text-xs font-semibold opacity-70">{isUser ? '你' : 'Embed Agent'}</div>
      <div className={isUser ? 'rounded bg-input px-2 py-1 text-sm' : 'text-sm leading-relaxed'}>
        {isUser ? (
          <span className="whitespace-pre-wrap">{item.text}</span>
        ) : (
          <Markdown text={item.text} />
        )}
      </div>
    </div>
  );
}
