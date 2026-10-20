"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Card, Form, Input, Radio, Space, Table, Typography } from "antd";
import { formatDate, formatFen } from "@/lib/format";
import { INVOICE_KIND_LABELS, INVOICE_KINDS, type InvoiceKindKey, type InvoiceTitleTypeKey } from "@/lib/invoice";
import type { invoiceDraft } from "@/server/invoice/invoice-service";
import { requestInvoiceAction } from "../actions";

type Draft = NonNullable<Awaited<ReturnType<typeof invoiceDraft>>>;
type Values = { kind: InvoiceKindKey; titleType: InvoiceTitleTypeKey; titleName: string; buyerTaxNo?: string; buyerAddressPhone?: string; buyerBankAccount?: string; receiver?: string };

export function InvoiceRequestForm({ draft }: { draft: Draft }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [form] = Form.useForm<Values>();
  const kind = Form.useWatch("kind", form);
  const titleType = Form.useWatch("titleType", form);
  const last = draft.lastTitle;

  function submit(v: Values) {
    startTransition(async () => {
      const result = await requestInvoiceAction({ salesOrderId: draft.order.id, ...v });
      if (!result.ok) return void message.error(result.error);
      message.success(result.message ?? "已提交");
      router.push(result.id ? `/invoices/${result.id}` : "/invoices");
    });
  }

  return (
    <Card
      title={`申请开票：${draft.order.orderNo}`}
      extra={
        <Link href={`/sales/${draft.order.id}`}>
          <Button>返回销售单</Button>
        </Link>
      }
    >
      <Typography.Paragraph type="secondary">
        {draft.order.store.code} {draft.order.store.name}，{formatDate(draft.order.bizDate)} 开单{draft.order.customer ? `，客户 ${draft.order.customer.name}` : ""}。发票开这张单还没退的商品，整单优惠分摊到每一行；以旧换新抵扣、国补立减不减发票金额。
      </Typography.Paragraph>
      {draft.blocked ? (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }} title={draft.blocked} action={draft.activeId ? <Link href={`/invoices/${draft.activeId}`}>看那张</Link> : undefined} />
      ) : null}
      <Table
        rowKey="salesOrderItemId"
        size="small"
        pagination={false}
        scroll={{ x: true }}
        dataSource={draft.lines}
        columns={[
          { title: "项目名称", dataIndex: "name" },
          { title: "规格（串号）", dataIndex: "spec", render: (v: string | null) => v ?? "" },
          { title: "数量", dataIndex: "qty", align: "right" },
          { title: "金额（含税，元）", dataIndex: "amountFen", align: "right", render: (v: number) => formatFen(v) },
          { title: "税率", dataIndex: "taxRateBp", align: "right", render: (v: number) => `${v / 100}%` },
          { title: "税额（元）", dataIndex: "taxFen", align: "right", render: (v: number) => formatFen(v) },
        ]}
        summary={() => (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0} colSpan={3}>
              价税合计
            </Table.Summary.Cell>
            <Table.Summary.Cell index={3} align="right">
              <Typography.Text strong>{formatFen(draft.amountFen)}</Typography.Text>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={4} />
            <Table.Summary.Cell index={5} align="right">
              {formatFen(draft.taxFen)}
            </Table.Summary.Cell>
          </Table.Summary.Row>
        )}
        style={{ marginBottom: 16 }}
      />
      <Form
        form={form}
        layout="vertical"
        onFinish={submit}
        disabled={!!draft.blocked}
        initialValues={{
          kind: last?.kind ?? "E_NORMAL",
          titleType: last?.titleType ?? "PERSONAL",
          titleName: last?.titleName ?? draft.order.customer?.name ?? "",
          buyerTaxNo: last?.buyerTaxNo ?? "",
          buyerAddressPhone: last?.buyerAddressPhone ?? "",
          buyerBankAccount: last?.buyerBankAccount ?? "",
          receiver: last?.receiver ?? "",
        }}
      >
        {last ? <Typography.Paragraph type="secondary">已经带出这位客户上次开票的抬头，不对就改。</Typography.Paragraph> : null}
        <Space wrap size="large">
          <Form.Item name="kind" label="发票种类" rules={[{ required: true }]}>
            <Radio.Group options={INVOICE_KINDS.map((k) => ({ value: k, label: INVOICE_KIND_LABELS[k] }))} onChange={(e) => e.target.value === "E_SPECIAL" && form.setFieldValue("titleType", "COMPANY")} />
          </Form.Item>
          <Form.Item name="titleType" label="抬头类型" rules={[{ required: true }]}>
            <Radio.Group options={[{ value: "PERSONAL", label: "个人", disabled: kind === "E_SPECIAL" }, { value: "COMPANY", label: "企业" }]} />
          </Form.Item>
        </Space>
        <Space wrap size="large">
          <Form.Item name="titleName" label={titleType === "COMPANY" ? "公司名称" : "抬头（个人写姓名）"} rules={[{ required: true, message: "填一下抬头" }]}>
            <Input maxLength={100} style={{ width: 280 }} />
          </Form.Item>
          {titleType === "COMPANY" ? (
            <Form.Item name="buyerTaxNo" label="纳税人识别号" rules={[{ required: true, pattern: /^[0-9A-Za-z]{15,20}$/, message: "15～20 位字母数字（统一社会信用代码 18 位）" }]}>
              <Input maxLength={20} style={{ width: 240 }} />
            </Form.Item>
          ) : null}
        </Space>
        {kind === "E_SPECIAL" ? (
          <Space wrap size="large">
            <Form.Item name="buyerAddressPhone" label="公司地址电话" rules={[{ required: true, message: "专票要填" }]}>
              <Input maxLength={100} style={{ width: 320 }} />
            </Form.Item>
            <Form.Item name="buyerBankAccount" label="开户行及账号" rules={[{ required: true, message: "专票要填" }]}>
              <Input maxLength={100} style={{ width: 320 }} />
            </Form.Item>
          </Space>
        ) : null}
        {kind !== "PAPER_NORMAL" ? (
          <Form.Item name="receiver" label="接收邮箱或手机" extra="电子票开好发过去；不填就到店扫码取">
            <Input maxLength={60} style={{ width: 280 }} />
          </Form.Item>
        ) : (
          <Typography.Paragraph type="secondary">纸质票总部开好寄到门店，到了店里点“已到店”，通知顾客来取。</Typography.Paragraph>
        )}
        <Button type="primary" htmlType="submit" loading={pending}>
          提交开票申请
        </Button>
      </Form>
    </Card>
  );
}
