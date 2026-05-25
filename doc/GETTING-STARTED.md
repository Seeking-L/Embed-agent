# 运行指南 · Getting Started

> 目标:从零把本项目在你的机器上跑起来,并按 F5 看到插件生效。
> 想了解项目是什么、进度如何,见 [README](../README.md) 与 [开发进度与路线图](./ROADMAP.md)。
> 想理解每一步**为什么这么搭**(面向 TS/Node 新手的手把手),见 [M0 脚手架详细文档](./Phase1/M0-工程脚手架-详细文档.md)。

---

## 1. 前置条件

| 工具        | 版本               | 说明                                                                          |
| ----------- | ------------------ | ----------------------------------------------------------------------------- |
| **Node.js** | ≥ 20(建议 22 LTS)  | 去 <https://nodejs.org> 装 LTS 版。验证:`node -v`                             |
| **pnpm**    | 10.x(已锁 10.26.2) | 推荐用 corepack 启用(见下),版本由 `package.json` 的 `packageManager` 字段锁定 |
| **Git**     | 任意较新版         | 验证:`git --version`                                                          |
| **VS Code** | ≥ 1.85             | 建议装扩展 **ESLint**、**Prettier**、**Tailwind CSS IntelliSense**            |

启用 pnpm(最省心的方式):

```bash
corepack enable
```

> `corepack` 是 Node 自带的。仓库已用 `packageManager: "pnpm@10.26.2"` 锁定版本,corepack 会自动用对的 pnpm。
> 若 `corepack` 不可用,退而求其次:`npm install -g pnpm`。
> 本阶段**不需要 Python**(嵌入式/领域能力相关依赖等方向确定后再说)。

详细的工具安装步骤见 [M0 文档 §4](./Phase1/M0-工程脚手架-详细文档.md)。

---

## 2. 获取代码

```bash
git clone <仓库地址>
cd Embed-agent
```

---

## 3. 安装依赖

```bash
pnpm install
```

完成后根目录出现 `node_modules/`。

> ⚠️ **两个已知坑**:
>
> - 若报 `ERR_PNPM_OUTDATED_LOCKFILE`(lockfile 与 `package.json` 不一致):`pnpm install --no-frozen-lockfile`。
> - 若 `node_modules` 是跨机器复制来的、出现「模块找不到」:让 pnpm 重建 —— 非交互环境下 `CI=true pnpm install --no-frozen-lockfile`(Windows PowerShell 用 `$env:CI="true"; pnpm install --no-frozen-lockfile`)。

---

## 4. 常用命令

全部命令在根目录用 `pnpm <名字>` 运行。

| 命令             | 作用                                                                                       | 状态        |
| ---------------- | ------------------------------------------------------------------------------------------ | ----------- |
| `pnpm install`   | 装依赖、链接本地包                                                                         | ✅          |
| `pnpm typecheck` | 类型检查(`tsc --noEmit`)                                                                   | ✅          |
| `pnpm test`      | 跑单元测试(vitest)                                                                         | ✅          |
| `pnpm build`     | 打包扩展 + webview + 编 Tailwind CSS(出 `dist/extension.js`、`dist/webview/main.{js,css}`) | ✅          |
| `pnpm watch`     | 监听改动、自动重打包(esbuild + Tailwind 同跑)                                              | ✅          |
| `pnpm lint`      | ESLint 代码规范检查                                                                        | ✅          |
| `pnpm format`    | Prettier 格式化(**会原地改写**全仓)                                                        | ✅          |
| `pnpm get-embed` | (占位脚本,尚未实现)                                                                        | ⬜ 暂不可用 |

跑**单个测试**:`pnpm test <文件路径片段>` 或 `pnpm test -t "<用例名>"`。

> `pnpm format` 目前没有 `.prettierignore`,会改写包括 `doc/` 在内的所有文件(因 `proseWrap` 默认 `preserve`,不会重排中文段落换行)。

---

## 5. 运行插件(按 F5)

1. (可选)先 `pnpm build`;`launch.json` 已配 `preLaunchTask`,**按 F5 会自动构建**。
2. 在 VS Code 里**按 F5**(或菜单「运行 → 启动调试」)。
3. 弹出一个新窗口(标题带「扩展开发宿主 / Extension Development Host」)。
4. 新窗口左侧**活动栏**出现 **Embed Agent** 图标,点它打开侧边栏 **Chat** 面板。
5. 在输入框发一条消息 → 助手气泡**逐字**回声(含一段高亮代码块),可点「停止」中断;底部显示 token 用量。

看到这些即说明:**插件能装载、侧边栏视图能挂载、前后端 type-safe 通信通、打包链路通**。(命令面板里也能用 `Embed Agent: Open Chat` / `Set API Key`。)

---

## 6. 日常开发循环

```bash
pnpm watch    # 开一个终端常驻,改代码自动重打包
```

改完代码后,在「扩展开发宿主」窗口按 `Ctrl+R` 重载即可看到效果,无需重启调试。

提交前建议跑一遍:

```bash
pnpm typecheck && pnpm lint && pnpm test
```

(这正是 CI 在三平台上跑的检查,见 [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)。)

---

## 7. 常见问题

| 现象                                       | 多半原因                           | 处理                                                                                             |
| ------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `Cannot find module '@embed-agent/shared'` | 改了包后没重新链接                 | 根目录跑 `pnpm install`                                                                          |
| `pnpm` 无法识别为命令                      | pnpm 没装好                        | `corepack enable`,见 §1                                                                          |
| 按 F5 没反应 / 命令找不到                  | 没先 `pnpm build`,或命令 id 不一致 | 先 `pnpm build`;核对命令 id                                                                      |
| 插件运行报 `Cannot find module 'vscode'`   | esbuild 没把 vscode 设为 external  | 检查 `esbuild.mjs` 的 `external`                                                                 |
| Chat 面板**白屏**                          | webview JS 报错 / CSP 拦截         | 面板内右键 →「检查」看 Console;详见 [M1 文档 附录 B](./Phase1/M1-插件骨架与Chat面板-详细文档.md) |
| `lint` 报一堆格式问题                      | 没格式化                           | 先 `pnpm format` 再 `pnpm lint`                                                                  |

更完整的排错与名词解释见 [M0 文档 附录 B / 附录 C](./Phase1/M0-工程脚手架-详细文档.md);TS/现代 JS 语法速查见该文档 附录 A。

---

## 8. 下一步

- M1(侧边栏 Chat 面板)怎么搭、为什么这么搭:[M1 详细文档](./Phase1/M1-插件骨架与Chat面板-详细文档.md)。
- M2(LLM + 流式 + 工具框架 + 可视化设置面板)怎么搭:[M2 详细文档](./Phase1/M2-Agent对话核心-详细文档.md)。
- 想**真正和模型对话**:F5 后点聊天面板右上角 **⚙** 选 provider、填 model、粘 API key(国内推荐 DeepSeek,最便宜、可直连);详见 [M2 文档 · 步骤 13](./Phase1/M2-Agent对话核心-详细文档.md)。
- 想知道接下来开发什么:[开发进度与路线图](./ROADMAP.md)。
- 写代码前请先读工程约束与护栏:[CLAUDE.md](../CLAUDE.md)。
