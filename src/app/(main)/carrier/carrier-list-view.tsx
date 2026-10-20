"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Button, Card, Input, Modal, Select, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import type { CarrierBizStatus } from "@/generated/prisma/enums";
import { CARRIER_BIZ_STATUS_COLORS, CARRIER_BIZ_STATUS_LABELS, CARRIER_BIZ_TYPE_LABELS, CARRIER_BIZ_TYPES, CARRIER_LABELS, CARRIERS } from "@/lib/carrier";
import { formatDate, formatFen } from "@/lib/format";
import type { CarrierBusinessRow, CarrierQuery, listBusiness } from "@/server/carrier/carrier-service";
import { confirmBusinessAction, syncSimulatedAction, voidBusinessAction, type CarrierActionResult } from "./actions";
import { CarrierNav } from "./carrier-nav";

type Data = Awaited<ReturnType<typeof listBusiness>>;

export function CarrierListView({ data, query, stores, isHq }: { data: Data; query: CarrierQuery; stores: { id: number; label: string }[]; isHq: boolean }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [modal, setModal] = useState<{ open: boolean; kind?: "activate" | "fail" | "void"; row?: CarrierBusinessRow }>({ open: false });
  const [input, setInput] = useState("");

  function navigate(next: Partial<CarrierQuery> & { page?: number }) {
    const merged = { ...query, ...next };
    const sp = new URLSearchParams();
    if (merged.status) sp.set("status", merged.status);
    if (merged.carrier) sp.set("carrier", merged.carrier);
    if (merged.bizType) sp.set("type", merged.bizType);
    if (merged.month) sp.set("month", merged.month);
    if (merged.storeId) sp.set("storeId", String(merged.storeId));
    if (merged.q) sp.set("q", merged.q);
    if (next.page && next.page > 1) sp.set("page", String(next.page));
    router.push(`/carrier${sp.size ? `?${sp}` : ""}`);
  }

  function act(fn: () => Promise<CarrierActionResult>, done: string) {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) return void message.error(result.error);
      message.success(result.message ?? done);
      setModal({ open: false });
      router.refresh();
    });
  }

  function submitModal() {
    const row = modal.row;
    if (!row) return;
    if (modal.kind === "activate") act(() => confirmBusinessAction(row.id, true, { carrierOrderNo: input }), "已确认开通");
    else if (modal.kind === "fail") act(() => confirmBusinessAction(row.id, false, { reason: input }), "已记下办理失败");
    else act(() => voidBusinessAction(row.id, input), "已作废");
  }

  const columns: TableColumnsType<CarrierBusinessRow> = [
    { title: "单号", dataIndex: "orderNo" },
    { title: "日期", dataIndex: "bizDate", render: (v: Date) => formatDate(v) },
    { title: "门店", render: (_, r) => `${r.store.code} ${r.store.name}` },
    { title: "经办", render: (_, r) => r.handledBy.name },
    { title: "运营商", render: (_, r) => CARRIER_LABELS[r.carrier] },
    { title: "业务", render: (_, r) => CARRIER_BIZ_TYPE_LABELS[r.bizType] },
    {
      title: "号码 / 套餐",
      render: (_, r) => (
        <Space orientation="vertical" size={0}>
          {r.phoneMasked}
          <Typography.Text type="secondary">
            {r.packageName}
            {r.monthlyFeeFen ? `，月租 ${formatFen(r.monthlyFeeFen)}` : ""}
          </Typography.Text>
        </Space>
      ),
    },
    { title: "客户", render: (_, r) => (r.customer ? <Link href={`/customers/${r.customer.id}`}>{r.customer.name}</Link> : "-") },
    { title: "关联销售单", render: (_, r) => (r.salesOrder ? <Link href={`/sales/${r.salesOrder.id}`}>{r.salesOrder.orderNo}</Link> : "-") },
    { title: "受理单号", dataIndex: "carrierOrderNo", render: (v: string | null) => v ?? "-" },
    {
      title: "佣金（元）",
      align: "right",
      render: (_, r) => (
        <Space orientation="vertical" size={0} style={{ alignItems: "flex-end" }}>
          <span>预计 {formatFen(r.expectedCommissionFen)}</span>
          {r.settledFen !== null ? <Typography.Text type={r.settledFen === r.expectedCommissionFen ? "success" : "warning"}>实收 {formatFen(r.settledFen)}</Typography.Text> : null}
          {r.clawbackFen ? <Typography.Text type="danger">扣回 {formatFen(r.clawbackFen)}</Typography.Text> : null}
        </Space>
      ),
    },
    {
      title: "状态",
      render: (_, r) => (
        <Space orientation="vertical" size={0}>
          <Tag color={CARRIER_BIZ_STATUS_COLORS[r.status]}>{CARRIER_BIZ_STATUS_LABELS[r.status]}</Tag>
          {r.failedReason ? <Typography.Text type="secondary">{r.failedReason}</Typography.Text> : null}
          {r.voidReason ? <Typography.Text type="secondary">{r.voidReason}</Typography.Text> : null}
        </Space>
      ),
    },
    {
      title: "操作",
      render: (_, r) => (
        <Space size={4} wrap>
          {data.can.register && r.status === "SUBMITTED" ? (
            <>
              <Button size="small" onClick={() => { setInput(r.carrierOrderNo ?? ""); setModal({ open: true, kind: "activate", row: r }); }}>开通了</Button>
              <Button size="small" onClick={() => { setInput(""); setModal({ open: true, kind: "fail", row: r }); }}>没办成</Button>
            </>
          ) : null}
          {data.can.void && (r.status === "SUBMITTED" || r.status === "ACTIVATED" || r.status === "FAILED") ? (
            <Button size="small" danger onClick={() => { setInput(""); setModal({ open: true, kind: "void", row: r }); }}>作废</Button>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={`运营商业务（${data.total}）`}
      extra={
        <Space>
          {data.can.simulate ? (
            <Button loading={pending} onClick={() => act(() => syncSimulatedAction(), "已同步")}>
              同步运营商状态（模拟）
            </Button>
          ) : null}
          {data.can.register ? (
            <Link href="/carrier/new">
              <Button type="primary">登记业务</Button>
            </Link>
          ) : null}
        </Space>
      }
    >
      <CarrierNav current="list" isHq={isHq} />
      <Typography.Paragraph type="secondary">
        号卡、合约机、宽带办完登记一笔；运营商那边办成了点“开通了”（演示里可以点“同步运营商状态”模拟）。佣金按登记时的政策记预计，总部按月导入运营商结算单后记实收或扣回。
      </Typography.Paragraph>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select allowClear placeholder="状态" style={{ width: 120 }} value={query.status} options={(Object.keys(CARRIER_BIZ_STATUS_LABELS) as CarrierBizStatus[]).map((s) => ({ value: s, label: CARRIER_BIZ_STATUS_LABELS[s] }))} onChange={(v) => navigate({ status: v, page: 1 })} />
        <Select allowClear placeholder="运营商" style={{ width: 120 }} value={query.carrier} options={CARRIERS.map((c) => ({ value: c, label: CARRIER_LABELS[c] }))} onChange={(v) => navigate({ carrier: v, page: 1 })} />
        <Select allowClear placeholder="业务类型" style={{ width: 120 }} value={query.bizType} options={CARRIER_BIZ_TYPES.map((t) => ({ value: t, label: CARRIER_BIZ_TYPE_LABELS[t] }))} onChange={(v) => navigate({ bizType: v, page: 1 })} />
        <Input placeholder="月份 2026-09" defaultValue={query.month} style={{ width: 130 }} onPressEnter={(e) => navigate({ month: (e.target as HTMLInputElement).value.trim() || undefined, page: 1 })} />
        {stores.length > 1 ? <Select allowClear placeholder="全部门店" style={{ width: 180 }} value={query.storeId} options={stores.map((s) => ({ value: s.id, label: s.label }))} onChange={(v) => navigate({ storeId: v, page: 1 })} /> : null}
        <Input.Search allowClear placeholder="单号、受理单号、号码（至少 4 位）" defaultValue={query.q} style={{ width: "min(280px, 100%)" }} onSearch={(v) => navigate({ q: v, page: 1 })} />
      </Space>
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={data.rows}
        scroll={{ x: 1400 }}
        locale={{ emptyText: "没有运营商业务" }}
        pagination={{ current: data.page, pageSize: data.pageSize, total: data.total, showSizeChanger: false, onChange: (p) => navigate({ page: p }) }}
      />
      <Modal
        title={modal.kind === "activate" ? "确认开通" : modal.kind === "fail" ? "办理失败" : "作废业务单"}
        open={modal.open}
        confirmLoading={pending}
        onOk={submitModal}
        onCancel={() => setModal({ open: false })}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          {modal.kind === "activate" ? "在运营商系统里看到办成了再确认；有受理单号就填上，月底对账先按它对。" : modal.kind === "fail" ? "写一下没办成的原因，这笔不算佣金。" : "登记错了才作废，要写原因；作废后不算佣金。"}
        </Typography.Paragraph>
        <Input value={input} maxLength={modal.kind === "activate" ? 40 : 200} placeholder={modal.kind === "activate" ? "运营商受理单号（可不填）" : "原因"} onChange={(e) => setInput(e.target.value)} />
      </Modal>
    </Card>
  );
}
