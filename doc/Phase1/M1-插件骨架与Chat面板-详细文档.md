# M1 · 插件骨架 + Chat 面板(侧边栏)— 手把手详细文档

> 配套:总规划 [`Embed-AI-Agent-开发规划.md`](../Embed-AI-Agent-开发规划.md)、Phase 1 计划 [`Phase1-plan.md`](../Phase1-plan.md)、上一步 [`M0-工程脚手架-详细文档.md`](./M0-工程脚手架-详细文档.md)、工程约束根 `CLAUDE.md`。
>
> **本文延续 M0 的风格,面向「会 Vue + 简单 JS,但没写过 TypeScript / React,没用过 Node 工程化」的你。** 新概念第一次出现都解释,并尽量用你熟悉的 Vue 经验类比(React 的很多东西在 Vue 里都有对应)。照着做,M1 大约一到两天。

> ⚠️ **定位说明**:M1 仍属「领域无关的可对话 agent 底座」。本阶段**不接真实大模型**——后台先用一个「echo(回声)占位」模拟流式输出,把**插件骨架 + 聊天界面 + 前后端通信**这条主链路打通。真正的 LLM 流式对话在 **M2**。

> 🧭 **本文的两个关键选择(已和你确认)**:
>
> 1. 聊天界面挂在**侧边栏**(VS Code 的 `WebviewView`,像 GitHub Copilot Chat / Cline),而不是编辑器标签页。
> 2. 样式与渲染**一步到位**:**Tailwind CSS v4 + react-markdown + shiki 代码高亮**。

---

## 0. 怎么用这份文档

- 先读**第 3 节「动手前必须懂的概念」**。M1 比 M0 多了三大块新东西:**React、Webview 通信、前端构建(第二个打包产物 + Tailwind)**,不先建立心智模型会很懵。
- 第 5 节是动手部分,**分 8 个步骤**。每步结尾尽量给「运行 → 你应该看到」;有些步骤要等后面凑齐才能跑,我会用 `pnpm typecheck` 作为中途检查点。
- React 语法不认识就翻**附录 A「React / Hooks 速查(给 Vue 背景)」**。
- 白屏、CSP 报错、找不到 `acquireVsCodeApi` 之类的坑,翻**附录 B**。

> ⚠️ 心态:M1 仍然**几乎不写业务逻辑**,主要是「把 VS Code 插件的两个世界(后台 + 界面)接起来」。你会写不少「管道代码」(通信、构建、HTML 外壳),这是值得的——这套管子 M2 之后一直复用。

---

## 1. M1 要达成什么(验收目标)

做完后:

| 命令 / 操作      | 作用                           | 成功标志                                                                                   |
| ---------------- | ------------------------------ | ------------------------------------------------------------------------------------------ |
| `pnpm install`   | 装新依赖(React/Tailwind/shiki) | 无报错                                                                                     |
| `pnpm typecheck` | 类型检查(含 `.tsx`)            | `0 errors`                                                                                 |
| `pnpm build`     | 打**两个**产物 + 编译 CSS      | 生成 `dist/extension.js`、`dist/webview/main.js`、`dist/webview/main.css`                  |
| `pnpm lint`      | 代码规范                       | 无 error                                                                                   |
| `pnpm test`      | 单测                           | 仍全绿(M0 的用例不被破坏)                                                                  |
| **按 F5**        | 启动调试                       | 活动栏出现 **Embed Agent** 图标 → 点开是聊天侧边栏                                         |
| 在面板里发消息   | 端到端通信                     | 输入「你好」→ 助手气泡**逐字**冒出回声 → 底部显示 token 用量;点「停止」能中断              |
| 命令面板         | 命令可用                       | `Embed Agent: Open Chat` 能聚焦面板;`Embed Agent: Set API Key` 能把 key 存进 SecretStorage |
| 主题适配         | 明暗自适应                     | 切 VS Code 明/暗主题,面板配色与代码高亮跟着变                                              |
| Output 面板      | 可观测                         | 「输出」面板选 **Embed Agent** 频道,能看到激活耗时、配置、收到的消息                       |

**一句话交付物**:F5 → 侧边栏开面板 → 发消息 → 后台 echo 流式回 → 前端用 markdown 渲染 → 看得到 token、能停止、明暗自适配。这就是 Phase 1 的「★ tracer bullet」的**前半截**(后半截 M2 把 echo 换成真 LLM)。

---

## 2. 你会新建 / 改动的文件

`✏️ 改` = 在 M0 基础上修改;`➕ 新` = 新建;`🗑 删` = 删除占位。

```
Embed-agent/
├─ esbuild.mjs                         ✏️ 改：从打 1 个产物 → 打 2 个(扩展 + webview)
├─ package.json                        ✏️ 改：build/watch 脚本接上 Tailwind；加构建依赖
├─ tsconfig.base.json                  ✏️ 改：开启 jsx、补 DOM.Iterable
├─ .vscode/
│  ├─ launch.json                      ✏️ 改：F5 前自动 build（preLaunchTask）
│  └─ tasks.json                       ➕ 新：定义 build 任务
├─ packages/
│  ├─ extension/
│  │  ├─ package.json                  ✏️ 改：贡献点（侧边栏视图/命令/配置）
│  │  ├─ media/icon.svg                ➕ 新：活动栏图标
│  │  └─ src/
│  │     ├─ extension.ts               ✏️ 改：注册视图/命令/配置/SecretStorage/Output/计时
│  │     └─ ChatViewProvider.ts        ➕ 新：侧边栏 Webview 提供者 + echo 后台
│  ├─ webview/                         ← 本阶段的主战场（React app）
│  │  ├─ package.json                  ✏️ 改：加 react / zustand / react-markdown / shiki
│  │  └─ src/
│  │     ├─ index.ts                   🗑 删：占位文件，换成下面这些
│  │     ├─ main.tsx                   ➕ 新：React 入口（挂载到 #root）
│  │     ├─ vscodeApi.ts               ➕ 新：type-safe RPC（封装 postMessage）
│  │     ├─ store.ts                   ➕ 新：Zustand 状态（消息、流式、token）
│  │     ├─ highlighter.ts             ➕ 新：shiki 单例（用 JS 引擎，绕开 wasm）
│  │     ├─ styles.css                 ➕ 新：Tailwind 入口 + 主题变量 + shiki 配色
│  │     ├─ App.tsx                    ➕ 新：根组件
│  │     └─ components/
│  │        ├─ MessageList.tsx         ➕ 新：消息列表 + 自动滚底
│  │        ├─ MessageItem.tsx         ➕ 新：单条消息
│  │        ├─ InputBar.tsx            ➕ 新：输入框 + 发送/停止
│  │        └─ Markdown.tsx            ➕ 新：react-markdown + shiki 代码块
│  ├─ shared/                          （不动：M1 直接复用 M0 已定义的 RPC 类型）
│  └─ agent-core/                      （不动：M2 才填）
```

> 📌 注意:**`shared` 不用改**。M0 已经把 `WebviewToExt` / `ExtToWebview` 这套消息协议定义好了,M1 正好把它「用起来」——前端发 `userMessage`,后端回 `streamDelta` / `assistantDone` / `tokenUsage`。这正是 M0 当初把协议写在 `shared` 的意义。

---

## 3. 动手前必须懂的概念

M1 的难点全在「概念」上,代码本身不难。慢点读这一节。

### 概念 1:回顾——插件的「两个世界」,M1 要点亮第二个

M0 的概念 5 讲过:VS Code 插件有两块,跑在两个隔离的环境里。M1 第一次让它们**同时存在并对话**:

|                       | 跑在哪                | 能干啥                             | 我们的代码                             |
| --------------------- | --------------------- | ---------------------------------- | -------------------------------------- |
| **扩展主体(后台)**    | Node.js               | 读写文件、开子进程、（M2）调 LLM   | `extension.ts` + `ChatViewProvider.ts` |
| **Webview(聊天界面)** | 类浏览器的沙箱 iframe | 只做界面(React),**不能**碰文件系统 | `webview/` 里整个 React app            |

它俩**不能直接调用对方的函数**,只能 `postMessage` 发消息。M1 的核心就是把这条消息通道,用 `shared` 里的类型**包成类型安全的**(概念 5)。

### 概念 2:React 极简入门(对照 Vue)

你会 Vue,React 的核心概念几乎都有对应。**最大区别**:Vue 把模板、逻辑、样式分在 `<template>/<script>/<style>`;React 把「模板」直接用 JS 写成 **JSX**,逻辑和「模板」混在一个函数里。

```tsx
// 一个 React 组件 = 一个返回 JSX 的函数。函数名首字母必须大写。
function Hello({ name }: { name: string }) {
  // 这里就是 Vue 的 <script setup>
  return <p>你好, {name}</p>; // 这里就是 Vue 的 <template>;{ } 里写 JS 表达式
}
```

对照表(详见附录 A):

| Vue                         | React                               | 说明                          |
| --------------------------- | ----------------------------------- | ----------------------------- |
| `<template>` 里 `{{ x }}`   | JSX 里 `{x}`                        | 插值                          |
| `props`                     | 函数参数(一个对象)                  | `function C({ a, b }) {}`     |
| `ref(0)` / 响应式           | `const [n, setN] = useState(0)`     | 状态;**改值必须用 `setN`**    |
| `onMounted` / `watchEffect` | `useEffect(() => {...}, [deps])`    | 副作用;依赖变了重跑           |
| `:class` / `:style`         | `className={...}` / `style={{...}}` | 注意是 `className` 不是 class |
| `@click="f"`                | `onClick={f}`                       | 事件用驼峰                    |
| `v-for`                     | `arr.map(x => <Li key={x.id} />)`   | 列表必须给 `key`              |
| `v-if`                      | `{cond && <X/>}` 或三元             | 条件渲染就是 JS 表达式        |

> 🔑 React 新手最容易栽的两点:
>
> 1. **状态不可直接改**。`messages.push(x)` 不会触发刷新,必须 `setMessages([...messages, x])`(造一个新数组)。这点和 Vue 的「直接改 `.value` 就行」不同——React 靠「引用变了」判断要不要重渲染。
> 2. **`useEffect` 的依赖数组**。`useEffect(fn, [])` ≈ `onMounted`(只跑一次);`useEffect(fn, [a])` ≈ `watch(a, ...)`。返回的函数是清理逻辑 ≈ `onUnmounted`。

### 概念 3:状态管理 Zustand(对照 Pinia)

聊天界面的状态(消息列表、是否正在流式输出、token 用量)被多个组件用。像 Vue 里你会用 **Pinia**,React 这边我们用 **Zustand**——比 Pinia 还轻,一个 `create` 就建好一个「store」。

```ts
import { create } from 'zustand';

// 定义 store:状态 + 改状态的方法,全写一起
const useCounter = create<{ n: number; inc: () => void }>((set) => ({
  n: 0,
  inc: () => set((s) => ({ n: s.n + 1 })), // set 类似 Pinia 里改 state
}));

// 组件里用:传一个「选择器」只取需要的字段(类似 Pinia 的 storeToRefs 按需取)
function C() {
  const n = useCounter((s) => s.n);
  const inc = useCounter((s) => s.inc);
  return <button onClick={inc}>{n}</button>;
}
```

为什么不用 React 自带的 `useState`?小界面其实够用,但聊天状态要在「输入框、消息列表、错误条」之间共享,放进一个 store 更干净,也更接近你熟悉的 Pinia 心智。**(这也是技术栈里定好的选型,别换。)**

### 概念 4:第二个打包产物(浏览器目标)

M0 里 esbuild 只打**一个**文件:`extension.js`(Node 环境、CJS 格式)。M1 多出一个**完全不同**的产物:webview 的前端 JS。

|              | 扩展主体            | Webview 前端                       |
| ------------ | ------------------- | ---------------------------------- |
| 运行环境     | Node.js             | 浏览器(沙箱 iframe)                |
| esbuild 目标 | `platform: 'node'`  | `platform: 'browser'`              |
| 模块格式     | `format: 'cjs'`     | `format: 'iife'`(自包含、能直接跑) |
| 入口         | `extension.ts`      | `main.tsx`                         |
| 产物         | `dist/extension.js` | `dist/webview/main.js`             |

> 🔑 两个易踩的点:
>
> - **React 需要 `process.env.NODE_ENV`**。浏览器里没有 `process` 这个全局变量,如果不处理,React 一加载就报 `process is not defined`。解决:esbuild 用 `define` 在打包时把这个字符串**替换成字面量**(`'production'` / `'development'`)。
> - **Webview 的 JS 必须打成 `iife`**:把所有依赖(React、shiki…)揉进一个自包含文件,`<script>` 一引就能跑,不依赖任何模块加载器。

**CSS 谁来编译?** Tailwind 不归 esbuild 管,由 **Tailwind v4 自己的 CLI** 把 `styles.css` 编译成 `dist/webview/main.css`(概念 7)。所以 `pnpm build` = esbuild 打 2 个 JS + Tailwind 编 1 个 CSS。

### 概念 5:type-safe RPC(把 postMessage 包起来)

两个世界靠 `postMessage(任意对象)` 通信——但「任意对象」太危险:字段打错、漏处理某种消息,运行时才崩。M0 已经在 `shared` 里把**两个方向的合法消息**都定义成了类型(`WebviewToExt` / `ExtToWebview`,都是「可辨识联合」)。M1 做的就是在两端各包一层薄封装,**强制只能收发这些类型**:

- 前端 `vscodeApi.ts`:`postToExt(msg: WebviewToExt)` 发、`onExtMessage(cb)` 收——发错字段编译期就报红。
- 后端 `ChatViewProvider.ts`:`webview.postMessage(msg: ExtToWebview)` 发、`onDidReceiveMessage((msg: WebviewToExt) => ...)` 收。

这就是「RPC(远程过程调用)」的雏形:虽然底层是发消息,但用起来像「调一个有类型的接口」。

### 概念 6:CSP 与 nonce(Webview 的安全门)

Webview 本质是个网页,VS Code 强制要求你声明 **CSP(内容安全策略)**——一段写在 HTML `<meta>` 里的规则,告诉浏览器「只许加载哪些来源的脚本/样式」,防止注入攻击。

我们的策略:

- `default-src 'none'`:默认什么都不许加载(最严)。
- `script-src 'nonce-xxxx'`:只许带正确 **nonce**(一次性随机串)的 `<script>` 跑。每次生成 HTML 现造一个 nonce,贴到 `<script nonce="...">` 上——攻击者注入的脚本没这个串,跑不了。
- `style-src ${webview.cspSource} 'unsafe-inline'`:允许我们自己的 CSS 文件 + 行内样式(shiki 高亮会往 `<span>` 上写行内 `style`,所以要放行 inline)。

`webview.cspSource` 是 VS Code 给的「我们自己资源」的来源占位符。本地文件不能用普通路径,要用 `webview.asWebviewUri(...)` 转成特殊 URI 才能在 webview 里加载。

### 概念 7:Tailwind v4 + VS Code 主题变量(明暗自适配)

**Tailwind** 是「原子化 CSS」:不写 `.btn { padding: ... }`,而是在元素上堆小类名 `class="px-3 py-1 rounded"`。你在 Vue 项目里可能见过。

**v4 的关键变化**:不再需要 `tailwind.config.js`,改成「CSS 优先」——在 CSS 里 `@import "tailwindcss";` 就启用,用 `@source` 指定要扫描哪些文件的类名,用 `@theme` 定义设计变量。

**怎么自动适配 VS Code 明暗主题?** VS Code 给 webview 注入了一大堆 CSS 变量(如 `--vscode-editor-background`、`--vscode-button-background`),**主题一换,这些变量的值自动变**。我们只要在 `@theme` 里把 Tailwind 的颜色指到这些变量上:

```css
@theme {
  --color-fg: var(--vscode-foreground); /* 于是 text-fg / bg-fg 等工具类都跟随主题 */
}
```

这样写 `text-fg`、`bg-editor`、`border-panel` 就自动明暗自适应,**完全不用自己写明暗两套**。

### 概念 8:VS Code 给后台的三个能力——配置 / SecretStorage / Output

M1 第一次用到 VS Code 后台的三个常用 API:

- **配置(Configuration)**:用户在「设置」里填的项(provider、model、baseURL)。在 `package.json` 的 `contributes.configuration` 声明,代码里 `vscode.workspace.getConfiguration('embed-agent').get('model')` 读。
- **SecretStorage**:专存敏感信息(API key)的加密仓库。**绝不能**把 key 写进普通配置(会进明文 settings.json、可能被同步/提交)。用 `context.secrets.store/get/delete`。
- **Output channel**:一个只读的日志面板(「输出」里选 `Embed Agent` 频道)。打激活耗时、配置、收到的消息,方便排查——比 `console.log`(只在调试控制台可见)更正式。

### 概念 9:WebviewView(侧边栏)而不是 WebviewPanel(标签页)

VS Code 放自定义界面有两种容器:

|          | `WebviewView`(我们选这个)                                                       | `WebviewPanel`                   |
| -------- | ------------------------------------------------------------------------------- | -------------------------------- |
| 位置     | 侧边栏 / 面板区,常驻                                                            | 编辑器区,像一个文件标签          |
| 形态     | 像 Copilot Chat,切文件不丢                                                      | 打开是一个可关闭的 tab           |
| 注册方式 | `registerWebviewViewProvider` + `package.json` 里贡献 `viewsContainers`/`views` | `window.createWebviewPanel(...)` |

聊天助手常驻侧边栏体验更好,所以 M1 用 `WebviewView`。代价:侧边栏被折叠再展开时,webview 可能被销毁重建——我们用 webview 自带的 `getState/setState` 把消息存一下,展开后能恢复(步骤 5 会做)。

---

## 4. 准备工作

M0 的工具(Node ≥ 20、pnpm、Git、VS Code)都还在用,无需重装。M1 不需要任何新的系统级工具——新增的全是 npm 包,下一节用 `pnpm add` 装。

> 建议在 VS Code 里装扩展 **ESLint**、**Prettier**,再装 **Tailwind CSS IntelliSense**(写 `className` 时有 Tailwind 类名补全,体验好很多)。

---

## 5. 动手:逐步搭建

> 约定同 M0:命令都在项目根 `D:\MyCode\Embed-agent` 下跑;「文件:`xxx`」= 新建或覆盖该文件。

### 步骤 1 · 装 M1 需要的依赖

**webview 包**(React 全家桶 + 状态 + markdown + 高亮)。`--filter` 指定只装到某个包:

```powershell
# React 显式锁 18(技术栈定的;registry 上 latest 可能已是 19)。shiki 用 v4,
# 它把按语言/主题的细粒度子路径拆到了 @shikijs/langs、@shikijs/themes 两个包里。
pnpm --filter @embed-agent/webview add react@^18 react-dom@^18 react-markdown@^9 shiki zustand @shikijs/langs @shikijs/themes
# 工作区内部包要用 workspace 协议加,否则 pnpm 会去 registry 找它(报 404)
pnpm --filter @embed-agent/webview add @embed-agent/shared@workspace:*
pnpm --filter @embed-agent/webview add -D @types/react@^18 @types/react-dom@^18
```

**根目录构建工具**(Tailwind 的引擎 + CLI + 同时跑两个 watch 的小工具):

```powershell
pnpm add -D -w tailwindcss @tailwindcss/cli concurrently
```

> 版本只锁了 React(18)。其余让 pnpm 装当前最新;后面贴的 `package.json` 版本号只是**示意**,以你实际装上的为准。
>
> ⚠️ 两个易踩点:① `@embed-agent/shared` 是工作区内部包,必须 `add @embed-agent/shared@workspace:*`,直接 `add @embed-agent/shared` 会被当成 registry 包导致 `ERR_PNPM_FETCH_404`。② 安装时 pnpm 可能提示 `Ignored build scripts: esbuild…`——这是 pnpm 10 默认拦截依赖的安装脚本,esbuild 的二进制 M0 已就位,不影响构建;无需处理。

**运行 → 你应该看到**:

```powershell
pnpm install
```

无报错。`packages/webview/package.json` 里多出 `dependencies` / `devDependencies`,大致长这样(版本以实际为准):

```json
{
  "name": "@embed-agent/webview",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@embed-agent/shared": "workspace:*",
    "@shikijs/langs": "^4.1.0",
    "@shikijs/themes": "^4.1.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-markdown": "^9.1.0",
    "shiki": "^4.1.0",
    "zustand": "^5.0.13"
  },
  "devDependencies": {
    "@types/react": "^18.3.29",
    "@types/react-dom": "^18.3.7"
  }
}
```

> 注意:webview 是一个**要被打包成网页的 app**,不是给别人 `import` 的库,所以可以把 M0 留下的 `exports` 字段删掉(留着也无妨,反正没人 import 它)。它的「入口」是 esbuild 的 `main.tsx`,不走 `package.json` 的 `exports`。

### 步骤 2 · 让 TypeScript 认识 JSX

`.tsx` 文件用了 JSX 语法,要告诉 TS 怎么编译。改公共配置(各包都继承它,所以一处搞定):

**文件:`tsconfig.base.json`**(在 M0 基础上加两行)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  }
}
```

逐条解释新增项:

- `"jsx": "react-jsx"`:用 React 17+ 的「自动 JSX 运行时」——写 JSX **不用**在每个文件顶上 `import React`,编译器自动处理。
- `"DOM.Iterable"`:补上一些 DOM 可迭代类型(如 `NodeList` 能 `for...of`),省得 strict 模式偶尔报类型错。

> 加在 `base` 里对 `.ts`(扩展主体)无害——它们没有 JSX,这个选项就用不上。

### 步骤 3 · esbuild 出第二个产物(webview 前端)

把打包脚本从「打 1 个」改成「打 2 个」。

**文件:`esbuild.mjs`**(整份替换)

```javascript
import esbuild from 'esbuild';
import { mkdirSync } from 'node:fs';

// 带 --watch 就进入监听模式
const watch = process.argv.includes('--watch');
const mode = watch ? 'development' : 'production';

// 确保 webview 产物目录存在（Tailwind CLI 也会往这里写 main.css）
mkdirSync('packages/extension/dist/webview', { recursive: true });

// ① 扩展主体：Node + CommonJS（和 M0 完全一样）
const extensionCtx = await esbuild.context({
  entryPoints: ['packages/extension/src/extension.ts'],
  outfile: 'packages/extension/dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'], // 由宿主注入，绝不打包
  sourcemap: true,
});

// ② Webview 前端：浏览器 + IIFE（自包含，丢进 <script> 就能跑）
const webviewCtx = await esbuild.context({
  entryPoints: ['packages/webview/src/main.tsx'],
  outfile: 'packages/extension/dist/webview/main.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic', // 配合 tsconfig 的 react-jsx，省去 import React
  sourcemap: true,
  minify: !watch, // 生产构建压缩（React + shiki 体积不小）；watch 时不压缩好调试
  define: {
    // 浏览器里没有 process，React 又要读它，必须在打包时替换成字面量
    'process.env.NODE_ENV': JSON.stringify(mode),
  },
});

if (watch) {
  await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
  console.log('esbuild: 监听中（extension + webview），改动自动重打包…');
} else {
  await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
  await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
  console.log('esbuild: 打包完成 -> dist/extension.js + dist/webview/main.js');
}
```

> 关键点回顾(概念 4):webview 那份是 `platform: 'browser'` + `format: 'iife'` + `define` 掉 `process.env.NODE_ENV`。少了 `define` 那行,面板会白屏并在开发者工具里报 `process is not defined`。

### 步骤 4 · 接上 Tailwind(编 CSS)

**文件:`packages/webview/src/styles.css`**(Tailwind 入口 + 主题映射 + shiki 配色)

```css
@import 'tailwindcss';

/* 告诉 Tailwind 去哪些文件里扫 className（v4 用 @source；路径相对本文件） */
@source './**/*.{ts,tsx}';

/* 把 Tailwind 的颜色指到 VS Code 主题变量上 —— 于是 text-fg / bg-editor 等
   工具类全部自动跟随明暗主题，不用写两套（概念 7） */
@theme {
  --color-editor: var(--vscode-editor-background);
  --color-fg: var(--vscode-foreground);
  --color-panel: var(--vscode-panel-border);
  --color-input: var(--vscode-input-background);
  --color-input-fg: var(--vscode-input-foreground);
  --color-input-border: var(--vscode-input-border);
  --color-focus: var(--vscode-focusBorder);
  --color-btn: var(--vscode-button-background);
  --color-btn-fg: var(--vscode-button-foreground);
  --color-btn2: var(--vscode-button-secondaryBackground);
  --color-btn2-fg: var(--vscode-button-secondaryForeground);
  --color-codebg: var(--vscode-textCodeBlock-background);
  --color-link: var(--vscode-textLink-foreground);
  --color-err: var(--vscode-inputValidation-errorBackground);
  --color-err-border: var(--vscode-inputValidation-errorBorder);
}

/* 整个 webview 的底色/字体跟随 VS Code */
html,
body,
#root {
  height: 100%;
  margin: 0;
  background: var(--vscode-editor-background);
  color: var(--vscode-foreground);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
}

/* shiki 双主题：默认用 light 变量；VS Code 暗色/高对比时切到 dark 变量。
   VS Code 会给 <body> 加 vscode-light / vscode-dark / vscode-high-contrast 类 */
.shiki-block .shiki,
.shiki-block .shiki span {
  color: var(--shiki-light);
  background-color: var(--shiki-light-bg);
}
.vscode-dark .shiki-block .shiki,
.vscode-dark .shiki-block .shiki span,
.vscode-high-contrast .shiki-block .shiki,
.vscode-high-contrast .shiki-block .shiki span {
  color: var(--shiki-dark);
  background-color: var(--shiki-dark-bg);
}
.shiki-block .shiki {
  padding: 0.5rem;
  border-radius: 0.25rem;
  overflow-x: auto;
}

/* markdown 基本排版（Tailwind 的 preflight 会清掉默认样式，这里补回来一点） */
.markdown-body p {
  margin: 0.25rem 0;
}
.markdown-body ul,
.markdown-body ol {
  margin: 0.25rem 0;
  padding-left: 1.25rem;
  list-style: revert;
}
.markdown-body a {
  color: var(--vscode-textLink-foreground);
}
```

> Tailwind v4 是「CSS 优先」:**不需要** `tailwind.config.js`。`@import "tailwindcss";` 启用、`@source` 指定扫描范围、`@theme` 定义变量,就够了。

接着把构建脚本接上 Tailwind CLI。

**文件:`package.json`(根)**——替换 `scripts` 与补充 `devDependencies`:

```json
{
  "name": "embed-agent-monorepo",
  "version": "0.0.0",
  "private": true,
  "packageManager": "pnpm@10.26.2",
  "scripts": {
    "build": "node esbuild.mjs && tailwindcss -i packages/webview/src/styles.css -o packages/extension/dist/webview/main.css --minify",
    "watch": "concurrently -n js,css \"node esbuild.mjs --watch\" \"tailwindcss -i packages/webview/src/styles.css -o packages/extension/dist/webview/main.css --watch\"",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "lint": "eslint \"packages/**/*.{ts,tsx}\"",
    "format": "prettier --write .",
    "get-embed": "node scripts/get-embed.mjs"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@tailwindcss/cli": "^4.0.0",
    "@types/node": "^25.9.1",
    "concurrently": "^9.1.0",
    "esbuild": "^0.28.0",
    "eslint": "^10.4.0",
    "prettier": "^3.8.3",
    "tailwindcss": "^4.0.0",
    "typescript": "^6.0.3",
    "typescript-eslint": "^8.59.4",
    "vitest": "^4.1.7"
  }
}
```

人话解释:

- `build`:先 `node esbuild.mjs`(打两个 JS),再用 `tailwindcss` CLI 把 `styles.css` 编成 `dist/webview/main.css`(`--minify` 压缩)。`&&` 在 npm/pnpm 脚本里是跨平台安全的(由系统 shell 执行),和 CLAUDE.md 里「agent 执行命令不许用 `&&`」是两码事——那条说的是**产品**将来跑外部命令的护栏。
- `watch`:`concurrently` 同时跑两个监听——esbuild 盯 JS、Tailwind 盯 CSS(改了 `className` 也要重编 CSS,因为 Tailwind 只生成你用到的类)。
- `tailwindcss` 这个命令哪来的?装了 `@tailwindcss/cli` 后,pnpm 会自动把它放进 `node_modules/.bin`,跑脚本时能直接用,跨平台。

**运行 → 你应该看到**(这一步还没有 React 源码,先单独验证 Tailwind 能编):

```powershell
pnpm build
```

> 现在多半会**失败**,因为 `main.tsx` 还没建,esbuild 找不到入口。**这是预期的**——下一步把 React 源码补齐后再回来跑。如果你想现在就单独验证 Tailwind,可以单跑:
>
> ```powershell
> tailwindcss -i packages/webview/src/styles.css -o packages/extension/dist/webview/main.css
> ```
>
> 看到 `dist/webview/main.css` 生成即说明 Tailwind 链路通。

### 步骤 5 · webview 端:React 聊天界面

先把 M0 的占位删掉:

```powershell
Remove-Item packages/webview/src/index.ts
```

然后逐个新建下面的文件。建议按顺序读,从「最底层的工具」到「最上层的组件」。

#### 5.1 type-safe RPC 封装

**文件:`packages/webview/src/vscodeApi.ts`**

```typescript
import type { WebviewToExt, ExtToWebview } from '@embed-agent/shared';

// VS Code 注入到 webview 全局的 API。整个 webview 生命周期只能调用一次。
interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

// 往后台发消息：只接受 shared 里定义的合法消息，发错字段编译期就报红。
export function postToExt(message: WebviewToExt): void {
  vscode.postMessage(message);
}

// 订阅后台发来的消息；返回一个「取消订阅」函数（给 useEffect 当清理用）。
export function onExtMessage(handler: (message: ExtToWebview) => void): () => void {
  const listener = (event: MessageEvent) => handler(event.data as ExtToWebview);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

// 轻量持久化：侧边栏折叠再展开时 webview 会重建，用它把消息存回来（概念 9）。
export function getPersistedState<T>(): T | undefined {
  return vscode.getState() as T | undefined;
}
export function setPersistedState(state: unknown): void {
  vscode.setState(state);
}
```

> `acquireVsCodeApi` 是 VS Code 在 webview 里塞的全局函数,TS 不认识,所以用 `declare function` 告诉它「有这么个函数,签名长这样」。**它只能调一次**,所以我们在这个模块里调一次、导出封装好的函数给全 app 用。

#### 5.2 Zustand 状态

**文件:`packages/webview/src/store.ts`**

```typescript
import { create } from 'zustand';
import type { ExtToWebview } from '@embed-agent/shared';
import { postToExt, getPersistedState, setPersistedState } from './vscodeApi';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

interface PersistedState {
  messages: ChatMessage[];
}

interface ChatState {
  messages: ChatMessage[];
  streaming: boolean; // 是否正在流式输出（决定显示「发送」还是「停止」）
  error: string | null;
  tokenUsage: { input: number; output: number } | null;
  send: (text: string) => void; // 用户发一条
  stop: () => void; // 用户点停止
  receive: (msg: ExtToWebview) => void; // 收到后台消息后更新状态
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

const initial = getPersistedState<PersistedState>();

export const useChat = create<ChatState>((set, get) => ({
  messages: initial?.messages ?? [],
  streaming: false,
  error: null,
  tokenUsage: null,

  send: (text) => {
    const trimmed = text.trim();
    if (!trimmed || get().streaming) return; // 空消息 / 正在流式中，忽略
    const userMsg: ChatMessage = { id: uid(), role: 'user', text: trimmed };
    // 先放一个空的 assistant 气泡，等 streamDelta 往里灌字
    const assistantMsg: ChatMessage = { id: uid(), role: 'assistant', text: '' };
    set((s) => ({
      messages: [...s.messages, userMsg, assistantMsg],
      streaming: true,
      error: null,
    }));
    postToExt({ type: 'userMessage', text: trimmed });
  },

  stop: () => {
    postToExt({ type: 'cancelStream' });
    set({ streaming: false });
  },

  receive: (msg) => {
    switch (msg.type) {
      case 'streamDelta':
        // 把增量追加到最后一条 assistant 气泡（注意：造新数组/新对象，别原地改）
        set((s) => {
          const messages = s.messages.slice();
          const last = messages[messages.length - 1];
          if (last && last.role === 'assistant') {
            messages[messages.length - 1] = { ...last, text: last.text + msg.text };
          }
          return { messages };
        });
        break;
      case 'assistantDone':
        set({ streaming: false });
        break;
      case 'error':
        set({ error: msg.message, streaming: false });
        break;
      case 'tokenUsage':
        set({ tokenUsage: { input: msg.input, output: msg.output } });
        break;
      // toolCallStart / toolCallResult / requestConfirm：M1 先不处理，M2/M3 再接
      default:
        break;
    }
  },
}));

// 每次状态变化，把消息存回 webview state，折叠/展开侧边栏后能恢复。
useChat.subscribe((state) => {
  setPersistedState({ messages: state.messages } satisfies PersistedState);
});
```

> 这里能看到概念 2 的「状态不可原地改」:`streamDelta` 分支里我们 `slice()` 复制数组、用 `{ ...last, text: ... }` 造新对象,而不是 `last.text += ...`。这样 React/Zustand 才知道「变了,该重渲染」。

#### 5.3 shiki 高亮器(用 JS 引擎绕开 wasm)

**文件:`packages/webview/src/highlighter.ts`**

```typescript
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

// 主题与语言都「按需引入」，让打包器只打进用到的部分（体积可控）。
// shiki v4：细粒度子路径在 @shikijs/themes/* 与 @shikijs/langs/* 这两个包里。
import githubLight from '@shikijs/themes/github-light';
import githubDark from '@shikijs/themes/github-dark';
import ts from '@shikijs/langs/typescript';
import tsx from '@shikijs/langs/tsx';
import js from '@shikijs/langs/javascript';
import json from '@shikijs/langs/json';
import bash from '@shikijs/langs/bash';
import python from '@shikijs/langs/python';
import c from '@shikijs/langs/c';
import yaml from '@shikijs/langs/yaml';

let highlighter: Promise<HighlighterCore> | null = null;

// 单例：整份 webview 共用一个 highlighter，别每个代码块都新建。
export function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighter) {
    highlighter = createHighlighterCore({
      themes: [githubLight, githubDark],
      langs: [ts, tsx, js, json, bash, python, c, yaml],
      // ⚠️ 关键：用纯 JS 正则引擎，而不是默认的 oniguruma（wasm）。
      // webview 的 CSP 会拦截 wasm，用 wasm 引擎代码块会高亮失败。
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighter;
}
```

> 🔑 **M1 最隐蔽的坑**:shiki 默认用 oniguruma 的 **wasm** 做正则匹配,而 webview 的严格 CSP 不允许加载/执行 wasm。换成 `createJavaScriptRegexEngine()`(纯 JS 正则)就绕开了——无需在 CSP 里开 `wasm-unsafe-eval`,也不用 fetch。想加语言?照着 `import xxx from '@shikijs/langs/xxx'` 加进 `langs` 数组即可。
>
> 📦 **体积提醒**:shiki 的 TextMate 语法是大块 JSON,即使只引 8 种语言,minify 后 `main.js` 仍约 1.1 MB。它是从本地磁盘加载的 webview 资源(不走网络),M1 可接受;后续要瘦身可减少语言、或把高亮做成按需动态加载。

#### 5.4 markdown + 代码块组件

**文件:`packages/webview/src/components/Markdown.tsx`**

```tsx
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { getHighlighter } from '../highlighter';

// 单个代码块：异步算出高亮 HTML，算好前先显示朴素代码
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string>('');

  useEffect(() => {
    let alive = true; // 防止组件已卸载还 setState
    getHighlighter().then((hl) => {
      if (!alive) return;
      const known = hl.getLoadedLanguages();
      const safe = known.includes(lang) ? lang : 'text';
      setHtml(
        hl.codeToHtml(code, {
          lang: safe,
          themes: { light: 'github-light', dark: 'github-dark' },
          defaultColor: false, // 不写死颜色，改用 CSS 变量，跟随 VS Code 明暗
        }),
      );
    });
    return () => {
      alive = false;
    };
  }, [code, lang]);

  if (!html) {
    return (
      <pre className="overflow-x-auto rounded bg-codebg p-2 text-xs">
        <code>{code}</code>
      </pre>
    );
  }
  // shiki 产出的是一段 HTML，用 dangerouslySetInnerHTML 插入（来源是我们自己的高亮器，安全）
  return <div className="shiki-block text-xs" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        components={{
          // 把 react-markdown 默认的 <pre> 拆掉，避免 <pre><div> 这种非法嵌套
          pre({ children }) {
            return <>{children}</>;
          },
          code({ className, children }) {
            const codeText = String(children).replace(/\n$/, '');
            const match = /language-(\w+)/.exec(className ?? '');
            const isBlock = !!match || codeText.includes('\n');
            if (isBlock) {
              return <CodeBlock code={codeText} lang={match?.[1] ?? 'text'} />;
            }
            // 行内代码
            return <code className="rounded bg-codebg px-1 py-0.5 text-xs">{children}</code>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
```

> 这里第一次见到 `useState` + `useEffect` 配合(概念 2):高亮是异步的,先 `useState('')` 占位,`useEffect` 里算好后 `setHtml(...)` 触发重渲染。`alive` 标志位是 React 的常见保险:异步还没回来组件就卸载了,别再 setState。

#### 5.5 三个界面组件

**文件:`packages/webview/src/components/MessageItem.tsx`**

```tsx
import type { ChatMessage } from '../store';
import { Markdown } from './Markdown';

export function MessageItem({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className="mb-3">
      <div className="mb-1 text-xs font-semibold opacity-70">{isUser ? '你' : 'Embed Agent'}</div>
      <div className={isUser ? 'rounded bg-input px-2 py-1 text-sm' : 'text-sm leading-relaxed'}>
        {isUser ? (
          <span className="whitespace-pre-wrap">{message.text}</span>
        ) : (
          <Markdown text={message.text} />
        )}
      </div>
    </div>
  );
}
```

**文件:`packages/webview/src/components/MessageList.tsx`**

```tsx
import { useEffect, useRef } from 'react';
import { useChat } from '../store';
import { MessageItem } from './MessageItem';

export function MessageList() {
  const messages = useChat((s) => s.messages);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 新消息进来自动滚到底（useRef ≈ Vue 的模板 ref）
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto px-3 py-2">
      {messages.length === 0 && (
        <p className="mt-8 text-center text-sm opacity-60">
          发一条消息开始对话（M1 阶段后台只会原样回声）。
        </p>
      )}
      {messages.map((m) => (
        <MessageItem key={m.id} message={m} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
```

**文件:`packages/webview/src/components/InputBar.tsx`**

```tsx
import { useState } from 'react';
import { useChat } from '../store';

export function InputBar() {
  const [text, setText] = useState('');
  const streaming = useChat((s) => s.streaming);
  const send = useChat((s) => s.send);
  const stop = useChat((s) => s.stop);

  const submit = () => {
    send(text);
    setText('');
  };

  return (
    <div className="border-t border-panel p-2">
      <textarea
        className="h-16 w-full resize-none rounded border border-input-border bg-input p-2 text-sm text-input-fg outline-none focus:border-focus"
        placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="mt-1 flex justify-end gap-2">
        {streaming ? (
          <button className="rounded bg-btn2 px-3 py-1 text-sm text-btn2-fg" onClick={stop}>
            停止
          </button>
        ) : (
          <button
            className="rounded bg-btn px-3 py-1 text-sm text-btn-fg disabled:opacity-50"
            onClick={submit}
            disabled={!text.trim()}
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}
```

#### 5.6 根组件 + 入口

**文件:`packages/webview/src/App.tsx`**

```tsx
import { useEffect } from 'react';
import { useChat } from './store';
import { onExtMessage } from './vscodeApi';
import { MessageList } from './components/MessageList';
import { InputBar } from './components/InputBar';

export function App() {
  const receive = useChat((s) => s.receive);
  const error = useChat((s) => s.error);

  // 挂载时订阅后台消息，卸载时自动取消（onExtMessage 返回的就是取消函数）
  useEffect(() => onExtMessage(receive), [receive]);

  return (
    <div className="flex h-screen flex-col text-fg">
      <header className="border-b border-panel px-3 py-2 text-sm font-medium">Embed Agent</header>
      <MessageList />
      {error && (
        <div className="mx-3 mb-2 rounded border border-err-border bg-err px-2 py-1 text-xs">
          {error}
        </div>
      )}
      <InputBar />
    </div>
  );
}
```

**文件:`packages/webview/src/main.tsx`**

```tsx
import { createRoot } from 'react-dom/client';
import { App } from './App';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}
```

**运行 → 你应该看到**(前端代码齐了,先做一次类型检查):

```powershell
pnpm typecheck
```

`0 errors`。这时 `pnpm build` 也应该能成功产出三件套了:

```powershell
pnpm build
```

> 生成 `dist/extension.js`、`dist/webview/main.js`、`dist/webview/main.css`。但**先别急着 F5**——extension 那边还没注册侧边栏视图,F5 看不到东西。下一步补齐后端。

### 步骤 6 · extension 端:注册侧边栏 + echo 后台

#### 6.1 侧边栏 Webview 提供者

这是 M1 后端的核心:实现 `WebviewViewProvider`,负责①生成带 CSP 的 HTML 外壳、②收发消息、③用 echo 模拟流式后台。

**文件:`packages/extension/src/ChatViewProvider.ts`**

````typescript
import * as vscode from 'vscode';
import type { WebviewToExt, ExtToWebview } from '@embed-agent/shared';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  // 必须和 package.json 里 views 声明的 id 一致
  static readonly viewId = 'embed-agent.chat';

  private view?: vscode.WebviewView;
  private streamTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  // 视图第一次显示（或重建）时被调用
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

    view.webview.options = {
      enableScripts: true, // 允许跑我们的 main.js
      // 只允许从 dist 加载本地资源（main.js / main.css）
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };

    view.webview.html = this.getHtml(view.webview);

    // 收到 webview 的消息（类型来自 shared，编译期保证只处理这几种）
    view.webview.onDidReceiveMessage((msg: WebviewToExt) => this.onMessage(msg));
  }

  // 给 webview 发消息：只能发 ExtToWebview 里定义的类型
  private post(message: ExtToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  private onMessage(msg: WebviewToExt): void {
    switch (msg.type) {
      case 'userMessage':
        this.output.appendLine(`[user] ${msg.text}`);
        this.echo(msg.text);
        break;
      case 'cancelStream':
        this.stopEcho();
        this.output.appendLine('[user] 取消');
        break;
      case 'confirmResponse':
        // M1 还没有需要确认的操作，先记日志，M2/M3 再用
        this.output.appendLine(`[confirm] ${msg.id} -> ${msg.approved}`);
        break;
    }
  }

  // M1 占位「后台」：把用户输入分片回声，模拟流式输出。
  // M2 会把这里换成真正的 LLM 流（同样是 streamDelta → assistantDone）。
  private echo(text: string): void {
    this.stopEcho();
    const reply =
      `你说的是：\n\n> ${text}\n\n` +
      '（M1 阶段这是 **echo 占位**，M2 会接上真正的大模型。）\n\n' +
      '```ts\nconst hello = "world"; // 顺便验证 shiki 代码高亮\n```';
    // 按每 ~8 个字符切片；s 标志让 . 匹配换行，u 处理 Unicode
    const chunks = reply.match(/.{1,8}/gsu) ?? [reply];
    let i = 0;
    this.streamTimer = setInterval(() => {
      if (i >= chunks.length) {
        this.stopEcho();
        this.post({ type: 'tokenUsage', input: text.length, output: reply.length });
        this.post({ type: 'assistantDone' });
        return;
      }
      this.post({ type: 'streamDelta', text: chunks[i++] });
    }, 40);
  }

  private stopEcho(): void {
    if (this.streamTimer) {
      clearInterval(this.streamTimer);
      this.streamTimer = undefined;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    // 本地文件必须转成 webview 专用 URI 才能加载
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.css'),
    );
    // CSP：默认全禁；脚本只放行带 nonce 的；样式放行我们的文件 + 行内（shiki 要）
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} https: data:`,
    ].join('; ');

    return `<!doctype html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>Embed Agent</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
````

> 这一个文件几乎把 M1 的后端概念都用上了:`WebviewViewProvider`(概念 9)、`asWebviewUri` + CSP + nonce(概念 6)、用 `shared` 类型收发(概念 5)、`streamDelta`/`assistantDone`/`tokenUsage` 三种回包凑成「流式 + 用量」。echo 里特意塞了一个 ` ```ts ` 代码块,方便你 F5 后肉眼验证 shiki 高亮。

#### 6.2 改写插件入口

**文件:`packages/extension/src/extension.ts`**(整份替换)

```typescript
import * as vscode from 'vscode';
import { ChatViewProvider } from './ChatViewProvider';

const SECRET_KEY = 'embed-agent.apiKey';

export function activate(context: vscode.ExtensionContext): void {
  const t0 = Date.now(); // 激活计时（DoD 要求 < 1s）

  const output = vscode.window.createOutputChannel('Embed Agent');
  context.subscriptions.push(output);
  output.appendLine('Embed Agent 激活中…');
  logConfig(output);

  // 配置变化时打日志（以后用来热更新 provider）
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('embed-agent')) {
        output.appendLine('配置已变化：');
        logConfig(output);
      }
    }),
  );

  // 注册侧边栏聊天视图
  const provider = new ChatViewProvider(context, output);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider),
  );

  // 命令：打开聊天 = 聚焦那个视图。<viewId>.focus 是 VS Code 自动生成的命令。
  context.subscriptions.push(
    vscode.commands.registerCommand('embed-agent.openChat', () => {
      void vscode.commands.executeCommand('embed-agent.chat.focus');
    }),
  );

  // 命令：设置 / 清除 API key（走 SecretStorage，不写明文配置）
  context.subscriptions.push(
    vscode.commands.registerCommand('embed-agent.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: '输入 LLM API Key',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'sk-…（只存到 VS Code SecretStorage，不进设置文件）',
      });
      if (key) {
        await context.secrets.store(SECRET_KEY, key);
        output.appendLine('API key 已保存到 SecretStorage。');
        void vscode.window.showInformationMessage('Embed Agent：API key 已保存。');
      }
    }),
    vscode.commands.registerCommand('embed-agent.clearApiKey', async () => {
      await context.secrets.delete(SECRET_KEY);
      output.appendLine('API key 已清除。');
      void vscode.window.showInformationMessage('Embed Agent：API key 已清除。');
    }),
  );

  output.appendLine(`Embed Agent 激活完成，耗时 ${Date.now() - t0} ms。`);
}

export function deactivate(): void {}

function logConfig(output: vscode.OutputChannel): void {
  const cfg = vscode.workspace.getConfiguration('embed-agent');
  const provider = cfg.get<string>('llmProvider', 'anthropic');
  const model = cfg.get<string>('model', '');
  const baseURL = cfg.get<string>('baseURL', '');
  output.appendLine(`  provider = ${provider}`);
  output.appendLine(`  model    = ${model || '(默认)'}`);
  output.appendLine(`  baseURL  = ${baseURL || '(官方默认)'}`);
}
```

> M0 的 `embed-agent.hello` 命令被删掉了(下一步 `package.json` 里也会删对应声明)。这一版把 M1 需要的后台能力(视图、命令、配置、SecretStorage、Output、激活计时)一次配齐。注意 `secrets.store/get/delete` 是异步的,所以命令回调用 `async`。

### 步骤 7 · 插件清单贡献点 + 图标 + F5 配置

#### 7.1 扩展的 package.json

**文件:`packages/extension/package.json`**(整份替换)

```json
{
  "name": "embed-agent",
  "displayName": "Embed AI Agent",
  "description": "Conversational AI agent (VS Code extension)",
  "version": "0.0.1",
  "private": true,
  "engines": {
    "vscode": "^1.85.0"
  },
  "categories": ["Other"],
  "main": "./dist/extension.js",
  "activationEvents": [],
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "embed-agent",
          "title": "Embed Agent",
          "icon": "media/icon.svg"
        }
      ]
    },
    "views": {
      "embed-agent": [
        {
          "type": "webview",
          "id": "embed-agent.chat",
          "name": "Chat"
        }
      ]
    },
    "commands": [
      { "command": "embed-agent.openChat", "title": "Embed Agent: Open Chat" },
      { "command": "embed-agent.setApiKey", "title": "Embed Agent: Set API Key" },
      { "command": "embed-agent.clearApiKey", "title": "Embed Agent: Clear API Key" }
    ],
    "configuration": {
      "title": "Embed Agent",
      "properties": {
        "embed-agent.llmProvider": {
          "type": "string",
          "enum": ["anthropic", "openai", "deepseek"],
          "default": "anthropic",
          "description": "选用的大模型提供商。"
        },
        "embed-agent.model": {
          "type": "string",
          "default": "claude-opus-4-7",
          "description": "模型名，如 claude-opus-4-7 / deepseek-v4-flash。"
        },
        "embed-agent.baseURL": {
          "type": "string",
          "default": "",
          "description": "自定义 API 端点；留空用官方默认。DeepSeek 填 https://api.deepseek.com。"
        }
      }
    }
  },
  "dependencies": {
    "@embed-agent/shared": "workspace:*"
  },
  "devDependencies": {
    "@types/vscode": "^1.120.0"
  }
}
```

关键字段:

- `viewsContainers.activitybar`:在**活动栏**(最左竖排图标条)加一个 Embed Agent 入口,`icon` 指向下面要建的 svg。
- `views`:在那个容器里放一个 **`type: "webview"`** 的视图,`id` 必须和 `ChatViewProvider.viewId`(`embed-agent.chat`)一致。
- `activationEvents: []`:留空即可——现代 VS Code 会**自动**根据 `views`/`commands` 贡献生成激活事件(用户点开侧边栏或跑命令时才激活,保证激活轻、< 1s)。

> 不需要手写 `onView:...` 激活事件,也不需要 `onStartupFinished`——懒激活对达成「激活 < 1s」最有利。

#### 7.2 活动栏图标

**文件:`packages/extension/media/icon.svg`**(一个聊天气泡;VS Code 会按主题给它上色)

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <path fill="currentColor" d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm0 14H5.2L4 17.2V4h16v12z"/>
</svg>
```

> `media/` 不在 `dist/` 里,**不会被 `.gitignore` 忽略**,要提交进仓库。活动栏图标由 VS Code 直接从插件目录读,不经过 webview,所以不受 CSP/`localResourceRoots` 限制。

#### 7.3 让 F5 先自动构建

M0 里 F5 前要手动 `pnpm build`。M1 产物多了,容易忘,我们用一个「预启动任务」自动跑。

**文件:`.vscode/tasks.json`**(新建)

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "build",
      "type": "shell",
      "command": "pnpm build",
      "problemMatcher": [],
      "group": "build"
    }
  ]
}
```

**文件:`.vscode/launch.json`**(在 M0 基础上加一行 `preLaunchTask`)

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "运行插件",
      "type": "extensionHost",
      "request": "launch",
      "preLaunchTask": "build",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}/packages/extension"],
      "outFiles": ["${workspaceFolder}/packages/extension/dist/**/*.js"]
    }
  ]
}
```

> 之后按 F5,VS Code 会先跑 `pnpm build` 再启动调试宿主。开发时也可以另开终端跑 `pnpm watch`,改完代码在调试宿主里 `Ctrl+R` 重载即可(改 webview 的话,直接在面板里右键 → Reload 或重开侧边栏)。

### 步骤 8 · 跑起来 + 自检

先整体过一遍质量门禁:

```powershell
pnpm typecheck   # 0 errors
pnpm lint        # 无 error
pnpm test        # M0 的用例仍然绿
pnpm build       # 产出 dist/extension.js + dist/webview/main.js + dist/webview/main.css
```

然后 **F5**(会自动先 build):

1. 弹出「扩展开发宿主」窗口。
2. 左侧**活动栏**多出一个聊天气泡图标(Embed Agent)。点它 → 在侧边栏打开 **Chat** 面板。
3. 输入框敲「你好」,回车。
4. 助手气泡**逐字**冒出回声,末尾的 ` ```ts ` 代码块有**语法高亮**;底部能看到这轮的 token 用量(echo 用字符数凑数)。
5. 趁流式没结束点「停止」,输出立刻中断。
6. 命令面板(`Ctrl+Shift+P`)运行 `Embed Agent: Set API Key`,输入任意串 → 提示已保存(存进了 SecretStorage,不会出现在 settings.json)。
7. 把 VS Code 主题在明/暗之间切换,面板配色和代码高亮**跟着变**。
8. 打开「输出」面板(`Ctrl+Shift+U`),频道选 **Embed Agent**,能看到激活耗时、当前配置、`[user] 你好` 等日志。

🎉 到这里,M1 的「插件骨架 + Chat 面板 + 前后端 type-safe 通信 + 流式/停止 + 主题自适配」就全通了。

---

## 6. M1 验收清单

对照 `Phase1-plan.md` 的 M1 任务,逐条打勾:

- [ ] `pnpm install` 装上 React/Tailwind/shiki 等,无报错
- [ ] `pnpm typecheck` → 0 errors(含 `.tsx`)
- [ ] `pnpm lint` → 无 error
- [ ] `pnpm test` → M0 用例仍通过
- [ ] `pnpm build` → 产出 `dist/extension.js`、`dist/webview/main.js`、`dist/webview/main.css`
- [ ] F5 → 活动栏出现 Embed Agent 图标,点开是侧边栏聊天面板
- [ ] 发消息 → 助手气泡**流式**逐字回声(走 `streamDelta` → `assistantDone`)
- [ ] 流式途中点「停止」→ 能中断(走 `cancelStream`)
- [ ] 底部显示 token 用量(走 `tokenUsage`)
- [ ] 助手输出里的代码块有 **shiki 高亮**(echo 故意塞了一段 ` ```ts `)
- [ ] 切换 VS Code 明/暗主题 → 面板与高亮**自动适配**
- [ ] `Embed Agent: Open Chat` 命令能聚焦面板
- [ ] `Embed Agent: Set API Key` 把 key 存进 **SecretStorage**(不出现在 settings.json)
- [ ] 设置里能看到并修改 `embed-agent.llmProvider / model / baseURL`
- [ ] 「输出 → Embed Agent」频道能看到激活耗时、配置、收到的消息
- [ ] 激活耗时 < 1s(看 Output 里打印的毫秒数)
- [ ] CI 三平台仍绿(推上 GitHub 后)
- [ ] 提交:`git add . && git commit -m "feat: M1 插件骨架 + 侧边栏 Chat 面板"`

> ⚠️ CI 提醒:`.github/workflows/ci.yml` 里跑的是 `pnpm build`,现在它会顺带跑 Tailwind CLI。确认 `tailwindcss` / `@tailwindcss/cli` 在**根** `devDependencies` 里(步骤 4 已加),否则 CI 会报「找不到 tailwindcss」。`pnpm install --frozen-lockfile` 也要求你把更新后的 `pnpm-lock.yaml` 一起提交。

---

## 附录 A · React / Hooks 速查(给 Vue 背景的你)

### 组件与渲染

- **组件 = 返回 JSX 的函数**,名字首字母大写。没有 `<template>`,JSX 直接写在 `return` 里。
- **JSX 里嵌 JS**:用 `{}`。`{cond && <X/>}` 做条件渲染,`{arr.map(...)}` 做列表(每项要 `key`)。
- **`class` 要写成 `className`**;内联样式是对象:`style={{ color: 'red' }}`。
- **重渲染时机**:组件用到的 state/props「引用变了」就重跑整个函数。所以**别原地改 state**(`arr.push` 无效),要 `setArr([...arr, x])`。

### 三个最常用 Hook(对照 Vue)

| Hook        | 写法                               | Vue 类比                      | 备注                                                                     |
| ----------- | ---------------------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| `useState`  | `const [v, setV] = useState(初值)` | `ref`                         | 改值只能用 `setV`;`setV(prev => ...)` 拿上一次的值                       |
| `useEffect` | `useEffect(fn, [deps])`            | `onMounted` / `watch`         | `[]` 只跑一次;`[a]` 在 a 变时跑;`return () => {}` 是清理(≈`onUnmounted`) |
| `useRef`    | `const r = useRef(null)`           | 模板 `ref` / 不触发渲染的变量 | `r.current` 拿值;改它**不**触发重渲染                                    |

### 本项目里的真实例子

```tsx
// 1) 受控输入框：value 绑 state，onChange 里 setState（≈ Vue 的 v-model）
const [text, setText] = useState('');
<textarea value={text} onChange={(e) => setText(e.target.value)} />;

// 2) 订阅 + 清理：挂载时订阅，卸载时退订
useEffect(() => onExtMessage(receive), [receive]); // 返回值就是退订函数

// 3) 自动滚底：消息变了就滚（useRef 拿 DOM 节点）
const bottomRef = useRef<HTMLDivElement>(null);
useEffect(() => bottomRef.current?.scrollIntoView(), [messages]);
```

### Zustand(对照 Pinia)

```tsx
// 定义：状态 + 方法写一起，set 改状态
const useChat = create<State>((set, get) => ({
  messages: [],
  send: (t) => set((s) => ({ messages: [...s.messages, t] })),
}));

// 用：传选择器只取需要的字段（多个字段就分多次取，保持选择器返回原始值，避免多余重渲染）
const messages = useChat((s) => s.messages);
const send = useChat((s) => s.send);
```

---

## 附录 B · 常见报错与排查(M1 专属)

| 现象                                              | 多半原因                                        | 处理                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 面板**整片白屏**                                  | webview 的 JS 报错没渲染                        | 在面板里右键 → **检查 / Open Webview Developer Tools**,看 Console 报错                                |
| 开发者工具报 `process is not defined`             | esbuild 没 `define` 掉 `process.env.NODE_ENV`   | 检查 `esbuild.mjs` 的 webview 那段有没有 `define`(步骤 3)                                             |
| 控制台报 **CSP** 拦截脚本/样式                    | nonce 没对上,或加载了 CSP 没放行的来源          | 确认 `<script nonce>` 用的是同一个 nonce;本地文件都走了 `asWebviewUri`;`localResourceRoots` 含 `dist` |
| 代码块**不高亮**(纯文本)                          | shiki 用了 wasm 引擎被 CSP 拦                   | 确认 `highlighter.ts` 用的是 `createJavaScriptRegexEngine()`(步骤 5.3)                                |
| `ReferenceError: acquireVsCodeApi is not defined` | 在非 webview 环境跑了前端代码,或重复调用        | 它只在 webview 里存在且**只能调一次**——只在 `vscodeApi.ts` 调,别处 import 封装好的函数                |
| 活动栏**没有图标**                                | `media/icon.svg` 路径不对 / 没建 / 被 gitignore | 确认文件存在、`package.json` 的 `icon` 指向它;`media/` 不该被忽略                                     |
| 样式**全丢**(没 Tailwind 效果)                    | `main.css` 没编出来 / HTML 没 `<link>`          | 跑 `pnpm build` 看 `dist/webview/main.css` 是否生成;确认 `getHtml` 里有 `styleUri` 的 `<link>`        |
| 改了 `className` 不生效                           | Tailwind 只生成用到的类,CSS 没重编              | 用 `pnpm watch`(同时盯 CSS),或重跑 `pnpm build`                                                       |
| `typecheck` 报 JSX 相关错                         | `tsconfig.base.json` 没开 `jsx`                 | 确认加了 `"jsx": "react-jsx"`(步骤 2)                                                                 |
| CI 报「找不到 tailwindcss」                       | 构建依赖没进 lockfile                           | 把 `tailwindcss`/`@tailwindcss/cli` 装到根 devDeps 并提交 `pnpm-lock.yaml`                            |
| 折叠侧边栏再展开,消息没了                         | 没做状态持久化                                  | 确认 `store.ts` 里有 `getPersistedState` 初值 + `subscribe` 存回(步骤 5.2)                            |

> 调 webview 的利器:在面板里右键选 **Open Webview Developer Tools**,就是熟悉的 Chrome DevTools,能看 Console、Network、Elements——和调网页一样。

---

## 附录 C · 名词表(M1 新增)

- **Webview**:插件里显示自定义网页界面的沙箱;本项目放 React 聊天界面。
- **WebviewView / WebviewViewProvider**:把 webview 挂到**侧边栏**的方式(对应活动栏图标)。
- **WebviewPanel**:把 webview 当**编辑器标签页**打开的方式(M1 没用)。
- **postMessage / RPC**:两个隔离环境间唯一的通信手段;包上类型后用起来像「调接口」。
- **CSP(内容安全策略)**:写在 HTML 里的安全白名单,限制能加载/执行什么。
- **nonce**:一次性随机串,贴在 `<script>` 上证明「这是我放的脚本」。
- **asWebviewUri**:把本地文件路径转成 webview 能加载的特殊 URI。
- **JSX / TSX**:在 JS/TS 里直接写「类 HTML」标签的语法;`.tsx` = 带 JSX 的 TS。
- **Hook**:React 里以 `use` 开头的函数(`useState`/`useEffect`/`useRef`),给函数组件加状态和副作用能力。
- **Zustand**:轻量状态管理库(类比 Pinia)。
- **Tailwind CSS**:原子化 CSS;v4 用 CSS 优先配置(`@import`/`@source`/`@theme`)。
- **shiki**:基于 VS Code 同款引擎的语法高亮库;webview 里要用其 **JS 正则引擎**避开 wasm。
- **SecretStorage**:VS Code 存敏感信息(API key)的加密仓库。
- **Output channel**:VS Code 的只读日志面板。
- **IIFE**:一种自包含的 JS 打包格式,丢进 `<script>` 即可运行。

---

## 下一步:M2 预告

M1 完成后进 **M2 · Agent 对话核心**(主战场转到 `agent-core` 包):

- LLM **thin adapter**:`chat(messages, tools, opts) → AsyncIterable<Delta>`,**必须流式**;先 Anthropic,再加 OpenAI 分支(同分支覆盖 DeepSeek,靠 `baseURL`)。
- **工具注册 + 分发循环**:收到 `tool_use` → 校验入参 → 跑 handler → 回填 `tool_result` → 续答。
- **确认原语**:工具可标 `requiresConfirm`,执行前发 `requestConfirm`,用户允许才跑(M1 已把 `requestConfirm`/`confirmResponse` 的通道留好了)。
- 会话状态、超长截断/摘要、token 计费、provider 错误可读 + 重试。
- ★ **tracer bullet 达成**:把 M1 的 echo 后台换成真正的 LLM 流——前端**一行不用改**(还是 `streamDelta`/`assistantDone`/`tokenUsage` 那套协议)。这就是 M1 把通信协议做扎实的回报。

> 需要的话,我可以直接按本文档把这些文件**实际生成到仓库里**,你跑一遍第 6 节验收清单即可。

---

_文档版本:v0.1 · 随 M1 实施修订。_
