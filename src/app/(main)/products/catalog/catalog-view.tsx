"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { App, Button, Card, Form, Input, InputNumber, Modal, Select, Space, Table, Tabs, Tag } from "antd";
import type { TableColumnsType } from "antd";
import type { SkuKind } from "@/generated/prisma/enums";
import type { Catalog, CatalogBrand, CatalogCategory, CatalogModel } from "@/server/products/product-service";
import type { ActionResult } from "@/server/products/action-result";
import {
  createBrandAction,
  createCategoryAction,
  createModelAction,
  updateBrandAction,
  updateCategoryAction,
  updateModelAction,
} from "./actions";

const KIND_OPTIONS = [
  { value: "DEVICE", label: "大件（按串号）" },
  { value: "ACCESSORY", label: "小件（按数量）" },
];

function KindTag({ kind }: { kind: SkuKind }) {
  return kind === "DEVICE" ? <Tag color="blue">大件</Tag> : <Tag>小件</Tag>;
}

export function CatalogView({ catalog }: { catalog: Catalog }) {
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [categoryModal, setCategoryModal] = useState<{ open: boolean; record?: CatalogCategory }>({ open: false });
  const [brandModal, setBrandModal] = useState<{ open: boolean; record?: CatalogBrand }>({ open: false });
  const [modelModal, setModelModal] = useState<{ open: boolean; record?: CatalogModel }>({ open: false });
  const [categoryForm] = Form.useForm<{ name: string; kind: SkuKind; sortOrder?: number }>();
  const [brandForm] = Form.useForm<{ name: string }>();
  const [modelForm] = Form.useForm<{ brandId: number; categoryId: number; name: string }>();

  function submit(run: () => Promise<ActionResult>, onDone?: () => void) {
    startTransition(async () => {
      const result = await run();
      if (result.ok) {
        message.success("已保存");
        onDone?.();
      } else {
        message.error(result.error);
      }
    });
  }

  const categoryColumns: TableColumnsType<CatalogCategory> = [
    { title: "品类", dataIndex: "name" },
    { title: "管理方式", dataIndex: "kind", render: (k: SkuKind) => <KindTag kind={k} /> },
    { title: "排序", dataIndex: "sortOrder" },
    {
      title: "操作",
      render: (_, r) => (
        <Button
          size="small"
          onClick={() => {
            categoryForm.setFieldsValue({ name: r.name, kind: r.kind, sortOrder: r.sortOrder });
            setCategoryModal({ open: true, record: r });
          }}
        >
          编辑
        </Button>
      ),
    },
  ];

  const brandColumns: TableColumnsType<CatalogBrand> = [
    { title: "品牌", dataIndex: "name" },
    { title: "型号数", render: (_, b) => catalog.models.filter((m) => m.brandId === b.id).length },
    {
      title: "操作",
      render: (_, r) => (
        <Button
          size="small"
          onClick={() => {
            brandForm.setFieldsValue({ name: r.name });
            setBrandModal({ open: true, record: r });
          }}
        >
          编辑
        </Button>
      ),
    },
  ];

  const modelColumns: TableColumnsType<CatalogModel> = [
    { title: "品牌", render: (_, m) => m.brand.name },
    { title: "型号", dataIndex: "name" },
    { title: "品类", render: (_, m) => <Space size={4}>{m.category.name}<KindTag kind={m.category.kind} /></Space> },
    { title: "SKU 数", render: (_, m) => m._count.skus },
    {
      title: "操作",
      render: (_, r) => (
        <Button
          size="small"
          onClick={() => {
            modelForm.setFieldsValue({ brandId: r.brandId, categoryId: r.categoryId, name: r.name });
            setModelModal({ open: true, record: r });
          }}
        >
          编辑
        </Button>
      ),
    },
  ];

  return (
    <Card
      title="品类 / 品牌 / 型号"
      extra={
        <Link href="/products">
          <Button>返回商品列表</Button>
        </Link>
      }
    >
      <Tabs
        defaultActiveKey="models"
        items={[
          {
            key: "categories",
            label: `品类（${catalog.categories.length}）`,
            children: (
              <Space orientation="vertical" style={{ width: "100%" }}>
                <Button
                  type="primary"
                  onClick={() => {
                    categoryForm.resetFields();
                    setCategoryModal({ open: true });
                  }}
                >
                  新增品类
                </Button>
                <Table rowKey="id" size="small" pagination={false} columns={categoryColumns} dataSource={catalog.categories} />
              </Space>
            ),
          },
          {
            key: "brands",
            label: `品牌（${catalog.brands.length}）`,
            children: (
              <Space orientation="vertical" style={{ width: "100%" }}>
                <Button
                  type="primary"
                  onClick={() => {
                    brandForm.resetFields();
                    setBrandModal({ open: true });
                  }}
                >
                  新增品牌
                </Button>
                <Table rowKey="id" size="small" pagination={false} columns={brandColumns} dataSource={catalog.brands} />
              </Space>
            ),
          },
          {
            key: "models",
            label: `型号（${catalog.models.length}）`,
            children: (
              <Space orientation="vertical" style={{ width: "100%" }}>
                <Button
                  type="primary"
                  onClick={() => {
                    modelForm.resetFields();
                    setModelModal({ open: true });
                  }}
                >
                  新增型号
                </Button>
                <Table rowKey="id" size="small" pagination={{ pageSize: 20 }} columns={modelColumns} dataSource={catalog.models} scroll={{ x: true }} />
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={categoryModal.record ? "编辑品类" : "新增品类"}
        open={categoryModal.open}
        confirmLoading={pending}
        onCancel={() => setCategoryModal({ open: false })}
        onOk={() => categoryForm.submit()}
        destroyOnHidden
      >
        <Form
          form={categoryForm}
          name="category"
          layout="vertical"
          onFinish={(values) =>
            submit(
              () => (categoryModal.record ? updateCategoryAction(categoryModal.record.id, values) : createCategoryAction(values)),
              () => setCategoryModal({ open: false }),
            )
          }
        >
          <Form.Item name="name" label="品类名称" rules={[{ required: true, message: "请输入品类名称" }]}>
            <Input maxLength={30} placeholder="如 手机、平板、配件" />
          </Form.Item>
          <Form.Item name="kind" label="管理方式" rules={[{ required: true, message: "请选择" }]}>
            <Select options={KIND_OPTIONS} />
          </Form.Item>
          <Form.Item name="sortOrder" label="排序（小的在前）">
            <InputNumber min={0} max={9999} precision={0} style={{ width: 120 }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={brandModal.record ? "编辑品牌" : "新增品牌"}
        open={brandModal.open}
        confirmLoading={pending}
        onCancel={() => setBrandModal({ open: false })}
        onOk={() => brandForm.submit()}
        destroyOnHidden
      >
        <Form
          form={brandForm}
          name="brand"
          layout="vertical"
          onFinish={(values) =>
            submit(
              () => (brandModal.record ? updateBrandAction(brandModal.record.id, values) : createBrandAction(values)),
              () => setBrandModal({ open: false }),
            )
          }
        >
          <Form.Item name="name" label="品牌名称" rules={[{ required: true, message: "请输入品牌名称" }]}>
            <Input maxLength={30} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={modelModal.record ? "编辑型号" : "新增型号"}
        open={modelModal.open}
        confirmLoading={pending}
        onCancel={() => setModelModal({ open: false })}
        onOk={() => modelForm.submit()}
        destroyOnHidden
      >
        <Form
          form={modelForm}
          name="model"
          layout="vertical"
          onFinish={(values) =>
            submit(
              () => (modelModal.record ? updateModelAction(modelModal.record.id, values) : createModelAction(values)),
              () => setModelModal({ open: false }),
            )
          }
        >
          <Form.Item name="brandId" label="品牌" rules={[{ required: true, message: "请选择品牌" }]}>
            <Select showSearch optionFilterProp="label" options={catalog.brands.map((b) => ({ value: b.id, label: b.name }))} />
          </Form.Item>
          <Form.Item name="categoryId" label="品类" rules={[{ required: true, message: "请选择品类" }]}>
            <Select options={catalog.categories.map((c) => ({ value: c.id, label: c.name }))} />
          </Form.Item>
          <Form.Item name="name" label="型号名称" rules={[{ required: true, message: "请输入型号名称" }]}>
            <Input maxLength={60} placeholder="如 Mate 70 Pro" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
