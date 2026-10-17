"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, DatePicker, Select, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import dayjs from "dayjs";
import { formatFen } from "@/lib/format";
import { PAYMENT_METHOD_LABELS } from "@/lib/sales-labels";
import { DAILY_CLOSE_METHODS } from "@/server/dailyclose/summary";
import type { CashierReportRow } from "@/server/dailyclose/daily-close-service";

export function CashierReportView({
  stores,
  storeId,
  from,
  to,
  rows,
}: {
  stores: { id: number; label: string }[];
  storeId?: number;
  from: string;
  to: string;
  rows: CashierReportRow[];
}) {
  const router = useRouter();
  const query = (next: { storeId?: number | null; from?: string; to?: string }) => {
    const sp = new URLSearchParams();
    const sid = next.storeId === undefined ? storeId : next.storeId;
    if (sid) sp.set("storeId", String(sid));
    sp.set("from", next.from ?? from);
    sp.set("to", next.to ?? to);
    return sp.toString();
  };

  // 只显示这段时间里出现过的收款方式，表格不至于太宽
  const methods = DAILY_CLOSE_METHODS.filter((m) => rows.some((r) => r.amounts[m] !== 0));
  const totals = Object.fromEntries(methods.map((m) => [m, rows.reduce((s, r) => s + r.amounts[m], 0)]));

  const columns: TableColumnsType<CashierReportRow> = [
    { title: "营业日", dataIndex: "bizDate", fixed: "left" },
    { title: "门店", dataIndex: "storeLabel" },
    ...methods.map((m) => ({ title: `${PAYMENT_METHOD_LABELS[m]}（元）`, align: "right" as const, render: (_: unknown, r: CashierReportRow) => formatFen(r.amounts[m]) })),
    { title: "实收（不含抵扣）", dataIndex: "cashFen", align: "right", render: (v: number) => <Typography.Text strong>{formatFen(v)}</Typography.Text> },
    {
      title: "日结",
      render: (_, r) => (
        <Link href={`/daily-close?storeId=${r.storeId}&date=${r.bizDate}`}>
          {r.closeStatus === "CONFIRMED" ? <Tag color={r.hasDiff ? "red" : "green"}>{r.hasDiff ? "已确认·有差异" : "已确认"}</Tag> : r.closeStatus === "PENDING" ? <Tag color="orange">未确认</Tag> : <Tag>未日结</Tag>}
        </Link>
      ),
    },
  ];

  return (
    <Card
      title={`收银日报（${rows.length} 行）`}
      extra={
        <a href={`/api/reports/cashier?${query({})}`}>
          <Button>导出（Excel 可打开）</Button>
        </a>
      }
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          allowClear={stores.length > 1}
          placeholder="全部门店"
          // 只能看一家店的人（店员、店长）直接显示这家店，别显示成“全部门店”
          value={stores.length === 1 ? stores[0]!.id : storeId}
          style={{ width: 220 }}
          showSearch
          optionFilterProp="label"
          options={stores.map((s) => ({ value: s.id, label: s.label }))}
          onChange={(v) => router.push(`/reports/cashier?${query({ storeId: v ?? null })}`)}
          disabled={stores.length === 1}
        />
        <DatePicker.RangePicker
          value={[dayjs(from), dayjs(to)]}
          allowClear={false}
          onChange={(v) => v?.[0] && v[1] && router.push(`/reports/cashier?${query({ from: v[0].format("YYYY-MM-DD"), to: v[1].format("YYYY-MM-DD") })}`)}
        />
      </Space>
      <Table
        rowKey="key"
        size="small"
        columns={columns}
        dataSource={rows}
        scroll={{ x: true }}
        pagination={{ pageSize: 31, showSizeChanger: false }}
        summary={() =>
          rows.length > 0 ? (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={2}>
                <Typography.Text strong>合计</Typography.Text>
              </Table.Summary.Cell>
              {methods.map((m, i) => (
                <Table.Summary.Cell key={m} index={i + 2} align="right">
                  {formatFen(totals[m]!)}
                </Table.Summary.Cell>
              ))}
              <Table.Summary.Cell index={methods.length + 2} align="right">
                <Typography.Text strong>{formatFen(rows.reduce((s, r) => s + r.cashFen, 0))}</Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={methods.length + 3} />
            </Table.Summary.Row>
          ) : null
        }
      />
    </Card>
  );
}
