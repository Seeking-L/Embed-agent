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

// ★ M3:真实只读工具(read_file / list_files / read_pdf)+ 路径安全 helper
//   注意它们是「工厂函数」而非常量,因为需要 extension 注入 allowedRoots(见 doc 概念 2)。
export { createReadFileTool } from './tools/read_file';
export { createListFilesTool } from './tools/list_files';
export { createReadPdfTool } from './tools/read_pdf';
export {
  resolveSafe,
  toDisplayPath,
  PathOutOfRangeError,
  type FsToolConfig,
} from './tools/paths';

// 错误小工具(extension 也可能想直接用)
export { humanizeError, isAbortError } from './errors';
