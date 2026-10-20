"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { App, Button, Card, Form, Input, Typography } from "antd";
import { saveSellerAction } from "../actions";

type Seller = { name: string; taxNo: string; addressPhone: string; bankAccount: string };

export function SellerForm({ seller }: { seller: Seller | null }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();

  return (
    <Card
      title="公司开票信息"
      extra={
        <Link href="/invoices">
          <Button>返回发票</Button>
        </Link>
      }
    >
      <Typography.Paragraph type="secondary">发票上的销售方信息。改了只影响以后开具的发票，开过的发票上存的是开具那一刻的信息。没填的时候不能开具。</Typography.Paragraph>
      <Form
        layout="vertical"
        initialValues={seller ?? {}}
        style={{ maxWidth: 560 }}
        onFinish={(v: Seller) =>
          startTransition(async () => {
            const result = await saveSellerAction(v);
            if (!result.ok) return void message.error(result.error);
            message.success(result.message ?? "已保存");
            router.refresh();
          })
        }
      >
        <Form.Item name="name" label="公司名称" rules={[{ required: true, message: "填公司名称" }]}>
          <Input maxLength={100} />
        </Form.Item>
        <Form.Item name="taxNo" label="纳税人识别号" rules={[{ required: true, pattern: /^[0-9A-Za-z]{15,20}$/, message: "15～20 位字母数字（统一社会信用代码 18 位）" }]}>
          <Input maxLength={20} />
        </Form.Item>
        <Form.Item name="addressPhone" label="地址电话" rules={[{ required: true, message: "填地址电话" }]}>
          <Input maxLength={100} />
        </Form.Item>
        <Form.Item name="bankAccount" label="开户行及账号" rules={[{ required: true, message: "填开户行及账号" }]}>
          <Input maxLength={100} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={pending}>
          保存
        </Button>
      </Form>
    </Card>
  );
}
