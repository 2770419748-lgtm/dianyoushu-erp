"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Card, Descriptions, Form, Input, InputNumber, Modal, Radio, Select, Space, Steps, Tag, Typography } from "antd";
import type { PaymentMethod } from "@/generated/prisma/enums";
import { formatDate, formatDateTime, formatFen, yuanToFen } from "@/lib/format";
import { FAULT_LABELS, REPAIR_PAYER_LABELS, REPAIR_STATUS_COLORS, REPAIR_STATUS_LABELS, type RepairPayerKey } from "@/lib/repair";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS_FOR_SALE } from "@/lib/sales-labels";
import type { RepairDetail } from "@/server/repair/repair-service";
import { approveRepairAction, declineRepairAction, finishRepairAction, pickupRepairAction, quoteRepairAction, voidRepairAction, type RepairActionResult } from "../actions";

const STEP_ORDER = ["RECEIVED", "QUOTED", "REPAIRING", "READY", "CLOSED"] as const;

type QuoteValues = { partsYuan?: number; laborYuan?: number; costYuan?: number; payer: RepairPayerKey; note?: string };
type PayRow = { key: number; method: PaymentMethod; amountYuan: number | null };

export function RepairDetailView({ repair }: { repair: RepairDetail }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [quoteForm] = Form.useForm<QuoteValues>();
  const [noteModal, setNoteModal] = useState<{ open: boolean; kind?: "decline" | "repaired" | "failed" | "void" }>({ open: false });
  const [note, setNote] = useState("");
  const [pays, setPays] = useState<PayRow[]>([{ key: 1, method: "WECHAT", amountYuan: null }]);

  function act(fn: () => Promise<RepairActionResult>, done: string, after?: () => void) {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) return void message.error(result.error);
      message.success(done);
      after?.();
      router.refresh();
    });
  }

  const stepIndex = repair.status === "VOIDED" ? 0 : STEP_ORDER.indexOf(repair.status as (typeof STEP_ORDER)[number]);
  const quoting = repair.can.handle && (repair.status === "RECEIVED" || repair.status === "QUOTED");
  const payFen = (row: PayRow) => (row.amountYuan === null ? (pays.length === 1 ? repair.chargeFen : 0) : yuanToFen(row.amountYuan) || 0);
  const paidFen = pays.reduce((s, p) => s + payFen(p), 0);

  function submitNote() {
    const kind = noteModal.kind;
    const after = () => setNoteModal({ open: false });
    if (kind === "decline") act(() => declineRepairAction(repair.id, note), "已记下客户不修，等客户取机", after);
    else if (kind === "repaired") act(() => finishRepairAction(repair.id, "REPAIRED", note), "修好了，等客户取机", after);
    else if (kind === "failed") act(() => finishRepairAction(repair.id, "NOT_REPAIRED", note), "已记下修不好，等客户取机", after);
    else if (kind === "void") act(() => voidRepairAction(repair.id, note), "已作废", after);
  }

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title={
          <Space wrap>
            <span>维修单 {repair.orderNo}</span>
            <Tag color={REPAIR_STATUS_COLORS[repair.status]}>{REPAIR_STATUS_LABELS[repair.status]}</Tag>
          </Space>
        }
        extra={
          <Space>
            <Link href="/repairs">
              <Button size="small">返回列表</Button>
            </Link>
            {repair.can.void ? (
              <Button size="small" danger onClick={() => { setNote(""); setNoteModal({ open: true, kind: "void" }); }}>
                作废
              </Button>
            ) : null}
          </Space>
        }
      >
        {repair.status === "VOIDED" ? (
          <Alert type="warning" showIcon title={`已作废：${repair.voidReason ?? ""}（${repair.voidedBy?.name ?? ""}，${repair.voidedAt ? formatDateTime(repair.voidedAt) : ""}）`} style={{ marginBottom: 16 }} />
        ) : (
          <Steps size="small" current={stepIndex} style={{ marginBottom: 16 }} items={STEP_ORDER.map((s) => ({ title: REPAIR_STATUS_LABELS[s] }))} />
        )}
        <Descriptions
          column={{ xs: 1, sm: 2, md: 3 }}
          items={[
            { key: "store", label: "接件门店", children: `${repair.store.code} ${repair.store.name}` },
            { key: "customer", label: "客户", children: <Link href={`/customers/${repair.customer.id}`}>{repair.customer.name} {repair.customer.phoneMasked}</Link> },
            { key: "received", label: "接件", children: `${repair.receivedBy.name}，${formatDateTime(repair.createdAt)}` },
            { key: "model", label: "机型", children: repair.modelName },
            { key: "code", label: "串号", children: repair.device ? <Link href={`/stock/devices/${repair.device.code}`}>{repair.deviceCode}</Link> : `${repair.deviceCode}（外面买的）` },
            {
              key: "buy",
              label: "购买 / 保修",
              children: repair.salesOrder
                ? (
                    <Space size={4} wrap>
                      {repair.salesOrder.canOpen ? <Link href={`/sales/${repair.salesOrder.id}`}>{repair.salesOrder.orderNo}</Link> : repair.salesOrder.orderNo}
                      {repair.purchasedOn ? `${formatDate(repair.purchasedOn)} 买的${repair.warrantyEndsOn ? `，保修到 ${formatDate(repair.warrantyEndsOn)}` : ""}` : null}
                    </Space>
                  )
                : "不是本店卖的，保修找厂家",
            },
            { key: "fault", label: "故障", children: `${FAULT_LABELS[repair.faultCategory]}：${repair.faultDescription}` },
            { key: "appearance", label: "外观附件", children: repair.appearance ?? "-" },
            { key: "note", label: "维修备注", children: repair.repairNote ?? "-" },
          ]}
        />
      </Card>

      {repair.payer ? (
        <Card title="报价">
          <Descriptions
            column={{ xs: 1, sm: 2, md: 3 }}
            items={[
              { key: "payer", label: "谁付", children: REPAIR_PAYER_LABELS[repair.payer] + (repair.entitlement ? `（${repair.entitlement.sku.name}，到 ${formatDate(repair.entitlement.expiresOn)}${repair.entitlement.status === "CLAIMED" ? "，已理赔" : ""}）` : "") },
              { key: "parts", label: "配件费", children: `${formatFen(repair.partsFen ?? 0)} 元` },
              { key: "labor", label: "工时费", children: `${formatFen(repair.laborFen ?? 0)} 元` },
              { key: "charge", label: "客户应付", children: <Typography.Text strong>{formatFen(repair.chargeFen)} 元</Typography.Text> },
              ...(repair.can.seeCost ? [{ key: "cost", label: "维修成本", children: `${formatFen(repair.costFen ?? 0)} 元` }] : []),
              { key: "outcome", label: "结果", children: repair.outcome === "REPAIRED" ? "修好了" : repair.outcome === "NOT_REPAIRED" ? "没修（客户不修或修不好），不收钱" : "-" },
            ]}
          />
        </Card>
      ) : null}

      {quoting ? (
        <Card title={repair.status === "RECEIVED" ? "检测报价" : "重新报价"}>
          <Form
            form={quoteForm}
            layout="vertical"
            initialValues={{ payer: repair.payer ?? "CUSTOMER", partsYuan: (repair.partsFen ?? 0) / 100, laborYuan: (repair.laborFen ?? 0) / 100, costYuan: (repair.costFen ?? 0) / 100 }}
            onFinish={(v) =>
              act(
                () => quoteRepairAction(repair.id, { partsFen: yuanToFen(v.partsYuan ?? 0), laborFen: yuanToFen(v.laborYuan ?? 0), costFen: yuanToFen(v.costYuan ?? 0), payer: v.payer, note: v.note }),
                "已报价，等客户确认",
              )
            }
          >
            <Form.Item name="payer" label="谁来付" rules={[{ required: true }]}>
              <Radio.Group>
                <Space orientation="vertical">
                  {repair.payerOptions.map((o) => (
                    <Radio key={o.payer} value={o.payer} disabled={!o.allowed}>
                      {REPAIR_PAYER_LABELS[o.payer]} <Typography.Text type="secondary">— {o.reason}</Typography.Text>
                    </Radio>
                  ))}
                </Space>
              </Radio.Group>
            </Form.Item>
            <Space wrap size="large">
              <Form.Item name="partsYuan" label="配件费（元）">
                <InputNumber min={0} precision={2} style={{ width: 140 }} />
              </Form.Item>
              <Form.Item name="laborYuan" label="工时费（元）">
                <InputNumber min={0} precision={2} style={{ width: 140 }} />
              </Form.Item>
              {repair.can.seeCost ? (
                <Form.Item name="costYuan" label="维修成本（元）" extra="店里实际花的钱，店长以上看">
                  <InputNumber min={0} precision={2} style={{ width: 140 }} />
                </Form.Item>
              ) : null}
            </Space>
            <Form.Item name="note" label="检测结果">
              <Input maxLength={200} placeholder="如：外屏碎、内屏正常，换外屏" />
            </Form.Item>
            <Typography.Paragraph type="secondary">保修、碎屏险、延保客户不付钱；自费 = 配件费 + 工时费。</Typography.Paragraph>
            <Button type="primary" htmlType="submit" loading={pending}>
              报价
            </Button>
          </Form>
        </Card>
      ) : null}

      {repair.can.handle && repair.status === "QUOTED" ? (
        <Card title="客户确认">
          <Space wrap>
            <Button type="primary" loading={pending} onClick={() => act(() => approveRepairAction(repair.id), "客户同意，开始维修")}>
              客户同意，开始修
            </Button>
            <Button onClick={() => { setNote(""); setNoteModal({ open: true, kind: "decline" }); }}>客户不修</Button>
          </Space>
        </Card>
      ) : null}

      {repair.can.handle && repair.status === "REPAIRING" ? (
        <Card title="维修结果">
          <Space wrap>
            <Button type="primary" onClick={() => { setNote(""); setNoteModal({ open: true, kind: "repaired" }); }}>修好了</Button>
            <Button onClick={() => { setNote(""); setNoteModal({ open: true, kind: "failed" }); }}>修不好</Button>
          </Space>
        </Card>
      ) : null}

      {repair.can.handle && repair.status === "READY" ? (
        <Card title="取机结算">
          {repair.todayClosed ? <Alert type="warning" showIcon title="这家店今天已经日结确认了，不能再结算；确实要结请总部先撤销今天的日结。" style={{ marginBottom: 12 }} /> : null}
          {repair.chargeFen > 0 ? (
            <Space orientation="vertical" style={{ width: "100%" }}>
              <Typography.Text>
                客户应付 <Typography.Text strong>{formatFen(repair.chargeFen)}</Typography.Text> 元，收款记在今天，进今天的日结。
              </Typography.Text>
              {pays.map((p) => (
                <Space key={p.key} wrap>
                  <Select value={p.method} style={{ width: 140 }} options={PAYMENT_METHODS_FOR_SALE.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m] }))} onChange={(m) => setPays(pays.map((x) => (x.key === p.key ? { ...x, method: m } : x)))} />
                  <InputNumber min={0} precision={2} placeholder={pays.length === 1 ? formatFen(repair.chargeFen) : "金额"} value={p.amountYuan} style={{ width: 140 }} onChange={(v) => setPays(pays.map((x) => (x.key === p.key ? { ...x, amountYuan: v === null ? null : Number(v) } : x)))} />
                  {pays.length > 1 ? <Button type="link" danger onClick={() => setPays(pays.filter((x) => x.key !== p.key))}>删</Button> : null}
                </Space>
              ))}
              <Space wrap>
                <Button size="small" onClick={() => setPays([...pays, { key: Date.now(), method: "CASH", amountYuan: null }])}>再加一种收款</Button>
                {paidFen !== repair.chargeFen ? <Typography.Text type="danger">合计 {formatFen(paidFen)}，和应付差 {formatFen(repair.chargeFen - paidFen)}</Typography.Text> : <Typography.Text type="success">收款已对上</Typography.Text>}
              </Space>
            </Space>
          ) : (
            <Typography.Paragraph>
              不用收钱（{repair.outcome === "NOT_REPAIRED" ? "没修" : repair.payer ? REPAIR_PAYER_LABELS[repair.payer] : ""}）{repair.payer === "SCREEN_INSURANCE" && repair.outcome === "REPAIRED" ? "，结算后这份碎屏险变“已理赔”" : ""}。
            </Typography.Paragraph>
          )}
          <Button
            type="primary"
            style={{ marginTop: 12 }}
            loading={pending}
            disabled={repair.todayClosed || (repair.chargeFen > 0 && paidFen !== repair.chargeFen)}
            onClick={() => act(() => pickupRepairAction(repair.id, repair.chargeFen > 0 ? pays.map((p) => ({ method: p.method, amountFen: payFen(p) })) : []), "已结算，客户取走了")}
          >
            客户取机，结算
          </Button>
        </Card>
      ) : null}

      {repair.status === "CLOSED" ? (
        <Card title="结算">
          <Typography.Text>
            {repair.closedBy?.name ?? ""} 在 {repair.closedAt ? formatDateTime(repair.closedAt) : ""} 结算；
            {repair.payments.length > 0 ? `收款 ${repair.payments.map((p) => `${PAYMENT_METHOD_LABELS[p.method]} ${formatFen(p.amountFen)} 元`).join(" + ")}` : "没收钱"}
            {repair.dailyCloseId ? "，已日结" : ""}。
          </Typography.Text>
        </Card>
      ) : null}

      <Modal
        title={noteModal.kind === "void" ? "作废维修单" : noteModal.kind === "decline" ? "客户不修" : noteModal.kind === "repaired" ? "修好了" : "修不好"}
        open={noteModal.open}
        confirmLoading={pending}
        onOk={submitNote}
        onCancel={() => setNoteModal({ open: false })}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          {noteModal.kind === "void" ? "接错了、重复接件才作废，要写原因。" : noteModal.kind === "repaired" ? "写一下修了什么（可以不写）。" : "写一下原因（可以不写），这张单不收钱，等客户来取机。"}
        </Typography.Paragraph>
        <Input.TextArea rows={2} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
      </Modal>
    </Space>
  );
}
