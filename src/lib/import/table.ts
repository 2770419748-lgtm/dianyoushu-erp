// 数据导入（口径第 22 节）的表格读取：上传的文件 → 一行一行的文字格子。纯函数，前后端、测试共用。
// - CSV：先按 UTF-8 解，解不开再按 GBK（Excel 中文版直接“另存为 CSV”存出来的是 GBK）；
//   按 RFC 4180 拆：双引号包起来的格子里可以有逗号、换行，两个双引号表示一个双引号。
// - 第一行是表头，按列名认（列的顺序不限、多出来的列不管）；表头里的“（元）”“(元)”“*”（必填标记）去掉再认。
// - 空行跳过；行号按文件里的行算（表头是第 1 行），预检报错时用户照着行号去表里找。

export class TableError extends Error {}

/** 一个文件最多多少行（不算表头），再多分几个文件（口径第 22 节） */
export const MAX_IMPORT_ROWS = 5000;

/** 文件内容 → 文字：UTF-8（去掉 BOM），不是合法 UTF-8 就按 GBK */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("gbk").decode(bytes);
  }
}

/** CSV 文字 → 行（每行是格子数组），带文件里的行号（从 1 开始；带换行的格子算在开始那一行） */
export function parseCsv(text: string): { line: number; cells: string[] }[] {
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let rowStart = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      cells.push(cell);
      rows.push({ line: rowStart, cells });
      cells = [];
      cell = "";
      line++;
      rowStart = line;
    } else cell += ch;
  }
  if (quoted) throw new TableError(`第 ${rowStart} 行有一个双引号没有配对，表格可能不完整`);
  if (cell !== "" || cells.length > 0) {
    cells.push(cell);
    rows.push({ line: rowStart, cells });
  }
  return rows;
}

export interface ColumnSpec<K extends string = string> {
  key: K;
  label: string; // 模板里的列名
  required?: boolean; // 这一列必须有（格子能不能空由各类自己查）
  aliases?: string[]; // 别的叫法，比如旧系统导出的“串号”
  example?: string; // 模板里的示例
  note?: string; // 模板说明
}

export interface TableRow<K extends string> {
  line: number;
  values: Record<K, string>;
}

/** 表头里的“（元）”“(元)”“*”、前后空格都去掉再比 */
export function normalizeHeader(text: string): string {
  return text.replace(/^﻿/, "").replace(/（元）|\(元\)|\*/g, "").trim();
}

/** 行 → 按列名取值的记录。缺必填列、表是空的、行数超了都报错；格子去掉前后空格；整行都空的跳过 */
export function toRecords<K extends string>(rows: { line: number; cells: string[] }[], columns: readonly ColumnSpec<K>[]): TableRow<K>[] {
  const nonEmpty = rows.filter((r) => r.cells.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) throw new TableError("表格是空的：第一行是表头，下面每行一条");
  const header = nonEmpty[0]!.cells.map(normalizeHeader);
  const index = new Map<K, number>();
  for (const col of columns) {
    const names = [col.label, ...(col.aliases ?? [])].map(normalizeHeader);
    const at = header.findIndex((h) => names.includes(h));
    if (at >= 0) index.set(col.key, at);
  }
  const missing = columns.filter((c) => c.required && !index.has(c.key)).map((c) => `“${c.label}”`);
  if (missing.length > 0) throw new TableError(`表头缺这几列：${missing.join("、")}（按模板的列名写，列的顺序不限）`);
  const body = nonEmpty.slice(1);
  if (body.length === 0) throw new TableError("只有表头，没有数据");
  if (body.length > MAX_IMPORT_ROWS) throw new TableError(`一次最多导 ${MAX_IMPORT_ROWS} 行，这个文件有 ${body.length} 行，分成几个文件导`);
  return body.map((r) => {
    const values = {} as Record<K, string>;
    for (const col of columns) {
      const at = index.get(col.key);
      values[col.key] = at === undefined ? "" : (r.cells[at] ?? "").trim();
    }
    return { line: r.line, values };
  });
}

// ---------- 格子的格式检查（各类导入共用）----------

/** 金额（元，最多两位小数）→ 分；空返回 null；不是金额返回 NaN */
export function yuanToFen(text: string): number | null {
  const t = text.replace(/[,，¥￥\s]/g, "");
  if (t === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return Number.NaN;
  return Math.round(Number(t) * 100);
}

/** 正整数；空返回 null；不是正整数返回 NaN */
export function positiveInt(text: string): number | null {
  const t = text.replace(/[,，\s]/g, "");
  if (t === "") return null;
  if (!/^\d+$/.test(t) || Number(t) <= 0 || Number(t) > 1_000_000) return Number.NaN;
  return Number(t);
}

/** Excel 把长数字显示成科学计数法（8.61E+14）以后再存成 CSV，后几位就丢了：认出来单独提示 */
export function looksLikeScientific(text: string): boolean {
  return /^\d+(\.\d+)?[eE]\+?\d+$/.test(text.trim());
}
