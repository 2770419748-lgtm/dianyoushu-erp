"use client";

import { useEffect } from "react";

// 打印页顶上的工具条（口径第 23 节）：换纸、打印、关闭。打印出来的纸上不显示（.no-print）。
// 换纸记在这台电脑的浏览器里（localStorage），下次从单据页点打印用上次的纸；带 auto=1 打开时自动弹出打印对话框。

export const PAPER_STORAGE = { receipt: "print.receipt.paper", warranty: "print.warranty.paper" } as const;

export function PrintToolbar({ papers, current, storageKey, auto }: { papers: { value: string; label: string }[]; current: string; storageKey: string; auto: boolean }) {
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, current);
    } catch {
      // 隐私模式等存不了：不影响打印
    }
    if (!auto) return;
    const timer = setTimeout(() => window.print(), 300); // 等字体、版式排好再弹
    return () => clearTimeout(timer);
  }, [auto, current, storageKey]);

  return (
    <div className="no-print toolbar">
      <span>纸：</span>
      {papers.map((p) => (
        <a key={p.value} href={`?paper=${p.value}`} className={p.value === current ? "on" : undefined}>
          {p.label}
        </a>
      ))}
      <button type="button" onClick={() => window.print()}>
        打印
      </button>
      <button type="button" onClick={() => window.close()}>
        关闭
      </button>
      <span className="hint">第一次打：在打印对话框里选小票打印机和它的纸，边距选“无”，浏览器会记住。</span>
    </div>
  );
}

/** 单据页上的“打印”按钮用：按这台电脑上次选的纸打开打印页 */
export function openPrint(path: string, kind: keyof typeof PAPER_STORAGE) {
  let paper = "";
  try {
    paper = localStorage.getItem(PAPER_STORAGE[kind]) ?? "";
  } catch {
    paper = "";
  }
  window.open(`${path}?auto=1${paper ? `&paper=${encodeURIComponent(paper)}` : ""}`, "_blank", "noopener");
}
