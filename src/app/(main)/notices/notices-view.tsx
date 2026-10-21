"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Badge, Button, Card, Form, Input, Modal, Radio, Select, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { formatDateTime } from "@/lib/format";
import type { NoticeList } from "@/server/notice/notice-service";
import { publishNoticeAction } from "./actions";

// 公告列表：标题、发给谁、谁发的、读没读；总部和店长右上角“发公告”（店长只能发本店）。

type Row = NoticeList["rows"][number];

export function NoticesView({ data }: { data: NoticeList }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [form] = Form.useForm<{ title: string; body: string; scope: "ALL" | "REGION" | "STORE"; regionId?: number; storeId?: number }>();
  const scope = Form.useWatch("scope", form);

  const columns: TableColumnsType<Row> = [
    {
      title: "标题",
      render: (_, r) => (
        <Space size={6}>
          {r.read ? null : <Badge status="processing" />}
          <Link href={`/notices/${r.id}`}>{r.title}</Link>
          {r.withdrawn ? <Tag>已撤下</Tag> : null}
        </Space>
      ),
    },
    { title: "发给", dataIndex: "scopeLabel", width: 120 },
    { title: "发布人", dataIndex: "author", width: 100 },
    { title: "时间", dataIndex: "createdAt", width: 170, render: (v: Date) => formatDateTime(v) },
    { title: "已读", width: 100, render: (_, r) => (r.readCount === null ? (r.read ? "已读" : <Typography.Text type="danger">未读</Typography.Text>) : `${r.readCount} / ${r.recipients}`) },
  ];

  function submit(values: { title: string; body: string; scope: "ALL" | "REGION" | "STORE"; regionId?: number; storeId?: number }) {
    startTransition(async () => {
      const r = await publishNoticeAction(values);
      if (!r.ok) {
        message.error(r.error);
        return;
      }
      message.success(r.message);
      setOpen(false);
      form.resetFields();
      router.refresh();
    });
  }

  return (
    <Card
      title="公告"
      extra={
        data.canPublish ? (
          <Button type="primary" onClick={() => setOpen(true)}>
            发公告
          </Button>
        ) : null
      }
    >
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={data.rows}
        scroll={{ x: true }}
        locale={{ emptyText: "还没有公告" }}
        pagination={{ current: data.page, pageSize: data.pageSize, total: data.total, onChange: (p) => router.push(`/notices?page=${p}`), showSizeChanger: false }}
      />
      <Modal title="发公告" open={open} okText="发布" confirmLoading={pending} onCancel={() => setOpen(false)} onOk={() => form.submit()} destroyOnHidden>
        <Form form={form} layout="vertical" initialValues={{ scope: "ALL" }} onFinish={submit}>
          <Form.Item name="title" label="标题" rules={[{ required: true, max: 60, message: "标题写 1～60 个字" }]}>
            <Input maxLength={60} />
          </Form.Item>
          <Form.Item name="body" label="内容" rules={[{ required: true, max: 3000, message: "内容写 1～3000 个字" }]}>
            <Input.TextArea rows={6} maxLength={3000} showCount />
          </Form.Item>
          {data.publishScopes ? (
            <>
              <Form.Item name="scope" label="发给">
                <Radio.Group options={[{ value: "ALL", label: "全公司" }, { value: "REGION", label: "某个区域" }, { value: "STORE", label: "某家门店" }]} />
              </Form.Item>
              {scope === "REGION" ? (
                <Form.Item name="regionId" label="区域" rules={[{ required: true, message: "选一个区域" }]}>
                  <Select options={data.publishScopes.regions.map((r) => ({ value: r.id, label: r.name }))} />
                </Form.Item>
              ) : null}
              {scope === "STORE" ? (
                <Form.Item name="storeId" label="门店" rules={[{ required: true, message: "选一家门店" }]}>
                  <Select showSearch optionFilterProp="label" options={data.publishScopes.stores.map((s) => ({ value: s.id, label: s.label }))} />
                </Form.Item>
              ) : null}
            </>
          ) : (
            <Typography.Paragraph type="secondary">店长的公告发给本店的人。</Typography.Paragraph>
          )}
          <Typography.Text type="secondary">发布后范围内的人右上角“消息”里会收到。</Typography.Text>
        </Form>
      </Modal>
    </Card>
  );
}
