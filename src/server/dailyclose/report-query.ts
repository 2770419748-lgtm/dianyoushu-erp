import { formatDate } from "@/lib/format";
import { DailyCloseError, parseBizDate } from "./daily-close-service";

// 收银日报的查询参数解析：默认最近 7 天（北京日期），最长 92 天。

export function parseReportRange(fromText: string, toText: string) {
  const today = formatDate(new Date());
  const to = parseBizDate(toText || today);
  const from = parseBizDate(fromText || formatDate(new Date(to.getTime() - 6 * 86400000)));
  if (from > to) throw new DailyCloseError("开始日期不能晚于结束日期");
  if ((to.getTime() - from.getTime()) / 86400000 > 92) throw new DailyCloseError("一次最多查 3 个月");
  return { from, to, fromText: from.toISOString().slice(0, 10), toText: to.toISOString().slice(0, 10) };
}
