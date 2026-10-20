"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, Form, Input, InputNumber, Modal, Switch, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { CARRIER_BIZ_TYPE_LABELS, CARRIER_BIZ_TYPES, CARRIER_LABELS, CARRIERS, type CarrierBizTypeKey, type CarrierKey } from "@/lib/carrier";
import { formatDateTime, formatFen, yuanToFen } from "@/lib/format";
import { saveRuleAction } from "../actions";
import { CarrierNav } from "../carrier-nav";

type Rule = { carrier: CarrierKey; bizType: CarrierBizTypeKey; commissionFen: number; clawbackMonths: number; isActive: boolean; note: string | null; updatedAt: Date };
type Row = { key: string; carrier: CarrierKey; bizType: CarrierBizTypeKey; rule?: Rule };
type Values = { commissionYuan: number; clawbackMonths: number; isActive: boolean; note?: string };

export function RulesView({ rules }: { rules: Rule[] }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<Row | null>(null);
  const [form] = Form.useForm<Values>();

  // 4 个运营商 × 5 种业务都列出来，没配的显示“未配置”（没配的业务登记不了）
  const rows: Row[] = CARRIERS.flatMap((carrier) => CARRIER_BIZ_TYPES.map((bizType) => ({ key: `${carrier}-${bizType}`, carrier, bizType, rule: rules.find((r) => r.carrier === carrier && r.bizType === bizType) })));

  function edit(row: Row) {
    form.setFieldsValue({ commissionYuan: row.rule ? row.rule.commissionFen / 100 : 0, clawbackMonths: row.rule?.clawbackMonths ?? 6, isActive: row.rule?.isActive ?? true, note: row.rule?.note ?? "" });
    setEditing(row);
  }

  function save() {
    const row = editing;
    if (!row) return;
    form.validateFields().then((v) =>
      startTransition(async () => {
        const result = await saveRuleAction({ carrier: row.carrier, bizType: row.bizType, commissionFen: yuanToFen(v.commissionYuan), clawbackMonths: v.clawbackMonths, isActive: v.isActive, note: v.note });
        if (!result.ok) return void message.error(result.error);
        message.success("已保存，以后登记的按新政策算");
        setEditing(null);
        router.refresh();
      }),
    );
  }

  const columns: TableColumnsType<Row> = [
    { title: "运营商", render: (_, r) => CARRIER_LABELS[r.carrier], onCell: (_, i) => ({ rowSpan: (i ?? 0) % CARRIER_BIZ_TYPES.length === 0 ? CARRIER_BIZ_TYPES.length : 0 }) },
    { title: "业务类型", render: (_, r) => CARRIER_BIZ_TYPE_LABELS[r.bizType] },
    { title: "每笔佣金（元）", align: "right", render: (_, r) => (r.rule ? formatFen(r.rule.commissionFen) : "-") },
    { title: "返销期", align: "right", render: (_, r) => (r.rule ? `${r.rule.clawbackMonths} 个月` : "-") },
    { title: "状态", render: (_, r) => (!r.rule ? <Tag>未配置</Tag> : r.rule.isActive ? <Tag color="green">在用</Tag> : <Tag color="default">停用</Tag>) },
    { title: "备注", render: (_, r) => r.rule?.note ?? "" },
    { title: "改于", render: (_, r) => (r.rule ? formatDateTime(r.rule.updatedAt) : "") },
    { title: "操作", render: (_, r) => <Button size="small" onClick={() => edit(r)}>{r.rule ? "改" : "配置"}</Button> },
  ];

  return (
    <Card title="运营商佣金政策">
      <CarrierNav current="rules" isHq />
      <Typography.Paragraph type="secondary">
        按“运营商 + 业务类型”配每笔佣金和返销期（客户在返销期内销户、降套餐，运营商会扣回佣金）。登记时按当时的政策记预计佣金，改政策不影响已经登记的。没配或停用的业务登记不了。
      </Typography.Paragraph>
      <Table rowKey="key" size="small" bordered columns={columns} dataSource={rows} pagination={false} scroll={{ x: true }} />
      <Modal title={editing ? `${CARRIER_LABELS[editing.carrier]} · ${CARRIER_BIZ_TYPE_LABELS[editing.bizType]}` : ""} open={!!editing} confirmLoading={pending} onOk={save} onCancel={() => setEditing(null)} destroyOnHidden>
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="commissionYuan" label="每笔佣金（元）" rules={[{ required: true, message: "填佣金" }]}>
            <InputNumber min={0} max={100000} precision={2} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="clawbackMonths" label="返销期（月）" rules={[{ required: true, message: "填返销期" }]} extra="几个月内销户要扣回佣金，0 表示不扣回">
            <InputNumber min={0} max={24} precision={0} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="isActive" label="在用" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input maxLength={100} placeholder="如 2026 年 10 月渠道政策" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
