// 串号（IMEI）解析与校验。纯函数。
// 入库时允许一次粘贴一批：按换行、空格、逗号、分号分开，每个必须是 15 位数字。

export interface ImeiParseResult {
  valid: string[]; // 去重后的合法串号，保持原顺序
  invalid: string[]; // 不是 15 位数字的
  duplicates: string[]; // 粘贴内容里重复出现的
}

export const IMEI_PATTERN = /^\d{15}$/;

export function isValidImei(value: string): boolean {
  return IMEI_PATTERN.test(value);
}

export function parseImeiList(text: string): ImeiParseResult {
  const tokens = text
    .split(/[\s,;，；]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const result: ImeiParseResult = { valid: [], invalid: [], duplicates: [] };
  for (const token of tokens) {
    if (!isValidImei(token)) {
      if (!result.invalid.includes(token)) result.invalid.push(token);
      continue;
    }
    if (seen.has(token)) {
      if (!result.duplicates.includes(token)) result.duplicates.push(token);
      continue;
    }
    seen.add(token);
    result.valid.push(token);
  }
  return result;
}
