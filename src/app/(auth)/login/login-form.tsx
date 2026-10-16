"use client";

import { useActionState } from "react";
import { Alert, Button, Card, Form, Input, Typography } from "antd";
import { login, type LoginState } from "./actions";

const { Title, Text } = Typography;

export function LoginForm() {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(login, {});

  return (
    <Card style={{ width: "100%", maxWidth: 380 }}>
      <Title level={3} style={{ marginTop: 0 }}>
        店有数 ERP
      </Title>
      <Text type="secondary">手机零售门店经营系统演示版</Text>
      <form action={formAction} style={{ marginTop: 24 }}>
        <Form layout="vertical" component={false}>
          <Form.Item label="账号">
            <Input name="username" autoComplete="username" autoFocus size="large" />
          </Form.Item>
          <Form.Item label="密码">
            <Input.Password name="password" autoComplete="current-password" size="large" />
          </Form.Item>
          {state.error ? (
            <Form.Item>
              <Alert type="error" message={state.error} showIcon />
            </Form.Item>
          ) : null}
          <Button type="primary" htmlType="submit" size="large" block loading={pending}>
            登录
          </Button>
        </Form>
      </form>
      <div style={{ marginTop: 24 }}>
        <Text type="secondary">
          演示账号（密码都是 demo1234）：hq 总部、regional 区域经理、manager 店长、staff 店员
        </Text>
      </div>
    </Card>
  );
}
