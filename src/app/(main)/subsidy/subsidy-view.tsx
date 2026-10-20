"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Button, Card, Col, Input, Modal, Row, Select, Space, Statistic, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import type { SubsidyClaimStatus } from "@/generated/prisma/enums";
import { formatDate, formatFen } from "@/lib/format";
import { SUBSIDY_STATUS_COLORS, SUBSIDY_STATUS_LABELS } from "@/lib/subsidy";
import type { listClaims, SubsidyClaimRow, SubsidyQuery, subsidySummary } from "@/server/subsidy/subsidy-service";
import { importResultsAction, markReturnedAction, simulateReviewAction, simulateSettleAction, submitClaimAction, type SubsidyActionResult } from "./actions";

type Data = Awaited<ReturnType<typeof listClaims>>;
type Summary = Awaited<ReturnType<typeof subsidySummary>>;

const SAMPLE = "核销码,结果,金额（元）,原因\nGB202610200001,通过,,\nGB202610200002,已到账,500.00,\nGB202610200003,驳回,,发票抬头和顾客实名不一致";

export function SubsidyView({ data, summary, query, stores }: { data: Data; summary: Summary; query: SubsidyQuery; stores: { id: number; label: string }[] }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState<SubsidyClaimRow | null>(null);
  const [invoiceNo, setInvoiceNo] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [csv, setCsv] = useState("");

  function navigate(next: Partial<SubsidyQuery>) {
    const merged = { ...query, ...next };
    const sp = new URLSearchParams();
    if (merged.status) sp.set("status", merged.status);
    if (merged.storeId) sp.set("storeId", String(merged.storeId));
    if (merged.month) sp.set("month", merged.month);
    if (merged.q) sp.set("q", merged.q);
    if (next.page && next.page > 1) sp.set("page", String(next.page));
    router.push(`/subsidy${sp.size ? `?${sp}` : ""}`);
  }

  function act(fn: () => Promise<SubsidyActionResult>, after?: () => void) {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) return void message.error(result.error);
      message.success(result.message ?? "已完成");
      after?.();
      router.refresh();
    });
  }

  async function readFile(file: File) {
    // 平台导出的表格常见是 GBK 编码：先按 UTF-8 读，读出乱码再按 GBK 读
    const buffer = await file.arrayBuffer();
    let content = new TextDecoder("utf-8").decode(buffer);
    if (content.includes("�")) content = new TextDecoder("gbk").decode(buffer);
    setCsv(content);
  }

  const columns: TableColumnsType<SubsidyClaimRow> = [
    { title: "国补单号", dataIndex: "claimNo" },
    { title: "开单日", dataIndex: "bizDate", render: (v: Date) => formatDate(v) },
    { title: "门店", render: (_, r) => `${r.store.code} ${r.store.name}` },
    { title: "销售单", render: (_, r) => <Link href={`/sales/${r.salesOrder.id}`}>{r.salesOrder.orderNo}</Link> },
    { title: "客户", render: (_, r) => <Link href={`/customers/${r.customer.id}`}>{r.customer.name}</Link> },
    {
      title: "机器",
      render: (_, r) => (
        <Space orientation="vertical" size={0}>
          <Link href={`/stock/devices/${r.device.code}`}>{r.device.code}</Link>
          <Typography.Text type="secondary">
            {r.category.name} {r.device.sku.name}
          </Typography.Text>
        </Space>
      ),
    },
    { title: "成交价（元）", dataIndex: "basePriceFen", align: "right", render: (v: number) => formatFen(v) },
    { title: "补贴（元）", dataIndex: "subsidyFen", align: "right", render: (v: number) => <Typography.Text strong>{formatFen(v)}</Typography.Text> },
    { title: "资格码", dataIndex: "qualificationCode" },
    { title: "发票号", dataIndex: "invoiceNo", render: (v: string | null) => v ?? "-" },
    {
      title: "状态",
      render: (_, r) => (
        <Space orientation="vertical" size={0}>
          <Tag color={SUBSIDY_STATUS_COLORS[r.status]}>{SUBSIDY_STATUS_LABELS[r.status]}</Tag>
          {r.rejectReason ? <Typography.Text type="danger">{r.rejectReason}</Typography.Text> : null}
          {r.settledAt ? (
            <Typography.Text type={r.settledFen !== null && r.settledFen !== r.subsidyFen ? "warning" : "secondary"}>
              {formatDate(r.settledAt)} 到账 {formatFen(r.settledFen ?? 0)}
              {r.settledFen !== null && r.settledFen !== r.subsidyFen ? `（应到 ${formatFen(r.subsidyFen)}，差 ${formatFen(r.subsidyFen - r.settledFen)}）` : ""}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: "操作",
      render: (_, r) => (
        <Space size={4} wrap>
          {data.can.submit && (r.status === "PENDING" || r.status === "REJECTED") ? (
            <Button size="small" type={r.status === "PENDING" ? "primary" : "default"} onClick={() => { setInvoiceNo(r.invoiceNo ?? ""); setSubmitting(r); }}>
              {r.status === "PENDING" ? "提交审核" : "改了重新提交"}
            </Button>
          ) : null}
          {data.can.manage && r.status === "RETURN_DUE" ? (
            <Button size="small" onClick={() => act(() => markReturnedAction(r.id))}>
              已退回平台
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];

  const t = summary.total;
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        title="国补"
        extra={
          data.can.manage ? (
            <Space wrap>
              <Link href="/subsidy/policies">
                <Button>国补政策</Button>
              </Link>
              <Button onClick={() => { setCsv(""); setImportOpen(true); }}>导入平台结果</Button>
              {data.can.simulate ? (
                <>
                  <Button loading={pending} onClick={() => act(() => simulateReviewAction())}>
                    平台审核（模拟）
                  </Button>
                  <Button loading={pending} onClick={() => act(() => simulateSettleAction())}>
                    到账（模拟）
                  </Button>
                </>
              ) : null}
            </Space>
          ) : null
        }
      >
        <Typography.Paragraph type="secondary">
          开单用了国补的机器，每台一张国补单。门店补上发票号提交平台审核；审核通过、到账由总部导入平台导出的结果表格（演示里点“平台审核（模拟）”“到账（模拟）”）。补贴是门店先垫的钱，没到账的都算国补应收。
        </Typography.Paragraph>
        <Row gutter={[16, 16]}>
          <Col xs={12} md={6}>
            <Statistic title="国补应收（元）" value={formatFen(t.receivableFen)} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title={`本月补贴（${t.monthCount} 台）`} value={formatFen(t.monthFen)} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="被驳回（可能收不回）" value={formatFen(t.rejectedFen)} styles={{ content: t.rejectedFen ? { color: "#cf1322" } : undefined }} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="退货要退回平台" value={formatFen(t.returnDueFen)} styles={{ content: t.returnDueFen ? { color: "#d46b08" } : undefined }} />
          </Col>
        </Row>
        {t.shortFen ? <Typography.Paragraph type="warning" style={{ marginTop: 12, marginBottom: 0 }}>平台到账比补贴{t.shortFen > 0 ? "少" : "多"} {formatFen(Math.abs(t.shortFen))} 元（看下面各店的“到账差额”和明细里标黄的单，找平台核对）。</Typography.Paragraph> : null}
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
              { title: "应收（元）", dataIndex: "receivableFen", align: "right", render: (v: number) => formatFen(v) },
              { title: "本月补贴（元）", dataIndex: "monthFen", align: "right", render: (v: number) => formatFen(v) },
              { title: "已到账（元）", dataIndex: "settledFen", align: "right", render: (v: number) => formatFen(v) },
              { title: "到账差额（元）", dataIndex: "shortFen", align: "right", render: (v: number) => (v ? <Typography.Text type="warning">{formatFen(v)}</Typography.Text> : "0.00") },
              { title: "被驳回（元）", dataIndex: "rejectedFen", align: "right", render: (v: number) => (v ? <Typography.Text type="danger">{formatFen(v)}</Typography.Text> : "0.00") },
              { title: "要退回（元）", dataIndex: "returnDueFen", align: "right", render: (v: number) => (v ? <Typography.Text type="warning">{formatFen(v)}</Typography.Text> : "0.00") },
            ]}
          />
        ) : null}
      </Card>
      <Card title={`国补订单明细（${data.total}）`}>
        <Space wrap style={{ marginBottom: 12 }}>
          <Select allowClear placeholder="状态" style={{ width: 120 }} value={query.status} options={(Object.keys(SUBSIDY_STATUS_LABELS) as SubsidyClaimStatus[]).map((s) => ({ value: s, label: SUBSIDY_STATUS_LABELS[s] }))} onChange={(v) => navigate({ status: v, page: 1 })} />
          {stores.length > 1 ? <Select allowClear placeholder="全部门店" style={{ width: 180 }} value={query.storeId} options={stores.map((s) => ({ value: s.id, label: s.label }))} onChange={(v) => navigate({ storeId: v, page: 1 })} /> : null}
          <Input placeholder="开单月份 2026-09" defaultValue={query.month} style={{ width: 150 }} onPressEnter={(e) => navigate({ month: (e.target as HTMLInputElement).value.trim() || undefined, page: 1 })} />
          <Input.Search allowClear placeholder="国补单号、销售单号、资格码、串号" defaultValue={query.q} style={{ width: "min(300px, 100%)" }} onSearch={(v) => navigate({ q: v, page: 1 })} />
        </Space>
        <Table
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={data.rows}
          scroll={{ x: 1500 }}
          locale={{ emptyText: "没有国补单" }}
          pagination={{ current: data.page, pageSize: data.pageSize, total: data.total, showSizeChanger: false, onChange: (p) => navigate({ page: p }) }}
        />
      </Card>
      <Modal
        title={submitting ? `提交审核 ${submitting.claimNo}` : ""}
        open={!!submitting}
        confirmLoading={pending}
        onCancel={() => setSubmitting(null)}
        onOk={() => submitting && act(() => submitClaimAction(submitting.id, invoiceNo), () => setSubmitting(null))}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">平台审核要发票和串号照片；这里记发票号（真用时照片在平台上传）。{submitting?.rejectReason ? `上次驳回原因：${submitting.rejectReason}` : ""}</Typography.Paragraph>
        <Input placeholder="发票号（不填就用这张销售单已经开好的发票号码）" value={invoiceNo} maxLength={30} onChange={(e) => setInvoiceNo(e.target.value)} />
      </Modal>
      <Modal title="导入平台审核 / 到账结果" open={importOpen} width={680} confirmLoading={pending} okText="导入" onCancel={() => setImportOpen(false)} onOk={() => act(() => importResultsAction(csv), () => setImportOpen(false))}>
        <Typography.Paragraph type="secondary">按核销码（资格码）对国补单。结果写“通过”“驳回”“已到账”；已到账没写金额的按补贴金额记。状态对不上的行（比如还没提交就说到账）不处理，会告诉你有几行。</Typography.Paragraph>
        <Space orientation="vertical" style={{ width: "100%" }}>
          <input type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); }} />
          <Input.TextArea rows={8} value={csv} placeholder={SAMPLE} style={{ fontFamily: "monospace" }} onChange={(e) => setCsv(e.target.value)} />
        </Space>
      </Modal>
    </Space>
  );
}
