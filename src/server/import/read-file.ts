import "server-only";
import { unzipSync, zipSync, type Unzipped } from "fflate";
import { readSheet } from "read-excel-file/node";
import { decodeText, parseCsv, TableError } from "@/lib/import/table";

// 读上传的导入文件（口径第 22 节）：.xlsx 读第一张表，CSV 按 UTF-8 / GBK 解。都变成“一行一组文字格子”。
// 数字按 Excel 里存的原样读成文字（不转浮点），15 位串号、金额都不走样。

/** 上传文件大小上限：5000 行的 .xlsx 远小于它 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export interface UnzipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

/** .xlsx 解压的上限（防“压缩炸弹”：几 MB 的文件解开几个 G） */
const UNZIP_LIMITS: UnzipLimits = { maxEntries: 500, maxEntryBytes: 50 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024 };

function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function isOldXls(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

/**
 * 自己控制解压（2026-10-23 复查第 75 条）：按中央目录逐个文件解开，先看目录里写的解开后大小，单个、总量、个数都设上限；
 * 解压时按目录写的大小开内存，数据比写的多也只解到这么多（不会越解越大）。解开以后再原样打成一个“干净”的 zip
 * （每个文件的头和目录一致）交给 read-excel-file——它是按每段文件头流式解压的，直接给它原文件，目录里的大小就管不住它。
 */
export function safeRezip(bytes: Uint8Array, limits: UnzipLimits = UNZIP_LIMITS): Uint8Array {
  let count = 0;
  let total = 0;
  let files: Unzipped;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        count += 1;
        total += file.originalSize;
        if (count > limits.maxEntries) throw new TableError("文件里的东西太多了，不像 Excel 文件");
        if (file.originalSize > limits.maxEntryBytes || total > limits.maxTotalBytes) throw new TableError("文件解开以后太大了，分成几个文件导");
        return true;
      },
    });
  } catch (error) {
    if (error instanceof TableError) throw error;
    throw new TableError("文件不完整，打不开（在 Excel 里重新另存一份 .xlsx）");
  }
  return zipSync(files, { level: 0 });
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
    const clean = safeRezip(bytes);
    let data: unknown[][];
    try {
      data = (await readSheet(Buffer.from(clean), 1, { parseNumber: (s: string) => s, trim: true })) as unknown[][];
    } catch {
      throw new TableError("读不出这个 Excel 文件：在 Excel 里重新另存一份 .xlsx 再上传");
    }
    return data.map((row, i) => ({ line: i + 1, cells: row.map(cellText) }));
  }
  if (/\.(xlsx|xls|xlsm|et|numbers)$/i.test(fileName)) throw new TableError("读不出这个文件：用模板的 .xlsx，或者在 Excel 里另存为 .xlsx / CSV");
  return parseCsv(decodeText(bytes));
}
