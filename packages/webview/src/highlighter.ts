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
