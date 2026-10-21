"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, Checkbox, DatePicker, Form, Input, InputNumber, Modal, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import dayjs from "dayjs";
import { formatDate, formatFen, yuanToFen } from "@/lib/format";
import type { EmployeeList } from "@/server/hr/employee-service";
import { ROLE_LABELS } from "@/server/auth/permissions";
import { saveEmployeeAction } from "./actions";

// 员工档案：一行一个员工；总部能看工资、能改（点“编辑”）。店长、区域经理看到的工资一列是空的（服务端就没给）。

type Row = EmployeeList["rows"][number];
type FormValues = { hireDate?: dayjs.Dayjs | null; position?: string; phone?: string; baseSalaryYuan?: number | null; leaveDate?: dayjs.Dayjs | null; note?: string };

export function EmployeesView({ data, q, includeInactive }: { data: EmployeeList; q: string; includeInactive: boolean }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [editing, setEditing] = useState<Row | null>(null);
  const [pending, startTransition] = useTransition();
  const [form] = Form.useForm<FormValues>();

  function go(next: { q?: string; all?: boolean }) {
    const sp = new URLSearchParams();
    const qq = next.q ?? q;
    if (qq) sp.set("q", qq);
    if (next.all ?? includeInactive) sp.set("all", "1");
    router.push(`/hr/employees${sp.size ? `?${sp}` : ""}`);
  }

  function edit(row: Row) {
    setEditing(row);
    form.setFieldsValue({
      hireDate: row.hireDate ? dayjs(row.hireDate) : null,
      position: row.position ?? undefined,
      phone: row.phone ?? undefined,
      baseSalaryYuan: row.baseSalaryFen !== null ? row.baseSalaryFen / 100 : null,
      leaveDate: row.leaveDate ? dayjs(row.leaveDate) : null,
      note: row.note ?? undefined,
    });
  }

  function save(values: FormValues) {
    if (!editing) return;
    startTransition(async () => {
      const r = await saveEmployeeAction(editing.id, {
        hireDate: values.hireDate ? values.hireDate.format("YYYY-MM-DD") : "",
        position: values.position ?? "",
        phone: values.phone ?? "",
        baseSalaryFen: values.baseSalaryYuan === null || values.baseSalaryYuan === undefined ? 0 : yuanToFen(values.baseSalaryYuan),
        leaveDate: values.leaveDate ? values.leaveDate.format("YYYY-MM-DD") : "",
        note: values.note ?? "",
      });
      if (!r.ok) {
        message.error(r.error);
        return;
      }
      message.success("保存了");
      setEditing(null);
      router.refresh();
    });
  }

  const columns: TableColumnsType<Row> = [
    { title: "姓名", render: (_, r) => <Space size={4}>{r.name}{r.isActive ? null : <Tag>已停用</Tag>}</Space> },
    { title: "账号", dataIndex: "username" },
    { title: "角色", dataIndex: "role", render: (v: Row["role"]) => ROLE_LABELS[v] },
    { title: "门店 / 区域", render: (_, r) => r.store ?? r.region ?? "总部" },
    { title: "岗位", dataIndex: "position", render: (v: string | null) => v ?? "-" },
    { title: "入职日期", dataIndex: "hireDate", render: (v: Date | null) => (v ? formatDate(v) : "-") },
    { title: "电话", dataIndex: "phoneMasked", render: (v: string | null) => v ?? "-" },
    ...(data.showSalary ? [{ title: "基本工资（元/月）", dataIndex: "baseSalaryFen", align: "right" as const, render: (v: number | null) => (v === null ? "-" : formatFen(v)) }] : []),
    { title: "离职日期", dataIndex: "leaveDate", render: (v: Date | null) => (v ? formatDate(v) : "-") },
    ...(data.canEdit ? [{ title: "", render: (_: unknown, r: Row) => <Button size="small" onClick={() => edit(r)}>编辑</Button> }] : []),
  ];

  return (
    <Card title="员工档案">
      <Space wrap style={{ marginBottom: 12 }}>
        <Input.Search placeholder="姓名或账号" defaultValue={q} allowClear onSearch={(v) => go({ q: v })} style={{ width: 220 }} />
        <Checkbox checked={includeInactive} onChange={(e) => go({ all: e.target.checked })}>
          含已停用
        </Checkbox>
        {data.showSalary ? null : <Typography.Text type="secondary">工资只有本人和总部能看。</Typography.Text>}
      </Space>
      <Table rowKey="id" size="small" columns={columns} dataSource={data.rows} pagination={{ pageSize: 30, showSizeChanger: false }} scroll={{ x: true }} />
      <Modal title={`编辑档案：${editing?.name ?? ""}`} open={editing !== null} confirmLoading={pending} onCancel={() => setEditing(null)} onOk={() => form.submit()} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item name="position" label="岗位">
            <Input maxLength={20} placeholder="如 店员、收银、维修" />
          </Form.Item>
          <Form.Item name="hireDate" label="入职日期">
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="phone" label="联系电话">
            <Input maxLength={13} placeholder="11 位手机号" />
          </Form.Item>
          <Form.Item name="baseSalaryYuan" label="基本工资（元/月）">
            <InputNumber min={0} precision={2} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="leaveDate" label="离职日期">
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} maxLength={200} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
