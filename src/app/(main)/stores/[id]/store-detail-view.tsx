"use client";

import Link from "next/link";
import { Button, Card, Descriptions, Space, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import type { Role } from "@/generated/prisma/enums";
import { ROLE_LABELS } from "@/server/auth/permissions";
import type { StoreDetail } from "@/server/org/store-query";

export function StoreDetailView({ store }: { store: StoreDetail }) {
  const columns: TableColumnsType<StoreDetail["users"][number]> = [
    { title: "账号", dataIndex: "username" },
    { title: "姓名", dataIndex: "name" },
    { title: "角色", dataIndex: "role", render: (r: Role) => ROLE_LABELS[r] },
  ];

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title={`${store.code} ${store.name}`}
        extra={
          <Link href="/stores">
            <Button size="small">返回列表</Button>
          </Link>
        }
      >
        <Descriptions
          column={{ xs: 1, md: 2 }}
          items={[
            { key: "region", label: "区域", children: store.region.name },
            { key: "address", label: "地址", children: store.address ?? "-" },
            {
              key: "status",
              label: "状态",
              children: store.isActive ? <Tag color="green">营业</Tag> : <Tag>停用</Tag>,
            },
            { key: "users", label: "在职人数", children: store.users.length },
          ]}
        />
      </Card>
      <Card title="在职员工">
        <Table rowKey="id" size="small" pagination={false} columns={columns} dataSource={store.users} />
      </Card>
    </Space>
  );
}
