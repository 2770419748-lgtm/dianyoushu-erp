// CSV 导出的单元格转义。纯函数，方便单元测试。
//
// 防“公式注入”：Excel 打开 CSV 时，以 = + - @（以及制表符、回车）开头的单元格会被当成公式执行。
// 门店名之类的文字是用户录的，万一录成 =HYPERLINK(...) 这种，导出的报表一打开就会执行。
// 做法是这类文字前面加一个单引号，Excel 就按普通文字显示；金额这种纯数字（包括 -29.00 这样的负数）不动，照样能求和。

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

export function csvCell(value: string | number): string {
  let s = String(value);
  if (FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 一整张表转成 CSV 文本：带 BOM（Excel 双击打开不乱码），Windows 换行 */
export function toCsv(rows: (string | number)[][]): string {
  return "﻿" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
