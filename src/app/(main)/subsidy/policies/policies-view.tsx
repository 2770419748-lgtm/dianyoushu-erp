"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Button, Card, Form, Input, InputNumber, Modal, Space, Switch, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { formatDateTime, formatFen, yuanToFen } from "@/lib/format";
import { savePolicyAction } from "../actions";

type Policy = { rateBp: number; capFen: number; priceCapFen: number; startsOn: string; endsOn: string; isActive: boolean; note: string | null; updatedAt: Date };
type Row = { categoryId: number; categoryName: string; policy: Policy | null };
type Values = { ratePct: number; capYuan: number; priceCapYuan: number; startsOn: string; endsOn: string; isActive: boolean; note?: string };

export function PoliciesView({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<Row | null>(null);
  const [form] = Form.useForm<Values>();

  function edit(row: Row) {
    const p = row.policy;
    const year = new Date().getFullYear();
    form.setFieldsValue({ ratePct: p ? p.rateBp / 100 : 15, capYuan: p ? p.capFen / 100 : 500, priceCapYuan: p ? p.priceCapFen / 100 : 6000, startsOn: p?.startsOn ?? `${year}-01-01`, endsOn: p?.endsOn ?? `${year}-12-31`, isActive: p?.isActive ?? true, note: p?.note ?? "" });
    setEditing(row);
  }

  function save() {
    const row = editing;
    if (!row) return;
    form.validateFields().then((v) =>
      startTransition(async () => {
        const result = await savePolicyAction({ categoryId: row.categoryId, rateBp: Math.round(v.ratePct * 100), capFen: yuanToFen(v.capYuan), priceCapFen: yuanToFen(v.priceCapYuan), startsOn: v.startsOn, endsOn: v.endsOn, isActive: v.isActive, note: v.note });
        if (!result.ok) return void message.error(result.error);
        message.success(result.message ?? "已保存");
        setEditing(null);
        router.refresh();
      }),
    );
  }

  const columns: TableColumnsType<Row> = [
    { title: "品类", dataIndex: "categoryName" },
    { title: "补贴比例", render: (_, r) => (r.policy ? `${r.policy.rateBp / 100}%` : "-") },
    { title: "单件封顶（元）", align: "right", render: (_, r) => (r.policy ? formatFen(r.policy.capFen) : "-") },
    { title: "单价上限（元）", align: "right", render: (_, r) => (r.policy ? formatFen(r.policy.priceCapFen) : "-") },
    { title: "生效期", render: (_, r) => (r.policy ? `${r.policy.startsOn} ～ ${r.policy.endsOn}` : "-") },
    { title: "状态", render: (_, r) => (!r.policy ? <Tag>未配置</Tag> : r.policy.isActive ? <Tag color="green">在用</Tag> : <Tag>停用</Tag>) },
    { title: "备注", render: (_, r) => r.policy?.note ?? "" },
    { title: "改于", render: (_, r) => (r.policy ? formatDateTime(r.policy.updatedAt) : "") },
    { title: "操作", render: (_, r) => <Button size="small" onClick={() => edit(r)}>{r.policy ? "改" : "配置"}</Button> },
  ];

  return (
    <Card
      title="国补政策"
      extra={
        <Link href="/subsidy">
          <Button>返回国补</Button>
        </Link>
      }
    >
      <Typography.Paragraph type="secondary">
        按品类配：补贴 = 成交价 × 比例，不超过单件封顶；成交价超过单价上限的不补；每个顾客在生效期内同一品类只能补一台。改了只影响以后开的单，已经开的国补单不变。
      </Typography.Paragraph>
      <Table rowKey="categoryId" size="small" columns={columns} dataSource={rows} pagination={false} scroll={{ x: true }} />
      <Modal title={editing ? `${editing.categoryName}国补政策` : ""} open={!!editing} confirmLoading={pending} onOk={save} onCancel={() => setEditing(null)} destroyOnHidden>
        <Form form={form} layout="vertical" preserve={false}>
          <Space wrap size="large">
            <Form.Item name="ratePct" label="补贴比例（%）" rules={[{ required: true }]}>
              <InputNumber min={0.01} max={100} precision={2} style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="capYuan" label="单件封顶（元）" rules={[{ required: true }]}>
              <InputNumber min={1} precision={2} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="priceCapYuan" label="单价上限（元）" rules={[{ required: true }]}>
              <InputNumber min={1} precision={2} style={{ width: 140 }} />
            </Form.Item>
          </Space>
          <Space wrap size="large">
            <Form.Item name="startsOn" label="开始日期" rules={[{ required: true, pattern: /^\d{4}-\d{2}-\d{2}$/, message: "如 2026-01-01" }]}>
              <Input style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="endsOn" label="结束日期（含）" rules={[{ required: true, pattern: /^\d{4}-\d{2}-\d{2}$/, message: "如 2026-12-31" }]}>
              <Input style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="isActive" label="在用" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item name="note" label="备注">
            <Input maxLength={100} placeholder="如 2026 年数码产品购新补贴" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
