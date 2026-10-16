// 机器编码的解析与校验。纯函数。
// 大件最多三个码：SN（序列号）、IMEI1、IMEI2，至少一个；主码 code = IMEI1 ?? SN ?? IMEI2（口径第 3 节，2026-10-16 坤总定）。
// IMEI：15 位数字。SN：6 到 30 位字母、数字、横线（不是 15 位纯数字）。

export const IMEI_PATTERN = /^\d{15}$/;
export const SN_PATTERN = /^[A-Za-z0-9-]{6,30}$/;

export function isValidImei(value: string): boolean {
  return IMEI_PATTERN.test(value);
}

export function isValidSn(value: string): boolean {
  return SN_PATTERN.test(value) && !IMEI_PATTERN.test(value);
}

/** 任意一个码的格式是否合法（扫码、盘点、收货都按这个收） */
export function isValidCode(value: string): boolean {
  return isValidImei(value) || isValidSn(value);
}

function splitTokens(text: string): string[] {
  return text
    .split(/[\s,;，；]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export interface CodeListResult {
  valid: string[]; // 去重后的合法码，保持原顺序
  invalid: string[];
  duplicates: string[];
}

/** 一批单个码（盘点实盘、调拨收货）：SN 或 IMEI 都行 */
export function parseCodeList(text: string): CodeListResult {
  const seen = new Set<string>();
  const result: CodeListResult = { valid: [], invalid: [], duplicates: [] };
  for (const token of splitTokens(text)) {
    if (!isValidCode(token)) {
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

/** 兼容旧名字 */
export const parseImeiList = parseCodeList;

export interface DeviceCodes {
  sn: string | null;
  imei1: string | null;
  imei2: string | null;
}

export interface DeviceCodeLine extends DeviceCodes {
  code: string; // 主码
  raw: string;
}

export interface DeviceCodeLinesResult {
  devices: DeviceCodeLine[];
  errors: string[]; // 每条带行号的人话
  duplicates: string[]; // 粘贴内容里重复出现的码
}

/** 主码规则：有 IMEI1 用 IMEI1，否则 SN，否则 IMEI2 */
export function primaryCode(codes: DeviceCodes): string | null {
  return codes.imei1 ?? codes.sn ?? codes.imei2 ?? null;
}

/**
 * 入库粘贴：一行一台，每行 1 到 3 个码，用空格、逗号、Tab 隔开，顺序不限。
 * 15 位数字当 IMEI（第一个是 IMEI1，第二个是 IMEI2），其他的当 SN。
 */
export function parseDeviceCodeLines(text: string): DeviceCodeLinesResult {
  const result: DeviceCodeLinesResult = { devices: [], errors: [], duplicates: [] };
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  lines.forEach((line, index) => {
    if (!line) return;
    const lineNo = index + 1;
    const tokens = line.split(/[\s,;，；]+/).filter(Boolean);
    const imeis: string[] = [];
    const sns: string[] = [];
    for (const token of tokens) {
      if (isValidImei(token)) imeis.push(token);
      else if (isValidSn(token)) sns.push(token);
      else {
        result.errors.push(`第 ${lineNo} 行：“${token}” 既不是 15 位 IMEI，也不是合法 SN（6 到 30 位字母数字）`);
        return;
      }
    }
    if (imeis.length > 2) {
      result.errors.push(`第 ${lineNo} 行：一台机器最多两个 IMEI，这行有 ${imeis.length} 个`);
      return;
    }
    if (sns.length > 1) {
      result.errors.push(`第 ${lineNo} 行：一台机器只有一个 SN，这行有 ${sns.length} 个`);
      return;
    }
    const codes: DeviceCodes = { sn: sns[0] ?? null, imei1: imeis[0] ?? null, imei2: imeis[1] ?? null };
    const code = primaryCode(codes);
    if (!code) return;
    const all = [codes.sn, codes.imei1, codes.imei2].filter((c): c is string => c !== null);
    const dup = all.filter((c) => seen.has(c));
    if (dup.length > 0) {
      for (const d of dup) if (!result.duplicates.includes(d)) result.duplicates.push(d);
      result.errors.push(`第 ${lineNo} 行：${dup.join("、")} 在前面已经出现过`);
      return;
    }
    for (const c of all) seen.add(c);
    result.devices.push({ ...codes, code, raw: line });
  });
  return result;
}
