"use client";

import Link from "next/link";
import { Card, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import type { StoreListItem } from "@/server/org/store-query";

export function StoresView({ stores }: { stores: StoreListItem[] }) {
  const columns: TableColumnsType<StoreListItem> = [
    { title: "编码", dataIndex: "code", render: (code: string, s) => <Link href={`/stores/${s.id}`}>{code}</Link> },
    { title: "门店", dataIndex: "name", render: (name: string, s) => <Link href={`/stores/${s.id}`}>{name}</Link> },
    { title: "区域", render: (_, s) => s.region.name },
    { title: "地址", dataIndex: "address", render: (v: string | null) => v ?? "-" },
    { title: "在职人数", render: (_, s) => s._count.users },
    { title: "状态", dataIndex: "isActive", render: (v: boolean) => (v ? <Tag color="green">营业</Tag> : <Tag>停用</Tag>) },
  ];

  return (
    <Card title={`门店（${stores.length}）`}>
      <Typography.Paragraph type="secondary">只显示你有权限看的门店：店员店长是本店，区域经理是辖区，总部是全部。</Typography.Paragraph>
      <Table rowKey="id" size="small" pagination={false} columns={columns} dataSource={stores} scroll={{ x: true }} />
    </Card>
  );
}
