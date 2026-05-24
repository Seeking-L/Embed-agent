import type { ChatMessage } from '../store';
import { Markdown } from './Markdown';

export function MessageItem({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className="mb-3">
      <div className="mb-1 text-xs font-semibold opacity-70">{isUser ? '你' : 'Embed Agent'}</div>
      <div className={isUser ? 'rounded bg-input px-2 py-1 text-sm' : 'text-sm leading-relaxed'}>
        {isUser ? (
          <span className="whitespace-pre-wrap">{message.text}</span>
        ) : (
          <Markdown text={message.text} />
        )}
      </div>
    </div>
  );
}
