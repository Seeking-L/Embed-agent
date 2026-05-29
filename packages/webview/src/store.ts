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
//
// 【M3 补丁】assistant 多了一个 `reasoning` 字段(思考型模型独有):
//   - DeepSeek thinking / R1 等模型流里会先吐 reasoning_content,再吐 content;
//   - 前者累加到 `reasoning`,后者累加到 `text`,**分开两段存**;
//   - UI 里把 reasoning 渲染成可折叠的「💭 思考过程」区,放在主气泡上方。
// 用户气泡没有 reasoning;非思考型模型(Anthropic / OpenAI 普通)产生的 assistant 气泡
// reasoning 字段保持 undefined,渲染时跳过那一段——零成本。
export type ChatItem =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; text: string; reasoning?: string }
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

// 【M4】当前待「应用 / 放弃」的写文件提议(没有就是 null)。
// 真正的逐行 diff 在 VS Code 原生 diff 编辑器里看;这张卡片只放路径 + 一句概述 + 两个按钮。
interface ApplyDiffState {
  id: string;
  path: string;
  summary: string;
}

interface ChatState {
  items: ChatItem[];
  streaming: boolean; // 是否正在流式输出(决定显示「发送」还是「停止」)
  error: string | null;
  tokenUsage: { input: number; output: number } | null;
  confirm: ConfirmState | null;
  applyDiff: ApplyDiffState | null; // 【M4】当前待应用的写文件提议
  send: (text: string) => void; // 用户发一条
  stop: () => void; // 用户点停止
  respondConfirm: (approved: boolean) => void; // 用户点确认卡片的允许/拒绝
  respondApplyDiff: (apply: boolean) => void; // 【M4】用户点 diff 卡片的应用/放弃
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
  applyDiff: null,

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

  respondApplyDiff: (apply) => {
    // 和 respondConfirm 同款:把用户的应用/放弃发回后台,收起卡片。
    const d = get().applyDiff;
    if (!d) return;
    postToExt({ type: 'applyDiffResponse', id: d.id, apply });
    set({ applyDiff: null });
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
      case 'reasoningDelta':
        // 思考片段(DeepSeek thinking / R1 等独有):规则和 streamDelta 几乎一致,
        // 只是追加到 reasoning 字段而非 text。
        //
        // 关键差异:思考通常**先于**正文产生(模型先想再说),所以这条分支必须能
        // **凭空创建一条 reasoning 不为空但 text 为空**的 assistant 气泡。等正文
        // streamDelta 来了再追加到同一条 item 的 text(因为它已是 last assistant)。
        // —— 这就是为什么这里"新开气泡"分支里 text 设成 ''。
        set((s) => {
          const items = s.items.slice();
          const last = items[items.length - 1];
          if (last && last.role === 'assistant') {
            // `last.reasoning ?? ''`:之前是 undefined 就当空串开始,首段 reasoning
            // 进来时不会出现 'undefined' + msg.text 的拼接事故。
            items[items.length - 1] = {
              ...last,
              reasoning: (last.reasoning ?? '') + msg.text,
            };
          } else {
            items.push({
              id: uid(),
              role: 'assistant',
              text: '',
              reasoning: msg.text,
            });
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
      case 'requestApplyDiff':
        set({ applyDiff: { id: msg.id, path: msg.path, summary: msg.summary } });
        break;
      case 'assistantDone':
        // 本轮结束:顺手清掉任何还悬挂的 确认/diff 卡片。此时它们一定是 stale 的——后台在
        // 取消/收尾时已把对应请求兑现并关掉了原生 diff;卡片若不清会变成「点了没反应」的孤儿。
        set({ streaming: false, confirm: null, applyDiff: null });
        break;
      case 'error':
        set({ error: msg.message, streaming: false, confirm: null, applyDiff: null });
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
