// ============================================================================
// loop.ts —— ★ agent 的工具循环(整个 M2 的心脏)
// ----------------------------------------------------------------------------
// 大模型「只会动脑、不会动手」:它能请求调用工具,但真正执行工具、把结果喂回去的是
// 我们。这个来回可能反复多次,所以是个 while 循环:
//
//   把(历史 + 工具清单)发给模型(流式)
//     ├─ 模型只输出文字、不要工具 → 把文字流给用户 → 本轮结束 ✅
//     └─ 模型要调工具 → 我们执行 → 结果回填进历史 → 再发一次给模型(回到循环顶部)
//
// 它是异步生成器(async function*):一边干活,一边把「发生了什么」yield 给上层
// (extension),上层再转成消息发给前端。
// ============================================================================

import type { ToolResult } from '@embed-agent/shared';
import type { AgentEvent, ChatTurn, ConfirmFn, LlmAdapter, ToolCall } from './types';
import type { ToolRegistry } from './registry';
import { SYSTEM_PROMPT } from './prompt';
import { humanizeError, isAbortError } from './errors';

// 单个工具结果回填给模型的字符数上限,超了就截断(防止一个超大文件撑爆上下文/烧钱)。
//
// 【M3 调整】从 8000 抬到 500_000。原因:
//   - M2 时只有演示工具(get_current_time 返回 ~20 字符),8000 完全够用,只是个粗糙的兜底;
//   - M3 起接 read_file 真工具,它的最大输出是 ~400 KB(header + 400 KB body + footer)。
//     如果 loop 继续按 8000 字符截,read_file 自己的"分段 + 续读提示"全部被截掉,
//     LLM 看不到末尾的 `start_line=N+1`,等于把 read_file 的核心设计废了。
//   - 500_000 字符 ≈ 125K~250K tokens(取决于英/中/代码),Opus 4.7 的 1M 上下文完全扛得住,
//     但仍是有效的"运行时安全网":若将来某工具失控吐 10 MB,loop 还能切一刀。
//
// 改这个值时请一并检查:read_file.ts 的 MAX_BYTES(400 KB)是不是仍 < 这个上限。
const MAX_TOOL_RESULT_CHARS = 500_000;

// runAgent 的参数。用一个对象打包,比一长串位置参数清楚。
export interface RunAgentOptions {
  adapter: LlmAdapter; // 用哪家模型(已由工厂按 provider 造好)
  registry: ToolRegistry; // 可用工具
  model: string; // 模型名
  // 调用方(extension)已经把「本轮用户消息」push 进了 history;loop 会把
  // 「模型发言 / 工具结果」继续追加进同一个数组,实现多轮记忆。
  history: ChatTurn[];
  confirm: ConfirmFn; // 依赖注入的确认函数(危险工具执行前问用户)
  signal?: AbortSignal; // 取消信号(用户点「停止」)
}

// 返回 AsyncIterable<AgentEvent>:上层用 `for await (const ev of runAgent(...))` 逐个接事件。
export async function* runAgent(opts: RunAgentOptions): AsyncIterable<AgentEvent> {
  const { adapter, registry, model, history, confirm, signal } = opts;
  const tools = registry.specs();

  // 多步循环:直到某一轮模型「不再要工具、只输出文字」为止。
  while (true) {
    if (signal?.aborted) return; // 进每轮前先看是否已取消

    let assistantText = ''; // 累积本轮模型说的话
    // 累积本轮的「思考过程」文本(仅思考型模型——DeepSeek thinking、R1 等——有)。
    // 必须把它和 assistantText 分开累加:DeepSeek 要求下一轮请求里把上一轮的
    // reasoning_content 一起回传,否则报 400(`The reasoning_content in the thinking
    // mode must be passed back to the API`)。
    let assistantReasoning = '';
    const toolCalls: ToolCall[] = []; // 本轮模型想调的工具

    // ① 把当前历史发给模型,边收边吐
    try {
      for await (const ev of adapter.chat({
        system: SYSTEM_PROMPT,
        messages: history,
        tools,
        model,
        signal,
      })) {
        if (ev.type === 'text') {
          assistantText += ev.text;
          yield { type: 'text', text: ev.text }; // 文字 → 立刻转发给上层
        } else if (ev.type === 'reasoning') {
          // 思考片段:累加 + 转发给上层(extension 可以选择展示成"思考中..."折叠区,
          // 或单纯打到日志——这是 UI 的事;loop 只负责保证下一轮请求带上它)。
          assistantReasoning += ev.text;
          yield { type: 'reasoning', text: ev.text };
        } else if (ev.type === 'toolCall') {
          toolCalls.push(ev.call); // 工具请求 → 先收集,等流结束再统一执行
        } else if (ev.type === 'usage') {
          yield { type: 'usage', input: ev.input, output: ev.output };
        }
      }
    } catch (e) {
      if (isAbortError(e)) return; // 用户取消:安静收尾,不报错
      yield { type: 'error', message: humanizeError(e) }; // 真错误:翻成人话发上去
      return;
    }

    // ② 把模型这一轮的发言记进历史
    // 用展开 `...(condition ? { x: ... } : {})` 表达"可选字段":
    //   - reasoningContent 仅当本轮真的收到了 reasoning 片段才加;
    //   - toolCalls 仅当模型确实要调工具才加。
    // 这样普通模型(非思考、不调工具)的 assistant turn 就是干净的 `{role, content}`,
    // 不会带任何 undefined 字段。
    const reasoningPart = assistantReasoning ? { reasoningContent: assistantReasoning } : {};
    if (toolCalls.length > 0) {
      history.push({
        role: 'assistant',
        content: assistantText,
        ...reasoningPart,
        toolCalls,
      });
    } else {
      // 没要调工具 → 本轮彻底结束
      history.push({
        role: 'assistant',
        content: assistantText,
        ...reasoningPart,
      });
      yield { type: 'done' };
      return;
    }

    // ③ 逐个执行工具。⚠️ 正确性关键:每个 tool_use 都必须配一条 tool_result,
    //    即便取消/拒绝/失败也要补一条 —— 否则下一轮请求结构非法(Anthropic 会直接报错)。
    for (const call of toolCalls) {
      yield { type: 'toolStart', id: call.id, name: call.name };

      let text: string; // 要回填给模型的结果文本
      let ok = true; // 成功与否(只影响 UI 上的图标)
      const spec = registry.get(call.name);

      if (signal?.aborted) {
        text = '已取消。';
        ok = false;
      } else if (!spec) {
        // 模型幻觉出一个不存在的工具名
        text = `未知工具:${call.name}`;
        ok = false;
      } else if (
        spec.requiresConfirm &&
        // await confirm(...) 会「卡」在这里,直到用户在面板上点了允许/拒绝(见确认原语)
        !(await confirm({ id: call.id, toolName: call.name, summary: summarize(call.input) }))
      ) {
        text = '用户拒绝了该操作。';
        ok = false;
      } else {
        // 正常执行工具的 handler
        try {
          text = stringifyResult(await spec.handler(call.input));
        } catch (e) {
          text = `工具执行失败:${(e as Error).message}`;
          ok = false;
        }
      }

      yield { type: 'toolEnd', id: call.id, name: call.name, ok };
      history.push({ role: 'tool', toolCallId: call.id, content: cap(text) });
    }

    if (signal?.aborted) return; // 工具跑完若已取消,就不再请求模型
    // 否则回到 while 顶部:带着工具结果再问一次模型,让它续答。
  }
}

// ---------------------------------------------------------------------------
// 几个内部小工具
// ---------------------------------------------------------------------------

// 给确认卡片用的一句话摘要:命令类工具直接显示命令,其它显示参数 JSON。
function summarize(input: unknown): string {
  if (input && typeof input === 'object' && 'command' in input) {
    return String((input as { command: unknown }).command);
  }
  return JSON.stringify(input);
}

// 把工具返回的 ToolResult 变成「喂回模型的字符串」。带 sources 时附上来源(对应「输出契约」)。
function stringifyResult(r: ToolResult): string {
  const body = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
  if (!r.sources?.length) return body;
  const src = r.sources.map((s) => `- ${s.file}${s.lines ? `:${s.lines}` : ''}`).join('\n');
  return `${body}\n\n来源:\n${src}`;
}

// 超长截断
function cap(s: string): string {
  return s.length <= MAX_TOOL_RESULT_CHARS ? s : `${s.slice(0, MAX_TOOL_RESULT_CHARS)}\n…(已截断)`;
}
