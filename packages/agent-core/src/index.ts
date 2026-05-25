// ============================================================================
// index.ts —— agent-core 的「对外门面」
// ----------------------------------------------------------------------------
// 别的包(extension)只从这里 import,不直接深入到内部文件。这样以后内部怎么重构,
// 对外的入口都稳定。
// ============================================================================

// 所有类型(ChatTurn / ToolSpec / AgentEvent / ConfirmRequest …)
export * from './types';

// 工具注册表
export { ToolRegistry } from './registry';

// 核心循环 + 它的参数类型
export { runAgent, type RunAgentOptions } from './loop';

// 按 provider 造 adapter 的工厂
export { createAdapter } from './adapters';

// 通用 system prompt(extension 一般用不到,导出以便测试/复用)
export { SYSTEM_PROMPT } from './prompt';

// 演示工具(M3 起会被真实工具替换/补充)
export { demoTools, getCurrentTime, runDemoCommand } from './tools/demo';

// 错误小工具(extension 也可能想直接用)
export { humanizeError, isAbortError } from './errors';
