"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Card, Form, Input, Modal, Select, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { CARRIER_LABELS, CARRIERS, type CarrierKey } from "@/lib/carrier";
import { formatDateTime, formatFen } from "@/lib/format";
import { importSettlementAction, simulateSettlementAction, type CarrierActionResult } from "../actions";
import { CarrierNav } from "../carrier-nav";

type Row = {
  id: number;
  settlementNo: string;
  carrier: CarrierKey;
  month: string;
  source: "FILE" | "SIMULATED";
  importedBy: string;
  createdAt: Date;
  lineCount: number;
  matchedCount: number;
  diffCount: number;
  unmatchedCount: number;
  missingCount: number;
  totalCommissionFen: number;
  totalClawbackFen: number;
};

const SAMPLE = "受理单号,办理号码,业务类型,佣金（元）,返销（元）\nCM20260901001,13800001111,新号入网,80.00,0\n,13900002222,宽带,120.00,0";

export function SettlementsView({ rows, defaultMonth, canSimulate }: { rows: Row[]; defaultMonth: string; canSimulate: boolean }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ carrier: CarrierKey; month: string; csv: string }>();
  const [simCarrier, setSimCarrier] = useState<CarrierKey>("CMCC");
  const [simMonth, setSimMonth] = useState(defaultMonth);

  function done(result: CarrierActionResult) {
    if (!result.ok) return void message.error(result.error);
    message.success(result.message ?? "已完成");
    setOpen(false);
    if (result.id) router.push(`/carrier/settlements/${result.id}`);
    else router.refresh();
  }

  async function readFile(file: File) {
    // 运营商渠道系统导出的 CSV 常见是 GBK 编码：先按 UTF-8 读，读出乱码再按 GBK 读
    const buffer = await file.arrayBuffer();
    let content = new TextDecoder("utf-8").decode(buffer);
    if (content.includes("�")) content = new TextDecoder("gbk").decode(buffer);
    form.setFieldValue("csv", content);
  }

  const columns: TableColumnsType<Row> = [
    { title: "结算单号", dataIndex: "settlementNo", render: (v: string, r) => <Link href={`/carrier/settlements/${r.id}`}>{v}</Link> },
    { title: "运营商", dataIndex: "carrier", render: (v: CarrierKey) => CARRIER_LABELS[v] },
    { title: "月份", dataIndex: "month" },
    { title: "来源", dataIndex: "source", render: (v: Row["source"]) => (v === "FILE" ? <Tag>导入文件</Tag> : <Tag color="purple">模拟</Tag>) },
    { title: "行数", dataIndex: "lineCount", align: "right" },
    { title: "对上", dataIndex: "matchedCount", align: "right" },
    { title: "金额不符", dataIndex: "diffCount", align: "right", render: (v: number) => (v ? <Typography.Text type="warning">{v}</Typography.Text> : 0) },
    { title: "我们没登记", dataIndex: "unmatchedCount", align: "right", render: (v: number) => (v ? <Typography.Text type="warning">{v}</Typography.Text> : 0) },
    { title: "运营商漏给", dataIndex: "missingCount", align: "right", render: (v: number) => (v ? <Typography.Text type="danger">{v}</Typography.Text> : 0) },
    { title: "佣金（元）", dataIndex: "totalCommissionFen", align: "right", render: (v: number) => formatFen(v) },
    { title: "扣回（元）", dataIndex: "totalClawbackFen", align: "right", render: (v: number) => (v ? <Typography.Text type="danger">{formatFen(v)}</Typography.Text> : "0.00") },
    { title: "导入", render: (_, r) => `${r.importedBy} ${formatDateTime(r.createdAt)}` },
  ];

  return (
    <Card
      title="运营商结算对账"
      extra={
        <Button type="primary" onClick={() => { form.resetFields(); setOpen(true); }}>
          导入结算单
        </Button>
      }
    >
      <CarrierNav current="settlements" isHq />
      <Typography.Paragraph type="secondary">
        每月初在运营商渠道系统导出上个月的佣金结算单，导进来自动对账：先按受理单号对，没有受理单号的按“号码 + 业务类型”对。一个运营商一个月只对一次，对完的业务记“已结算”，被扣回的记“已返销”。
      </Typography.Paragraph>
      {canSimulate ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          title="演示：没有真的运营商结算单，可以按已开通的业务生成一张模拟结算单（会故意带几笔少给、漏给、扣回和一笔我们没登记的）"
          action={
            <Space wrap>
              <Select<CarrierKey> value={simCarrier} style={{ width: 110 }} options={CARRIERS.map((c) => ({ value: c, label: CARRIER_LABELS[c] }))} onChange={setSimCarrier} />
              <Input value={simMonth} style={{ width: 100 }} onChange={(e) => setSimMonth(e.target.value.trim())} />
              <Button loading={pending} onClick={() => startTransition(async () => done(await simulateSettlementAction({ carrier: simCarrier, month: simMonth })))}>
                生成模拟结算单
              </Button>
            </Space>
          }
        />
      ) : null}
      <Table rowKey="id" size="small" columns={columns} dataSource={rows} scroll={{ x: 1200 }} locale={{ emptyText: "还没有导入过结算单" }} pagination={{ pageSize: 20, hideOnSinglePage: true }} />
      <Modal
        title="导入运营商结算单"
        open={open}
        width={680}
        confirmLoading={pending}
        okText="导入并对账"
        onCancel={() => setOpen(false)}
        onOk={() => form.validateFields().then((v) => startTransition(async () => done(await importSettlementAction(v))))}
      >
        <Form form={form} layout="vertical" initialValues={{ carrier: "CMCC", month: defaultMonth, csv: "" }}>
          <Space wrap size="large">
            <Form.Item name="carrier" label="运营商" rules={[{ required: true }]}>
              <Select style={{ width: 140 }} options={CARRIERS.map((c) => ({ value: c, label: CARRIER_LABELS[c] }))} />
            </Form.Item>
            <Form.Item name="month" label="结算月份" rules={[{ required: true, pattern: /^\d{4}-\d{2}$/, message: "如 2026-09" }]} extra="只能是已经过完的月份">
              <Input style={{ width: 120 }} />
            </Form.Item>
          </Space>
          <Form.Item label="选文件（CSV）">
            <input type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); }} />
          </Form.Item>
          <Form.Item name="csv" label="或者把内容粘贴到这里" rules={[{ required: true, message: "选一个文件或粘贴内容" }]} extra="第一行是表头，要有“佣金”，以及“受理单号”或“办理号码”；“业务类型”“返销”可以没有。金额单位是元。">
            <Input.TextArea rows={8} placeholder={SAMPLE} style={{ fontFamily: "monospace" }} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
