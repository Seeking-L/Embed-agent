// ============================================================================
// settings.ts —— 设置面板的前端状态(独立于聊天 store)
// ----------------------------------------------------------------------------
// 单独开一个 store,跟 chat store 互不干扰:它只关心「配置」。后台发来的 configState
// 由它接收;别的消息它一概忽略。所有写操作都通过 postToExt 发给后台真正落盘
//(VS Code 设置 / SecretStorage),前端自己不保存 key。
// ============================================================================

import { create } from 'zustand';
import type { ExtToWebview, LlmProvider } from '@embed-agent/shared';
import { postToExt } from './vscodeApi';

interface SettingsState {
  open: boolean; // 设置面板是否展开
  provider: LlmProvider;
  model: string;
  baseURL: string;
  hasApiKey: boolean; // 后台是否已存了 key(只知道有没有,拿不到 key 本身)
  // 表单编辑动作(只改前端草稿,点「保存」才发给后台)
  openPanel: () => void;
  closePanel: () => void;
  setProvider: (p: LlmProvider) => void;
  setModel: (m: string) => void;
  setBaseURL: (u: string) => void;
  // 与后台交互
  save: () => void; // 保存 provider/model/baseURL
  setApiKey: (key: string) => void; // 存 key
  clearApiKey: () => void; // 清除 key
  receive: (msg: ExtToWebview) => void; // 接收 configState
}

export const useSettings = create<SettingsState>((set, get) => ({
  open: false,
  provider: 'anthropic',
  model: '',
  baseURL: '',
  hasApiKey: false,

  openPanel: () => {
    postToExt({ type: 'getConfig' }); // 打开时拉一次最新配置
    set({ open: true });
  },
  closePanel: () => set({ open: false }),

  setProvider: (provider) => set({ provider }),
  setModel: (model) => set({ model }),
  setBaseURL: (baseURL) => set({ baseURL }),

  save: () => {
    const { provider, model, baseURL } = get();
    postToExt({ type: 'saveConfig', provider, model, baseURL });
  },
  setApiKey: (key) => postToExt({ type: 'setApiKey', key }),
  clearApiKey: () => postToExt({ type: 'clearApiKey' }),

  receive: (msg) => {
    // 只认 configState,其余消息(streamDelta 等)忽略
    if (msg.type === 'configState') {
      set({
        provider: msg.provider,
        model: msg.model,
        baseURL: msg.baseURL,
        hasApiKey: msg.hasApiKey,
      });
    }
  },
}));
