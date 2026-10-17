"use client";

import Link from "next/link";
import { Card, Col, Row, Space, Tag, Typography } from "antd";

import type { SystemStatus as DbStatus } from "@/server/system-status";

const { Title, Paragraph } = Typography;

export interface QuickEntry {
  href: string;
  title: string;
  desc: string;
  primary?: boolean;
}

// 首页：按角色给几个大按钮，手机上一点就进；底部一行数据库连接状态，演示时出问题一眼能看到。
export function HomeView({ db, greeting, entries }: { db: DbStatus; greeting: string; entries: QuickEntry[] }) {
  return (
    <Space orientation="vertical" size="large" style={{ width: "100%", maxWidth: 960 }}>
      <Title level={3} style={{ marginBottom: 0 }}>
        {greeting}
      </Title>
      <Row gutter={[12, 12]}>
        {entries.map((e) => (
          <Col key={e.href} xs={12} sm={8} md={6}>
            <Link href={e.href}>
              <Card hoverable size="small" style={{ height: "100%", borderColor: e.primary ? "#1677ff" : undefined }} styles={{ body: { padding: 16 } }}>
                <Typography.Text strong style={{ fontSize: 16, color: e.primary ? "#1677ff" : undefined }}>
                  {e.title}
                </Typography.Text>
                <Paragraph type="secondary" style={{ margin: "4px 0 0", fontSize: 12 }}>
                  {e.desc}
                </Paragraph>
              </Card>
            </Link>
          </Col>
        ))}
      </Row>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        数据库：{db.ok ? <Tag color="green">已连接</Tag> : <Tag color="red">连不上</Tag>}
        {db.ok ? (db.counts ? `门店 ${db.counts.stores} 家，用户 ${db.counts.users} 个` : "") : "暂时连不上，请稍后刷新；一直连不上请联系管理员"}
      </Typography.Text>
    </Space>
  );
}
