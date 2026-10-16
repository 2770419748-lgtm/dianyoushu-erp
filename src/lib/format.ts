import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

// 全站时间一律按北京时间显示，不随服务器或浏览器所在时区变：
// 数据库存 UTC，这里固定转成 Asia/Shanghai，服务端渲染和浏览器渲染结果一致，不会报 hydration 不一致。
export const APP_TIMEZONE = "Asia/Shanghai";

export function formatDateTime(value: Date | string | number): string {
  return dayjs(value).tz(APP_TIMEZONE).format("YYYY-MM-DD HH:mm:ss");
}

export function formatDate(value: Date | string | number): string {
  return dayjs(value).tz(APP_TIMEZONE).format("YYYY-MM-DD");
}

/** 分 → 元，两位小数，用于显示 */
export function formatFen(fen: number): string {
  return (fen / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 元（表单里输入的数）→ 分；非法值返回 NaN，由服务层拒绝 */
export function yuanToFen(yuan: unknown): number {
  const n = typeof yuan === "number" ? yuan : Number(yuan);
  if (!Number.isFinite(n)) return Number.NaN;
  return Math.round(n * 100);
}
