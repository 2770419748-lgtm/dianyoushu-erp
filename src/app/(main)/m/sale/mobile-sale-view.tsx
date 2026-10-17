"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Button, Card, Input, InputNumber, Modal, Radio, Result, Select, Space, Tag, Typography } from "antd";
import type { InputRef } from "antd";
import type { PaymentMethod } from "@/generated/prisma/enums";
import { ScanButton } from "@/components/scan-button";
import { formatFen, yuanToFen } from "@/lib/format";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS_FOR_SALE } from "@/lib/sales-labels";
import type { AvailableTradeIn } from "@/server/tradein/trade-in-service";
import { searchCustomersAction } from "../../customers/actions";
import { TradeInForm, type CreatedTradeIn, type TradeInSkuOption } from "../../trade-ins/trade-in-form";
import { createSalesOrderAction, lookupForSaleAction } from "../../sales/actions";

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
  listPriceFen: number;
}

interface TradeInPick {
  id: number;
  orderNo: string;
  modelName: string;
  appraisedFen: number;
}

interface CustomerPick {
  id: number;
  name: string;
  phoneMasked: string;
}

const BIG = { height: 48, fontSize: 16 };

// 手机开单：扫码 / 输码加商品 → 改价（可选）→ 客户、旧机抵扣（可选）→ 点一种收款方式 → 底部一键提交。
// 下单走的是和电脑版同一个 createSalesOrderAction，扣库存、写流水、记支付的规则完全一样。
export function MobileSaleView({
  stores,
  storeId,
  availableTradeIns,
  tradeInSkuOptions,
}: {
  stores: { id: number; label: string }[];
  storeId: number;
  availableTradeIns: AvailableTradeIn[];
  tradeInSkuOptions: TradeInSkuOption[];
}) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [looking, setLooking] = useState(false);
  const inputRef = useRef<InputRef>(null);
  const linesRef = useRef<Line[]>([]); // 连续扫码时回调里拿最新的单子（state 闭包会是旧的）

  const [code, setCode] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [customer, setCustomer] = useState<CustomerPick | null>(null);
  const [customerResults, setCustomerResults] = useState<CustomerPick[]>([]);
  const [tradeIn, setTradeIn] = useState<TradeInPick | null>(null);
  const [tradeInOptions, setTradeInOptions] = useState<TradeInPick[]>(availableTradeIns);
  const [tradeInModalOpen, setTradeInModalOpen] = useState(false);
  const [method, setMethod] = useState<PaymentMethod>("WECHAT");
  const [done, setDone] = useState<{ id: number; orderNo: string; totalFen: number } | null>(null);

  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);
  const totalFen = lines.reduce((s, l) => s + l.unitPriceFen * l.qty, 0);
  const tradeInFen = tradeIn?.appraisedFen ?? 0;
  const needFen = totalFen - tradeInFen;
  const itemCount = lines.reduce((s, l) => s + l.qty, 0);

  // 扫码和回车走同一个入口：机器一台一行，同一个配件再扫一次数量加 1
  async function addByCode(raw: string) {
    const value = raw.trim();
    if (!value) return;
    setLooking(true);
    try {
      const found = await lookupForSaleAction(storeId, value);
      if (found.kind === "error") {
        message.warning(found.message);
        return;
      }
      const current = linesRef.current;
      if (found.kind === "device") {
        if (current.some((l) => l.deviceId === found.deviceId)) {
          message.info("这台已经在单子里了");
        } else {
          const line: Line = { key: `d-${found.deviceId}`, kind: "device", deviceId: found.deviceId, skuId: found.skuId, name: found.name, code: found.code, qty: 1, unitPriceFen: found.priceFen, listPriceFen: found.priceFen };
          linesRef.current = [...current, line];
          setLines(linesRef.current);
        }
      } else {
        const existing = current.find((l) => l.kind === "accessory" && l.skuId === found.skuId);
        if (existing && existing.qty >= found.stockQty) {
          message.warning(`${found.name} 本店只有 ${found.stockQty} 件`);
        } else {
          linesRef.current = existing
            ? current.map((l) => (l === existing ? { ...l, qty: l.qty + 1, maxQty: found.stockQty } : l))
            : [...current, { key: `a-${found.skuId}`, kind: "accessory", skuId: found.skuId, name: found.name, qty: 1, maxQty: found.stockQty, unitPriceFen: found.priceFen, listPriceFen: found.priceFen }];
          setLines(linesRef.current);
        }
      }
      setCode("");
    } finally {
      setLooking(false);
    }
  }

  function updateLine(key: string, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function onTradeInCreated(t: CreatedTradeIn) {
    const pick = { id: t.id, orderNo: t.orderNo, modelName: t.modelName, appraisedFen: t.appraisedFen };
    setTradeInOptions((prev) => [pick, ...prev]);
    setTradeIn(pick);
    setTradeInModalOpen(false);
  }

  function reset() {
    setLines([]);
    setCustomer(null);
    setTradeIn(null);
    setMethod("WECHAT");
    setDone(null);
    router.refresh(); // 重新取一遍本店未用的回收单
  }

  function submit() {
    if (lines.length === 0) return message.warning("还没加商品");
    startTransition(async () => {
      const result = await createSalesOrderAction({
        storeId,
        customerId: customer?.id,
        items: lines.map((l) => (l.kind === "device" ? { deviceId: l.deviceId, unitPriceFen: l.unitPriceFen } : { skuId: l.skuId, qty: l.qty, unitPriceFen: l.unitPriceFen })),
        tradeInOrderId: tradeIn?.id,
        paymentMethod: method,
      });
      if (!result.ok) {
        message.error(result.error);
        return;
      }
      if (tradeIn) setTradeInOptions((prev) => prev.filter((t) => t.id !== tradeIn.id));
      setDone({ id: result.id!, orderNo: result.orderNo!, totalFen: Math.max(needFen, 0) });
    });
  }

  if (done) {
    return (
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <Card>
          <Result
            status="success"
            title={`开单成功，${PAYMENT_METHOD_LABELS[method]}收 ${formatFen(done.totalFen)} 元`}
            subTitle={done.orderNo}
            extra={
              <Space orientation="vertical" style={{ width: "100%" }}>
                <Button type="primary" block style={BIG} onClick={reset}>
                  再开一单
                </Button>
                <Link href={`/sales/${done.id}`}>
                  <Button block style={BIG}>
                    看这张单
                  </Button>
                </Link>
              </Space>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", paddingBottom: 96 }}>
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        {stores.length > 1 ? (
          <Select value={storeId} style={{ width: "100%" }} size="large" showSearch optionFilterProp="label" options={stores.map((s) => ({ value: s.id, label: s.label }))} onChange={(v) => router.push(`/m/sale?storeId=${v}`)} />
        ) : (
          <Typography.Text type="secondary">{stores[0]!.label}</Typography.Text>
        )}

        <ScanButton size="large" block label="扫码加商品" continuous onCode={(c) => void addByCode(c)} />
        <Space.Compact style={{ width: "100%" }}>
          <Input
            ref={inputRef}
            size="large"
            placeholder="或输入串号 / 配件条码，回车"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onPressEnter={() => void addByCode(code)}
            allowClear
          />
          <Button size="large" loading={looking} onClick={() => void addByCode(code)}>
            加入
          </Button>
        </Space.Compact>

        {lines.length === 0 ? (
          <Card size="small">
            <Typography.Text type="secondary">机器扫串号（SN、IMEI1、IMEI2 哪个都行），配件扫商品条码；同一个配件多扫一次就多一件。</Typography.Text>
          </Card>
        ) : (
          lines.map((l) => (
            <Card key={l.key} size="small" styles={{ body: { padding: 12 } }}>
              <Space orientation="vertical" size={6} style={{ width: "100%" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <Typography.Text strong>{l.name}</Typography.Text>
                  <Button type="link" danger size="small" onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}>
                    删
                  </Button>
                </div>
                {l.code ? <Tag style={{ alignSelf: "flex-start" }}>{l.code}</Tag> : null}
                <Space wrap>
                  <InputNumber
                    size="large"
                    min={0}
                    precision={2}
                    prefix="¥"
                    inputMode="decimal"
                    value={l.unitPriceFen / 100}
                    style={{ width: 150 }}
                    onChange={(v) => updateLine(l.key, { unitPriceFen: yuanToFen(v ?? 0) || 0 })}
                  />
                  {l.kind === "accessory" ? (
                    <Space.Compact>
                      <Button size="large" disabled={l.qty <= 1} onClick={() => updateLine(l.key, { qty: l.qty - 1 })}>
                        −
                      </Button>
                      <Button size="large" tabIndex={-1} style={{ pointerEvents: "none", minWidth: 48 }}>
                        {l.qty}
                      </Button>
                      <Button size="large" disabled={l.qty >= (l.maxQty ?? Infinity)} onClick={() => updateLine(l.key, { qty: l.qty + 1 })}>
                        +
                      </Button>
                    </Space.Compact>
                  ) : null}
                  {l.unitPriceFen !== l.listPriceFen ? <Typography.Text type="secondary">原价 {formatFen(l.listPriceFen)}</Typography.Text> : null}
                </Space>
              </Space>
            </Card>
          ))
        )}

        <Card size="small" title="客户（可不填，不填算散客）">
          {customer ? (
            <Space>
              <Tag color="blue">
                {customer.name} {customer.phoneMasked}
              </Tag>
              <Button size="small" onClick={() => setCustomer(null)}>
                换一个
              </Button>
            </Space>
          ) : (
            <Space orientation="vertical" style={{ width: "100%" }}>
              <Input.Search placeholder="输手机号找老客户" inputMode="tel" allowClear onSearch={async (q) => setCustomerResults(q.trim() ? await searchCustomersAction(q) : [])} />
              {customerResults.length > 0 ? (
                <Space wrap>
                  {customerResults.map((c) => (
                    <Button
                      key={c.id}
                      size="small"
                      onClick={() => {
                        setCustomer(c);
                        setCustomerResults([]);
                      }}
                    >
                      {c.name} {c.phoneMasked}
                    </Button>
                  ))}
                </Space>
              ) : null}
            </Space>
          )}
        </Card>

        <Card
          size="small"
          title="以旧换新（可不用）"
          extra={
            <Button size="small" onClick={() => setTradeInModalOpen(true)}>
              现场收旧机
            </Button>
          }
        >
          <Select
            allowClear
            placeholder="选一张本店未用的回收单抵扣"
            style={{ width: "100%" }}
            value={tradeIn?.id}
            onChange={(id) => setTradeIn(tradeInOptions.find((t) => t.id === id) ?? null)}
            options={tradeInOptions.map((t) => ({ value: t.id, label: `${t.modelName} · 抵 ${formatFen(t.appraisedFen)} 元` }))}
          />
          {tradeIn && tradeInFen > totalFen ? (
            <Typography.Text type="danger" style={{ display: "block", marginTop: 8 }}>
              抵扣超过应收了，换一张或加商品
            </Typography.Text>
          ) : null}
        </Card>

        <Card size="small" title="收款方式">
          <Radio.Group value={method} onChange={(e) => setMethod(e.target.value)} buttonStyle="solid" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            {PAYMENT_METHODS_FOR_SALE.map((m) => (
              <Radio.Button key={m} value={m} style={{ ...BIG, lineHeight: "46px", textAlign: "center", borderRadius: 6, borderInlineStartWidth: 1 }}>
                {PAYMENT_METHOD_LABELS[m]}
              </Radio.Button>
            ))}
          </Radio.Group>
          <Typography.Text type="secondary" style={{ display: "block", marginTop: 8 }}>
            手机上只收一种；要拆成几种收、整单优惠，用电脑版<Link href={`/sales/new?storeId=${storeId}`}>开单</Link>。
          </Typography.Text>
        </Card>
      </Space>

      {/* 底部固定的合计和提交：手机上不用翻回顶部也能提交 */}
      <div
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          background: "#fff",
          borderTop: "1px solid #f0f0f0",
          padding: "10px 16px calc(10px + env(safe-area-inset-bottom))",
          zIndex: 10,
        }}
      >
        <div style={{ maxWidth: 560, margin: "0 auto", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: "#888" }}>
              共 {itemCount} 件{tradeIn ? `，旧机抵 ${formatFen(tradeInFen)}` : ""}
            </div>
            <div style={{ fontSize: 20, fontWeight: 600 }}>¥{formatFen(Math.max(needFen, 0))}</div>
          </div>
          <Button type="primary" size="large" style={{ ...BIG, minWidth: 150 }} loading={pending} disabled={lines.length === 0 || tradeInFen > totalFen} onClick={submit}>
            {PAYMENT_METHOD_LABELS[method]}收款并提交
          </Button>
        </div>
      </div>

      <Modal title="现场收旧机" open={tradeInModalOpen} onCancel={() => setTradeInModalOpen(false)} footer={null} destroyOnHidden>
        <TradeInForm storeId={storeId} customerId={customer?.id} skuOptions={tradeInSkuOptions} onCreated={onTradeInCreated} submitText="收下旧机并用来抵扣" />
      </Modal>
    </div>
  );
}
