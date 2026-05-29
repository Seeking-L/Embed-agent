// ============================================================================
// ApplyDiffCard.tsx —— 「应用 / 放弃」写文件提议卡片(M4)
// ----------------------------------------------------------------------------
// 这是 ConfirmCard 的「孪生兄弟」:当后台想改文件时,会先在 VS Code 原生 diff 编辑器里
// 打开改动,并发 requestApplyDiff,store 把它存进 applyDiff 状态;这张卡片就显示出来。
// 用户点「应用 / 放弃」→ respondApplyDiff 把结果发回后台:
//   - 应用 → 后台才真正把改动写盘(diff-first:在此之前文件没动过);
//   - 放弃 → 后台关掉 diff,什么都不写。
// applyDiff 为 null 时返回 null(不渲染)。
//
// 注意:逐行的 diff 在【diff 编辑器】里看,这张卡片只放「改哪个文件 + 一句概述 + 两个按钮」。
// ============================================================================

import { useChat } from '../store';

export function ApplyDiffCard() {
  const applyDiff = useChat((s) => s.applyDiff);
  const respond = useChat((s) => s.respondApplyDiff);
  if (!applyDiff) return null;

  return (
    <div className="mx-3 mb-2 rounded border border-focus bg-input p-2 text-xs">
      <div className="mb-2">
        Agent 想修改文件 <code>{applyDiff.path}</code>:
        <div className="mt-1 whitespace-pre-wrap opacity-80">{applyDiff.summary}</div>
        <div className="mt-1 opacity-60">改动已在 diff 编辑器中打开,请查看后决定是否应用。</div>
      </div>
      <div className="flex justify-end gap-2">
        <button className="rounded bg-btn2 px-3 py-1 text-btn2-fg" onClick={() => respond(false)}>
          放弃
        </button>
        <button className="rounded bg-btn px-3 py-1 text-btn-fg" onClick={() => respond(true)}>
          应用
        </button>
      </div>
    </div>
  );
}
