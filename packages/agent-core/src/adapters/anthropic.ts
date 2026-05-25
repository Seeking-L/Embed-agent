// ============================================================================
// adapters/anthropic.ts —— Anthropic(Claude)适配器
// ----------------------------------------------------------------------------
// 它做三件事:
//   ① 把我们的「统一格式」翻译成 Anthropic SDK 要的格式;
//   ② 调用 SDK 的「流式」接口;
//   ③ 把 Anthropic 吐出的事件,翻回我们的「统一流事件」(LlmStreamEvent)。
// 对上,它只暴露 LlmAdapter 接口,loop 不知道底层是哪家。
// ============================================================================

import Anthropic from '@anthropic-ai/sdk';
import type { ChatTurn, LlmAdapter, LlmChatRequest, LlmStreamEvent, ToolSpec } from '../types';

// 工厂函数:给它 key(和可选的自定义地址),返回一个「Anthropic 版」的 adapter。
export function createAnthropicAdapter(apiKey: string, baseURL?: string): LlmAdapter {
  // maxRetries:SDK 自带「对 429/5xx 做指数退避重试」,不用我们自己写重试循环。
  // ...(baseURL ? { baseURL } : {}) 是「条件展开」:填了 baseURL 才加这个字段,否则用官方默认。
  const client = new Anthropic({ apiKey, maxRetries: 3, ...(baseURL ? { baseURL } : {}) });

  return {
    // async *chat = 异步生成器:能一边 await(等网络)一边 yield(吐事件)。
    async *chat(req: LlmChatRequest): AsyncIterable<LlmStreamEvent> {
      // 开流。stream: true 让返回值变成「可 for await 的事件流」而不是整条消息。
      // 第二个参数 { signal } 把取消信号交给 SDK —— abort() 后这个流会抛错。
      const stream = await client.messages.create(
        {
          model: req.model,
          max_tokens: 4096, // Anthropic 必填:本次最多生成多少 token
          stream: true,
          system: req.system, // Anthropic 的 system 是顶层单独字段(OpenAI 是塞进 messages)
          messages: toAnthropicMessages(req.messages),
          tools: toAnthropicTools(req.tools),
        },
        { signal: req.signal },
      );

      // 模型请求工具时,参数(input)是以「JSON 字符串片段」一段段流式下发的,
      // 要自己拼起来,等这个块结束时再整体 JSON.parse。pending 就是「正在拼的那个工具」。
      let pending: { id: string; name: string; json: string } | null = null;
      let inputTokens = 0;
      let outputTokens = 0;

      // 逐个消费 Anthropic 的原始事件。event.type 是标签,switch 进不同分支。
      for await (const event of stream) {
        switch (event.type) {
          case 'message_start':
            // 消息开始:这里能拿到输入 token 数
            inputTokens = event.message.usage.input_tokens;
            break;
          case 'content_block_start':
            // 模型开了一个新「内容块」。如果是工具调用块,记下 id/name,准备拼参数。
            if (event.content_block.type === 'tool_use') {
              pending = { id: event.content_block.id, name: event.content_block.name, json: '' };
            }
            break;
          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              // 普通回答文字 → 立刻吐出去(这就是你看到的「逐字冒出」)
              yield { type: 'text', text: event.delta.text };
            } else if (event.delta.type === 'input_json_delta' && pending) {
              // 工具参数的 JSON 片段 → 攒到 pending.json 上
              pending.json += event.delta.partial_json;
            }
            break;
          case 'content_block_stop':
            // 一个内容块结束。若它是工具块,把攒好的 JSON 解析成对象,吐出完整 toolCall。
            if (pending) {
              const input = pending.json ? JSON.parse(pending.json) : {};
              yield { type: 'toolCall', call: { id: pending.id, name: pending.name, input } };
              pending = null;
            }
            break;
          case 'message_delta':
            // 消息推进:这里能拿到「到目前为止」的输出 token 数(最后一条即总数)
            outputTokens = event.usage.output_tokens;
            break;
        }
      }
      // 流结束,汇报本次 token 用量
      yield { type: 'usage', input: inputTokens, output: outputTokens };
    },
  };
}

// ---------------------------------------------------------------------------
// 下面是「翻译」:统一格式 → Anthropic 格式
// ---------------------------------------------------------------------------

// 工具清单:Anthropic 要 { name, description, input_schema }
function toAnthropicTools(tools: ToolSpec[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    // 我们的 inputSchema 是 JSON Schema;断言成 Anthropic 期望的类型即可。
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

// 消息历史:把统一的 ChatTurn[] 翻成 Anthropic 的 MessageParam[]。
function toAnthropicMessages(turns: ChatTurn[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const turn of turns) {
    if (turn.role === 'user') {
      out.push({ role: 'user', content: turn.content });
    } else if (turn.role === 'assistant') {
      if (turn.toolCalls && turn.toolCalls.length > 0) {
        // 助手「又说话又调工具」:内容拼成 [文本块?, 工具块, 工具块…]
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (turn.content) blocks.push({ type: 'text', text: turn.content });
        for (const c of turn.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: c.id,
            name: c.name,
            input: c.input as Record<string, unknown>,
          });
        }
        out.push({ role: 'assistant', content: blocks });
      } else {
        // 纯文字回答
        out.push({ role: 'assistant', content: turn.content });
      }
    } else {
      // 工具结果。⚠️ Anthropic 要求:tool_result 必须放进「紧跟在那条 assistant 之后的
      // 一条 user 消息」里。所以这里把「连续的多个工具结果」合并进同一条 user 消息。
      const block: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: turn.toolCallId,
        content: turn.content,
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        // 上一条已经是「装着工具结果的 user 消息」,直接追加进去
        last.content.push(block);
      } else {
        // 否则新开一条 user 消息
        out.push({ role: 'user', content: [block] });
      }
    }
  }
  return out;
}
