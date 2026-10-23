// 打印页的样式（口径第 23 节）。用 <style> 直接写在页面里：@page 纸张要按选的纸变，CSS 模块写不了 @page。
// 小票：80mm 纸可打宽度约 72mm，58mm 纸约 48mm；保修卡默认 A5 竖版，一台机器一页。

export type ReceiptPaper = "80" | "58";
export type WarrantyPaper = "a5" | "80";

const BASE = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: #000; font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 12px; background: #f5f5f5; border-bottom: 1px solid #ddd; font-size: 14px; }
  .toolbar a { padding: 2px 8px; border: 1px solid #ccc; border-radius: 4px; color: #333; text-decoration: none; }
  .toolbar a.on { background: #1677ff; border-color: #1677ff; color: #fff; }
  .toolbar button { padding: 4px 12px; font-size: 14px; cursor: pointer; }
  .toolbar .hint { color: #888; font-size: 12px; }
  .sheet { margin: 12px auto; }
  .center { text-align: center; }
  .right { text-align: right; }
  .muted { color: #555; }
  .title { font-weight: 700; }
  .stamp { border: 2px solid #000; text-align: center; font-weight: 700; padding: 2px 0; margin: 4px 0; }
  .rule { border-top: 1px dashed #000; margin: 4px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { vertical-align: top; padding: 1px 0; }
  .code { font-family: Consolas, "Courier New", monospace; word-break: break-all; }
  @media print { .no-print { display: none !important; } .sheet { margin: 0; } }
`;

export function receiptCss(paper: ReceiptPaper): string {
  const width = paper === "58" ? 48 : 72;
  const font = paper === "58" ? 11 : 12;
  return `${BASE}
  @page { margin: 2mm; }
  .sheet { width: ${width}mm; font-size: ${font}px; line-height: 1.45; }
  .sheet .title { font-size: ${font + 4}px; }
  `;
}

export function warrantyCss(paper: WarrantyPaper): string {
  if (paper === "80") {
    return `${BASE}
  @page { margin: 2mm; }
  .sheet { width: 72mm; font-size: 12px; line-height: 1.5; }
  .card { padding: 2mm 0; page-break-after: always; break-after: page; }
  .card:last-child { page-break-after: auto; break-after: auto; }
  .card h1 { font-size: 16px; margin: 0 0 2mm; text-align: center; }
  `;
  }
  return `${BASE}
  @page { size: A5 portrait; margin: 10mm; }
  .sheet { width: 128mm; font-size: 13px; line-height: 1.6; }
  .card { border: 1px solid #000; padding: 6mm; min-height: 170mm; page-break-after: always; break-after: page; }
  .card:last-child { page-break-after: auto; break-after: auto; }
  .card h1 { font-size: 20px; margin: 0 0 4mm; text-align: center; letter-spacing: 4px; }
  .card table td:first-child { width: 26mm; color: #555; }
  @media screen { .card { margin-bottom: 8mm; } }
  `;
}
