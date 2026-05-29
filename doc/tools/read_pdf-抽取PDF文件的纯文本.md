# `read_pdf` —— 抽取 PDF 文件的纯文本

> 状态:✅ 已实现|最近同步:M3|代码位置:`packages/agent-core/src/tools/read_pdf.ts`(+ 守门员 `tools/paths.ts`)|运行时依赖:`pdf-parse`

## 1. 一句话总结

让 LLM 读到 PDF 里的**文本层**——芯片手册、板子原理图、规格书等。当用户给的资料是 PDF、或 agent 需要查 PDF 内容时被调用。抽出来是**纯文本(丢失版面)**,复杂排版可能乱序;**仅对「有文本层」的 PDF 有效,扫描件(图像 PDF)抽不出东西**。

## 2. 接口契约

- **`name`**:`read_pdf`
- **`description`(给 LLM 看的原文)**:

  ```
  读取 PDF 文件的文本内容(抽取纯文本,丢失版面)。

  用途:读芯片手册、板子原理图、规格书等 PDF 资料。
  参数:
    - path(必填):PDF 文件路径(相对工作区根,或允许范围内的绝对路径)。
  返回:抽取的纯文本 + 总页数;超过 30000 字会被截断。
  注意:
    - 仅适用于"有文本层"的 PDF;扫描件(图像 PDF)抽出来会是空字符串。
    - 复杂版面(原理图、表格)的抽取结果顺序可能错乱——
      如果发现内容像被打乱,优先尝试用户工程里的结构化资料(如 board.yaml),
      或建议用户提供更清晰的来源。
  ```

- **`inputSchema`**:

  | 参数 | 类型 | 必填 | 默认 | 说明 |
  | --- | --- | --- | --- | --- |
  | `path` | string | ✅ | — | PDF 文件路径(相对工作区根,或允许范围内的绝对路径) |

  `additionalProperties: false`。

- **返回(`ToolResult`)**:
  - `result`(string):`元数据头 + 抽取文本 (+ 可选截断尾)`。头部形如 `[PDF 共 12 页,完整抽取]` 或 `[PDF 共 312 页,已截断]`;超 30000 字时尾部 `…(已截断)`。
  - `sources`:`[{ file: '相对路径' }]`。
  - **拒绝**(越界路径)通过 `result` 返回 `拒绝:` 开头,不抛异常。

- **`requiresConfirm`**:`false`。只读,无需确认。

## 3. 设计要点

- **为什么单独一个工具,不塞进 `read_file` 按扩展名分流**:
  1. **心智契约不同**:`read_file` 承诺「读什么得什么」;`read_pdf` 内部做了大量启发式抽取(段落顺序、表格、图注),结果**可能与原版面不一致**。分开后,LLM 看到 `read_pdf` 就知道「这是抽取过的、可能有损」。
  2. **`pdf-parse` 体积不小(~1 MB)**:独立成工具,便于将来做「按需注册」(不是每个对话都要 PDF 能力)。
- **`import pdf from 'pdf-parse'`(default import)**:`pdf-parse` 是 CommonJS 老包,导出方式是 `module.exports = fn`。在 ESM/TS 工程里**必须用 default import**,写 `import { pdf } from ...` 会得到 `undefined` → 运行时 `pdf is not a function`(见 M3 附录 B)。
- **元数据头(总页数 + 是否截断)**:和 `read_file` 的头部同款心法 —— 让 LLM 第一时间知道「我看到的是全部还是片段、原始有多少页」。
- **抽取乱序的应对**:description 明确告诉 LLM「复杂版面顺序可能错乱,优先用工程里的结构化资料」。M3 端到端场景(Blue Pill 呼吸灯)正是靠这条引导 LLM 优先读 `board-bluepill.yaml` 而非硬啃 PDF 原理图。
- **路径安全**:与另两个工具共用 `resolveSafe`(`tools/paths.ts`)。

## 4. 核心代码节选

handler 主干(路径校验后):

```ts
const buf = await readFile(abs);   // PDF 是二进制,不传编码,readFile 返回 Buffer
const data = await pdf(buf);       // pdf-parse:返回 { text, numpages, info, ... }

let text = data.text ?? '';        // 极少数 PDF 抽不出文本,兜底空串
let truncated = false;
if (text.length > MAX_CHARS) {     // MAX_CHARS = 30000
  text = text.slice(0, MAX_CHARS);
  truncated = true;
}

const header = `[PDF 共 ${data.numpages} 页,${truncated ? '已截断' : '完整抽取'}]\n\n`;
return {
  result: header + text + (truncated ? '\n\n…(已截断)' : ''),
  sources: [{ file: toDisplayPath(abs, cfg.workspaceRoot) }],
};
```

## 5. 测试

- 单测位置:目前无独立单测(PDF 解析依赖真实二进制样本,构造成本高;`pdf-parse` 本身有上游测试)。
- 路径安全这条公共命脉由 `tools/paths.test.ts` 覆盖(共用 `resolveSafe`)。
- 手动验证场景(F5 调试宿主):
  - 「读一下 xxx.pdf」→ 头部显示总页数、抽出文本
  - 扫描件 PDF → 文本为空(符合预期)
  - 越界路径 → `拒绝:` 开头
- TODO:放一个小的「有文本层」样本 PDF 进 fixtures,补一条「能抽出已知字符串 + numpages 正确」的单测。

## 6. 已知局限 / 后续 TODO

- **扫描件无效**:图像 PDF 没有文本层,抽出空字符串;要支持得上 OCR(不在 Phase 1 范围)。
- **复杂版面乱序**:原理图/表格按视觉位置排,抽取顺序可能错乱 —— 见设计要点的应对。
- **不能按页读**:当前抽全文 + 30000 字截断。真要 `pages: "1-3"` 需换 `pdfjs-dist`(API 复杂得多),M3 不做。
- **30000 字截断**:粗暴按字符切;长手册会丢后半部分。后续可配合「按页读」或检索定位改进。
- **体积**:`pdf-parse` 给 `dist/extension.js` 增重 ~1 MB;将来工具变多可做「按需注册」只在需要时加载。
