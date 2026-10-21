"use client";

import { useTransition } from "react";
import Link from "next/link";
import { Alert, App, Button, Card, Descriptions, Form, Input, Space, Tag, Typography } from "antd";
import { dayLabel, LEAVE_KIND_LABELS, SHIFT_COLORS, SHIFT_LABELS, type LeaveKindKey, type ShiftKindKey } from "@/lib/attendance";
import { formatDate, formatFen } from "@/lib/format";
import { changePasswordAction } from "./actions";

interface Values {
  oldPassword: string;
  newPassword: string;
  confirm: string;
}

type Profile = { hireDate: Date | null; position: string | null; phone: string | null; baseSalaryFen: number; leaveDate: Date | null } | null;

type WeekDay = { date: string; shift: ShiftKindKey | null; leave: LeaveKindKey | null; isToday: boolean };

export function MeView({ info, isDemo, profile = null, week = null }: { info: { username: string; name: string; role: string; scope: string }; isDemo: boolean; profile?: Profile; week?: WeekDay[] | null }) {
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [form] = Form.useForm<Values>();

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%", maxWidth: 560 }}>
      <Card title="我的账号">
        <Descriptions
          column={1}
          items={[
            { key: "username", label: "登录账号", children: info.username },
            { key: "name", label: "姓名", children: info.name },
            { key: "role", label: "角色", children: info.role },
            { key: "scope", label: "能看的范围", children: info.scope },
          ]}
        />
      </Card>
      <Card title="我的档案">
        {profile ? (
          <Descriptions
            column={1}
            items={[
              { key: "position", label: "岗位", children: profile.position ?? "-" },
              { key: "hire", label: "入职日期", children: profile.hireDate ? formatDate(profile.hireDate) : "-" },
              { key: "phone", label: "联系电话", children: profile.phone ?? "-" },
              { key: "salary", label: "基本工资", children: `${formatFen(profile.baseSalaryFen)} 元/月（只有你和总部能看）` },
            ]}
          />
        ) : (
          "总部还没给你建档案"
        )}
      </Card>
      {week ? (
        <Card title="我本周的班" extra={<Link href="/hr/attendance">去打卡</Link>}>
          <Space wrap>
            {week.map((d) => (
              <Space key={d.date} orientation="vertical" size={0} style={{ minWidth: 64 }}>
                <Typography.Text type={d.isToday ? undefined : "secondary"} strong={d.isToday}>
                  {dayLabel(d.date)}
                </Typography.Text>
                {d.leave ? <Tag color="gold">{LEAVE_KIND_LABELS[d.leave]}</Tag> : d.shift ? <Tag color={SHIFT_COLORS[d.shift]}>{SHIFT_LABELS[d.shift]}</Tag> : <Typography.Text type="secondary">—</Typography.Text>}
              </Space>
            ))}
          </Space>
        </Card>
      ) : null}
      <Card title="改密码">
        {isDemo ? (
          <Alert type="info" showIcon title="这是公共演示账号，不能改密码，免得后面来看演示的人登不进去。想试改密码，用总部账号在组织管理里新建一个员工再登录。" />
        ) : (
          <Form<Values>
            form={form}
            name="change-password"
            layout="vertical"
            onFinish={(values) =>
              startTransition(async () => {
                const result = await changePasswordAction(values.oldPassword, values.newPassword);
                if (!result.ok) {
                  message.error(result.error);
                  return;
                }
                message.success("密码已改，下次登录用新密码");
                form.resetFields();
              })
            }
          >
            <Form.Item name="oldPassword" label="旧密码" rules={[{ required: true, message: "填旧密码" }]}>
              <Input.Password autoComplete="current-password" />
            </Form.Item>
            <Form.Item name="newPassword" label="新密码" rules={[{ required: true, min: 6, max: 72, message: "新密码 6 到 72 位" }]}>
              <Input.Password autoComplete="new-password" />
            </Form.Item>
            <Form.Item
              name="confirm"
              label="再输一次新密码"
              dependencies={["newPassword"]}
              rules={[
                { required: true, message: "再输一次" },
                ({ getFieldValue }) => ({
                  validator: (_, value) => (!value || value === getFieldValue("newPassword") ? Promise.resolve() : Promise.reject(new Error("两次输的不一样"))),
                }),
              ]}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={pending}>
              改密码
            </Button>
          </Form>
        )}
      </Card>
    </Space>
  );
}
