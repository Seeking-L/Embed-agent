// ============================================================================
// types.ts —— agent-core 的「契约中心」
// ----------------------------------------------------------------------------
// 这一份相当于 agent-core 内部的 shared:adapter(适配各家大模型)、loop(工具
// 循环)、registry(工具注册表)全都依赖这里定义的类型。先读这个文件,再读别的会
// 顺很多。
//
// 给 TS 新手的几个记号速记(在本文件反复出现):
//   interface X { ... }          —— 描述「一个对象长什么样」(类比 Vue 里给 props 定形状)
//   type X = A | B               —— 联合类型,「X 要么是 A 要么是 B」
//   字段名后面的 ?               —— 可选字段,可有可无
//   unknown                      —— 「类型未知」,比 any 安全:用之前 TS 逼你先收窄类型
//   AsyncIterable<T>             —— 「能被 for await...of 一个个取出 T 的东西」(流)
// ============================================================================

import type { ToolResult } from '@embed-agent/shared';

// ========== 1) 统一的「工具调用请求」==========
// 大模型自己不执行工具,它只会「请求」:我要调 name 这个工具,参数是 input。
// id 是这次调用的唯一标识(模型生成,如 'toolu_xxx' / 'call_xxx'),用来把
// 「调用」和「结果」对应起来。
export interface ToolCall {
  id: string;
  name: string;
  // input 用 unknown 而不是 any:它来自模型吐出的 JSON,我们事先不知道具体形状,
  // 在真正使用前(工具的 handler 里)再收窄成期望的类型。这样更安全。
  input: unknown;
}

// ========== 2) 统一的「一条对话消息」==========
// 这是「provider 无关」的中间格式。两个 adapter 各自把它翻译成自家 SDK 的消息格式。
// 它是「可辨识联合」:靠 role 字段当标签,switch (turn.role) 就能精确知道这条消息
// 还带哪些字段——和 shared 里的 WebviewToExt/ExtToWebview 是同一个 TS 模式。
export type ChatTurn =
  // 用户说的话
  | { role: 'user'; content: string }
  // 模型说的话;它可能在说话的同时「要求调用若干工具」(toolCalls 可选)
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  // 某次工具调用的结果;toolCallId 对应上面 ToolCall 的 id,content 是结果文本
  | { role: 'tool'; toolCallId: string; content: string };

// ========== 3) 统一的「工具描述」==========
// 一个工具 = 给模型看的说明书(name/description/inputSchema)+ 真正干活的 handler。
export interface ToolSpec {
  name: string;
  // description 是给「大模型」读的:这工具是干嘛的、什么时候该用。写得越清楚,
  // 模型越知道何时调用它(写得含糊是「模型不肯调工具」的头号原因)。
  description: string;
  // 用 JSON Schema 描述参数长什么样。两家 SDK 声明工具参数用的都是 JSON Schema,
  // 所以我们写一份,adapter 直接转交即可。Record<string, unknown> = 「键是字符串、
  // 值随意的普通对象」,这里就是一坨 JSON Schema。
  inputSchema: Record<string, unknown>;
  // 危险操作?标 true,执行前会先弹确认(见 loop.ts 与确认原语)。? 表示可省略,
  // 省略即视为 false。
  requiresConfirm?: boolean;
  // 真正干活的函数。input 是模型给的参数;返回 Promise(因为可能是异步,比如读文件)。
  // 返回值是 M0 就定好的 ToolResult(`{ result, sources? }`),结果可带「来源引用」。
  handler: (input: unknown) => Promise<ToolResult>;
}

// ========== 4) 统一的「流事件」==========
// adapter 在收到模型的流式输出时,边收边「吐」出这些事件;loop 用 for await 接。
export type LlmStreamEvent =
  // 一小片回答文字(模型边想边说,一片一片来)
  | { type: 'text'; text: string }
  // 模型完整地请求了一次工具调用(参数已拼接、解析完毕)
  | { type: 'toolCall'; call: ToolCall }
  // 本次请求的 token 用量(由 API 真实返回,不用我们自己数)
  | { type: 'usage'; input: number; output: number };

// adapter 的输入:一次「请把这些消息 + 这些工具发给模型」的请求。
export interface LlmChatRequest {
  system: string; // 系统提示(设定模型身份与工作方式)
  messages: ChatTurn[]; // 对话历史(统一中间格式)
  tools: ToolSpec[]; // 可用工具清单
  model: string; // 模型名,如 'claude-opus-4-7'
  signal?: AbortSignal; // 取消信号:用户点「停止」时用它掐断请求
}

// ========== 5) adapter 接口 ==========
// loop 只认这个接口,永远不知道底层用的是 Anthropic 还是 OpenAI。
// chat() 返回一个 AsyncIterable:可以用 `for await (const ev of adapter.chat(...))` 逐个收事件。
export interface LlmAdapter {
  chat(req: LlmChatRequest): AsyncIterable<LlmStreamEvent>;
}

// ========== 6) 循环对外(给 extension)吐的事件 ==========
// 注意它和上面的 LlmStreamEvent 不同:LlmStreamEvent 是「单次模型请求」内部的事件;
// AgentEvent 是「整个 agent 循环」对外的事件,额外包含工具开始/结束、整轮结束、错误。
// extension 会把每个 AgentEvent 一一映射成 shared 的 ExtToWebview 发给前端。
export type AgentEvent =
  | { type: 'text'; text: string } // 一小片回答文字
  | { type: 'toolStart'; id: string; name: string } // 开始执行某工具
  | { type: 'toolEnd'; id: string; name: string; ok: boolean } // 某工具执行完(成功/失败)
  | { type: 'usage'; input: number; output: number } // token 用量
  | { type: 'done' } // 本轮彻底结束(模型不再要工具)
  | { type: 'error'; message: string }; // 出错了(已是人话)

// ========== 7) 确认原语(依赖注入)==========
// loop 不知道怎么弹窗(它不碰 vscode/webview)。它只接受一个 confirm 函数,
// 准备执行危险工具时 `await confirm(req)`,拿到 true 才执行。具体「怎么弹、怎么等
// 用户点」由 extension 实现后注入进来。这就是「依赖注入」。
export interface ConfirmRequest {
  id: string;
  toolName: string;
  summary: string; // 一句人话:这次要干什么(给用户看)
}
// 一个「接收确认请求、返回 Promise<是否允许>」的函数类型。
export type ConfirmFn = (req: ConfirmRequest) => Promise<boolean>;
