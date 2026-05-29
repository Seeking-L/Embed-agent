// ============================================================================
// MessageItem.tsx —— 渲染时间线里的一项
// ----------------------------------------------------------------------------
// M2 起一项可能是「工具调用条目」或「普通气泡」,所以先按 role 分流渲染。
//
// 【M3 补丁】assistant 多了一个可选的 `reasoning` 字段(思考型模型独有,例如
// DeepSeek thinking / R1)。渲染顺序:
//   [💭 思考过程(可折叠,限高 + 流式自动滚到底)]
//      ↑ 仅 reasoning 非空时出现
//      ↑ 默认展开;**正文首段到达后 ~500ms 自动折叠**(让用户聚焦最终答案)
//      ↑ 一旦用户手动展开/折叠过,程序不再覆盖
//   [主气泡:正文 markdown]
//
// 用 HTML5 原生 <details>/<summary> 做折叠,浏览器自带键盘 + ARIA;但因为我们要
// 程序化自动折叠,这里用 React state(open)+ onToggle 做"双向同步"——
//   - 自动折叠:setOpen(false) → React 把 DOM 里的 open 属性去掉 → 浏览器收起内容;
//   - 用户点击:浏览器先改 DOM → 触发 toggle 事件 → onToggle 把新状态同步回 React。
// 不做同步的话,React 在下次渲染时会把用户的折叠状态强制改回 state,造成"点不动"。
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import type { ChatItem } from '../store';
import { Markdown } from './Markdown';

export function MessageItem({ item }: { item: ChatItem }) {
  // ─── 工具调用条目:一行小标签,带状态图标(执行中 / 成功 / 失败)
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

  // 后面同时处理 user 与 assistant 两种气泡。
  // 三元真值分支让 TS 把 item 收窄成 assistant,合法访问 item.reasoning(user 没这字段)。
  const isUser = item.role === 'user';
  const reasoning = item.role === 'assistant' ? item.reasoning : undefined;
  const hasText = !isUser && !!item.text;

  // ─── 思考区:折叠状态管理 ───
  //
  // 决策表(initialHasText 来自 useRef 的"挂载瞬间"快照):
  //
  //   挂载时 hasText | 初始 open | 是否能自动折叠 | 适用场景
  //   --------------+-----------+--------------+--------------------------------
  //   false         | true      | 是           | 正在流式生成:思考先来 → 展开看;
  //                 |           |              | 正文一到 → 自动折叠
  //   true          | false     | 否           | 挂载时正文已在(刷新 webview /
  //                 |           |              | 历史回放),直接收起,不打扰
  //
  // initialHasText 用 useRef 而不是普通 const:它必须在组件多次渲染间稳定不变,
  // 否则在 hasText 变化触发的重渲染里"挂载时是 false 还是 true"会被覆盖,逻辑出错。
  const initialHasTextRef = useRef(hasText);
  const [open, setOpen] = useState(!initialHasTextRef.current);
  // autoCollapsedRef:一次性闸门——已经自动折叠过 / 已是历史消息,后续不再自动改 open。
  const autoCollapsedRef = useRef(initialHasTextRef.current);

  useEffect(() => {
    if (!reasoning || !hasText || autoCollapsedRef.current) return;
    autoCollapsedRef.current = true;
    // 500ms 给用户一个短暂的"思考完了 → 答案开始 → 思考淡出"的视觉过渡。
    // 立即折叠会显得突兀,1s+ 又拖得太久。
    const timer = setTimeout(() => setOpen(false), 500);
    return () => clearTimeout(timer);
  }, [hasText, reasoning]);

  // ─── 思考区:流式自动滚到底 ───
  //
  // 思考区限高 max-h-64(16rem ≈ 256px),内容超出会出滚动条。流式输入时新内容
  // 在底部追加,但浏览器默认不自动滚 —— 用户看到的还是顶部那段,新内容看不见。
  // 这里每次 reasoning 变化(每一个流片段)把滚动条强制贴底,保证用户跟得上模型思路。
  //
  // 副作用:如果用户手动滚回去看上面,新片段会把他们拽回底部。这是常见的"聊天室
  // 自动跟随"权衡——多数人想看新内容,少数想回看的可暂时折叠思考区再展开看。
  const reasoningRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reasoningRef.current) {
      reasoningRef.current.scrollTop = reasoningRef.current.scrollHeight;
    }
  }, [reasoning]);

  return (
    <div className="mb-3">
      <div className="mb-1 text-xs font-semibold opacity-70">{isUser ? '你' : 'Embed Agent'}</div>

      {/* ─── 思考过程 ─── */}
      {reasoning && (
        <details
          open={open}
          // 用户点 summary → 浏览器先翻转 DOM 的 open → 触发 toggle → 在这里同步回 state。
          // 不做同步,React 下次渲染会用 open prop 把 DOM 强制覆盖回去,看起来"点不动"。
          onToggle={(e) => {
            const isOpen = (e.currentTarget as HTMLDetailsElement).open;
            if (isOpen !== open) setOpen(isOpen);
          }}
          className="mb-2 text-xs opacity-70"
        >
          <summary className="cursor-pointer select-none rounded bg-codebg px-2 py-1 font-medium">
            💭 思考过程
          </summary>
          <div
            ref={reasoningRef}
            className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap border-l-2 border-codebg pl-3 italic"
          >
            {reasoning}
          </div>
        </details>
      )}

      {/* ─── 主气泡 ─── */}
      {/* assistant.text 可能在 reasoning 已经开始流但正文还没到时为空——
          这时不渲染主气泡的内框,只看到思考区,UX 上更干净。 */}
      {(isUser || item.text) && (
        <div className={isUser ? 'rounded bg-input px-2 py-1 text-sm' : 'text-sm leading-relaxed'}>
          {isUser ? (
            <span className="whitespace-pre-wrap">{item.text}</span>
          ) : (
            <Markdown text={item.text} />
          )}
        </div>
      )}
    </div>
  );
}
