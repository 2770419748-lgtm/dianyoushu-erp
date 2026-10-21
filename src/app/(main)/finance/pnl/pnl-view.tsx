"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { App, Card, DatePicker, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import dayjs from "dayjs";
import { formatFen, yuanToFen } from "@/lib/format";
import { FIXED_EXPENSE_CATEGORIES, FIXED_EXPENSE_LABELS, type FixedExpenseCategoryKey } from "@/lib/pnl";
import type { PnlPage, PnlRow } from "@/server/finance/pnl-service";
import { saveFixedAction } from "./actions";

type Line = { key: string; name: string; numbers: PnlRow["numbers"]; row: PnlRow | null };

const money = (fen: number) => <span style={{ color: fen < 0 ? "var(--ant-color-error)" : undefined }}>{formatFen(fen)}</span>;

export function PnlView({ data }: { data: PnlPage }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<PnlRow | null>(null);
  const [form, setForm] = useState<Record<FixedExpenseCategoryKey, { amount: number | null; note: string }>>({ RENT: { amount: null, note: "" }, UTILITIES: { amount: null, note: "" }, PROPERTY: { amount: null, note: "" }, OTHER: { amount: null, note: "" } });

  function go(next: { month?: string; store?: number | null }) {
    const sp = new URLSearchParams();
    sp.set("month", next.month ?? data.month);
    const st = next.store === undefined ? data.storeId : next.store;
    if (st) sp.set("store", String(st));
    router.push(`/finance/pnl?${sp}`);
  }

  function edit(row: PnlRow) {
    const f = row.fixed as Partial<Record<FixedExpenseCategoryKey, { amountFen: number; note: string | null }>>;
    setForm(Object.fromEntries(FIXED_EXPENSE_CATEGORIES.map((c) => [c, { amount: f[c] ? f[c]!.amountFen / 100 : null, note: f[c]?.note ?? "" }])) as typeof form);
    setEditing(row);
  }

  function save() {
    if (!editing || editing.storeId === null) return;
    const items = FIXED_EXPENSE_CATEGORIES.filter((c) => form[c].amount !== null).map((c) => ({ category: c, amountFen: yuanToFen(form[c].amount!), note: form[c].note }));
    if (items.length === 0) return void message.error("至少填一项（这个月没有的填 0）");
    startTransition(async () => {
      const r = await saveFixedAction(editing.storeId!, data.month, items);
      if (!r.ok) return void message.error(r.error);
      message.success("已保存");
      setEditing(null);
      router.refresh();
    });
  }

  const lines: Line[] = [...data.rows.map((r) => ({ key: r.key, name: r.name, numbers: r.numbers, row: r })), ...(data.total ? [{ key: "total", name: "合计", numbers: data.total, row: null }] : [])];
  const columns: TableColumnsType<Line> = [
    { title: "门店", fixed: "left", width: 150, render: (_, l) => (l.row ? l.name : <Typography.Text strong>{l.name}</Typography.Text>) },
    { title: "销售额", align: "right", render: (_, l) => money(l.numbers.salesFen) },
    { title: "运营商佣金", align: "right", render: (_, l) => money(l.numbers.carrierFen) },
    { title: "维修收费", align: "right", render: (_, l) => money(l.numbers.repairFen) },
    { title: "收入", align: "right", render: (_, l) => <Typography.Text strong>{money(l.numbers.revenueFen)}</Typography.Text> },
    { title: "销货成本", align: "right", render: (_, l) => money(l.numbers.costFen) },
    {
      title: "毛利",
      align: "right",
      render: (_, l) => (
        <Space orientation="vertical" size={0} style={{ alignItems: "flex-end" }}>
          <Typography.Text strong>{money(l.numbers.grossFen)}</Typography.Text>
          {l.numbers.grossRate !== null ? <Typography.Text type="secondary">{(l.numbers.grossRate * 100).toFixed(1)}%</Typography.Text> : null}
        </Space>
      ),
    },
    { title: "报销", align: "right", render: (_, l) => money(l.numbers.expenseFen) },
    { title: "工资", align: "right", render: (_, l) => money(l.numbers.payrollFen) },
    { title: "固定支出", align: "right", render: (_, l) => money(l.numbers.fixedFen) },
    { title: "利润", align: "right", render: (_, l) => <Typography.Text strong>{money(l.numbers.profitFen)}</Typography.Text> },
    { title: "", render: (_, l) => (l.numbers.missing.length ? <Space wrap size={2}>{l.numbers.missing.map((m) => <Tag key={m} color="orange">{m}</Tag>)}</Space> : null) },
    { title: "", fixed: "right", render: (_, l) => (l.row?.canEdit ? <a onClick={() => edit(l.row!)}>录固定支出</a> : null) },
  ];

  return (
    <Card
      title="门店收支和利润表"
      extra={
        <Space wrap>
          {data.stores.length > 1 ? <Select allowClear placeholder="全部门店" style={{ width: 180 }} value={data.storeId ?? undefined} options={data.stores.map((s) => ({ value: s.id, label: s.label }))} onChange={(v) => go({ store: v ?? null })} /> : null}
          <DatePicker picker="month" allowClear={false} value={dayjs(`${data.month}-01`)} disabledDate={(d) => d.format("YYYY-MM") > data.thisMonth} onChange={(d) => d && go({ month: d.format("YYYY-MM") })} />
        </Space>
      }
    >
      <Typography.Paragraph type="secondary">
        收入 = 销售额（应收扣退款，和看板一样）+ 运营商佣金（这个月办的、没作废没失败的，按政策记的）+ 维修收费（这个月取机结算的）。销货成本 = 卖出的机器、配件成本（退货冲回）+ 维修成本。费用 = 已付款的报销（按付款日期）+ 已发布工资条的应发（按那天在哪家店分）+ 门店固定支出。利润 = 毛利 − 费用。工资条没发布、固定支出没录的月份标“数据不全”。单位：元。
      </Typography.Paragraph>
      <Table rowKey="key" size="small" columns={columns} dataSource={lines} pagination={false} scroll={{ x: 1400 }} rowClassName={(l) => (l.key === "total" ? "ant-table-row-selected" : "")} />
      <Modal title={editing ? `录固定支出：${editing.name} ${data.month}` : ""} open={editing !== null} confirmLoading={pending} onCancel={() => setEditing(null)} onOk={save} destroyOnHidden>
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Typography.Text type="secondary">这个月没有的项填 0；空着的不保存。录了（哪怕全是 0）这个月就不再标“固定支出没录”。</Typography.Text>
          {FIXED_EXPENSE_CATEGORIES.map((c) => (
            <Space key={c} wrap>
              <InputNumber style={{ width: 200 }} min={0} max={100000} precision={2} addonBefore={FIXED_EXPENSE_LABELS[c]} addonAfter="元" value={form[c].amount} onChange={(v) => setForm({ ...form, [c]: { ...form[c], amount: v } })} />
              <Input style={{ width: 200 }} placeholder="备注（可不填）" maxLength={50} value={form[c].note} onChange={(e) => setForm({ ...form, [c]: { ...form[c], note: e.target.value } })} />
            </Space>
          ))}
        </Space>
      </Modal>
    </Card>
  );
}
