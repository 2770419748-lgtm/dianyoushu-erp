"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, Col, Form, Input, InputNumber, Modal, Row, Select, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import type { PaymentMethod } from "@/generated/prisma/enums";
import { formatFen, yuanToFen } from "@/lib/format";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS_FOR_SALE } from "@/lib/sales-labels";
import type { SellableAccessory, SellableDevice } from "@/server/sales/sales-service";
import { createCustomerAction, searchCustomersAction } from "../../customers/actions";
import { createSalesOrderAction, searchSellableDevicesAction } from "../actions";

interface Line {
  key: string;
  kind: "device" | "accessory";
  deviceId?: number;
  skuId: number;
  name: string;
  code?: string;
  qty: number;
  maxQty?: number;
  unitPriceFen: number;
  listPriceFen: number; // 门店售价/指导价，改价时参照
}

interface CustomerPick {
  id: number;
  name: string;
  phoneMasked: string;
}

// 开单第一版：选客户 → 选机器/加配件 → 改价优惠 → 一种收款方式 → 提交（一个事务扣库存）。
export function SaleForm({ stores, storeId, accessories }: { stores: { id: number; label: string }[]; storeId: number; accessories: SellableAccessory[] }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();

  const [customer, setCustomer] = useState<CustomerPick | null>(null);
  const [customerResults, setCustomerResults] = useState<CustomerPick[]>([]);
  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [customerForm] = Form.useForm<{ name: string; phone: string; note?: string }>();

  const [deviceResults, setDeviceResults] = useState<SellableDevice[]>([]);
  const [searching, setSearching] = useState(false);
  const [accessorySkuId, setAccessorySkuId] = useState<number | undefined>();
  const [accessoryQty, setAccessoryQty] = useState<number>(1);

  const [lines, setLines] = useState<Line[]>([]);
  const [discountYuan, setDiscountYuan] = useState<number>(0);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("WECHAT");
  const [note, setNote] = useState("");

  const subtotalFen = useMemo(() => lines.reduce((s, l) => s + l.unitPriceFen * l.qty, 0), [lines]);
  const discountFen = Math.min(yuanToFen(discountYuan) || 0, subtotalFen);
  const totalFen = subtotalFen - discountFen;

  async function searchCustomers(q: string) {
    if (!q.trim()) return setCustomerResults([]);
    setCustomerResults(await searchCustomersAction(q));
  }

  async function searchDevices(q: string) {
    setSearching(true);
    try {
      setDeviceResults(await searchSellableDevicesAction(storeId, q));
    } finally {
      setSearching(false);
    }
  }

  function addDevice(d: SellableDevice) {
    if (lines.some((l) => l.deviceId === d.id)) return;
    setLines([...lines, { key: `d-${d.id}`, kind: "device", deviceId: d.id, skuId: d.skuId, name: d.skuName, code: d.code, qty: 1, unitPriceFen: d.priceFen, listPriceFen: d.priceFen }]);
  }

  function addAccessory() {
    const a = accessories.find((x) => x.skuId === accessorySkuId);
    if (!a) return message.warning("先选配件");
    const qty = Math.max(1, Math.floor(accessoryQty || 1));
    const existing = lines.find((l) => l.kind === "accessory" && l.skuId === a.skuId);
    const nextQty = (existing?.qty ?? 0) + qty;
    if (nextQty > a.qty) return message.warning(`${a.name} 本店只有 ${a.qty} 件`);
    if (existing) setLines(lines.map((l) => (l === existing ? { ...l, qty: nextQty } : l)));
    else setLines([...lines, { key: `a-${a.skuId}`, kind: "accessory", skuId: a.skuId, name: a.name, qty, maxQty: a.qty, unitPriceFen: a.priceFen, listPriceFen: a.priceFen }]);
    setAccessoryQty(1);
  }

  function updateLine(key: string, patch: Partial<Line>) {
    setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function submit() {
    if (lines.length === 0) return message.warning("还没加商品");
    startTransition(async () => {
      const result = await createSalesOrderAction({
        storeId,
        customerId: customer?.id,
        items: lines.map((l) => (l.kind === "device" ? { deviceId: l.deviceId, unitPriceFen: l.unitPriceFen } : { skuId: l.skuId, qty: l.qty, unitPriceFen: l.unitPriceFen })),
        discountFen,
        paymentMethod,
        note,
      });
      if (!result.ok) {
        message.error(result.error);
        return;
      }
      message.success(`开单成功 ${result.orderNo}`);
      router.push(`/sales/${result.id}`);
    });
  }

  const lineColumns: TableColumnsType<Line> = [
    { title: "商品", dataIndex: "name" },
    { title: "机器 / 数量", render: (_, l) => (l.kind === "device" ? <Tag>{l.code}</Tag> : <InputNumber min={1} max={l.maxQty} precision={0} value={l.qty} style={{ width: 80 }} onChange={(v) => updateLine(l.key, { qty: Math.max(1, Math.floor(Number(v) || 1)) })} />) },
    {
      title: "单价（元）",
      render: (_, l) => (
        <Space size={4}>
          <InputNumber min={0} precision={2} value={l.unitPriceFen / 100} style={{ width: 120 }} onChange={(v) => updateLine(l.key, { unitPriceFen: yuanToFen(v ?? 0) || 0 })} />
          {l.unitPriceFen !== l.listPriceFen ? <Typography.Text type="secondary">原 {formatFen(l.listPriceFen)}</Typography.Text> : null}
        </Space>
      ),
    },
    { title: "小计（元）", align: "right", render: (_, l) => formatFen(l.unitPriceFen * l.qty) },
    { title: "", width: 50, render: (_, l) => <Button type="link" danger onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>删</Button> },
  ];

  const deviceColumns: TableColumnsType<SellableDevice> = [
    { title: "主码", dataIndex: "code" },
    { title: "商品", dataIndex: "skuName" },
    { title: "售价（元）", dataIndex: "priceFen", align: "right", render: (v: number) => formatFen(v) },
    { title: "", width: 70, render: (_, d) => <Button size="small" type="link" disabled={lines.some((l) => l.deviceId === d.id)} onClick={() => addDevice(d)}>加入</Button> },
  ];

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={14}>
        <Card title="开单" extra={<Select value={storeId} style={{ width: 200 }} showSearch optionFilterProp="label" options={stores.map((s) => ({ value: s.id, label: s.label }))} onChange={(v) => router.push(`/sales/new?storeId=${v}`)} disabled={stores.length === 1} />}>
          <Typography.Title level={5}>客户</Typography.Title>
          {customer ? (
            <Space style={{ marginBottom: 16 }}>
              <Tag color="blue">{customer.name} {customer.phoneMasked}</Tag>
              <Button size="small" onClick={() => setCustomer(null)}>换一个</Button>
            </Space>
          ) : (
            <Space orientation="vertical" style={{ width: "100%", marginBottom: 16 }}>
              <Space>
                <Input.Search placeholder="输手机号或姓名找客户" style={{ width: 280 }} onSearch={searchCustomers} allowClear />
                <Button onClick={() => { customerForm.resetFields(); setCustomerModalOpen(true); }}>新客户</Button>
                <Typography.Text type="secondary">不选就是散客</Typography.Text>
              </Space>
              {customerResults.length > 0 ? (
                <Space wrap>
                  {customerResults.map((c) => (
                    <Button key={c.id} size="small" onClick={() => { setCustomer(c); setCustomerResults([]); }}>{c.name} {c.phoneMasked}</Button>
                  ))}
                </Space>
              ) : null}
            </Space>
          )}

          <Typography.Title level={5}>机器</Typography.Title>
          <Input.Search placeholder="输串号、SN 或型号搜本店在库机器" style={{ width: 320, marginBottom: 8 }} loading={searching} onSearch={searchDevices} enterButton="搜" />
          {deviceResults.length > 0 ? <Table rowKey="id" size="small" pagination={{ pageSize: 5, showSizeChanger: false }} columns={deviceColumns} dataSource={deviceResults} /> : null}

          <Typography.Title level={5} style={{ marginTop: 16 }}>配件</Typography.Title>
          <Space wrap>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选配件"
              style={{ width: 320 }}
              value={accessorySkuId}
              onChange={setAccessorySkuId}
              options={accessories.map((a) => ({ value: a.skuId, label: `${a.name}（${formatFen(a.priceFen)} 元，有 ${a.qty}）` }))}
            />
            <InputNumber min={1} precision={0} value={accessoryQty} onChange={(v) => setAccessoryQty(Number(v) || 1)} style={{ width: 80 }} />
            <Button onClick={addAccessory}>加入</Button>
          </Space>
        </Card>
      </Col>
      <Col xs={24} lg={10}>
        <Card title={`本单（${lines.length} 行）`}>
          <Table rowKey="key" size="small" pagination={false} columns={lineColumns} dataSource={lines} scroll={{ x: true }} />
          <Space orientation="vertical" style={{ width: "100%", marginTop: 16 }} size="middle">
            <Space>
              <span>商品合计</span>
              <Typography.Text strong>{formatFen(subtotalFen)} 元</Typography.Text>
            </Space>
            <Space>
              <span>整单优惠（元）</span>
              <InputNumber min={0} precision={2} value={discountYuan} onChange={(v) => setDiscountYuan(Number(v) || 0)} style={{ width: 140 }} />
            </Space>
            <Space>
              <span>应收</span>
              <Typography.Title level={4} style={{ margin: 0 }}>{formatFen(totalFen)} 元</Typography.Title>
            </Space>
            <Space>
              <span>收款方式</span>
              <Select value={paymentMethod} style={{ width: 160 }} onChange={setPaymentMethod} options={PAYMENT_METHODS_FOR_SALE.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m] }))} />
              <Typography.Text type="secondary">实收 {formatFen(totalFen)} 元</Typography.Text>
            </Space>
            <Input placeholder="备注" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
            <Button type="primary" size="large" block loading={pending} onClick={submit} disabled={lines.length === 0}>
              提交开单
            </Button>
            <Typography.Text type="secondary">提交后机器变已售、配件减数量，都在库存流水里有记录；作废要店长。</Typography.Text>
          </Space>
        </Card>
      </Col>

      <Modal title="新建客户" open={customerModalOpen} confirmLoading={pending} onCancel={() => setCustomerModalOpen(false)} onOk={() => customerForm.submit()} destroyOnHidden>
        <Form
          form={customerForm}
          name="sale-customer"
          layout="vertical"
          onFinish={(values) =>
            startTransition(async () => {
              const result = await createCustomerAction(values);
              if (!result.ok) {
                message.error(result.error);
                return;
              }
              if (result.customer) setCustomer(result.customer);
              setCustomerModalOpen(false);
            })
          }
        >
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: "请填姓名" }]}>
            <Input maxLength={30} />
          </Form.Item>
          <Form.Item name="phone" label="手机号" rules={[{ required: true, pattern: /^1\d{10}$/, message: "手机号要 11 位，1 开头" }]}>
            <Input maxLength={11} inputMode="numeric" />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input maxLength={200} />
          </Form.Item>
        </Form>
      </Modal>
    </Row>
  );
}
