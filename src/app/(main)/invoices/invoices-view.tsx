"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, Col, Input, Row, Select, Space, Statistic, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import type { InvoiceStatus } from "@/generated/prisma/enums";
import { formatDateTime, formatFen } from "@/lib/format";
import { INVOICE_KIND_LABELS, INVOICE_STATUS_COLORS, INVOICE_STATUS_LABELS, INVOICE_TITLE_TYPE_LABELS } from "@/lib/invoice";
import type { InvoiceQuery, InvoiceRow, invoiceSummary, listInvoices } from "@/server/invoice/invoice-service";

type Data = Awaited<ReturnType<typeof listInvoices>>;
type Summary = Awaited<ReturnType<typeof invoiceSummary>>;

export function InvoicesView({ data, summary, query, stores }: { data: Data; summary: Summary; query: InvoiceQuery; stores: { id: number; label: string }[] }) {
  const router = useRouter();

  function navigate(next: Partial<InvoiceQuery>) {
    const merged = { ...query, ...next };
    const sp = new URLSearchParams();
    if (merged.status) sp.set("status", merged.status);
    if (merged.storeId) sp.set("storeId", String(merged.storeId));
    if (merged.month) sp.set("month", merged.month);
    if (merged.q) sp.set("q", merged.q);
    if (next.page && next.page > 1) sp.set("page", String(next.page));
    router.push(`/invoices${sp.size ? `?${sp}` : ""}`);
  }

  const columns: TableColumnsType<InvoiceRow> = [
    { title: "申请单号", dataIndex: "requestNo", render: (v: string, r) => <Link href={`/invoices/${r.id}`}>{v}</Link> },
    { title: "申请时间", dataIndex: "createdAt", render: (v: Date) => formatDateTime(v) },
    { title: "门店", render: (_, r) => `${r.store.code} ${r.store.name}` },
    { title: "销售单", render: (_, r) => r.salesOrder.orderNo },
    { title: "种类", dataIndex: "kind", render: (v: InvoiceRow["kind"]) => INVOICE_KIND_LABELS[v] },
    {
      title: "抬头",
      render: (_, r) => (
        <Space orientation="vertical" size={0}>
          {r.titleName}
          <Typography.Text type="secondary">
            {INVOICE_TITLE_TYPE_LABELS[r.titleType]}
            {r.buyerTaxNo ? ` ${r.buyerTaxNo}` : ""}
          </Typography.Text>
        </Space>
      ),
    },
    { title: "价税合计（元）", dataIndex: "amountFen", align: "right", render: (v: number) => formatFen(v) },
    { title: "发票号码", dataIndex: "invoiceNumber", render: (v: string | null) => v ?? "-" },
    {
      title: "状态",
      render: (_, r) => (
        <Space orientation="vertical" size={0}>
          <Tag color={INVOICE_STATUS_COLORS[r.status]}>{INVOICE_STATUS_LABELS[r.status]}</Tag>
          {r.kind === "PAPER_NORMAL" && r.status === "ISSUED" ? <Typography.Text type="secondary">{r.deliveredAt ? "已到店" : "寄送中"}</Typography.Text> : null}
        </Space>
      ),
    },
    { title: "申请人", render: (_, r) => r.requestedBy.name },
  ];

  const t = summary.total;
  const electronicRate = t.electronic + t.paper > 0 ? Math.round((t.electronic / (t.electronic + t.paper)) * 1000) / 10 : 0;
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        title="发票"
        extra={
          data.can.manage ? (
            <Link href="/invoices/seller">
              <Button>公司开票信息</Button>
            </Link>
          ) : null
        }
      >
        <Typography.Paragraph type="secondary">
          顾客要发票就在销售单详情里“申请开票”，总部开具（演示里模拟开出数电票号码，真用时在电子税务局开好回来登记）。开了之后退货、作废的会标“需红冲”，红冲后可以按剩下的商品重新申请。国补单提交审核会自动带出发票号码。
        </Typography.Paragraph>
        <Row gutter={[16, 16]}>
          <Col xs={12} md={6}>
            <Statistic title="待开票" value={t.pending} suffix="张" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title={`本月开票（${t.monthCount} 张）`} value={formatFen(t.monthFen)} suffix="元" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="需红冲" value={t.redPending} suffix="张" styles={{ content: t.redPending ? { color: "#d46b08" } : undefined }} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="电子票占比" value={electronicRate} suffix="%" />
          </Col>
        </Row>
        {summary.stores.length > 1 ? (
          <Table
            rowKey="storeId"
            size="small"
            style={{ marginTop: 16 }}
            pagination={false}
            scroll={{ x: true }}
            dataSource={summary.stores}
            columns={[
              { title: "门店", dataIndex: "label" },
              { title: "待开票", dataIndex: "pending", align: "right" },
              { title: "本月开票（张）", dataIndex: "monthCount", align: "right" },
              { title: "本月开票（元）", dataIndex: "monthFen", align: "right", render: (v: number) => formatFen(v) },
              { title: "需红冲", dataIndex: "redPending", align: "right", render: (v: number) => (v ? <Typography.Text type="warning">{v}</Typography.Text> : 0) },
              { title: "电子票 / 纸质票", render: (_, a) => `${a.electronic} / ${a.paper}` },
            ]}
          />
        ) : null}
      </Card>
      <Card title={`发票列表（${data.total}）`}>
        <Space wrap style={{ marginBottom: 12 }}>
          <Select allowClear placeholder="状态" style={{ width: 120 }} value={query.status} options={(Object.keys(INVOICE_STATUS_LABELS) as InvoiceStatus[]).map((s) => ({ value: s, label: INVOICE_STATUS_LABELS[s] }))} onChange={(v) => navigate({ status: v, page: 1 })} />
          {stores.length > 1 ? <Select allowClear placeholder="全部门店" style={{ width: 180 }} value={query.storeId} options={stores.map((s) => ({ value: s.id, label: s.label }))} onChange={(v) => navigate({ storeId: v, page: 1 })} /> : null}
          <Input placeholder="申请月份 2026-09" defaultValue={query.month} style={{ width: 150 }} onPressEnter={(e) => navigate({ month: (e.target as HTMLInputElement).value.trim() || undefined, page: 1 })} />
          <Input.Search allowClear placeholder="申请单号、发票号码、抬头、销售单号" defaultValue={query.q} style={{ width: "min(300px, 100%)" }} onSearch={(v) => navigate({ q: v, page: 1 })} />
        </Space>
        <Table
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={data.rows}
          scroll={{ x: 1300 }}
          locale={{ emptyText: "没有发票" }}
          pagination={{ current: data.page, pageSize: data.pageSize, total: data.total, showSizeChanger: false, onChange: (p) => navigate({ page: p }) }}
        />
      </Card>
    </Space>
  );
}
