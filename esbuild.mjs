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
