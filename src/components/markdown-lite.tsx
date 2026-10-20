"use client";

import { Fragment, type ReactNode } from "react";
import { Typography } from "antd";

// 今日待办的 markdown 只用到几种写法：### 标题、1. 编号、- 列表、**加粗**、> 引用。这里按行转成 React 元素，
// 不拼 HTML（不用 dangerouslySetInnerHTML），模型写了什么奇怪的东西也只会显示成文字。

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>));
}

export function MarkdownLite({ text }: { text: string }) {
  return (
    <div style={{ lineHeight: 1.8 }}>
      {text.split("\n").map((line, i) => {
        const t = line.trimEnd();
        if (!t.trim()) return <div key={i} style={{ height: 6 }} />;
        if (t.startsWith("### ")) return <Typography.Title key={i} level={5} style={{ marginTop: 0 }}>{inline(t.slice(4))}</Typography.Title>;
        if (t.startsWith("> ")) return <Typography.Text key={i} type="secondary" style={{ display: "block", fontSize: 12 }}>{inline(t.slice(2))}</Typography.Text>;
        const numbered = /^(\d+)\.\s+(.*)$/.exec(t);
        if (numbered) return <div key={i} style={{ paddingLeft: 20, textIndent: -20 }}>{`${numbered[1]}. `}{inline(numbered[2]!)}</div>;
        if (/^[-*]\s+/.test(t)) return <div key={i} style={{ paddingLeft: 20, textIndent: -12 }}>· {inline(t.replace(/^[-*]\s+/, ""))}</div>;
        return <div key={i}>{inline(t)}</div>;
      })}
    </div>
  );
}
