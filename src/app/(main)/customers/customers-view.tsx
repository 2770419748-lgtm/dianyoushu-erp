"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, Form, Input, Modal, Space, Table, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { formatDateTime } from "@/lib/format";
import type { CustomerRow } from "@/server/customers/customer-service";
import { createCustomerAction, updateCustomerAction, type CustomerActionResult } from "./actions";

type FormValues = { name: string; phone?: string; note?: string };

export function CustomersView({ rows, total, page, pageSize, q }: { rows: CustomerRow[]; total: number; page: number; pageSize: number; q: string }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [modal, setModal] = useState<{ open: boolean; record?: CustomerRow }>({ open: false });
  const [form] = Form.useForm<FormValues>();

  function navigate(next: { q?: string; page?: number }) {
    const sp = new URLSearchParams();
    const text = next.q ?? q;
    if (text) sp.set("q", text);
    if (next.page && next.page > 1) sp.set("page", String(next.page));
    router.push(`/customers${sp.size ? `?${sp}` : ""}`);
  }

  function submit(run: () => Promise<CustomerActionResult>) {
    startTransition(async () => {
      const result = await run();
      if (result.ok) {
        message.success("已保存");
        setModal({ open: false });
      } else {
        message.error(result.error);
      }
    });
  }

  const columns: TableColumnsType<CustomerRow> = [
    { title: "姓名", dataIndex: "name" },
    { title: "手机号", dataIndex: "phoneMasked" },
    { title: "备注", dataIndex: "note", render: (v: string | null) => v ?? "-" },
    { title: "下单次数", dataIndex: "orders", align: "right" },
    { title: "建档时间", dataIndex: "createdAt", render: (v: Date) => formatDateTime(v) },
    {
      title: "操作",
      render: (_, r) => (
        <Button
          size="small"
          onClick={() => {
            form.resetFields();
            form.setFieldsValue({ name: r.name, note: r.note ?? undefined });
            setModal({ open: true, record: r });
          }}
        >
          编辑
        </Button>
      ),
    },
  ];

  return (
    <Card
      title={`客户（${total}）`}
      extra={
        <Button
          type="primary"
          onClick={() => {
            form.resetFields();
            setModal({ open: true });
          }}
        >
          新建客户
        </Button>
      }
    >
      <Space style={{ marginBottom: 12 }}>
        <Input.Search allowClear placeholder="输手机号或姓名" defaultValue={q} style={{ width: 280 }} onSearch={(value) => navigate({ q: value, page: 1 })} />
        <Typography.Text type="secondary">手机号脱敏显示；开单时按完整手机号能搜到。</Typography.Text>
      </Space>
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={rows}
        scroll={{ x: true }}
        pagination={{ current: page, pageSize, total, showSizeChanger: false, onChange: (p) => navigate({ page: p }) }}
      />
      <Modal title={modal.record ? "编辑客户" : "新建客户"} open={modal.open} confirmLoading={pending} onCancel={() => setModal({ open: false })} onOk={() => form.submit()} destroyOnHidden>
        <Form<FormValues>
          form={form}
          name="customer"
          layout="vertical"
          onFinish={(values) =>
            submit(() =>
              modal.record
                ? updateCustomerAction(modal.record.id, { name: values.name, phone: values.phone ?? "", note: values.note })
                : createCustomerAction({ name: values.name, phone: values.phone ?? "", note: values.note }),
            )
          }
        >
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: "请填姓名" }]}>
            <Input maxLength={30} />
          </Form.Item>
          <Form.Item
            name="phone"
            label={modal.record ? `手机号（现在是 ${modal.record.phoneMasked}，要换号才填）` : "手机号"}
            rules={[{ required: !modal.record, pattern: /^1\d{10}$/, message: "手机号要 11 位，1 开头" }]}
          >
            <Input maxLength={11} inputMode="numeric" placeholder={modal.record ? "留空不改" : undefined} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input maxLength={200} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
