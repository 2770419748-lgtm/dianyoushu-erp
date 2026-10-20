"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Card, Checkbox, Input, InputNumber, Select, Space, Table, Typography } from "antd";
import type { TableColumnsType } from "antd";
import type { PaymentMethod } from "@/generated/prisma/enums";
import { formatFen, yuanToFen } from "@/lib/format";
import { PAYMENT_METHOD_LABELS } from "@/lib/sales-labels";
import { proportionalRefundFen } from "@/server/sales/payments";
import type { ReturnContext } from "@/server/sales/return-service";
import { createReturnAction } from "../../actions";

type Item = ReturnContext["items"][number];

export function ReturnForm({ ctx }: { ctx: ReturnContext }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [qtys, setQtys] = useState<Record<number, number>>({});
  const [refundYuan, setRefundYuan] = useState<number | null>(null);
  const [method, setMethod] = useState<PaymentMethod | undefined>(ctx.refundMethods[0]);
  const [reason, setReason] = useState("");

  // 默认退款 = 退回行成交额按整单优惠分摊，再不超过还能退的实付
  const suggestedFen = useMemo(() => {
    const sum = ctx.items.reduce((s, i) => s + proportionalRefundFen(Math.round((i.lineTotalFen * (qtys[i.id] ?? 0)) / i.qty), ctx.order.subtotalFen, ctx.order.totalFen), 0);
    return Math.min(sum, ctx.maxRefundFen);
  }, [ctx, qtys]);
  // 这次最多能退：只按勾选的行算（和服务端 returnRefundCapFen 同一个算法），所以等于按比例建议的金额
  const capFen = suggestedFen;
  const refundFen = refundYuan === null ? suggestedFen : yuanToFen(refundYuan) || 0;
  const overCap = refundFen > capFen;
  const selectedCount = Object.values(qtys).filter((q) => q > 0).length;

  /** 勾机器时，保这台机器的碎屏险、延保默认一起勾上（客户不要这台机器了，一般服务也退）；不退服务可以再取消 */
  function toggle(item: Item, checked: boolean) {
    const next = { ...qtys, [item.id]: checked ? 1 : 0 };
    if (checked && item.deviceId) {
      for (const s of ctx.items) if (s.serviceForDeviceId === item.deviceId && s.returnableQty > 0) next[s.id] = 1;
    }
    setQtys(next);
  }
  // 退了机器、却没退保这台机器的服务：提醒一下（不强制，客户可能只退机器）
  const returningDevices = new Set(ctx.items.filter((i) => i.deviceId && (qtys[i.id] ?? 0) > 0).map((i) => i.deviceId));
  const orphanServices = ctx.items.filter((i) => i.serviceForDeviceId && returningDevices.has(i.serviceForDeviceId) && i.returnableQty > 0 && (qtys[i.id] ?? 0) === 0);

  const columns: TableColumnsType<Item> = [
    {
      title: "退",
      width: 60,
      render: (_, i) =>
        i.deviceCode ? (
          <Checkbox disabled={i.returnableQty === 0} checked={(qtys[i.id] ?? 0) > 0} onChange={(e) => toggle(i, e.target.checked)} />
        ) : (
          <InputNumber min={0} max={i.returnableQty} precision={0} disabled={i.returnableQty === 0} value={qtys[i.id] ?? 0} style={{ width: 70 }} onChange={(v) => setQtys({ ...qtys, [i.id]: Number(v) || 0 })} />
        ),
    },
    { title: "商品", dataIndex: "name" },
    { title: "机器 / 数量", render: (_, i) => i.deviceCode ?? `× ${i.qty}` },
    { title: "已退", dataIndex: "returnedQty", align: "right" },
    { title: "成交额（元）", dataIndex: "lineTotalFen", align: "right", render: (v: number) => formatFen(v) },
  ];

  function submit() {
    const lines = ctx.items.filter((i) => (qtys[i.id] ?? 0) > 0).map((i) => ({ salesItemId: i.id, qty: qtys[i.id] }));
    startTransition(async () => {
      const result = await createReturnAction({ salesOrderId: ctx.order.id, lines, refundFen, refundMethod: method, reason });
      if (!result.ok) {
        message.error(result.error);
        return;
      }
      message.success(`退货完成 ${result.orderNo}`);
      router.push(`/sales/${ctx.order.id}`);
    });
  }

  return (
    <Card
      title={`退货：${ctx.order.orderNo}`}
      extra={
        <Link href={`/sales/${ctx.order.id}`}>
          <Button size="small">返回原单</Button>
        </Link>
      }
    >
      {ctx.todayClosed ? <Alert type="warning" showIcon title="这家店今天已经日结确认了，不能再退货；确实要退请总部先撤销今天的日结。" style={{ marginBottom: 16 }} /> : null}
      <Typography.Paragraph type="secondary">
        勾选要退的机器、填配件数量。退回后机器回在库（回收机回良品）、配件加回数量；退掉的碎屏险、延保跟着失效。退款走原单用过的收款方式；以旧换新抵扣的 {formatFen(ctx.tradeInFen)} 元不退（旧机已回收）。
      </Typography.Paragraph>
      <Table rowKey="id" size="small" pagination={false} columns={columns} dataSource={ctx.items} scroll={{ x: true }} />
      {orphanServices.length > 0 ? (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 12 }}
          title={`要退的机器还买了 ${orphanServices.map((i) => i.name).join("、")}：一般服务也一起退（勾上它）；不退的话服务照常有效，但会标“机器已退回”，不再算这台机器的保障。`}
        />
      ) : null}
      <Space orientation="vertical" style={{ marginTop: 16 }} size="middle">
        <Typography.Text>
          原单应收 {formatFen(ctx.order.totalFen)} 元，已退 {formatFen(ctx.refundedFen)} 元；这次勾选的商品最多退 <Typography.Text strong>{formatFen(capFen)}</Typography.Text> 元
        </Typography.Text>
        <Space wrap>
          <span>退款金额（元）</span>
          <InputNumber min={0} max={capFen / 100} status={overCap ? "error" : undefined} precision={2} style={{ width: 160 }} placeholder={(suggestedFen / 100).toFixed(2)} value={refundYuan} onChange={(v) => setRefundYuan(v === null ? null : Number(v))} />
          <Typography.Text type="secondary">按比例建议 {formatFen(suggestedFen)} 元</Typography.Text>
        </Space>
        <Space wrap>
          <span>退款方式</span>
          <Select style={{ width: 140 }} value={method} onChange={setMethod} options={ctx.refundMethods.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m] }))} placeholder={ctx.refundMethods.length ? "选择" : "原单全是抵扣，不用退钱"} disabled={ctx.refundMethods.length === 0} />
        </Space>
        <Input placeholder="退货原因" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: 360 }} />
        <Button type="primary" danger loading={pending} disabled={ctx.todayClosed || selectedCount === 0 || overCap || (refundFen > 0 && !method)} onClick={submit}>
          确认退货（退 {formatFen(refundFen)} 元）
        </Button>
      </Space>
    </Card>
  );
}
