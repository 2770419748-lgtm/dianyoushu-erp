"use client";

import { Card, Space, Tag, Typography } from "antd";

const { Title, Paragraph } = Typography;

export type DbStatus =
  | { ok: true; version: string; stores: number; users: number }
  | { ok: false; message: string };

// 首页的界面部分。antd 组件只能在客户端组件里用，数据由 page.tsx 在服务端查好传进来。
export function HomeView({ db, greeting }: { db: DbStatus; greeting: string }) {
  return (
    <Space orientation="vertical" size="large" style={{ width: "100%", maxWidth: 720 }}>
      <Title level={3} style={{ marginBottom: 0 }}>
        {greeting}
      </Title>
      <Paragraph type="secondary">第 1 周：登录与角色已接入，左边是按角色显示的菜单（暂时还点不开）。</Paragraph>
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
  );
}
