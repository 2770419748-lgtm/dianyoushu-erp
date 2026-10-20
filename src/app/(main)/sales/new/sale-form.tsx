"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, Col, Form, Input, InputNumber, Modal, Row, Select, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import type { PaymentMethod } from "@/generated/prisma/enums";
import { ScanButton } from "@/components/scan-button";
import { formatFen, yuanToFen } from "@/lib/format";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS_FOR_SALE } from "@/lib/sales-labels";
import type { SellableAccessory, SellableDevice, SellableService } from "@/server/sales/sales-service";
import type { AvailableTradeIn } from "@/server/tradein/trade-in-service";
import { createCustomerAction, searchCustomersAction } from "../../customers/actions";
import { TradeInForm, type CreatedTradeIn, type TradeInSkuOption } from "../../trade-ins/trade-in-form";
import { createSalesOrderAction, lookupForSaleAction, searchSellableDevicesAction } from "../actions";

interface Line {
  key: string;
  kind: "device" | "accessory" | "service";
  serviceDeviceId?: number; // 服务行：保本单哪台机器
  deviceId?: number;
  skuId: number;
  name: string;
  code?: string;
  qty: number;
  maxQty?: number;
  unitPriceFen: number;
  listPriceFen: number; // 门店售价/指导价，改价时参照
}

interface PaymentRow {
  key: number;
  method: PaymentMethod;
  amountYuan: number | null;
}

interface TradeInPick {
  id: number;
  orderNo: string;
  modelName: string;
  deviceCode: string;
  appraisedFen: number;
}

interface CustomerPick {
  id: number;
  name: string;
  phoneMasked: string;
}

// 开单：选客户 → 选机器/加配件/加服务 → 改价优惠 → 以旧换新抵扣（可选）→ 多种收款拆分 → 提交（一个事务扣库存）。
// 服务（碎屏险、延保）不扣库存，记在客户名下，所以要先选客户；一行一份，选保本单哪台机器。
export function SaleForm({
  stores,
  storeId,
  accessories,
  services,
  availableTradeIns,
  tradeInSkuOptions,
}: {
  stores: { id: number; label: string }[];
  storeId: number;
  accessories: SellableAccessory[];
  services: SellableService[];
  availableTradeIns: AvailableTradeIn[];
  tradeInSkuOptions: TradeInSkuOption[];
}) {
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
  const [serviceSkuId, setServiceSkuId] = useState<number | undefined>();
  const [serviceDeviceId, setServiceDeviceId] = useState<number | undefined>();

  const [lines, setLines] = useState<Line[]>([]);
  const [discountYuan, setDiscountYuan] = useState<number>(0);
  const [payments, setPayments] = useState<PaymentRow[]>([{ key: 1, method: "WECHAT", amountYuan: null }]);
  const [note, setNote] = useState("");

  const [tradeIn, setTradeIn] = useState<TradeInPick | null>(null);
  const [tradeInOptions, setTradeInOptions] = useState<TradeInPick[]>(availableTradeIns);
  const [tradeInModalOpen, setTradeInModalOpen] = useState(false);

  const subtotalFen = useMemo(() => lines.reduce((s, l) => s + l.unitPriceFen * l.qty, 0), [lines]);
  const typedDiscountFen = yuanToFen(discountYuan) || 0;
  const discountFen = Math.min(typedDiscountFen, subtotalFen); // 超过合计按合计算，下面会提示
  const totalFen = subtotalFen - discountFen;
  const tradeInFen = tradeIn?.appraisedFen ?? 0;
  const needFen = totalFen - tradeInFen; // 抵扣之后还要客户付的
  // 只有一行收款且没填金额时，默认收剩下的全部
  const paymentFen = (row: PaymentRow) => (row.amountYuan === null ? (payments.length === 1 ? Math.max(needFen, 0) : 0) : yuanToFen(row.amountYuan) || 0);
  const paidFen = payments.reduce((s, p) => s + paymentFen(p), 0);
  const gapFen = needFen - paidFen; // 正数 = 还差，负数 = 多收

  function onTradeInCreated(t: CreatedTradeIn) {
    const pick = { id: t.id, orderNo: t.orderNo, modelName: t.modelName, deviceCode: t.deviceCode, appraisedFen: t.appraisedFen };
    setTradeInOptions([pick, ...tradeInOptions]);
    setTradeIn(pick);
    setTradeInModalOpen(false);
  }

  function updatePayment(key: number, patch: Partial<PaymentRow>) {
    setPayments(payments.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  }

  /** 把这一行改成"剩下没收的全部" */
  function fillPayment(key: number) {
    const others = payments.filter((p) => p.key !== key).reduce((s, p) => s + paymentFen(p), 0);
    updatePayment(key, { amountYuan: Math.max(needFen - others, 0) / 100 });
  }

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

  // 扫码加商品：机器按串号、配件按商品条码，和手机开单同一个查找逻辑
  async function addScanned(code: string) {
    let found;
    try {
      found = await lookupForSaleAction(storeId, code);
    } catch {
      return void message.error("网络不通，这个码没查到，检查网络后再扫一次");
    }
    if (found.kind === "error") return void message.warning(found.message);
    if (found.kind === "device") {
      setLines((prev) =>
        prev.some((l) => l.deviceId === found.deviceId)
          ? prev
          : [...prev, { key: `d-${found.deviceId}`, kind: "device", deviceId: found.deviceId, skuId: found.skuId, name: found.name, code: found.code, qty: 1, unitPriceFen: found.priceFen, listPriceFen: found.priceFen }],
      );
      return;
    }
    setLines((prev) => {
      const existing = prev.find((l) => l.kind === "accessory" && l.skuId === found.skuId);
      if (existing) return existing.qty >= found.stockQty ? prev : prev.map((l) => (l === existing ? { ...l, qty: l.qty + 1 } : l));
      return [...prev, { key: `a-${found.skuId}`, kind: "accessory", skuId: found.skuId, name: found.name, qty: 1, maxQty: found.stockQty, unitPriceFen: found.priceFen, listPriceFen: found.priceFen }];
    });
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

  const deviceLines = lines.filter((l) => l.kind === "device");

  function addService() {
    const sv = services.find((s) => s.skuId === serviceSkuId);
    if (!sv) return message.warning("先选服务");
    // 本单只有一台机器时默认保它；有好几台要店员选
    const deviceId = serviceDeviceId ?? (deviceLines.length === 1 ? deviceLines[0]!.deviceId : undefined);
    if (deviceLines.length > 1 && deviceId === undefined) return message.warning("本单有好几台机器，选一下这份服务保哪台");
    const device = deviceLines.find((l) => l.deviceId === deviceId);
    const key = `s-${sv.skuId}-${deviceId ?? 0}`;
    if (lines.some((l) => l.key === key)) return message.warning(`这台机器已经加过 ${sv.name}`);
    setLines([...lines, { key, kind: "service", skuId: sv.skuId, name: sv.name, code: device?.code, serviceDeviceId: deviceId, qty: 1, unitPriceFen: sv.priceFen, listPriceFen: sv.priceFen }]);
    setServiceSkuId(undefined);
    setServiceDeviceId(undefined);
  }

  /** 删机器时，保这台机器的服务一起删掉（服务只能保本单的机器） */
  function removeLine(line: Line) {
    const attached = line.kind === "device" ? lines.filter((l) => l.kind === "service" && l.serviceDeviceId === line.deviceId) : [];
    if (attached.length > 0) message.info(`保这台机器的 ${attached.map((l) => l.name).join("、")} 也一起删了`);
    setLines(lines.filter((x) => x.key !== line.key && !attached.includes(x)));
  }

  function updateLine(key: string, patch: Partial<Line>) {
    setLines(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function submit() {
    if (lines.length === 0) return message.warning("还没加商品");
    if (lines.some((l) => l.kind === "service") && !customer && !tradeIn) return message.warning("单里有碎屏险、延保这类服务，要先选客户（服务记在客户名下，到期要提醒）");
    startTransition(async () => {
      const result = await createSalesOrderAction({
        storeId,
        customerId: customer?.id,
        items: lines.map((l) =>
          l.kind === "device"
            ? { deviceId: l.deviceId, unitPriceFen: l.unitPriceFen }
            : l.kind === "service"
              ? { skuId: l.skuId, qty: 1, unitPriceFen: l.unitPriceFen, serviceDeviceId: l.serviceDeviceId }
              : { skuId: l.skuId, qty: l.qty, unitPriceFen: l.unitPriceFen },
        ),
        discountFen,
        tradeInOrderId: tradeIn?.id,
        payments: payments.map((p) => ({ method: p.method, amountFen: paymentFen(p) })),
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
    { title: "机器 / 数量", render: (_, l) => (l.kind === "device" ? <Tag>{l.code}</Tag> : l.kind === "service" ? <Tag color="purple">{l.code ? `保 ${l.code}` : "不绑机器"}</Tag> : <InputNumber min={1} max={l.maxQty} precision={0} value={l.qty} style={{ width: 80 }} onChange={(v) => updateLine(l.key, { qty: Math.max(1, Math.floor(Number(v) || 1)) })} />) },
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
    { title: "", width: 50, render: (_, l) => <Button type="link" danger onClick={() => removeLine(l)}>删</Button> },
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
        <Card title="开单" extra={<Select value={storeId} style={{ width: "min(200px, 45vw)" }} showSearch optionFilterProp="label" options={stores.map((s) => ({ value: s.id, label: s.label }))} onChange={(v) => router.push(`/sales/new?storeId=${v}`)} disabled={stores.length === 1} />}>
          <Typography.Title level={5}>客户</Typography.Title>
          {customer ? (
            <Space style={{ marginBottom: 16 }}>
              <Tag color="blue">{customer.name} {customer.phoneMasked}</Tag>
              <Button size="small" onClick={() => setCustomer(null)}>换一个</Button>
            </Space>
          ) : (
            <Space orientation="vertical" style={{ width: "100%", marginBottom: 16 }}>
              <Space>
                <Input.Search placeholder="输手机号（至少 4 位）或姓名找客户" style={{ width: "min(280px, 100%)" }} onSearch={searchCustomers} allowClear />
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
          <Space wrap style={{ marginBottom: 8 }}>
            <Input.Search placeholder="输串号、SN 或型号搜本店在库机器" style={{ width: "min(320px, calc(100vw - 72px))" }} loading={searching} onSearch={searchDevices} enterButton="搜" />
            <ScanButton continuous label="扫码加商品" onCode={(c) => void addScanned(c)} />
          </Space>
          {deviceResults.length > 0 ? <Table rowKey="id" size="small" pagination={{ pageSize: 5, showSizeChanger: false }} columns={deviceColumns} dataSource={deviceResults} /> : null}

          <Typography.Title level={5} style={{ marginTop: 16 }}>配件</Typography.Title>
          <Space wrap>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选配件"
              style={{ width: "min(320px, calc(100vw - 72px))" }}
              value={accessorySkuId}
              onChange={setAccessorySkuId}
              options={accessories.map((a) => ({ value: a.skuId, label: `${a.name}（${formatFen(a.priceFen)} 元，有 ${a.qty}）` }))}
            />
            <InputNumber min={1} precision={0} value={accessoryQty} onChange={(v) => setAccessoryQty(Number(v) || 1)} style={{ width: 80 }} />
            <Button onClick={addAccessory}>加入</Button>
          </Space>

          {services.length > 0 ? (
            <>
              <Typography.Title level={5} style={{ marginTop: 16 }}>服务（碎屏险、延保）</Typography.Title>
              <Space wrap>
                <Select
                  placeholder="选服务"
                  style={{ width: "min(260px, calc(100vw - 72px))" }}
                  value={serviceSkuId}
                  onChange={setServiceSkuId}
                  options={services.map((s) => ({ value: s.skuId, label: `${s.name}（${formatFen(s.priceFen)} 元，${s.months} 个月）` }))}
                />
                <Select
                  allowClear
                  placeholder={deviceLines.length === 0 ? "本单没有机器，不绑机器" : deviceLines.length === 1 ? `保 ${deviceLines[0]!.code}` : "保哪台机器"}
                  style={{ width: "min(260px, calc(100vw - 72px))" }}
                  value={serviceDeviceId}
                  onChange={setServiceDeviceId}
                  disabled={deviceLines.length === 0}
                  options={deviceLines.map((l) => ({ value: l.deviceId, label: `${l.code} ${l.name}` }))}
                />
                <Button onClick={addService}>加服务</Button>
              </Space>
              <Typography.Paragraph type="secondary" style={{ marginTop: 4, marginBottom: 0 }}>
                服务不扣库存，记在客户名下，到期前会进到期名单提醒，所以要先选客户；一台机器一份。
              </Typography.Paragraph>
            </>
          ) : null}
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
              {typedDiscountFen > subtotalFen ? <Typography.Text type="warning">优惠超过了商品合计，按 {formatFen(subtotalFen)} 元算</Typography.Text> : null}
            </Space>
            <Space>
              <span>应收</span>
              <Typography.Title level={4} style={{ margin: 0 }}>{formatFen(totalFen)} 元</Typography.Title>
            </Space>
            <Card size="small" title="以旧换新" extra={<Button size="small" onClick={() => setTradeInModalOpen(true)}>现场收旧机</Button>}>
              <Select
                allowClear
                placeholder="不用就留空；选一张本店未用的回收单抵扣"
                style={{ width: "100%" }}
                value={tradeIn?.id}
                onChange={(id) => setTradeIn(tradeInOptions.find((t) => t.id === id) ?? null)}
                options={tradeInOptions.map((t) => ({ value: t.id, label: `${t.orderNo} · ${t.modelName} · 抵 ${formatFen(t.appraisedFen)} 元` }))}
              />
              {tradeIn ? (
                <Typography.Text type={tradeInFen > totalFen ? "danger" : "secondary"} style={{ display: "block", marginTop: 8 }}>
                  抵扣 {formatFen(tradeInFen)} 元{tradeInFen > totalFen ? "，超过应收了，换一张或加商品" : ""}
                </Typography.Text>
              ) : null}
            </Card>
            <Card size="small" title={`收款（还要付 ${formatFen(Math.max(needFen, 0))} 元）`}>
              <Space orientation="vertical" style={{ width: "100%" }}>
                {payments.map((p) => (
                  <Space key={p.key} wrap>
                    <Select
                      value={p.method}
                      style={{ width: 120 }}
                      onChange={(m) => updatePayment(p.key, { method: m })}
                      options={PAYMENT_METHODS_FOR_SALE.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m], disabled: payments.some((x) => x.key !== p.key && x.method === m) }))}
                    />
                    <InputNumber
                      min={0}
                      precision={2}
                      style={{ width: 130 }}
                      placeholder={payments.length === 1 ? (Math.max(needFen, 0) / 100).toFixed(2) : "0.00"}
                      value={p.amountYuan}
                      onChange={(v) => updatePayment(p.key, { amountYuan: v === null ? null : Number(v) })}
                    />
                    <Button size="small" onClick={() => fillPayment(p.key)}>
                      补齐
                    </Button>
                    {payments.length > 1 ? (
                      <Button size="small" type="link" danger onClick={() => setPayments(payments.filter((x) => x.key !== p.key))}>
                        删
                      </Button>
                    ) : null}
                  </Space>
                ))}
                <Space wrap>
                  <Button
                    size="small"
                    disabled={payments.length >= PAYMENT_METHODS_FOR_SALE.length}
                    onClick={() => {
                      const used = new Set(payments.map((x) => x.method));
                      const method = PAYMENT_METHODS_FOR_SALE.find((m) => !used.has(m))!;
                      setPayments([...payments.map((x) => (x.amountYuan === null ? { ...x, amountYuan: paymentFen(x) / 100 } : x)), { key: Date.now(), method, amountYuan: null }]);
                    }}
                  >
                    再加一种收款
                  </Button>
                  {gapFen === 0 ? <Tag color="green">收款已对上</Tag> : <Tag color="red">{gapFen > 0 ? `还差 ${formatFen(gapFen)} 元` : `多收 ${formatFen(-gapFen)} 元`}</Tag>}
                </Space>
              </Space>
            </Card>
            <Input placeholder="备注" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
            <Button type="primary" size="large" block loading={pending} onClick={submit} disabled={lines.length === 0 || gapFen !== 0 || tradeInFen > totalFen}>
              提交开单
            </Button>
            <Typography.Text type="secondary">提交后机器变已售、配件减数量，都在库存流水里有记录；作废要店长。</Typography.Text>
          </Space>
        </Card>
      </Col>

      <Modal title="以旧换新：现场收旧机" open={tradeInModalOpen} onCancel={() => setTradeInModalOpen(false)} footer={null} destroyOnHidden width={640}>
        <TradeInForm storeId={storeId} customerId={customer?.id} skuOptions={tradeInSkuOptions} onCreated={onTradeInCreated} submitText="收下旧机并用来抵扣" />
      </Modal>

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
