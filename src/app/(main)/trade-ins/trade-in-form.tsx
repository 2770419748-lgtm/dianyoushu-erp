"use client";

import { useTransition } from "react";
import { App, Button, Form, Input, InputNumber, Select, Space, Typography } from "antd";
import { ScanButton } from "@/components/scan-button";
import { yuanToFen } from "@/lib/format";
import { parseDeviceCodeLines } from "@/server/stock/imei";
import { createTradeInAction } from "./actions";

export const CONDITIONS = ["全新", "95 新", "9 成新", "8 成新", "有损"];

export interface TradeInSkuOption {
  id: number;
  label: string;
  generic: boolean;
}

export interface CreatedTradeIn {
  id: number;
  orderNo: string;
  appraisedFen: number;
  deviceCode: string;
  modelName: string;
}

interface Values {
  codesText: string;
  skuId: number;
  modelName?: string;
  condition: string;
  appraisedYuan: number;
  note?: string;
}

// 收旧机的表单：独立回收单页面和开单页的"以旧换新"弹窗共用。
export function TradeInForm({
  storeId,
  customerId,
  skuOptions,
  onCreated,
  submitText = "提交回收单",
}: {
  storeId: number;
  customerId?: number;
  skuOptions: TradeInSkuOption[];
  onCreated: (t: CreatedTradeIn) => void;
  submitText?: string;
}) {
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [form] = Form.useForm<Values>();
  const codesText = Form.useWatch("codesText", form) ?? "";
  const skuId = Form.useWatch("skuId", form);
  const parsed = parseDeviceCodeLines(codesText);
  const generic = skuOptions.find((s) => s.id === skuId)?.generic ?? false;

  function onFinish(values: Values) {
    startTransition(async () => {
      const result = await createTradeInAction({
        storeId,
        customerId,
        codesText: values.codesText,
        skuId: values.skuId,
        modelName: values.modelName,
        condition: values.condition,
        appraisedFen: yuanToFen(values.appraisedYuan),
        note: values.note,
      });
      if (!result.ok) {
        message.error(result.error);
        return;
      }
      message.success(`回收单 ${result.tradeIn!.orderNo} 已建，旧机进回收库`);
      form.resetFields();
      onCreated(result.tradeIn!);
    });
  }

  return (
    <Form<Values> form={form} name={`trade-in-${storeId}`} layout="vertical" onFinish={onFinish} initialValues={{ condition: "9 成新" }}>
      <Form.Item label="旧机的码（SN、IMEI1、IMEI2 任意 1 到 3 个，空格隔开）" required style={{ marginBottom: 4 }}>
        <Space.Compact style={{ width: "100%" }}>
          <Form.Item name="codesText" noStyle rules={[{ required: true, message: "至少填一个码" }]}>
            <Input placeholder="如 SNOLD12345 867530019999991" />
          </Form.Item>
          <ScanButton
            continuous
            onCode={(code) => {
              const current: string = (form.getFieldValue("codesText") ?? "").trim();
              if (current.split(/[\s,，]+/).includes(code)) return;
              form.setFieldValue("codesText", current ? `${current} ${code}` : code);
            }}
          />
        </Space.Compact>
      </Form.Item>
      <Typography.Text type={parsed.errors.length ? "danger" : "secondary"} style={{ display: "block", marginBottom: 12 }}>
        {parsed.errors.length
          ? parsed.errors[0]
          : parsed.devices[0]
            ? `识别：${[parsed.devices[0].sn ? `SN ${parsed.devices[0].sn}` : null, parsed.devices[0].imei1 ? `IMEI1 ${parsed.devices[0].imei1}` : null, parsed.devices[0].imei2 ? `IMEI2 ${parsed.devices[0].imei2}` : null].filter(Boolean).join("，")}`
            : "15 位数字按先后算 IMEI1、IMEI2，其他的算 SN；本系统卖出过的机器，机型按系统里记的"}
      </Typography.Text>
      <Form.Item name="skuId" label="旧机机型" rules={[{ required: true, message: "请选机型" }]}>
        <Select showSearch optionFilterProp="label" options={skuOptions.map((s) => ({ value: s.id, label: s.label }))} placeholder="搜型号；对不上选“回收机（其他机型）”" />
      </Form.Item>
      {generic ? (
        <Form.Item name="modelName" label="实际机型" rules={[{ required: true, message: "写清旧机型号" }]}>
          <Input maxLength={60} placeholder="如 iPhone 12 128GB 白色" />
        </Form.Item>
      ) : null}
      <Space size="large" wrap>
        <Form.Item name="condition" label="成色" rules={[{ required: true }]}>
          <Select style={{ width: 140 }} options={CONDITIONS.map((c) => ({ value: c, label: c }))} />
        </Form.Item>
        <Form.Item name="appraisedYuan" label="估价（元，等于抵扣金额）" rules={[{ required: true, message: "填估价" }]}>
          <InputNumber min={1} precision={2} style={{ width: 180 }} />
        </Form.Item>
      </Space>
      <Form.Item name="note" label="备注">
        <Input maxLength={200} placeholder="如 屏幕有划痕、无充电器" />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={pending}>
        {submitText}
      </Button>
    </Form>
  );
}
