// ============================================================================
// tools/demo.ts —— 两个演示工具
// ----------------------------------------------------------------------------
// M2 的目标是「框架就位」,所以这里给两个「假工具」来验证工具循环 + 确认原语:
//   - get_current_time:无参数、无需确认 —— 验证最朴素的「调用→拿结果→续答」。
//   - run_demo_command:带参数、需要确认 —— 验证确认原语(它并不真执行命令,只是
//                       回显;真正受控的 run_command 是 M3 的事)。
//
// 真正会读文件/跑命令的工具(M3)要跑在 extension 里(因为要碰 vscode/文件系统),
// 所以那些工具的定义会放在 extension 包;这里只放「不依赖环境」的纯演示工具。
// ============================================================================

import type { ToolSpec } from '../types';

// 工具①:返回当前时间。无参数、无副作用、无需确认。
export const getCurrentTime: ToolSpec = {
  name: 'get_current_time',
  description: '返回当前的日期与时间(ISO 8601 格式)。当用户问"现在几点 / 今天几号"时调用。',
  // 一个「不需要任何参数」的 JSON Schema:对象、没有属性、不允许多余字段。
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  // handler 必须返回 Promise,所以用 async。返回的 { result } 就是 ToolResult。
  handler: async () => ({ result: new Date().toISOString() }),
};

// 工具②:演示「需要确认」的受控操作。它并不真执行命令,只是回显,纯粹用来验证确认原语。
export const runDemoCommand: ToolSpec = {
  name: 'run_demo_command',
  description: '【演示用】假装执行一条命令并返回结果。用于演示"需要用户确认"的受控操作。',
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string', description: '要执行的命令' } },
    required: ['command'], // command 是必填
    additionalProperties: false,
  },
  requiresConfirm: true, // ← 关键:执行前会触发确认卡片
  handler: async (input) => {
    // input 的类型是 unknown,用之前先断言成我们期望的形状。
    const { command } = input as { command: string };
    return { result: `(demo) 假装执行了:${command}\n退出码:0` };
  },
};

// 打包成一个数组,方便 extension 一次性全部 register。
export const demoTools: ToolSpec[] = [getCurrentTime, runDemoCommand];
