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
