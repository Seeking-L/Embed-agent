import esbuild from 'esbuild';

// 是否带 --watch 参数(改代码自动重新打包)
const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: ['packages/extension/src/extension.ts'], // 从入口出发
  outfile: 'packages/extension/dist/extension.js', // 打成这一个文件
  bundle: true, // 把依赖都揉进来
  platform: 'node', // 目标是 Node 环境(不是浏览器)
  format: 'cjs', // VS Code 插件要求 CommonJS 格式
  target: 'node18',
  external: ['vscode'], // ⚠️ vscode 由宿主提供,绝不能打包进去
  sourcemap: true,
});

if (watch) {
  await ctx.watch();
  console.log('esbuild: 监听中,改动会自动重打包…');
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log('esbuild: 打包完成 -> packages/extension/dist/extension.js');
}
