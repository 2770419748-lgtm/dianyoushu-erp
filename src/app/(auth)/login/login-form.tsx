"use client";

import { useActionState } from "react";
import { Alert, Button, Card, Form, Input, Typography } from "antd";
import { login, verifyMfa, type LoginState, type MfaState } from "./actions";

const { Title, Text, Paragraph } = Typography;

/** 第二步：输动态码；没绑定过的先扫二维码绑定（口径第 20 节） */
function MfaStep({ step, qr, secret }: { step: "verify" | "setup"; qr?: string; secret?: string }) {
  const [state, formAction, pending] = useActionState<MfaState, FormData>(verifyMfa, {});
  return (
    <form action={formAction} style={{ marginTop: 24 }}>
      <Form layout="vertical" component={false}>
        {step === "setup" ? (
          <>
            <Paragraph>
              这个账号要开二次验证：手机上装一个验证器 App（Google Authenticator、Microsoft Authenticator、腾讯身份验证器都行），扫下面的二维码，再把 App 里显示的 6 位数填进来。
            </Paragraph>
            {/* 二维码是服务端生成的 data: 图片，不用 next/image */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {qr ? <img src={qr} alt="二次验证二维码" width={200} height={200} style={{ display: "block", margin: "0 auto 8px" }} /> : null}
            <Paragraph type="secondary" style={{ fontSize: 12 }}>
              扫不了就在 App 里手动输入密钥：<Text copyable code>{secret}</Text>
            </Paragraph>
          </>
        ) : (
          <Paragraph>输入手机验证器 App 里这个账号现在的 6 位动态码（30 秒一换）。</Paragraph>
        )}
        <Form.Item label="动态码">
          <Input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus size="large" />
        </Form.Item>
        {state.error ? (
          <Form.Item>
            <Alert type="error" title={state.error} showIcon />
          </Form.Item>
        ) : null}
        {state.restart ? (
          <Button size="large" block onClick={() => window.location.reload()}>
            重新输密码
          </Button>
        ) : (
          <Button type="primary" htmlType="submit" size="large" block loading={pending}>
            {step === "setup" ? "绑定并登录" : "登录"}
          </Button>
        )}
      </Form>
    </form>
  );
}

export function LoginForm({ notice, showDemoAccounts }: { notice?: string; showDemoAccounts: boolean }) {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(login, {});

  return (
    <Card style={{ width: "100%", maxWidth: 380 }}>
      <Title level={3} style={{ marginTop: 0 }}>
        店有数 ERP
      </Title>
      <Text type="secondary">手机零售门店经营系统演示版</Text>
      {state.step ? (
        <MfaStep step={state.step} qr={state.qr} secret={state.secret} />
      ) : (
        <form action={formAction} style={{ marginTop: 24 }}>
          <Form layout="vertical" component={false}>
            <Form.Item label="账号">
              <Input name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus size="large" />
            </Form.Item>
            <Form.Item label="密码">
              <Input.Password name="password" autoComplete="current-password" size="large" />
            </Form.Item>
            {notice && !state.error ? (
              <Form.Item>
                <Alert type="warning" title={notice} showIcon />
              </Form.Item>
            ) : null}
            {state.error ? (
              <Form.Item>
                <Alert type="error" title={state.error} showIcon />
              </Form.Item>
            ) : null}
            <Button type="primary" htmlType="submit" size="large" block loading={pending}>
              登录
            </Button>
          </Form>
        </form>
      )}
      {showDemoAccounts && !state.step ? (
        <div style={{ marginTop: 24 }}>
          <Text type="secondary">
            演示账号（密码都是 demo1234）：hq 总部、regional 区域经理、manager 店长、staff 店员
          </Text>
        </div>
      ) : null}
    </Card>
  );
}
