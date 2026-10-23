import "server-only";
import { readSheet } from "read-excel-file/node";
import { decodeText, parseCsv, TableError } from "@/lib/import/table";

// 读上传的导入文件（口径第 22 节）：.xlsx 读第一张表，CSV 按 UTF-8 / GBK 解。都变成“一行一组文字格子”。
// 数字按 Excel 里存的原样读成文字（不转浮点），15 位串号、金额都不走样。

/** 上传文件大小上限：5000 行的 .xlsx 远小于它 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** .xlsx 解压后的总大小上限（防“压缩炸弹”：几 MB 的文件解开几个 G） */
const MAX_UNZIPPED_BYTES = 100 * 1024 * 1024;

function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function isOldXls(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

/**
 * 按 ZIP 的中央目录把每个文件解压后的大小加起来（只读目录，不解压）。
 * 认不出目录、用了 ZIP64（单个文件超过 4G 才用）都当作不合格。
 */
export function zipUnpackedSize(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new TableError("文件不完整，打不开（在 Excel 里重新另存一份 .xlsx）");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new TableError("文件不完整，打不开（在 Excel 里重新另存一份 .xlsx）");
    const size = view.getUint32(at + 24, true);
    if (size === 0xffffffff) throw new TableError("文件太大了");
    total += size;
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return total;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  return String(value);
}

/** 上传的文件 → 行（带文件里的行号，表头是第 1 行） */
export async function readUpload(bytes: Uint8Array, fileName: string): Promise<{ line: number; cells: string[] }[]> {
  if (bytes.length === 0) throw new TableError("文件是空的");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new TableError(`文件太大了（最大 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB），分成几个文件导`);
  if (isOldXls(bytes)) throw new TableError("这是老的 .xls 格式：在 Excel 里“另存为”选 .xlsx（Excel 工作簿）再上传");
  if (isZip(bytes)) {
    if (zipUnpackedSize(bytes) > MAX_UNZIPPED_BYTES) throw new TableError("文件解开以后太大了，分成几个文件导");
    let data: unknown[][];
    try {
      data = (await readSheet(Buffer.from(bytes), 1, { parseNumber: (s: string) => s, trim: true })) as unknown[][];
    } catch {
      throw new TableError("读不出这个 Excel 文件：在 Excel 里重新另存一份 .xlsx 再上传");
    }
    return data.map((row, i) => ({ line: i + 1, cells: row.map(cellText) }));
  }
  if (/\.(xlsx|xls|xlsm|et|numbers)$/i.test(fileName)) throw new TableError("读不出这个文件：用模板的 .xlsx，或者在 Excel 里另存为 .xlsx / CSV");
  return parseCsv(decodeText(bytes));
}
