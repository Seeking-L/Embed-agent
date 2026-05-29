// ============================================================================
// adapters/openai.ts —— OpenAI 适配器(同时覆盖 DeepSeek)
// ----------------------------------------------------------------------------
// 和 anthropic.ts 同样实现 LlmAdapter 接口,只是翻译成 OpenAI 的协议。
// DeepSeek「兼容 OpenAI」,所以复用这一份,只需把 baseURL 指到 deepseek 即可
// (见 adapters/index.ts 的工厂)。
//
// 对照 anthropic.ts 能直观看到几处差异:
//   - system 提示:OpenAI 塞进 messages 的第一条(role:'system'),不是顶层字段。
//   - 工具声明:包一层 { type:'function', function:{...} }。
//   - 工具结果:每个是一条独立的 role:'tool' 消息(Anthropic 是合并进 user)。
// ============================================================================

import OpenAI from 'openai';
import type { ChatTurn, LlmAdapter, LlmChatRequest, LlmStreamEvent, ToolSpec } from '../types';

export function createOpenAiAdapter(apiKey: string, baseURL?: string): LlmAdapter {
  const client = new OpenAI({ apiKey, maxRetries: 3, ...(baseURL ? { baseURL } : {}) });

  return {
    async *chat(req: LlmChatRequest): AsyncIterable<LlmStreamEvent> {
      const stream = await client.chat.completions.create(
        {
          model: req.model,
          messages: toOpenAiMessages(req.system, req.messages),
          tools: toOpenAiTools(req.tools),
          tool_choice: 'auto', // 让模型自己决定要不要调工具
          stream: true,
          stream_options: { include_usage: true }, // 让最后一片带上 token 用量
        },
        { signal: req.signal },
      );

      // OpenAI 的工具调用是「按 index 分片」下发的:name 来一片、arguments 来好几片,
      // 都带同一个 index。我们按下标把它们攒进 calls 数组里。
      const calls: { id: string; name: string; args: string }[] = [];

      for await (const chunk of stream) {
        // 流里每一片叫 chunk;正常内容在 choices[0].delta 里。
        const choice = chunk.choices[0];
        if (choice?.delta?.content) {
          yield { type: 'text', text: choice.delta.content };
        }
        // 「思考过程」文本(DeepSeek thinking / R1 等模型独有,OpenAI SDK 的官方
        // 类型里没声明此字段,所以用 as 断言一下;非思考型模型这个字段永远是 undefined)。
        // 这一片必须 yield 给 loop 累加进 ChatTurn.reasoningContent —— DeepSeek 要求
        // 下一轮请求里把上一轮的 reasoning_content 一起回传,否则 400。
        const reasoning = (choice?.delta as { reasoning_content?: string } | undefined)
          ?.reasoning_content;
        if (reasoning) {
          yield { type: 'reasoning', text: reasoning };
        }
        // ?? [] :delta.tool_calls 可能没有,用空数组兜底,免得 for 报错。
        for (const tc of choice?.delta?.tool_calls ?? []) {
          // ??= :calls[index] 还没有就先建一个空壳,再往里填。
          const slot = (calls[tc.index] ??= { id: '', name: '', args: '' });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments; // 参数片段累加
        }
        // 带了 include_usage 时,最后会有一片 choices 为空、只带 usage。
        if (chunk.usage) {
          yield {
            type: 'usage',
            input: chunk.usage.prompt_tokens,
            output: chunk.usage.completion_tokens,
          };
        }
      }

      // 流结束后,把攒好的工具调用逐个吐出(参数字符串此时已完整,可以 JSON.parse)。
      for (const c of calls) {
        if (!c.name) continue;
        yield {
          type: 'toolCall',
          call: { id: c.id, name: c.name, input: c.args ? JSON.parse(c.args) : {} },
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 翻译:统一格式 → OpenAI 格式
// ---------------------------------------------------------------------------

function toOpenAiTools(tools: ToolSpec[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

function toOpenAiMessages(
  system: string,
  turns: ChatTurn[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  // OpenAI 的 system 提示是 messages 里的第一条
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
  ];
  for (const turn of turns) {
    if (turn.role === 'user') {
      out.push({ role: 'user', content: turn.content });
    } else if (turn.role === 'assistant') {
      // 【DeepSeek thinking 兼容】思考型模型(DeepSeek thinking、R1 等)在上一轮流里
      // 会单独吐 reasoning_content。loop 已把它累加进 turn.reasoningContent;这里把它
      // 原样塞回 assistant 消息——不传就 400(`The reasoning_content in the thinking
      // mode must be passed back to the API`)。非思考型模型 reasoningContent 是
      // undefined,展开 `{}` 不会污染消息。
      //
      // 因为 OpenAI SDK 的官方类型里没有 reasoning_content 字段,我们先构造一个普通
      // 对象再 as 成 ChatCompletionMessageParam(超集允许多余字段,API 自己会识别)。
      const reasoningPart: Record<string, string> = turn.reasoningContent
        ? { reasoning_content: turn.reasoningContent }
        : {};

      if (turn.toolCalls && turn.toolCalls.length > 0) {
        out.push({
          role: 'assistant',
          content: turn.content || null, // 只调工具、没说话时 content 为 null
          ...reasoningPart,
          tool_calls: turn.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            // OpenAI 这里要的是「参数的 JSON 字符串」,所以把对象再 stringify 回去
            function: { name: c.name, arguments: JSON.stringify(c.input) },
          })),
        } as OpenAI.Chat.Completions.ChatCompletionMessageParam);
      } else {
        out.push({
          role: 'assistant',
          content: turn.content,
          ...reasoningPart,
        } as OpenAI.Chat.Completions.ChatCompletionMessageParam);
      }
    } else {
      // 工具结果:OpenAI 用独立的一条 role:'tool' 消息(和 Anthropic 不同,不用合并)
      out.push({ role: 'tool', tool_call_id: turn.toolCallId, content: turn.content });
    }
  }
  return out;
}
