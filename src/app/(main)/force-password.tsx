"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, Form, Input, Typography } from "antd";
import { changePasswordAction } from "./me/actions";

// 第一次登录先改密码（口径第 21 节）：开户的管理员、总部新建或重置过密码的人，改完才能用别的功能。
export function ForcePassword({ next }: { next: string }) {
  const { message } = App.useApp();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [form] = Form.useForm<{ oldPassword: string; newPassword: string; confirm: string }>();
  return (
    <Card title="先改一下密码" style={{ maxWidth: 480 }}>
      <Typography.Paragraph type="secondary">这个账号的密码是别人帮你设的（开户或者总部新建、重置），先换成只有你知道的新密码再用。</Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) =>
          startTransition(async () => {
            const result = await changePasswordAction(values.oldPassword, values.newPassword);
            if (!result.ok) return void message.error(result.error);
            message.success("密码已改");
            router.push(next);
            router.refresh();
          })
        }
      >
        <Form.Item name="oldPassword" label="现在的密码（刚才登录用的）" rules={[{ required: true, message: "填现在的密码" }]}>
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
            ({ getFieldValue }) => ({ validator: (_, v) => (!v || v === getFieldValue("newPassword") ? Promise.resolve() : Promise.reject(new Error("两次输的不一样"))) }),
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={pending}>
          改密码
        </Button>
      </Form>
    </Card>
  );
}
