// ============================================================================
// SettingsPanel.tsx —— 可视化设置面板
// ----------------------------------------------------------------------------
// 点聊天头部的 ⚙ 打开。一个表单:选 provider、填 model / baseURL、设 API key。
// 「保存」把 provider/model/baseURL 写进 VS Code 设置;若 key 输入框里填了内容,
// 同时存 key。key 是密码框、不回显已存的 key(安全)。
// open 为 false 时整个组件返回 null(不渲染)。
// ============================================================================

import { useState } from 'react';
import type { LlmProvider } from '@embed-agent/shared';
import { useSettings } from '../settings';

// 各 provider 的推荐模型(给 model 输入框当占位提示 + 「用推荐值」按钮)
const MODEL_HINT: Record<LlmProvider, string> = {
  anthropic: 'claude-opus-4-7',
  openai: 'gpt-4o',
  deepseek: 'deepseek-chat',
};

export function SettingsPanel() {
  const s = useSettings();
  // key 单独用本地状态:它不进全局 store(也就不会被持久化/回显)
  const [keyInput, setKeyInput] = useState('');

  if (!s.open) return null;

  // 点「保存」:先存 provider/model/baseURL;若填了新 key 再存 key。
  const onSave = () => {
    s.save();
    if (keyInput.trim()) {
      s.setApiKey(keyInput.trim());
      setKeyInput('');
    }
  };

  return (
    // absolute inset-0:盖住整个 webview(根容器有 relative);z-10 浮在聊天之上
    <div className="absolute inset-0 z-10 flex flex-col overflow-y-auto bg-editor p-4 text-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold">设置</h2>
        <button className="rounded bg-btn2 px-2 py-1 text-xs text-btn2-fg" onClick={s.closePanel}>
          关闭
        </button>
      </div>

      {/* provider 下拉 */}
      <label className="mb-1 font-medium">大模型提供商</label>
      <select
        className="mb-3 rounded border border-input-border bg-input p-2 text-input-fg outline-none focus:border-focus"
        value={s.provider}
        onChange={(e) => s.setProvider(e.target.value as LlmProvider)}
      >
        <option value="anthropic">Anthropic(Claude)</option>
        <option value="openai">OpenAI</option>
        <option value="deepseek">DeepSeek(便宜 · 国内可直连)</option>
      </select>

      {/* model 输入 + 一键填推荐值 */}
      <label className="mb-1 font-medium">模型名</label>
      <input
        className="mb-1 rounded border border-input-border bg-input p-2 text-input-fg outline-none focus:border-focus"
        value={s.model}
        placeholder={MODEL_HINT[s.provider]}
        onChange={(e) => s.setModel(e.target.value)}
      />
      <button
        className="mb-3 self-start text-xs text-link underline"
        onClick={() => s.setModel(MODEL_HINT[s.provider])}
      >
        用推荐值:{MODEL_HINT[s.provider]}
      </button>

      {/* baseURL */}
      <label className="mb-1 font-medium">自定义 API 地址(baseURL,可留空)</label>
      <input
        className="mb-3 rounded border border-input-border bg-input p-2 text-input-fg outline-none focus:border-focus"
        value={s.baseURL}
        placeholder="留空用官方默认;DeepSeek 留空即自动指向官方"
        onChange={(e) => s.setBaseURL(e.target.value)}
      />

      {/* api key(密码框,不回显已存的 key) */}
      <label className="mb-1 font-medium">
        API Key{' '}
        {s.hasApiKey ? (
          <span className="text-xs opacity-70">(已设置 ✅;留空则不修改)</span>
        ) : (
          <span className="text-xs opacity-70">(未设置 ⚠️)</span>
        )}
      </label>
      <input
        type="password"
        className="mb-1 rounded border border-input-border bg-input p-2 text-input-fg outline-none focus:border-focus"
        value={keyInput}
        placeholder={s.hasApiKey ? '已存;如需更换在此输入新 key' : 'sk-… 粘贴你的 key'}
        onChange={(e) => setKeyInput(e.target.value)}
      />
      {s.hasApiKey && (
        <button
          className="mb-3 self-start text-xs text-link underline"
          onClick={() => {
            s.clearApiKey();
            setKeyInput('');
          }}
        >
          清除已保存的 key
        </button>
      )}

      <div className="mt-2 flex justify-end gap-2">
        <button className="rounded bg-btn px-4 py-1.5 text-btn-fg" onClick={onSave}>
          保存
        </button>
      </div>

      <p className="mt-4 text-xs opacity-60">
        provider / model / baseURL 写入 VS Code 设置;API key 加密存入
        SecretStorage(不写入设置文件、不回传界面)。
      </p>
    </div>
  );
}
