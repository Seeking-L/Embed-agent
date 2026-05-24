import { useState } from 'react';
import { useChat } from '../store';

export function InputBar() {
  const [text, setText] = useState('');
  const streaming = useChat((s) => s.streaming);
  const send = useChat((s) => s.send);
  const stop = useChat((s) => s.stop);

  const submit = () => {
    send(text);
    setText('');
  };

  return (
    <div className="border-t border-panel p-2">
      <textarea
        className="h-16 w-full resize-none rounded border border-input-border bg-input p-2 text-sm text-input-fg outline-none focus:border-focus"
        placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="mt-1 flex justify-end gap-2">
        {streaming ? (
          <button className="rounded bg-btn2 px-3 py-1 text-sm text-btn2-fg" onClick={stop}>
            停止
          </button>
        ) : (
          <button
            className="rounded bg-btn px-3 py-1 text-sm text-btn-fg disabled:opacity-50"
            onClick={submit}
            disabled={!text.trim()}
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}
