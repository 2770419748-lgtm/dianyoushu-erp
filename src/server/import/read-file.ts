import "server-only";
import { inflateRawSync } from "node:zlib";
import { zipSync } from "fflate";
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

/** .xlsx 解压的上限（防“压缩炸弹”：几 MB 的文件解开几个 G）。5000 行的表解开也就几 MB */
const UNZIP_LIMITS: UnzipLimits = { maxEntries: 500, maxEntryBytes: 20 * 1024 * 1024, maxTotalBytes: 30 * 1024 * 1024 };

function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function isOldXls(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

const BROKEN = "文件不完整，打不开（在 Excel 里重新另存一份 .xlsx）";

/**
 * 自己控制解压（2026-10-23 复查第 75、79 条）：按 ZIP 末尾的中央目录逐个文件解开——
 * - 先看目录里写的“解开后多大”，单个、总量、个数都设上限；
 * - 解压用 zlib 的 inflateRawSync，输出上限就是目录里写的大小：数据比写的多，解到上限马上报错停下，
 *   不会把内存撑大，也不会空转把整段数据跑完（fflate 给了输出缓冲以后多的会丢掉，但循环照样跑完，CPU 管不住）；
 * - 解出来的大小必须和目录里写的一样；用了 ZIP64、加密、别的压缩方式都当作不合格。
 * 解开以后再原样打成一个“干净”的 zip（每个文件的头和目录一致、不压缩）交给 read-excel-file：
 * 它按每段文件头流式解压，直接给它原文件，目录里的大小管不住它。
 */
export function safeRezip(bytes: Uint8Array, limits: UnzipLimits = UNZIP_LIMITS): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new TableError(BROKEN);
  const count = view.getUint16(eocd + 10, true);
  if (count > limits.maxEntries) throw new TableError("文件里的东西太多了，不像 Excel 文件");
  let at = view.getUint32(eocd + 16, true);
  let total = 0;
  const files: Record<string, Uint8Array> = {};
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new TableError(BROKEN);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (size === 0xffffffff || compressed === 0xffffffff || local === 0xffffffff || flags & 0x1) throw new TableError(BROKEN); // ZIP64、加密
    total += size;
    if (size > limits.maxEntryBytes || total > limits.maxTotalBytes) throw new TableError("文件解开以后太大了，分成几个文件导");
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new TableError(BROKEN);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + compressed > bytes.length) throw new TableError(BROKEN);
    const data = bytes.subarray(start, start + compressed);
    let out: Uint8Array;
    if (method === 0) out = data;
    else if (method === 8) {
      try {
        out = size === 0 ? new Uint8Array() : inflateRawSync(data, { maxOutputLength: size });
      } catch {
        throw new TableError("文件解开以后和它自己写的大小对不上，不像正常的 Excel 文件");
      }
    } else throw new TableError(BROKEN);
    if (out.length !== size) throw new TableError("文件解开以后和它自己写的大小对不上，不像正常的 Excel 文件");
    if (!name.endsWith("/")) files[name] = out;
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
