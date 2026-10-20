"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Card, Descriptions, Input, Modal, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { formatDate, formatDateTime, formatFen } from "@/lib/format";
import { INVOICE_KIND_LABELS, INVOICE_STATUS_COLORS, INVOICE_STATUS_LABELS, INVOICE_TITLE_TYPE_LABELS } from "@/lib/invoice";
import type { InvoiceDetail } from "@/server/invoice/invoice-service";
import { cancelInvoiceAction, issueInvoiceAction, markDeliveredAction, redInvoiceAction, type InvoiceActionResult } from "../actions";

type Line = InvoiceDetail["lines"][number];
type Seller = { name: string; taxNo: string; addressPhone: string; bankAccount: string };

export function InvoiceDetailView({ invoice }: { invoice: InvoiceDetail }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [modal, setModal] = useState<"issue" | "red" | "cancel" | null>(null);
  const [number, setNumber] = useState("");
  const [reason, setReason] = useState("");

  function act(fn: () => Promise<InvoiceActionResult>) {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) return void message.error(result.error);
      message.success(result.message ?? "已完成");
      setModal(null);
      router.refresh();
    });
  }

  function submitModal() {
    if (modal === "issue") act(() => issueInvoiceAction(invoice.id, number));
    else if (modal === "red") act(() => redInvoiceAction(invoice.id, { redNumber: number, reason }));
    else if (modal === "cancel") act(() => cancelInvoiceAction(invoice.id, reason));
  }

  const seller = invoice.sellerSnapshot as Seller | null;
  const columns: TableColumnsType<Line> = [
    { title: "项目名称", dataIndex: "name" },
    { title: "规格（串号）", dataIndex: "spec", render: (v: string | null) => v ?? "" },
    { title: "数量", dataIndex: "qty", align: "right" },
    { title: "金额（含税，元）", dataIndex: "amountFen", align: "right", render: (v: number) => formatFen(v) },
    { title: "税率", dataIndex: "taxRateBp", align: "right", render: (v: number) => `${v / 100}%` },
    { title: "税额（元）", dataIndex: "taxFen", align: "right", render: (v: number) => formatFen(v) },
  ];

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        title={
          <Space wrap>
            {`${INVOICE_KIND_LABELS[invoice.kind]} ${invoice.requestNo}`}
            <Tag color={INVOICE_STATUS_COLORS[invoice.status]}>{INVOICE_STATUS_LABELS[invoice.status]}</Tag>
          </Space>
        }
        extra={
          <Space wrap>
            {invoice.can.issue ? (
              <Button type="primary" onClick={() => { setNumber(""); setModal("issue"); }}>
                开具
              </Button>
            ) : null}
            {invoice.can.red ? (
              <Button danger={invoice.status === "RED_PENDING"} onClick={() => { setNumber(""); setReason(invoice.status === "RED_PENDING" ? (invoice.cancelReason ?? "") : ""); setModal("red"); }}>
                红冲
              </Button>
            ) : null}
            {invoice.can.delivered ? (
              <Button loading={pending} onClick={() => act(() => markDeliveredAction(invoice.id))}>
                纸质票已到店
              </Button>
            ) : null}
            {invoice.can.cancel ? <Button onClick={() => { setReason(""); setModal("cancel"); }}>撤回</Button> : null}
            <Link href="/invoices">
              <Button>返回列表</Button>
            </Link>
          </Space>
        }
      >
        {invoice.status === "RED_PENDING" ? <Alert type="warning" showIcon style={{ marginBottom: 12 }} title={`${invoice.cancelReason ?? "销售单变了"}：总部开红字发票冲掉这张，之后可以按剩下的商品重新申请。`} /> : null}
        {invoice.status === "CANCELLED" ? <Alert type="info" showIcon style={{ marginBottom: 12 }} title={`已撤回：${invoice.cancelReason ?? ""}`} /> : null}
        <Descriptions
          size="small"
          column={{ xs: 1, sm: 2, md: 3 }}
          items={[
            { key: "order", label: "销售单", children: invoice.salesOrder.canOpen ? <Link href={`/sales/${invoice.salesOrder.id}`}>{invoice.salesOrder.orderNo}</Link> : invoice.salesOrder.orderNo },
            { key: "bizDate", label: "开单日", children: formatDate(invoice.salesOrder.bizDate) },
            { key: "store", label: "门店", children: `${invoice.store.code} ${invoice.store.name}` },
            { key: "title", label: "抬头", children: `${invoice.titleName}（${INVOICE_TITLE_TYPE_LABELS[invoice.titleType]}）` },
            { key: "taxNo", label: "购买方税号", children: invoice.buyerTaxNo ?? "-" },
            { key: "receiver", label: "接收方", children: invoice.kind === "PAPER_NORMAL" ? (invoice.deliveredAt ? `纸质票 ${formatDateTime(invoice.deliveredAt)} 到店` : "纸质票寄到门店") : (invoice.receiver ?? "到店扫码取") },
            ...(invoice.buyerAddressPhone ? [{ key: "addr", label: "购买方地址电话", children: invoice.buyerAddressPhone }] : []),
            ...(invoice.buyerBankAccount ? [{ key: "bank", label: "购买方开户行及账号", children: invoice.buyerBankAccount }] : []),
            { key: "amount", label: "价税合计", children: <Typography.Text strong>{formatFen(invoice.amountFen)} 元</Typography.Text> },
            { key: "tax", label: "税额", children: `${formatFen(invoice.taxFen)} 元` },
            { key: "requested", label: "申请", children: `${invoice.requestedBy.name}，${formatDateTime(invoice.createdAt)}` },
            ...(invoice.invoiceNumber ? [{ key: "number", label: "发票号码", children: `${invoice.invoiceNumber}${invoice.issueSource === "SIMULATED" ? "（模拟）" : ""}` }] : []),
            ...(invoice.issuedAt ? [{ key: "issued", label: "开具", children: `${invoice.issuedBy?.name ?? ""}，${formatDateTime(invoice.issuedAt)}` }] : []),
            ...(invoice.redAt ? [{ key: "red", label: "红冲", children: `${invoice.redNumber}，${invoice.redBy?.name ?? ""}，${formatDateTime(invoice.redAt)}，${invoice.redReason ?? ""}` }] : []),
          ]}
        />
      </Card>
      {seller ? (
        <Card title="销售方（开具时）" size="small">
          <Typography.Text>
            {seller.name}，税号 {seller.taxNo}，{seller.addressPhone}，{seller.bankAccount}
          </Typography.Text>
        </Card>
      ) : null}
      <Card title={`明细（${invoice.lines.length} 行）`}>
        <Table rowKey="id" size="small" columns={columns} dataSource={invoice.lines} pagination={false} scroll={{ x: true }} />
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
          金额都是含税价：商品 13%、碎屏险延保这类服务 6%；整单优惠按成交额分摊到每一行；以旧换新抵扣、国补立减是收款方式，不减发票金额。
        </Typography.Paragraph>
      </Card>
      <Modal title={modal === "issue" ? "开具发票" : modal === "red" ? "红冲" : "撤回开票申请"} open={modal !== null} confirmLoading={pending} onOk={submitModal} onCancel={() => setModal(null)} destroyOnHidden>
        {modal === "issue" ? (
          <Space orientation="vertical" style={{ width: "100%" }}>
            <Typography.Text type="secondary">在电子税务局开好后，把发票号码填进来{invoice.can.simulate ? "；演示里不填就模拟开出一张 20 位数电票号码" : ""}。</Typography.Text>
            <Input placeholder={invoice.can.simulate ? "发票号码（可不填）" : "发票号码"} value={number} maxLength={24} onChange={(e) => setNumber(e.target.value)} />
          </Space>
        ) : null}
        {modal === "red" ? (
          <Space orientation="vertical" style={{ width: "100%" }}>
            <Typography.Text type="secondary">开红字发票冲掉这张{invoice.can.simulate ? "；演示里红字号码不填就模拟生成" : ""}。</Typography.Text>
            <Input placeholder={invoice.can.simulate ? "红字发票号码（可不填）" : "红字发票号码"} value={number} maxLength={24} onChange={(e) => setNumber(e.target.value)} />
            <Input placeholder="红冲原因" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
          </Space>
        ) : null}
        {modal === "cancel" ? <Input placeholder="撤回原因（可不填）" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /> : null}
      </Modal>
    </Space>
  );
}
