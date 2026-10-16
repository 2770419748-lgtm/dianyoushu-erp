"use client";

import { Card, Space, Tag, Typography } from "antd";

const { Title, Paragraph } = Typography;

export type DbStatus =
  | { ok: true; version: string; stores: number; users: number }
  | { ok: false; message: string };

// 首页的界面部分。antd 组件只能在客户端组件里用（服务端组件拿不到 Typography.Title 这类子组件），
// 所以数据由 page.tsx 在服务端查好，再传进来渲染。
export function HomeView({ db }: { db: DbStatus }) {
  return (
    <main style={{ maxWidth: 720, margin: "48px auto", padding: "0 16px" }}>
      <Space orientation="vertical" size="large" style={{ width: "100%" }}>
        <Title level={2} style={{ marginBottom: 0 }}>
          店有数 ERP
        </Title>
        <Paragraph type="secondary">
          手机零售门店经营系统演示版。第 1 周：脚手架已搭好，登录与角色随后接入。
        </Paragraph>
        <Card title="环境自检">
          <p>框架：Next.js（App Router）+ Ant Design</p>
          <p>
            数据库：{db.ok ? <Tag color="green">已连接</Tag> : <Tag color="red">连不上</Tag>}
            {db.ok ? (
              <span style={{ marginLeft: 8 }}>
                {db.version.split(",")[0]}，门店 {db.stores} 家，用户 {db.users} 个
              </span>
            ) : (
              <span style={{ marginLeft: 8 }}>{db.message}</span>
            )}
          </p>
        </Card>
      </Space>
    </main>
  );
}
