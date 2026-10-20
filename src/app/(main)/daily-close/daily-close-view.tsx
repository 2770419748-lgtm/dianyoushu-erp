"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Card, Col, DatePicker, Input, InputNumber, Popconfirm, Row, Select, Space, Statistic, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import dayjs from "dayjs";
import type { PaymentMethod } from "@/generated/prisma/enums";
import { formatDate, formatDateTime, formatFen, yuanToFen } from "@/lib/format";
import { PAYMENT_METHOD_LABELS, SALES_STATUS_COLORS, SALES_STATUS_LABELS } from "@/lib/sales-labels";
import { AUTO_MATCH_METHODS, type CloseLine } from "@/server/dailyclose/summary";
import type { DailyCloseView as View } from "@/server/dailyclose/daily-close-service";
import { confirmDailyCloseAction, reopenDailyCloseAction, saveDailyCloseAction, type DailyCloseActionResult } from "./actions";

type Order = View["orders"][number];
type Ret = View["returns"][number];
type Rep = View["repairs"][number];

export function DailyCloseView({
  stores,
  storeId,
  dateText,
  view,
  canClose,
  canReopen,
}: {
  stores: { id: number; label: string }[];
  storeId: number;
  dateText: string;
  view: View;
  canClose: boolean;
  canReopen: boolean;
}) {
  const todayText = formatDate(new Date()); // 北京时间的今天，日期选择器不能选之后的日子
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const confirmed = view.close?.status === "CONFIRMED";
  const editable = canClose && !confirmed;

  const [actualYuan, setActualYuan] = useState<Partial<Record<PaymentMethod, number | null>>>(() =>
    Object.fromEntries(view.lines.map((l) => [l.method, l.actualFen === null ? null : l.actualFen / 100])),
  );
  const [note, setNote] = useState(view.close?.note ?? "");
  const [reopenReason, setReopenReason] = useState("");

  function go(next: { storeId?: number; date?: string }) {
    router.push(`/daily-close?storeId=${next.storeId ?? storeId}&date=${next.date ?? dateText}`);
  }

  const lines: CloseLine[] = view.lines.map((l) => {
    if (AUTO_MATCH_METHODS.includes(l.method) || confirmed) return l;
    const y = actualYuan[l.method];
    const actualFen = y === null || y === undefined ? null : yuanToFen(y);
    return { ...l, actualFen, diffFen: actualFen === null ? null : actualFen - l.systemFen };
  });
  const missing = lines.filter((l) => l.actualFen === null).length;
  const diffCount = lines.filter((l) => (l.diffFen ?? 0) !== 0).length;

  function payload() {
    return {
      storeId,
      bizDate: dateText,
      note,
      actuals: Object.fromEntries(lines.filter((l) => l.actualFen !== null).map((l) => [l.method, l.actualFen])),
    };
  }

  function run(fn: () => Promise<DailyCloseActionResult>) {
    startTransition(async () => {
      const result = await fn();
      if (result.ok) message.success(result.message ?? "已完成");
      else message.error(result.error);
    });
  }

  const lineColumns: TableColumnsType<CloseLine> = [
    { title: "收款方式", dataIndex: "method", render: (m: PaymentMethod) => PAYMENT_METHOD_LABELS[m] },
    { title: "系统应收（元）", dataIndex: "systemFen", align: "right", render: (v: number) => formatFen(v) },
    {
      title: "实收（元）",
      align: "right",
      render: (_, l) =>
        editable && !AUTO_MATCH_METHODS.includes(l.method) ? (
          <InputNumber
            precision={2}
            style={{ width: 140 }}
            placeholder={(l.systemFen / 100).toFixed(2)}
            value={actualYuan[l.method] ?? null}
            onChange={(v) => setActualYuan({ ...actualYuan, [l.method]: v === null ? null : Number(v) })}
          />
        ) : l.actualFen === null ? (
          "-"
        ) : (
          formatFen(l.actualFen)
        ),
    },
    {
      title: "差异（元）",
      align: "right",
      render: (_, l) =>
        l.diffFen === null ? <Tag>未录</Tag> : l.diffFen === 0 ? <Tag color="green">对上</Tag> : <Tag color="red">{l.diffFen > 0 ? "+" : ""}{formatFen(l.diffFen)}</Tag>,
    },
  ];

  const orderColumns: TableColumnsType<Order> = [
    { title: "单号", dataIndex: "orderNo", render: (no: string, o) => <Link href={`/sales/${o.id}`}>{no}</Link> },
    { title: "时间", dataIndex: "createdAt", render: (v: Date) => formatDateTime(v).slice(11) },
    { title: "客户", dataIndex: "customer" },
    { title: "销售员", dataIndex: "salesperson" },
    { title: "应收（元）", dataIndex: "totalFen", align: "right", render: (v: number) => formatFen(v) },
    { title: "收款", render: (_, o) => o.payments.map((p) => `${PAYMENT_METHOD_LABELS[p.method]} ${formatFen(p.amountFen)}`).join(" + ") },
    {
      title: "比对",
      render: (_, o) =>
        o.status !== "COMPLETED" ? (
          <Tag color={SALES_STATUS_COLORS[o.status]}>{SALES_STATUS_LABELS[o.status]}，不计入</Tag>
        ) : o.mismatchFen === 0 ? (
          <Tag color="green">对上</Tag>
        ) : (
          <Tag color="red">差 {formatFen(o.mismatchFen)}</Tag>
        ),
    },
  ];

  const returnColumns: TableColumnsType<Ret> = [
    { title: "退货单", dataIndex: "orderNo" },
    { title: "原单", dataIndex: "salesOrderNo" },
    { title: "退款", render: (_, r) => r.payments.map((p) => `${PAYMENT_METHOD_LABELS[p.method]} ${formatFen(p.amountFen)}`).join(" + ") || "不退钱" },
    { title: "经手", dataIndex: "handledBy" },
    { title: "时间", dataIndex: "createdAt", render: (v: Date) => formatDateTime(v).slice(11) },
  ];

  const repairColumns: TableColumnsType<Rep> = [
    { title: "维修单", render: (_, r) => <Link href={`/repairs/${r.id}`}>{r.orderNo}</Link> },
    { title: "客户", dataIndex: "customer" },
    { title: "收款", render: (_, r) => r.payments.map((p) => `${PAYMENT_METHOD_LABELS[p.method]} ${formatFen(p.amountFen)}`).join(" + ") || "不收钱（保修、碎屏险、延保或没修）" },
    { title: "结算人", dataIndex: "closedBy" },
    { title: "时间", dataIndex: "closedAt", render: (v: Date | null) => (v ? formatDateTime(v).slice(11) : "-") },
  ];

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title={
          <Space wrap>
            <span>日结</span>
            {confirmed ? <Tag color="green">已确认</Tag> : view.close ? <Tag color="orange">已保存未确认</Tag> : <Tag>未日结</Tag>}
            {view.close ? <Typography.Text type="secondary">{view.close.closeNo}</Typography.Text> : null}
          </Space>
        }
        extra={
          <Space wrap>
            <Select value={storeId} style={{ width: 200 }} showSearch optionFilterProp="label" options={stores.map((s) => ({ value: s.id, label: s.label }))} onChange={(v) => go({ storeId: v })} disabled={stores.length === 1} />
            <DatePicker value={dayjs(dateText)} allowClear={false} disabledDate={(d) => d.format("YYYY-MM-DD") > todayText} onChange={(d) => d && go({ date: d.format("YYYY-MM-DD") })} />
          </Space>
        }
      >
        <Row gutter={[16, 16]}>
          <Col xs={12} md={6}>
            <Statistic title="成交单数" value={view.totals.orderCount} suffix={view.totals.voidedCount ? `（作废 ${view.totals.voidedCount}）` : undefined} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="销售应收（元）" value={formatFen(view.totals.salesFen)} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="退款（元）" value={formatFen(view.totals.refundFen)} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="系统应收合计（元）" value={formatFen(view.totals.systemFen)} />
          </Col>
        </Row>
        {confirmed ? (
          <Alert style={{ marginTop: 16 }} type="success" showIcon title={`${view.close?.confirmedBy ?? ""} 于 ${view.close?.confirmedAt ? formatDateTime(view.close.confirmedAt) : ""} 确认，当日单据已锁定`} description={view.close?.note ?? undefined} />
        ) : null}
      </Card>

      <Card title="按收款方式对账">
        <Table rowKey="method" size="small" pagination={false} columns={lineColumns} dataSource={lines} scroll={{ x: true }} />
        {editable ? (
          <Space orientation="vertical" style={{ width: "100%", marginTop: 16 }}>
            <Typography.Text type="secondary">把每种方式实际收到的钱填进去（现金点钞、微信支付宝看账单），系统数为 0 的不用填。以旧换新抵扣不是钱，自动对平。</Typography.Text>
            <Input.TextArea rows={2} maxLength={200} placeholder={diffCount ? "有差异，写一下原因（必填）" : "备注（选填）"} value={note} onChange={(e) => setNote(e.target.value)} />
            <Space wrap>
              <Button loading={pending} onClick={() => run(() => saveDailyCloseAction(payload()))}>
                先保存
              </Button>
              <Popconfirm
                title={diffCount ? `有 ${diffCount} 项差异，确认后会留痕、当日单据锁定，确定？` : "全部对上，确认日结？确认后当天不能再开单、作废。"}
                onConfirm={() => run(() => confirmDailyCloseAction(payload()))}
                disabled={missing > 0 || view.check.mismatchedOrders > 0}
              >
                <Button type="primary" loading={pending} disabled={missing > 0 || view.check.mismatchedOrders > 0}>
                  确认日结
                </Button>
              </Popconfirm>
              {missing > 0 ? <Tag color="orange">还有 {missing} 种没录实收</Tag> : null}
              {view.check.mismatchedOrders > 0 ? <Tag color="red">{view.check.mismatchedOrders} 张单收款对不上</Tag> : null}
            </Space>
          </Space>
        ) : null}
        {confirmed && canReopen ? (
          <Space style={{ marginTop: 16 }} wrap>
            <Input placeholder="撤销原因（必填）" value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} style={{ width: 280 }} />
            <Popconfirm title="撤销日结？当天单据会解锁。" onConfirm={() => run(() => reopenDailyCloseAction(storeId, dateText, reopenReason))}>
              <Button danger loading={pending}>
                撤销日结
              </Button>
            </Popconfirm>
          </Space>
        ) : null}
      </Card>

      <Card title={`当日销售单（${view.orders.length}）`}>
        <Table rowKey="id" size="small" columns={orderColumns} dataSource={view.orders} scroll={{ x: true }} pagination={{ pageSize: 20, showSizeChanger: false }} rowClassName={(o) => (o.mismatchFen !== 0 ? "row-danger" : "")} />
      </Card>
      {view.returns.length > 0 ? (
        <Card title={`当日退货（${view.returns.length}）`}>
          <Table rowKey="id" size="small" pagination={false} columns={returnColumns} dataSource={view.returns} scroll={{ x: true }} />
        </Card>
      ) : null}
      {view.repairs.length > 0 ? (
        <Card title={`当日维修取机（${view.repairs.length}）`}>
          <Typography.Paragraph type="secondary">维修取机结算的收款算在取机这天，已经加进上面各收款方式的系统数里。</Typography.Paragraph>
          <Table rowKey="id" size="small" pagination={false} columns={repairColumns} dataSource={view.repairs} scroll={{ x: true }} />
        </Card>
      ) : null}
    </Space>
  );
}
