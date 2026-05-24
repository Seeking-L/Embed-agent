import { create } from 'zustand';
import type { ExtToWebview } from '@embed-agent/shared';
import { postToExt, getPersistedState, setPersistedState } from './vscodeApi';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

interface PersistedState {
  messages: ChatMessage[];
}

interface ChatState {
  messages: ChatMessage[];
  streaming: boolean; // 是否正在流式输出（决定显示「发送」还是「停止」）
  error: string | null;
  tokenUsage: { input: number; output: number } | null;
  send: (text: string) => void; // 用户发一条
  stop: () => void; // 用户点停止
  receive: (msg: ExtToWebview) => void; // 收到后台消息后更新状态
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

const initial = getPersistedState<PersistedState>();

export const useChat = create<ChatState>((set, get) => ({
  messages: initial?.messages ?? [],
  streaming: false,
  error: null,
  tokenUsage: null,

  send: (text) => {
    const trimmed = text.trim();
    if (!trimmed || get().streaming) return; // 空消息 / 正在流式中，忽略
    const userMsg: ChatMessage = { id: uid(), role: 'user', text: trimmed };
    // 先放一个空的 assistant 气泡，等 streamDelta 往里灌字
    const assistantMsg: ChatMessage = { id: uid(), role: 'assistant', text: '' };
    set((s) => ({
      messages: [...s.messages, userMsg, assistantMsg],
      streaming: true,
      error: null,
    }));
    postToExt({ type: 'userMessage', text: trimmed });
  },

  stop: () => {
    postToExt({ type: 'cancelStream' });
    set({ streaming: false });
  },

  receive: (msg) => {
    switch (msg.type) {
      case 'streamDelta':
        // 把增量追加到最后一条 assistant 气泡（注意：造新数组/新对象，别原地改）
        set((s) => {
          const messages = s.messages.slice();
          const last = messages[messages.length - 1];
          if (last && last.role === 'assistant') {
            messages[messages.length - 1] = { ...last, text: last.text + msg.text };
          }
          return { messages };
        });
        break;
      case 'assistantDone':
        set({ streaming: false });
        break;
      case 'error':
        set({ error: msg.message, streaming: false });
        break;
      case 'tokenUsage':
        set({ tokenUsage: { input: msg.input, output: msg.output } });
        break;
      // toolCallStart / toolCallResult / requestConfirm：M1 先不处理，M2/M3 再接
      default:
        break;
    }
  },
}));

// 每次状态变化，把消息存回 webview state，折叠/展开侧边栏后能恢复。
useChat.subscribe((state) => {
  setPersistedState({ messages: state.messages } satisfies PersistedState);
});
