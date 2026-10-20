"use client";

import type { Key, ReactNode } from "react";

// 简单的竖排列表（一行一条、中间细线）。Ant Design 6 的 List 组件已经标了弃用，这里够用就不引新组件。
export function SimpleList<T>({ items, rowKey, render }: { items: T[]; rowKey: (item: T, index: number) => Key; render: (item: T, index: number) => ReactNode }) {
  return (
    <div>
      {items.map((item, index) => (
        <div key={rowKey(item, index)} style={{ padding: "8px 0", borderBottom: index < items.length - 1 ? "1px solid #f0f0f0" : undefined }}>
          {render(item, index)}
        </div>
      ))}
    </div>
  );
}
