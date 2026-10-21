"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Button, Card, DatePicker, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Statistic, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import dayjs from "dayjs";
import { APPROVER_ROLE_LABELS, type ApproverRoleKey } from "@/lib/approval";
import {
  EXPENSE_BACKDATE_DAYS,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_HQ_FEN,
  EXPENSE_PAY_METHOD_LABELS,
  EXPENSE_PAY_METHODS,
  EXPENSE_STATUS_COLORS,
  EXPENSE_STATUS_LABELS,
  type ExpenseCategoryKey,
  type ExpensePayMethodKey,
  type ExpenseStatusKey,
} from "@/lib/expense";
import { formatFen, yuanToFen } from "@/lib/format";
import type { ExpenseList, ExpenseView } from "@/server/finance/expense-service";
import { cancelExpenseAction, payExpenseAction, submitExpenseAction, type ExpenseActionResult } from "./actions";

type Row = ExpenseList["rows"][number];

const VIEW_LABELS: Record<ExpenseView, string> = { mine: "我的", team: "员工的", topay: "待付款" };

export function ExpensesView({ data, status, month, today, role }: { data: ExpenseList; status?: ExpenseStatusKey; month: string | null; today: string; role: string }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<{ category?: ExpenseCategoryKey; amount: number | null; occurredOn: string; description: string; storeId: number | null }>({ amount: null, occurredOn: today, description: "", storeId: null });
  const [paying, setPaying] = useState<Row | null>(null);
  const [pay, setPay] = useState<{ payMethod: ExpensePayMethodKey; paidOn: string; note: string }>({ payMethod: "BANK", paidOn: today, note: "" });
  const pickStore = role === "HQ" || role === "REGIONAL_MANAGER";

  function go(next: { view?: ExpenseView; status?: ExpenseStatusKey | null; month?: string | null; store?: number | null; page?: number }) {
    const sp = new URLSearchParams();
    sp.set("view", next.view ?? data.view);
    const s = next.status === undefined ? status : next.status;
    if (s) sp.set("status", s);
    const m = next.month === undefined ? month : next.month;
    if (m) sp.set("month", m);
    const st = next.store === undefined ? data.storeId : next.store;
    if (st) sp.set("store", String(st));
    if (next.page && next.page > 1) sp.set("page", String(next.page));
    router.push(`/finance/expenses?${sp}`);
  }

  function act(fn: () => Promise<ExpenseActionResult>, after?: () => void) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) return void message.error(r.error);
      message.success(r.message, 5);
      after?.();
      router.refresh();
    });
  }

  const amountFen = form.amount === null ? 0 : yuanToFen(form.amount);
  const columns: TableColumnsType<Row> = [
    { title: "单号", dataIndex: "claimNo" },
    ...(data.view !== "mine" ? [{ title: "报销人", render: (_: unknown, r: Row) => r.name }] : []),
    { title: "算哪家的", dataIndex: "store" },
    { title: "类型", render: (_, r) => EXPENSE_CATEGORY_LABELS[r.category] },
    { title: "金额（元）", align: "right", render: (_, r) => formatFen(r.amountFen) },
    { title: "发生日期", dataIndex: "occurredOn" },
    { title: "说明", dataIndex: "description", render: (v: string) => <Typography.Text ellipsis={{ tooltip: v }} style={{ maxWidth: 220 }}>{v}</Typography.Text> },
    {
      title: "状态",
      render: (_, r) => (
        <Space orientation="vertical" size={0}>
          <Tag color={EXPENSE_STATUS_COLORS[r.status]}>{EXPENSE_STATUS_LABELS[r.status]}</Tag>
          {r.status === "PENDING" && r.approval ? <Typography.Text type="secondary">等{APPROVER_ROLE_LABELS[r.approval.approverRole as ApproverRoleKey]}批{r.approval.steps > 1 ? `（第 ${r.approval.step}/${r.approval.steps} 级）` : ""}</Typography.Text> : null}
          {r.paid ? <Typography.Text type="secondary">{`${r.paid.on} ${EXPENSE_PAY_METHOD_LABELS[r.paid.method]}，${r.paid.by}`}</Typography.Text> : null}
          {r.approval?.note ? <Typography.Text type="secondary">{r.approval.note}</Typography.Text> : null}
        </Space>
      ),
    },
    {
      title: "",
      render: (_, r) => (
        <Space>
          {r.approval ? <Link href={`/approvals/${r.approval.id}`}>审批单</Link> : null}
          {r.mine && r.status === "PENDING" ? (
            <Popconfirm title="撤回这张报销？" onConfirm={() => act(() => cancelExpenseAction(r.id))}>
              <a>撤回</a>
            </Popconfirm>
          ) : null}
          {data.canPay && r.status === "APPROVED" ? (
            <Button size="small" type="primary" onClick={() => { setPay({ payMethod: "BANK", paidOn: today, note: "" }); setPaying(r); }}>
              登记付款
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];

  const t = data.totals;
  return (
    <Card
      title="费用报销"
      extra={
        <Button type="primary" onClick={() => setOpen(true)}>
          我要报销
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">
        交通、办公用品、维修耗材、招待、快递物流这些垫付的费用在这里报。店员 {formatFen(EXPENSE_HQ_FEN)} 元以下店长批，{formatFen(EXPENSE_HQ_FEN)} 元及以上店长批完总部再批；店长和总部的人直接总部批。批了是“待付款”，总部付完款登记后才算进门店当月的费用（按付款日期）。纸质发票交财务，这里不传附件。
      </Typography.Paragraph>
      <Space wrap style={{ marginBottom: 12 }}>
        {data.views.length > 1 ? <Segmented<ExpenseView> value={data.view} options={data.views.map((v) => ({ value: v, label: VIEW_LABELS[v] }))} onChange={(v) => go({ view: v, page: 1 })} /> : null}
        <DatePicker picker="month" placeholder="按发生月份" value={month ? dayjs(`${month}-01`) : null} onChange={(d) => go({ month: d ? d.format("YYYY-MM") : null, page: 1 })} />
        {data.view !== "topay" ? <Select allowClear placeholder="状态" style={{ width: 120 }} value={status} options={(Object.keys(EXPENSE_STATUS_LABELS) as ExpenseStatusKey[]).map((s) => ({ value: s, label: EXPENSE_STATUS_LABELS[s] }))} onChange={(v) => go({ status: v ?? null, page: 1 })} /> : null}
        {data.view !== "mine" && data.stores.length > 1 ? <Select allowClear placeholder="全部门店" style={{ width: 180 }} value={data.storeId ?? undefined} options={data.stores.map((s) => ({ value: s.id, label: `${s.code} ${s.name}` }))} onChange={(v) => go({ store: v ?? null, page: 1 })} /> : null}
      </Space>
      <Space wrap size="large" style={{ marginBottom: 12 }}>
        {(["PENDING", "APPROVED", "PAID"] as const).map((s) => (
          <Statistic key={s} title={`${EXPENSE_STATUS_LABELS[s]}（${t[s]?.count ?? 0} 张）`} value={formatFen(t[s]?.amountFen ?? 0)} suffix="元" />
        ))}
      </Space>
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={data.rows}
        scroll={{ x: 1100 }}
        locale={{ emptyText: data.view === "topay" ? "没有待付款的报销" : "没有报销记录" }}
        pagination={{ current: data.page, pageSize: data.pageSize, total: data.total, showSizeChanger: false, hideOnSinglePage: true, onChange: (p) => go({ page: p }) }}
      />

      <Modal
        title="我要报销"
        open={open}
        confirmLoading={pending}
        okText="提交审批"
        onCancel={() => setOpen(false)}
        onOk={() => {
          if (!form.category || !amountFen) return void message.error("选一下类型、填一下金额");
          act(() => submitExpenseAction({ category: form.category!, amountFen, occurredOn: form.occurredOn, description: form.description, storeId: pickStore ? form.storeId : undefined }), () => {
            setOpen(false);
            setForm({ amount: null, occurredOn: today, description: "", storeId: null });
          });
        }}
        destroyOnHidden
      >
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Select placeholder="费用类型" style={{ width: "100%" }} value={form.category} options={EXPENSE_CATEGORIES.map((c) => ({ value: c, label: EXPENSE_CATEGORY_LABELS[c] }))} onChange={(v) => setForm({ ...form, category: v })} />
          <Space wrap>
            <InputNumber placeholder="金额" min={0.01} max={50000} precision={2} addonAfter="元" style={{ width: 180 }} value={form.amount} onChange={(v) => setForm({ ...form, amount: v })} />
            <DatePicker allowClear={false} value={dayjs(form.occurredOn)} disabledDate={(d) => d.format("YYYY-MM-DD") > today || d.isBefore(dayjs(today).subtract(EXPENSE_BACKDATE_DAYS, "day"), "day")} onChange={(d) => d && setForm({ ...form, occurredOn: d.format("YYYY-MM-DD") })} />
          </Space>
          {pickStore ? (
            <Select allowClear placeholder="算哪家门店的（不选就是总部的费用）" style={{ width: "100%" }} value={form.storeId ?? undefined} options={data.stores.map((s) => ({ value: s.id, label: `${s.code} ${s.name}` }))} onChange={(v) => setForm({ ...form, storeId: v ?? null })} />
          ) : (
            <Typography.Text type="secondary">算本店（{data.myStore ?? "未分配门店"}）的费用</Typography.Text>
          )}
          <Input.TextArea placeholder="说明（必填，比如：给中山路店买打印纸）" rows={3} maxLength={200} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          {amountFen >= EXPENSE_HQ_FEN && role === "STAFF" ? <Typography.Text type="secondary">{formatFen(EXPENSE_HQ_FEN)} 元及以上：店长批完还要总部批</Typography.Text> : null}
        </Space>
      </Modal>

      <Modal
        title={paying ? `登记付款：${paying.claimNo} ${paying.name} ${formatFen(paying.amountFen)} 元` : "登记付款"}
        open={paying !== null}
        confirmLoading={pending}
        okText="已付款"
        onCancel={() => setPaying(null)}
        onOk={() => paying && act(() => payExpenseAction(paying.id, pay), () => setPaying(null))}
        destroyOnHidden
      >
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Segmented<ExpensePayMethodKey> value={pay.payMethod} options={EXPENSE_PAY_METHODS.map((m) => ({ value: m, label: EXPENSE_PAY_METHOD_LABELS[m] }))} onChange={(v) => setPay({ ...pay, payMethod: v })} />
          <DatePicker allowClear={false} value={dayjs(pay.paidOn)} disabledDate={(d) => d.format("YYYY-MM-DD") > today} onChange={(d) => d && setPay({ ...pay, paidOn: d.format("YYYY-MM-DD") })} />
          <Input placeholder="备注（可不填，比如转账流水号后四位）" maxLength={100} value={pay.note} onChange={(e) => setPay({ ...pay, note: e.target.value })} />
          <Typography.Text type="secondary">按付款日期算进门店那个月的费用。</Typography.Text>
        </Space>
      </Modal>
    </Card>
  );
}
