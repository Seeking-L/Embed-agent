// ============================================================================
// registry.ts —— 工具注册表
// ----------------------------------------------------------------------------
// 就是一个带「防重名」的 Map<工具名, ToolSpec>。所有可用工具登记在这里,loop 执行
// 工具时按名字来取。「工具可插拔」就体现在这里:以后 M3 加 read_file、将来加查芯片的
// 工具,都只是 registry.register(一个 ToolSpec),loop 的代码一行不用动。
// ============================================================================

import type { ToolSpec } from './types';

export class ToolRegistry {
  // Map 是 JS 内置的「键值表」,这里键是工具名(string),值是工具描述(ToolSpec)。
  // private = 类外部不能直接访问,只能通过下面的方法操作。
  private tools = new Map<string, ToolSpec>();

  // 登记一个工具。重名直接抛错,避免「两个工具同名、调哪个都说不清」。
  register(spec: ToolSpec): void {
    if (this.tools.has(spec.name)) {
      throw new Error(`工具重名:${spec.name}`);
    }
    this.tools.set(spec.name, spec);
  }

  // 按名字取一个工具。可能不存在,所以返回类型是 `ToolSpec | undefined`。
  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  // 把所有工具列出来,发给大模型(adapter 只会用到 name/description/inputSchema)。
  // [...x.values()] 是「展开语法」:把 Map 的所有值摊成一个数组。
  specs(): ToolSpec[] {
    return [...this.tools.values()];
  }
}
