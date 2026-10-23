"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Card, Input, Space, Typography } from "antd";
import { formatDateTime } from "@/lib/format";
import { confirmMfaSetupAction, startMfaSetupAction } from "./actions";

// “我的”页的二次验证（口径第 20 节）：看开没开；没开的自己开（扫码 → 输一次动态码确认）。关闭、换手机找总部重置。
export function MfaCard({ status }: { status: { enabledAt: Date | null; required: boolean; canEnable: boolean } }) {
  const { message } = App.useApp();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [setup, setSetup] = useState<{ qr: string; secret: string; sid: string } | null>(null);
  const [code, setCode] = useState("");

  return (
    <Card title="二次验证">
      {status.enabledAt ? (
        <Typography.Paragraph>
          已开启（{formatDateTime(status.enabledAt)}），登录时输完密码还要输手机验证器上的 6 位动态码。换手机、手机丢了找总部在组织管理里重置，重置后下次登录重新绑定。
        </Typography.Paragraph>
      ) : setup ? (
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Typography.Paragraph>用手机验证器 App（Google Authenticator、Microsoft Authenticator、腾讯身份验证器都行）扫二维码，再把 App 里显示的 6 位数填进来确认。</Typography.Paragraph>
          {/* 二维码是服务端生成的 data: 图片，不用 next/image */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={setup.qr} alt="二次验证二维码" width={200} height={200} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            扫不了就手动输入密钥：<Typography.Text copyable code>{setup.secret}</Typography.Text>
          </Typography.Text>
          <Space wrap>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6 位动态码" inputMode="numeric" maxLength={6} style={{ width: 160 }} />
            <Button
              type="primary"
              loading={pending}
              disabled={code.replace(/\s/g, "").length !== 6}
              onClick={() =>
                startTransition(async () => {
                  const r = await confirmMfaSetupAction(code, setup.sid);
                  if (!r.ok) return void message.error(r.error);
                  message.success("二次验证已开启，下次登录要输动态码");
                  setSetup(null);
                  router.refresh();
                })
              }
            >
              确认开启
            </Button>
          </Space>
        </Space>
      ) : (
        <Space orientation="vertical" style={{ width: "100%" }}>
          {status.required ? <Alert type="warning" showIcon title="你的账号要求开二次验证，下次登录时会让你先绑定。" /> : null}
          <Typography.Paragraph type="secondary">没开。开了以后，别人就算知道你的密码，没有你的手机也登不上。</Typography.Paragraph>
          {status.canEnable ? (
            <Button
              loading={pending}
              onClick={() =>
                startTransition(async () => {
                  const r = await startMfaSetupAction();
                  if (!r.ok) return void message.error(r.error);
                  setSetup(r.setup);
                  setCode("");
                })
              }
            >
              开启二次验证
            </Button>
          ) : (
            <Typography.Text type="secondary">演示账号不能开（密码是公开的，开了别人就登不上了）。想试先新建一个员工账号。</Typography.Text>
          )}
        </Space>
      )}
    </Card>
  );
}
