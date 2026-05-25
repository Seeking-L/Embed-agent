// ============================================================================
// adapters/index.ts —— 适配器工厂
// ----------------------------------------------------------------------------
// 按用户配置里的 provider,造出对应的 adapter。DeepSeek 复用 OpenAI 那份,只是默认
// 把 baseURL 指到 deepseek。这样 loop 拿到的永远是统一的 LlmAdapter,不关心是哪家。
// ============================================================================

import type { AgentConfig } from '@embed-agent/shared';
import type { LlmAdapter } from '../types';
import { createAnthropicAdapter } from './anthropic';
import { createOpenAiAdapter } from './openai';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

export function createAdapter(config: AgentConfig, apiKey: string): LlmAdapter {
  switch (config.provider) {
    case 'anthropic':
      // config.baseURL 可能是空串,|| undefined 把空串变成「不传」,用官方默认地址
      return createAnthropicAdapter(apiKey, config.baseURL || undefined);
    case 'openai':
      return createOpenAiAdapter(apiKey, config.baseURL || undefined);
    case 'deepseek':
      // DeepSeek 兼容 OpenAI:没填 baseURL 就默认指向 deepseek 官方
      return createOpenAiAdapter(apiKey, config.baseURL || DEEPSEEK_BASE_URL);
  }
}
