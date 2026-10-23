"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Card, Form, Input, InputNumber, Modal, Select, Space, Tag, Typography } from "antd";
import { CARRIER_BIZ_TYPE_LABELS, CARRIER_BIZ_TYPES, CARRIER_LABELS, CARRIERS, type CarrierBizTypeKey, type CarrierKey } from "@/lib/carrier";
import { formatFen, yuanToFen } from "@/lib/format";
import { createCustomerAction, searchCustomersAction } from "../../customers/actions";
import { registerBusinessAction } from "../actions";

type CustomerPick = { id: number; name: string; phoneMasked: string };
type Rule = { carrier: CarrierKey; bizType: CarrierBizTypeKey; commissionFen: number; clawbackMonths: number };
type Values = { carrier: CarrierKey; bizType: CarrierBizTypeKey; phone: string; packageName: string; monthlyFeeYuan?: number; carrierOrderNo?: string; salesOrderNo?: string; note?: string };

const PACKAGE_HINT: Record<CarrierBizTypeKey, string> = {
  NEW_LINE: "如 5G 畅享 129 元套餐",
  PORT_IN: "如 携转 99 元融合套餐",
  CONTRACT_PHONE: "如 购机送费 199 元档 24 个月",
  BROADBAND: "如 千兆宽带 1 年",
  PLAN_UPGRADE: "如 79 升 129 元套餐",
};

export function CarrierRegisterForm({ stores, defaultStoreId, rules }: { stores: { id: number; label: string }[]; defaultStoreId: number; rules: Rule[] }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [form] = Form.useForm<Values>();
  const [storeId, setStoreId] = useState(defaultStoreId);
  const [customer, setCustomer] = useState<CustomerPick | null>(null);
  const [results, setResults] = useState<CustomerPick[]>([]);
  const [customerModal, setCustomerModal] = useState(false);
  const [customerForm] = Form.useForm<{ name: string; phone: string }>();
  const carrier = Form.useWatch("carrier", form);
  const bizType = Form.useWatch("bizType", form);
  const rule = rules.find((r) => r.carrier === carrier && r.bizType === bizType);

  function submit(v: Values) {
    startTransition(async () => {
      const result = await registerBusinessAction({ storeId, customerId: customer?.id, carrier: v.carrier, bizType: v.bizType, phone: v.phone, packageName: v.packageName, monthlyFeeFen: v.monthlyFeeYuan === undefined || v.monthlyFeeYuan === null ? undefined : yuanToFen(v.monthlyFeeYuan), carrierOrderNo: v.carrierOrderNo, salesOrderNo: v.salesOrderNo, note: v.note });
      if (!result.ok) return void message.error(result.error);
      message.success(result.message ?? "已登记");
      router.push("/carrier");
    });
  }

  return (
    <Card title="登记运营商业务" extra={<Select value={storeId} style={{ width: "min(200px, 45vw)" }} options={stores.map((s) => ({ value: s.id, label: s.label }))} onChange={setStoreId} disabled={stores.length === 1} />}>
      <Form form={form} layout="vertical" onFinish={submit} initialValues={{ carrier: "CMCC", bizType: "NEW_LINE" }}>
        <Space wrap size="large">
          <Form.Item name="carrier" label="运营商" rules={[{ required: true }]}>
            <Select style={{ width: 140 }} options={CARRIERS.map((c) => ({ value: c, label: CARRIER_LABELS[c] }))} />
          </Form.Item>
          <Form.Item name="bizType" label="业务类型" rules={[{ required: true }]}>
            <Select style={{ width: 140 }} options={CARRIER_BIZ_TYPES.map((t) => ({ value: t, label: CARRIER_BIZ_TYPE_LABELS[t] }))} />
          </Form.Item>
        </Space>
        {rule ? (
          <Alert type="info" showIcon style={{ marginBottom: 16 }} title={`这项业务预计佣金 ${formatFen(rule.commissionFen)} 元，返销期 ${rule.clawbackMonths} 个月（客户这期间销户，运营商会扣回）`} />
        ) : carrier && bizType ? (
          <Alert type="warning" showIcon style={{ marginBottom: 16 }} title="总部还没配这项业务的佣金政策，登记不了，先找总部配上" />
        ) : null}
        <Form.Item label="客户">
          {customer ? (
            <Space>
              <Tag color="blue">{customer.name} {customer.phoneMasked}</Tag>
              <Button size="small" onClick={() => setCustomer(null)}>换一个</Button>
            </Space>
          ) : (
            <Space orientation="vertical" style={{ width: "100%" }}>
              <Space wrap>
                <Input.Search placeholder="输完整手机号、尾号 4 位或姓名找客户（可不选）" style={{ width: "min(300px, 100%)" }} allowClear onSearch={async (q) => setResults(q.trim() ? await searchCustomersAction(q) : [])} />
                <Button onClick={() => { customerForm.resetFields(); setCustomerModal(true); }}>新客户</Button>
              </Space>
              {results.length > 0 ? (
                <Space wrap>
                  {results.map((c) => (
                    <Button key={c.id} size="small" onClick={() => { setCustomer(c); setResults([]); }}>{c.name} {c.phoneMasked}</Button>
                  ))}
                </Space>
              ) : null}
            </Space>
          )}
        </Form.Item>
        <Space wrap size="large">
          <Form.Item name="phone" label={bizType === "BROADBAND" ? "联系手机" : "办理的号码"} rules={[{ required: true, pattern: /^1\d{10}$/, message: "11 位手机号" }]} extra="只存号码，不存身份证号（实名在运营商系统里做）">
            <Input maxLength={11} style={{ width: 180 }} />
          </Form.Item>
          <Form.Item name="packageName" label="套餐" rules={[{ required: true, message: "写一下套餐名" }]}>
            <Input maxLength={60} style={{ width: 260 }} placeholder={bizType ? PACKAGE_HINT[bizType] : ""} />
          </Form.Item>
          <Form.Item name="monthlyFeeYuan" label="月租（元）">
            <InputNumber min={0} precision={2} style={{ width: 120 }} />
          </Form.Item>
        </Space>
        <Space wrap size="large">
          <Form.Item name="carrierOrderNo" label="运营商受理单号" extra="在运营商系统里能看到就填，月底对账先按它对">
            <Input maxLength={40} style={{ width: 220 }} />
          </Form.Item>
          {bizType === "CONTRACT_PHONE" ? (
            <Form.Item name="salesOrderNo" label="关联销售单号" extra="合约机：本店卖这台机器的单号，客户会自动带出">
              <Input maxLength={30} style={{ width: 200 }} placeholder="SO202610200001" />
            </Form.Item>
          ) : null}
        </Space>
        <Form.Item name="note" label="备注">
          <Input maxLength={200} />
        </Form.Item>
        <Typography.Paragraph type="secondary">登记后是“已登记”，运营商那边办成了在明细里点“开通了”。</Typography.Paragraph>
        <Button type="primary" htmlType="submit" loading={pending} disabled={!rule}>
          登记
        </Button>
      </Form>
      <Modal
        title="新客户"
        open={customerModal}
        confirmLoading={pending}
        onCancel={() => setCustomerModal(false)}
        onOk={() =>
          customerForm.validateFields().then((values) =>
            startTransition(async () => {
              const result = await createCustomerAction(values);
              if (!result.ok) return void message.error(result.error);
              if (result.customer) setCustomer(result.customer);
              setCustomerModal(false);
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
