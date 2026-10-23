import "server-only";
import writeXlsxFile from "write-excel-file/node";
import type { SheetData } from "write-excel-file/node";
import { IMPORT_COLUMNS, IMPORT_KIND_LABELS, type ImportKindKey } from "@/lib/import/specs";
import { MAX_IMPORT_ROWS } from "@/lib/import/table";

// 导入模板（口径第 22 节）：第一张表“导入”只有表头，下面 5000 行里码、编码、手机号这些列先设成文本格式
// （不然 Excel 把 15 位串号显示成科学计数法，存的时候后几位就丢了）；第二张表“说明”写每列填什么、例子。
// 示例不放在“导入”表里，免得忘了删被当成数据导进来。

/** 要设成文本格式的列：码、编码、账号、手机号 */
const TEXT_COLUMNS = new Set(["code", "storeCode", "barcode", "sn", "imei1", "imei2", "phone", "username", "wecomUserid"]);
const PREFORMATTED_ROWS = MAX_IMPORT_ROWS; // 一个文件最多这么多行，全设上（复查顺手修：以前只设了前 1000 行）

export async function templateXlsx(kind: ImportKindKey): Promise<Buffer> {
  const columns = IMPORT_COLUMNS[kind];
  const header = columns.map((c) => ({ value: c.required ? `${c.label}*` : c.label, fontWeight: "bold" as const }));
  const blank = columns.map((c) => (TEXT_COLUMNS.has(c.key) ? { type: String, value: "", format: "@" } : null));
  const data: SheetData = [header, ...Array.from({ length: PREFORMATTED_ROWS }, () => blank)];
  const notes: SheetData = [
    [
      { value: "列名", fontWeight: "bold" },
      { value: "必填", fontWeight: "bold" },
      { value: "说明", fontWeight: "bold" },
      { value: "例子", fontWeight: "bold" },
    ],
    ...columns.map((c) => [c.label, c.required ? "是" : "", c.note ?? "", c.example ?? ""]),
    [],
    [`在“导入”这张表里，从第 2 行开始一行填一条${IMPORT_KIND_LABELS[kind]}。带 * 的列必填；列的顺序可以调，不用的列可以删。`],
    ["上传后系统先检查，有一条不对整批都不进，改好再传。一个文件最多 5000 行。"],
  ];
  return writeXlsxFile([
    { sheet: "导入", data, columns: columns.map(() => ({ width: 18 })), stickyRowsCount: 1 },
    { sheet: "说明", data: notes, columns: [{ width: 14 }, { width: 6 }, { width: 50 }, { width: 22 }] },
  ]).toBuffer();
}
