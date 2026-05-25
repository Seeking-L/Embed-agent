// ============================================================================
// loop.test.ts —— 用「假 adapter」测工具循环(完全离线,不烧 API)
// ----------------------------------------------------------------------------
// 这是「agent-core 不碰 vscode、可单测」的兑现:不联网、不花钱,就能验证工具循环的
// 逻辑对不对(也为 M4 的评测打底)。假 adapter 第一轮要求调工具,第二轮给最终答复。
// ============================================================================

import { describe, it, expect } from 'vitest';
import { runAgent } from './loop';
import { ToolRegistry } from './registry';
import type { AgentEvent, ChatTurn, LlmAdapter } from './types';

// 一个「假」adapter:第 1 次被调用 → 要求调 get_current_time;第 2 次 → 给最终文字。
// 它完全不联网,只是按固定脚本 yield 事件。
function stubAdapter(): LlmAdapter {
  let round = 0;
  return {
    async *chat() {
      round += 1;
      if (round === 1) {
        yield { type: 'text', text: '让我查一下时间。' };
        yield { type: 'toolCall', call: { id: 't1', name: 'get_current_time', input: {} } };
        yield { type: 'usage', input: 10, output: 5 };
      } else {
        yield { type: 'text', text: '现在时间已获取,回答完毕。' };
        yield { type: 'usage', input: 20, output: 8 };
      }
    },
  };
}

describe('runAgent 工具循环', () => {
  it('调用工具后能拿结果续答,并把历史补全', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'get_current_time',
      description: '',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ result: '2026-05-24T00:00:00Z' }),
    });

    const history: ChatTurn[] = [{ role: 'user', content: '现在几点?' }];
    const events: AgentEvent[] = [];
    for await (const ev of runAgent({
      adapter: stubAdapter(),
      registry,
      model: 'stub',
      history,
      confirm: async () => true, // 测试里一律放行
    })) {
      events.push(ev);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain('toolStart');
    expect(types).toContain('toolEnd');
    expect(types[types.length - 1]).toBe('done'); // 最后一定是 done
    // 历史被补全:既有「助手要调工具」也有「工具结果」
    expect(history.some((t) => t.role === 'tool')).toBe(true);
    expect(history.some((t) => t.role === 'assistant' && t.toolCalls?.length)).toBe(true);
  });

  it('requiresConfirm 工具被拒绝时不执行 handler,且回填「拒绝」结果', async () => {
    const registry = new ToolRegistry();
    let handlerCalled = false;
    registry.register({
      name: 'danger',
      description: '',
      inputSchema: { type: 'object', properties: {} },
      requiresConfirm: true,
      handler: async () => {
        handlerCalled = true; // 若被调用就翻 true —— 我们要断言它「没」被调用
        return { result: '不该被调用' };
      },
    });

    // 假 adapter:第 1 轮要求调 danger;第 2 轮收尾
    let round = 0;
    const adapter: LlmAdapter = {
      async *chat() {
        round += 1;
        if (round === 1) {
          yield { type: 'toolCall', call: { id: 'd1', name: 'danger', input: {} } };
        } else {
          yield { type: 'text', text: '已了解,操作被拒绝。' };
        }
      },
    };

    const history: ChatTurn[] = [{ role: 'user', content: '删点东西' }];
    for await (const ev of runAgent({
      adapter,
      registry,
      model: 'stub',
      history,
      confirm: async () => false, // 一律拒绝
    })) {
      void ev;
    }

    expect(handlerCalled).toBe(false); // 关键:被拒绝 → handler 不执行
    // 即便拒绝,也补了一条 tool 结果(否则下一轮请求结构非法)
    const toolResult = history.find((t) => t.role === 'tool');
    expect(toolResult?.content).toContain('拒绝');
  });
});
