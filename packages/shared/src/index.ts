// ========== 1) 工具返回契约(见 Phase1 计划 §五)==========
// interface = 描述"一个对象长什么样"。类比 Vue 里给 props 定义形状。
export interface Source {
  file: string; // 必填:来源文件路径
  lines?: string; // 问号 = 可选字段,比如 "1-40"
  section?: string; // 可选:文档小节标题
}

// <T> 是"泛型":调用时再决定 result 的具体类型(附录 A 有讲)。
// = unknown 是默认值:不指定时当作"未知类型"。
export interface ToolResult<T = unknown> {
  result: T;
  sources?: Source[]; // Source[] = "Source 组成的数组"
}

// ========== 2) 配置 ==========
//
// 用户在 VS Code 设置里填的东西。注意:API key 不在这里 —— key 太敏感,
// 走 VS Code 的 SecretStorage 存(见步骤 3 package.json 旁的说明),不写进普通配置。
//
// provider = 用哪家大模型。这里用"字面量联合"(只能填列出的这几个之一):
// 好处是填错当场报红;以后加新 provider 时,凡是没处理它的代码编译器都会提醒。
//   - 'anthropic':开发期默认,工具调用最准(见规划 §3.3)
//   - 'openai'   :备选
//   - 'deepseek' :便宜选项。它的接口"兼容 OpenAI",所以底层复用 OpenAI SDK,
//                  只要把下面的 baseURL 指到 https://api.deepseek.com 即可
export type LlmProvider = 'anthropic' | 'openai' | 'deepseek';

export interface AgentConfig {
  // 用哪家(上面三者之一)
  provider: LlmProvider;
  // 具体模型名,如 'claude-opus-4-7'、'deepseek-v4-flash'。取值开放 → string。
  model: string;
  // 自定义 API 端点(可选)。留空 = 用该 provider 的官方默认地址;
  // 填了就打到这个地址 —— DeepSeek、自建网关、任何"OpenAI 兼容"服务都靠它。
  // 例:用 DeepSeek 时填 'https://api.deepseek.com'。
  baseURL?: string;
}

// ========== 3) RPC 消息协议(Webview 与 Extension 互发的消息)==========
//
// 回忆概念 5:webview(聊天界面)跑在沙箱里,不能直接调用 extension(Node 后台)
// 的函数,两边只能靠 postMessage "发消息"。所以这里把"允许互发的消息"全部列成类型,
// 两个方向各一个类型,前后端共用 —— 谁都不会发错字段、也不会漏处理某种消息。
//
// 下面每个成员都是"可辨识联合"(discriminated union):靠 type 字段当"标签",
// 收到后用 switch (msg.type) 就能精确知道这条消息还带了哪些字段(附录 A 有详解)。
// 这是本项目最重要的 TS 模式,务必理解。

// ---- 方向一:Webview(界面)──► Extension(后台)----
export type WebviewToExt =
  // 用户在输入框敲了一句并发送 —— 一轮对话的起点,后台收到后启动 agent 循环。
  // text:用户输入的原文。
  | { type: 'userMessage'; text: string }
  // 用户点了"停止":要求中断当前正在流式输出的这轮回答。无额外字段。
  | { type: 'cancelStream' }
  // 用户对某条"确认请求"(见下方 requestConfirm)的回应。
  // id:对应是哪一条请求(可能同时挂着多条);approved:同意 / 拒绝 ——
  // 这就是"执行命令"等受控操作的"放行开关"(对应"write-heavy is gated"原则)。
  | { type: 'confirmResponse'; id: string; approved: boolean }
  // ↓↓↓ 可视化设置面板用的几条消息 ↓↓↓
  // 打开设置面板时,向后台索取当前配置(provider/model/baseURL + 是否已设置 key)。
  | { type: 'getConfig' }
  // 保存「非敏感」配置(写进 VS Code 设置)。
  | { type: 'saveConfig'; provider: LlmProvider; model: string; baseURL: string }
  // 设置 API key(存进 SecretStorage;key 永不回传前端)。
  | { type: 'setApiKey'; key: string }
  // 清除 API key。
  | { type: 'clearApiKey' };

// ---- 方向二:Extension(后台)──► Webview(界面)----
export type ExtToWebview =
  // 回答的一小片增量文本(流式输出,一片一片来);界面把 text 追加到当前气泡。
  // 为什么不整段一次发?因为"必须流式",边生成边显示体验才好(见规划 §3.3)。
  | { type: 'streamDelta'; text: string }
  // agent 开始调用某个工具了;id 用于和下面的 result 配对(一轮可能并发多个工具),
  // name 是工具名(如 'get_current_time')。界面据此显示"正在调用 xxx…",让用户看见
  // agent 在做什么(可审计)。
  | { type: 'toolCallStart'; id: string; name: string }
  // 某次工具调用结束;id 对应上面的 start,name 是哪个工具,ok 表示成功与否。界面更新那条状态。
  | { type: 'toolCallResult'; id: string; name: string; ok: boolean }
  // 本轮回答彻底结束(流式输出完了)。无字段;界面可借此重新启用输入框。
  | { type: 'assistantDone' }
  // agent 想执行一个需要用户点头的操作(如执行命令),请界面弹确认卡片。
  // id:之后用户的 confirmResponse 靠它对应回来(M2 起可同时挂多条,按 id 配对);
  // toolName:将要调用的工具名;summary:一句人话说明它要干什么(原样给用户看清再决定)。
  | { type: 'requestConfirm'; id: string; toolName: string; summary: string }
  // 出错了(LLM 报 429 / 超时、配置缺失等);message 是人类可读的说明。
  | { type: 'error'; message: string }
  // 本轮 / 累计 token 用量;input、output 分别是输入、输出 token 数。
  // 界面显示出来,让用户对"花了多少"心里有数(见规划 §3.3 token 计费)。
  | { type: 'tokenUsage'; input: number; output: number }
  // 当前配置回传前端(hasApiKey 只表示「是否已设置」,绝不回传 key 本身)。
  | {
      type: 'configState';
      provider: LlmProvider;
      model: string;
      baseURL: string;
      hasApiKey: boolean;
    };

// ========== 4) 一个小工具函数(纯粹为了有东西可测试)==========
// 参数和返回值都标了类型。反引号是"模板字符串",你在 JS 里见过。
export function formatTokenUsage(input: number, output: number): string {
  return `${input} in / ${output} out`;
}
