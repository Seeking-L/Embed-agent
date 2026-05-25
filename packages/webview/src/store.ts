// ============================================================================
// store.ts —— 前端状态(Zustand,类比 Pinia)
// ----------------------------------------------------------------------------
// M2 相比 M1 的变化:时间线里除了「用户/助手气泡」,还会穿插「工具调用」条目,
// 而且会出现「待确认卡片」。所以:
//   - 把消息模型从「只有 user/assistant」升级成联合类型 ChatItem(多了一种 tool 条目);
//   - 新增 confirm 状态 + respondConfirm 动作;
//   - receive 里处理 toolCallStart/toolCallResult/requestConfirm 三种新消息。
// 流式聊天主链路(streamDelta/assistantDone/tokenUsage)逻辑基本沿用 M1。
// ============================================================================

import { create } from 'zustand';
import type { ExtToWebview } from '@embed-agent/shared';
import { postToExt, getPersistedState, setPersistedState } from './vscodeApi';

// 时间线里的一项:要么是普通气泡(user/assistant),要么是一条工具调用记录。
// 这是「可辨识联合」:靠 role 区分,渲染时 switch 即可。
export type ChatItem =
  | { id: string; role: 'user' | 'assistant'; text: string }
  | { id: string; role: 'tool'; name: string; status: 'running' | 'ok' | 'error' };

interface PersistedState {
  items: ChatItem[];
}

// 当前待确认的请求(没有就是 null)
interface ConfirmState {
  id: string;
  toolName: string;
  summary: string;
}

interface ChatState {
  items: ChatItem[];
  streaming: boolean; // 是否正在流式输出(决定显示「发送」还是「停止」)
  error: string | null;
  tokenUsage: { input: number; output: number } | null;
  confirm: ConfirmState | null;
  send: (text: string) => void; // 用户发一条
  stop: () => void; // 用户点停止
  respondConfirm: (approved: boolean) => void; // 用户点确认卡片的允许/拒绝
  receive: (msg: ExtToWebview) => void; // 收到后台消息后更新状态
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

const initial = getPersistedState<PersistedState>();

export const useChat = create<ChatState>((set, get) => ({
  items: initial?.items ?? [],
  streaming: false,
  error: null,
  tokenUsage: null,
  confirm: null,

  send: (text) => {
    const trimmed = text.trim();
    if (!trimmed || get().streaming) return; // 空消息 / 正在流式中,忽略
    // 只 push 用户气泡;助手气泡不预先建,等第一片 streamDelta 来了再建(见 receive)。
    set((s) => ({
      items: [...s.items, { id: uid(), role: 'user', text: trimmed }],
      streaming: true,
      error: null,
    }));
    postToExt({ type: 'userMessage', text: trimmed });
  },

  stop: () => {
    postToExt({ type: 'cancelStream' });
    set({ streaming: false });
  },

  respondConfirm: (approved) => {
    const c = get().confirm;
    if (!c) return;
    postToExt({ type: 'confirmResponse', id: c.id, approved });
    set({ confirm: null }); // 收起卡片
  },

  receive: (msg) => {
    switch (msg.type) {
      case 'streamDelta':
        // 规则:把增量追加到「最后一条 assistant 气泡」;若最后一条不是 assistant
        //(比如刚插了个工具条目),就新开一个 assistant 气泡。这条规则自动处理了
        // 「文字 → 工具 → 又文字」的穿插显示,不需要额外状态机。
        set((s) => {
          const items = s.items.slice(); // 复制一份(别原地改,React 靠引用变化判断重渲染)
          const last = items[items.length - 1];
          if (last && last.role === 'assistant') {
            items[items.length - 1] = { ...last, text: last.text + msg.text };
          } else {
            items.push({ id: uid(), role: 'assistant', text: msg.text });
          }
          return { items };
        });
        break;
      case 'toolCallStart':
        // 用后端给的 id 当条目 id,方便 result 回来时按 id 更新它的状态。
        set((s) => ({
          items: [...s.items, { id: msg.id, role: 'tool', name: msg.name, status: 'running' }],
        }));
        break;
      case 'toolCallResult':
        set((s) => ({
          items: s.items.map((it) =>
            it.role === 'tool' && it.id === msg.id
              ? { ...it, status: msg.ok ? 'ok' : 'error' }
              : it,
          ),
        }));
        break;
      case 'requestConfirm':
        set({ confirm: { id: msg.id, toolName: msg.toolName, summary: msg.summary } });
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
    }
  },
}));

// 每次状态变化,把消息存回 webview state,折叠/展开侧边栏后能恢复(同 M1)。
useChat.subscribe((state) => {
  setPersistedState({ items: state.items } satisfies PersistedState);
});
