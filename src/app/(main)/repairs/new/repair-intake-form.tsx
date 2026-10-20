"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Card, Descriptions, Form, Input, Modal, Select, Space, Tag, Typography } from "antd";
import { ScanButton } from "@/components/scan-button";
import { formatDate } from "@/lib/format";
import { FAULT_LABELS, type FaultCategoryKey } from "@/lib/repair";
import type { RepairDeviceLookup } from "@/server/repair/repair-service";
import { createCustomerAction, searchCustomersAction } from "../../customers/actions";
import { createRepairAction, lookupRepairDeviceAction } from "../actions";

type CustomerPick = { id: number; name: string; phoneMasked: string };
type Lookup = RepairDeviceLookup | { kind: "error"; message: string } | null;

// 接件：先扫或输机器的码——本店卖出的机器自动带出机型、购买记录、保修、碎屏险和延保；外面买的手填机型。
export function RepairIntakeForm({ stores, defaultStoreId }: { stores: { id: number; label: string }[]; defaultStoreId: number }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [storeId, setStoreId] = useState(defaultStoreId);
  const [code, setCode] = useState("");
  const [lookup, setLookup] = useState<Lookup>(null);
  const [customer, setCustomer] = useState<CustomerPick | null>(null);
  const [customerResults, setCustomerResults] = useState<CustomerPick[]>([]);
  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [customerForm] = Form.useForm<{ name: string; phone: string }>();
  const [form] = Form.useForm<{ modelName?: string; faultCategory: FaultCategoryKey; faultDescription: string; appearance?: string }>();

  async function check(raw: string) {
    const value = raw.trim();
    setCode(value);
    if (!value) return setLookup(null);
    try {
      const result = await lookupRepairDeviceAction(value);
      setLookup(result);
      // 本店卖出的机器，买它的客户默认就是这次来修的客户
      if (result.kind === "ours" && result.sale?.customer && !customer) setCustomer(result.sale.customer);
    } catch {
      message.error("网络不通，没查到这个码");
    }
  }

  function submit(values: { modelName?: string; faultCategory: FaultCategoryKey; faultDescription: string; appearance?: string }) {
    if (!customer) return void message.warning("先选客户：修好了要联系客户取机");
    if (!code) return void message.warning("扫或输机器的 SN / IMEI");
    startTransition(async () => {
      const result = await createRepairAction({ storeId, customerId: customer.id, code, ...values });
      if (!result.ok) return void message.error(result.error);
      message.success(`已接件 ${result.orderNo}`);
      router.push(`/repairs/${result.id}`);
    });
  }

  const blocked = lookup?.kind === "in_stock" || (lookup && "openRepair" in lookup && lookup.openRepair);

  return (
    <Card title="售后接件" extra={<Select value={storeId} style={{ width: "min(200px, 45vw)" }} options={stores.map((s) => ({ value: s.id, label: s.label }))} onChange={setStoreId} disabled={stores.length === 1} />}>
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        <div>
          <Typography.Title level={5}>机器</Typography.Title>
          <Space wrap>
            <Input.Search placeholder="扫或输 SN / IMEI" style={{ width: "min(320px, calc(100vw - 72px))" }} enterButton="查" onSearch={(v) => void check(v)} allowClear />
            <ScanButton label="扫码" onCode={(c) => void check(c)} />
          </Space>
          {lookup?.kind === "ours" ? (
            <Descriptions
              size="small"
              column={{ xs: 1, sm: 2 }}
              style={{ marginTop: 12 }}
              items={[
                { key: "model", label: "机型", children: `${lookup.modelName}（${lookup.code}）` },
                { key: "sale", label: "购买", children: lookup.sale ? `${formatDate(lookup.sale.bizDate)} 在${lookup.sale.storeName}买的（${lookup.sale.orderNo}）` : "-" },
                { key: "warranty", label: "保修", children: lookup.warrantyEndsOn ? <Tag color={lookup.inWarranty ? "green" : "default"}>{lookup.inWarranty ? "保内" : "已过保"}，到 {formatDate(lookup.warrantyEndsOn)}</Tag> : "-" },
                { key: "services", label: "碎屏险 / 延保", children: lookup.entitlements.length ? lookup.entitlements.map((e) => <Tag key={e.id} color="purple">{e.name}，剩 {e.daysLeft} 天</Tag>) : "没有" },
              ]}
            />
          ) : lookup?.kind === "outside" ? (
            <Alert style={{ marginTop: 12 }} type="info" showIcon title="系统里没有这个码：外面买的机器，下面手填机型。保修找厂家，本店不保。" />
          ) : lookup?.kind === "in_stock" ? (
            <Alert style={{ marginTop: 12 }} type="error" showIcon title={`${lookup.code} 还在店里（${lookup.statusLabel}），不是客户的机器，不能接件`} />
          ) : lookup?.kind === "error" ? (
            <Alert style={{ marginTop: 12 }} type="error" showIcon title={lookup.message} />
          ) : null}
          {lookup && "openRepair" in lookup && lookup.openRepair ? (
            <Alert style={{ marginTop: 12 }} type="warning" showIcon title={`这台机器已经有一张没完结的维修单 ${lookup.openRepair.orderNo}`} action={<Button size="small" onClick={() => router.push(`/repairs/${lookup.openRepair!.id}`)}>去看</Button>} />
          ) : null}
        </div>

        <div>
          <Typography.Title level={5}>客户</Typography.Title>
          {customer ? (
            <Space>
              <Tag color="blue">{customer.name} {customer.phoneMasked}</Tag>
              <Button size="small" onClick={() => setCustomer(null)}>换一个</Button>
            </Space>
          ) : (
            <Space orientation="vertical" style={{ width: "100%" }}>
              <Space wrap>
                <Input.Search placeholder="输手机号（至少 4 位）或姓名找客户" style={{ width: "min(280px, 100%)" }} allowClear onSearch={async (q) => setCustomerResults(q.trim() ? await searchCustomersAction(q) : [])} />
                <Button onClick={() => { customerForm.resetFields(); setCustomerModalOpen(true); }}>新客户</Button>
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
        </div>

        <Form form={form} layout="vertical" onFinish={submit} initialValues={{ faultCategory: "SCREEN" }}>
          {lookup?.kind !== "ours" ? (
            <Form.Item name="modelName" label="机型" rules={[{ required: lookup?.kind === "outside", message: "外面买的机器写一下机型" }]}>
              <Input maxLength={60} placeholder="如 iPhone 13 128GB" />
            </Form.Item>
          ) : null}
          <Form.Item name="faultCategory" label="故障类型" rules={[{ required: true }]} extra="屏幕、进水算人为损坏：保修和延保不管，屏幕可以用碎屏险">
            <Select style={{ width: 200 }} options={(Object.keys(FAULT_LABELS) as FaultCategoryKey[]).map((k) => ({ value: k, label: FAULT_LABELS[k] }))} />
          </Form.Item>
          <Form.Item name="faultDescription" label="故障描述" rules={[{ required: true, message: "写一下故障描述" }]}>
            <Input.TextArea rows={2} maxLength={200} placeholder="如：摔了一下，屏幕右上角碎了，触摸正常" />
          </Form.Item>
          <Form.Item name="appearance" label="外观和随机附件">
            <Input maxLength={200} placeholder="如：边框有磕碰，带手机壳，没有充电器" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={pending} disabled={Boolean(blocked)}>
            接件
          </Button>
        </Form>
      </Space>

      <Modal
        title="新客户"
        open={customerModalOpen}
        confirmLoading={pending}
        onCancel={() => setCustomerModalOpen(false)}
        onOk={() =>
          customerForm.validateFields().then((values) =>
            startTransition(async () => {
              const result = await createCustomerAction(values);
              if (!result.ok) return void message.error(result.error);
              if (result.customer) setCustomer(result.customer);
              setCustomerModalOpen(false);
            }),
          )
        }
      >
        <Form form={customerForm} layout="vertical">
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: "请填姓名" }]}>
            <Input maxLength={30} />
          </Form.Item>
          <Form.Item name="phone" label="手机号" rules={[{ required: true, pattern: /^1\d{10}$/, message: "手机号要 11 位，1 开头" }]}>
            <Input maxLength={11} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
