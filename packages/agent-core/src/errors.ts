// ============================================================================
// errors.ts —— 错误处理小工具
// ----------------------------------------------------------------------------
// 两件事:
//   1. 识别「用户主动取消」——取消不是真错误,要安静收尾,不该弹红色报错。
//   2. 把 SDK 抛出的错误翻成「人话」,前端只显示一句话,而不是一屏堆栈。
// ============================================================================

// 判断一个错误是不是「用户点了停止 / AbortController.abort() 触发的取消」。
// 不同 SDK 抛的取消错误名字不一样,这里把几种常见的都认一下。
export function isAbortError(e: unknown): boolean {
  // e instanceof Error:先确认它是个 Error 对象(才有 .name / .message 可读)
  return (
    e instanceof Error &&
    (e.name === 'AbortError' || e.name === 'APIUserAbortError' || /abort/i.test(e.message))
  );
}

// 把错误翻成人话。SDK 抛的网络错误对象上通常带一个 status(HTTP 状态码),
// 我们按状态码给出对应的中文说明。
export function humanizeError(e: unknown): string {
  // e 的类型是 unknown(我们不确定它是什么),先「断言」成「可能有 status/message 的对象」
  // 再读字段。?. 是可选链:对象为空也不会报错。
  const err = e as { status?: number; message?: string };
  switch (err?.status) {
    case 401:
      return 'API key 无效或未设置。请运行命令「Embed Agent: Set API Key」。';
    case 403:
      return '没有访问该模型/接口的权限(403)。请检查 key 的额度与权限。';
    case 404:
      return '模型或接口不存在(404)。请检查「设置」里的 model 与 baseURL 是否匹配当前 provider。';
    case 429:
      return '触发提供商限流(429),自动重试后仍失败。请稍后再试。';
    case 500:
    case 503:
    case 529:
      return '提供商服务暂时不可用,请稍后再试。';
    default:
      // ?? 是空值合并:err.message 为空时用后面的兜底。String(e) 把任意值转成字符串。
      return `请求失败:${err?.message ?? String(e)}`;
  }
}
