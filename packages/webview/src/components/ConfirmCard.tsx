// ============================================================================
// ConfirmCard.tsx —— 「允许 / 拒绝」确认卡片
// ----------------------------------------------------------------------------
// 当后台想执行一个 requiresConfirm 工具时,会发 requestConfirm,store 把它存进
// confirm 状态;这张卡片就显示出来。用户点按钮 → respondConfirm 把结果发回后台。
// confirm 为 null 时返回 null(不渲染任何东西)。
// ============================================================================

import { useChat } from '../store';

export function ConfirmCard() {
  const confirm = useChat((s) => s.confirm);
  const respond = useChat((s) => s.respondConfirm);
  if (!confirm) return null;

  return (
    <div className="mx-3 mb-2 rounded border border-focus bg-input p-2 text-xs">
      <div className="mb-2">
        Agent 想调用工具 <code>{confirm.toolName}</code>:
        <div className="mt-1 whitespace-pre-wrap opacity-80">{confirm.summary}</div>
      </div>
      <div className="flex justify-end gap-2">
        <button className="rounded bg-btn2 px-3 py-1 text-btn2-fg" onClick={() => respond(false)}>
          拒绝
        </button>
        <button className="rounded bg-btn px-3 py-1 text-btn-fg" onClick={() => respond(true)}>
          允许
        </button>
      </div>
    </div>
  );
}
