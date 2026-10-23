"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, Form, Input, InputNumber, Select, Space, Table, Tag, Typography } from "antd";
import { formatFen, yuanToFen } from "@/lib/format";
import type { SkuOption } from "@/server/purchase/purchase-service";
import { createPurchaseOrderAction, updatePurchaseOrderAction } from "./actions";

interface ItemValue {
  skuId?: number;
  qty?: number;
  unitCostYuan?: number;
}

interface FormValues {
  storeId: number;
  supplierName?: string;
  note?: string;
  items: ItemValue[];
}

export interface PurchaseFormInitial {
  id: number;
  storeId: number;
  supplierName: string | null;
  note: string | null;
  items: { skuId: number; qty: number; unitCostFen: number }[];
}

// 新建 / 编辑采购单的表单。金额在表单里按元填，提交时转成分。
export function PurchaseForm({
  stores,
  skus,
  initial,
}: {
  stores: { id: number; label: string }[];
  skus: SkuOption[];
  initial?: PurchaseFormInitial;
}) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [form] = Form.useForm<FormValues>();
  const items = Form.useWatch("items", form) ?? [];

  const skuById = new Map(skus.map((s) => [s.id, s]));
  const skuOptions = skus.map((s) => ({
    value: s.id,
    label: `${s.model.brand.name} ${s.model.name} / ${s.name}${s.model.category.kind === "DEVICE" ? "（大件）" : "（小件）"}`,
  }));

  const totalFen = items.reduce((sum, item) => {
    if (!item?.skuId || !item.qty) return sum;
    return sum + item.qty * (yuanToFen(item.unitCostYuan ?? 0) || 0);
  }, 0);

  function onFinish(values: FormValues) {
    const input = {
      storeId: values.storeId,
      supplierName: values.supplierName,
      note: values.note,
      items: (values.items ?? []).map((item) => ({ skuId: item.skuId, qty: item.qty, unitCostFen: yuanToFen(item.unitCostYuan ?? 0) })),
    };
    startTransition(async () => {
      const result = initial ? await updatePurchaseOrderAction(initial.id, input) : await createPurchaseOrderAction(input);
      if (!result.ok) {
        message.error(result.error);
        return;
      }
      message.success("已保存");
      router.push(`/purchase/${initial ? initial.id : result.id}`);
    });
  }

  return (
    <Card title={initial ? `编辑采购单` : "新建采购单"}>
      <Form<FormValues>
        form={form}
        name="purchase"
        layout="vertical"
        onFinish={onFinish}
        initialValues={
          initial
            ? {
                storeId: initial.storeId,
                supplierName: initial.supplierName ?? undefined,
                note: initial.note ?? undefined,
                items: initial.items.map((i) => ({ skuId: i.skuId, qty: i.qty, unitCostYuan: i.unitCostFen / 100 })),
              }
            : { items: [{}] }
        }
      >
        <Space size="large" wrap>
          <Form.Item name="storeId" label="收货门店" rules={[{ required: true, message: "请选择收货门店" }]}>
            <Select showSearch optionFilterProp="label" style={{ width: 240 }} options={stores.map((s) => ({ value: s.id, label: s.label }))} />
          </Form.Item>
          <Form.Item name="supplierName" label="供应商">
            <Input maxLength={60} style={{ width: 240 }} placeholder="如 华为省代" />
          </Form.Item>
        </Space>
        <Form.Item name="note" label="备注">
          <Input.TextArea rows={2} maxLength={200} />
        </Form.Item>

        <Typography.Title level={5}>商品明细</Typography.Title>
        <Form.List name="items">
          {(fields, { add, remove }) => (
            <>
              <Table
                size="small"
                pagination={false}
                rowKey="key"
                dataSource={fields}
                scroll={{ x: true }} // 手机上表格自己横着滚，不把整页撑宽（复查第 81 条）
                columns={[
                  {
                    title: "商品",
                    render: (_, field) => (
                      <Form.Item name={[field.name, "skuId"]} rules={[{ required: true, message: "选商品" }]} style={{ marginBottom: 0 }}>
                        <Select
                          showSearch
                          optionFilterProp="label"
                          options={skuOptions}
                          style={{ minWidth: 320 }}
                          placeholder="搜品牌、型号或商品名"
                          onChange={(skuId: number) => {
                            const sku = skuById.get(skuId);
                            if (sku) form.setFieldValue(["items", field.name, "unitCostYuan"], sku.costPriceFen / 100);
                          }}
                        />
                      </Form.Item>
                    ),
                  },
                  {
                    title: "类型",
                    width: 70,
                    render: (_, field) => {
                      const sku = skuById.get(items[field.name]?.skuId ?? -1);
                      return sku ? <Tag color={sku.model.category.kind === "DEVICE" ? "blue" : "default"}>{sku.model.category.kind === "DEVICE" ? "大件" : "小件"}</Tag> : null;
                    },
                  },
                  {
                    title: "数量",
                    width: 110,
                    render: (_, field) => (
                      <Form.Item name={[field.name, "qty"]} rules={[{ required: true, message: "填数量" }]} style={{ marginBottom: 0 }}>
                        <InputNumber min={1} precision={0} style={{ width: 90 }} />
                      </Form.Item>
                    ),
                  },
                  {
                    title: "成本单价（元）",
                    width: 150,
                    render: (_, field) => (
                      <Form.Item name={[field.name, "unitCostYuan"]} rules={[{ required: true, message: "填单价" }]} style={{ marginBottom: 0 }}>
                        <InputNumber min={0} precision={2} style={{ width: 130 }} />
                      </Form.Item>
                    ),
                  },
                  {
                    title: "小计（元）",
                    width: 120,
                    align: "right",
                    render: (_, field) => {
                      const item = items[field.name];
                      const fen = item?.qty && item.unitCostYuan !== undefined ? item.qty * (yuanToFen(item.unitCostYuan) || 0) : 0;
                      return formatFen(fen);
                    },
                  },
                  {
                    title: "",
                    width: 60,
                    render: (_, field) => (
                      <Button type="link" danger disabled={fields.length === 1} onClick={() => remove(field.name)}>
                        删
                      </Button>
                    ),
                  },
                ]}
              />
              <Space style={{ marginTop: 12 }}>
                <Button onClick={() => add({})}>加一行</Button>
                <Typography.Text strong>合计：{formatFen(totalFen)} 元</Typography.Text>
              </Space>
            </>
          )}
        </Form.List>

        <Space style={{ marginTop: 24 }}>
          <Button type="primary" htmlType="submit" loading={pending}>
            {initial ? "保存修改" : "保存为草稿"}
          </Button>
          <Button onClick={() => router.push(initial ? `/purchase/${initial.id}` : "/purchase")}>取消</Button>
        </Space>
      </Form>
    </Card>
  );
}
