// 企业微信回调的 XML 是平铺的一层：<xml><Tag><![CDATA[...]]></Tag><Num>123</Num></xml>。
// 这里只取第一层字段，不引 XML 库（也就没有外部实体之类的风险）；客户联系的几个事件都是平铺的，够用。

// 值要么是一段或几段 CDATA（内容里有 ]]> 时会拆成几段），要么是不含 < 的纯文本
const FIELD = /<([A-Za-z_]\w*)>((?:<!\[CDATA\[[\s\S]*?\]\]>)+|[^<]*)<\/\1>/g;
const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

export function parseWecomXml(xml: string): Record<string, string> {
  const inner = /<xml>([\s\S]*)<\/xml>/.exec(xml)?.[1] ?? "";
  const fields: Record<string, string> = {};
  for (const match of inner.matchAll(FIELD)) {
    const raw = match[2] ?? "";
    fields[match[1]!] = raw.startsWith("<![CDATA[") ? raw.replace(CDATA, "$1") : raw;
  }
  return fields;
}

/** 拼一段平铺的 XML（模拟器造事件用）：数字原样写，字符串包进 CDATA */
export function buildWecomXml(fields: Record<string, string | number>): string {
  const body = Object.entries(fields)
    .map(([key, value]) => (typeof value === "number" ? `<${key}>${value}</${key}>` : `<${key}><![CDATA[${value.replaceAll("]]>", "]]]]><![CDATA[>")}]]></${key}>`))
    .join("");
  return `<xml>${body}</xml>`;
}
