"use client";

import { Alert, Card, Col, Row, Space, Statistic, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { formatDateTime } from "@/lib/format";
import type { WecomOverview } from "@/server/wecom/overview-service";

type EventRow = WecomOverview["events"][number];

const STATUS: Record<string, { color: string; label: string }> = {
  PENDING: { color: "default", label: "处理中" },
  PROCESSED: { color: "green", label: "处理完" },
  FAILED: { color: "red", label: "出错" },
};

const CHANGE_LABELS: Record<string, string> = {
  add_external_contact: "加好友",
  del_external_contact: "员工删了客户",
  del_follow_user: "客户删了员工",
  edit_external_contact: "改备注",
};

export function WecomOverviewView({ data }: { data: WecomOverview }) {
  const columns: TableColumnsType<EventRow> = [
    { title: "收到时间", dataIndex: "receivedAt", render: (v: Date) => formatDateTime(v) },
    {
      title: "事件",
      render: (_, e) => (
        <Space size={4}>
          {e.changeType ? (CHANGE_LABELS[e.changeType] ?? e.changeType) : e.eventType}
          {e.simulated ? <Tag color="purple">模拟</Tag> : null}
        </Space>
      ),
    },
    { title: "状态", dataIndex: "status", render: (s: string) => <Tag color={STATUS[s]?.color}>{STATUS[s]?.label ?? s}</Tag> },
    { title: "处理结果", render: (_, e) => e.error ?? e.result ?? "-" },
  ];
  const c = data.counts;
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Card title="企微对接">
        {data.mode === "simulated" ? (
          <Alert
            type="info"
            showIcon
            title="现在是模拟模式：没有连企业微信。销售单详情里生成的二维码是占位图，点“模拟客户扫码加好友”会造一条加密事件，走一遍和真回调一样的处理（验签、解密、去重、按开单绑定码绑客户、发欢迎语、写操作日志）。真对接要在服务器上设 WECOM_ENABLED=1 并配好企业微信后台，见 docs/部署.md。"
          />
        ) : data.missingConfig.length > 0 ? (
          <Alert type="error" showIcon title={`真对接缺配置：${data.missingConfig.join("、")}`} />
        ) : (
          <Alert type="success" showIcon title="已对接企业微信：回调地址 /api/wecom/callback 打开，客户扫码加好友后自动绑到客户档案。" />
        )}
        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col xs={12} md={6}><Statistic title="已加企业微信的客户" value={c.boundCustomers} /></Col>
          <Col xs={12} md={6}><Statistic title="跟进中的好友关系" value={c.activeFollows} /></Col>
          <Col xs={12} md={6}><Statistic title="被删的好友关系" value={c.deletedFollows} /></Col>
          <Col xs={12} md={6}><Statistic title="还没绑客户档案的好友" value={c.unboundFollows} /></Col>
          <Col xs={12} md={6}><Statistic title="还没扫的开单二维码" value={c.activeCodes} /></Col>
          <Col xs={12} md={6}><Statistic title="填了企业微信账号的店员" value={`${c.staffBound} / ${c.staffTotal}`} /></Col>
        </Row>
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          客户只按开单二维码绑定，不按手机号猜（企业微信拿不到客户手机号，猜容易错绑）。员工的企业微信账号在组织管理里填。
        </Typography.Paragraph>
      </Card>
      <Card title="最近的回调事件">
        <Table rowKey="id" size="small" columns={columns} dataSource={data.events} pagination={false} scroll={{ x: true }} locale={{ emptyText: "还没收到过事件" }} />
      </Card>
    </Space>
  );
}
