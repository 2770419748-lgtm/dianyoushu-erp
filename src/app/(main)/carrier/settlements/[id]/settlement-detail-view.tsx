"use client";

import Link from "next/link";
import { Alert, Button, Card, Descriptions, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { CARRIER_BIZ_TYPE_LABELS, CARRIER_LABELS, type CarrierLineResultKey } from "@/lib/carrier";
import { formatDate, formatDateTime, formatFen } from "@/lib/format";
import type { CarrierSettlementDetail } from "@/server/carrier/carrier-service";

type Line = CarrierSettlementDetail["lines"][number];
type Missing = CarrierSettlementDetail["missing"][number];

const RESULT: Record<CarrierLineResultKey, { label: string; color: string }> = {
  MATCHED: { label: "对上了", color: "green" },
  DIFF: { label: "金额不符", color: "orange" },
  UNMATCHED: { label: "我们没登记", color: "red" },
};

export function SettlementDetailView({ detail }: { detail: CarrierSettlementDetail }) {
  const lineColumns: TableColumnsType<Line> = [
    { title: "对账结果", dataIndex: "result", render: (v: CarrierLineResultKey) => <Tag color={RESULT[v].color}>{RESULT[v].label}</Tag> },
    { title: "受理单号", dataIndex: "carrierOrderNo", render: (v: string | null) => v ?? "-" },
    { title: "号码", dataIndex: "phoneMasked", render: (v: string | null) => v ?? "-" },
    { title: "业务类型", dataIndex: "bizType", render: (v: Line["bizType"]) => (v ? CARRIER_BIZ_TYPE_LABELS[v] : "-") },
    { title: "佣金（元）", dataIndex: "commissionFen", align: "right", render: (v: number) => formatFen(v) },
    { title: "返销扣回（元）", dataIndex: "clawbackFen", align: "right", render: (v: number) => (v ? <Typography.Text type="danger">{formatFen(v)}</Typography.Text> : "0.00") },
    {
      title: "我们的业务单",
      render: (_, l) =>
        l.business ? (
          <Space orientation="vertical" size={0}>
            <Link href={`/carrier?q=${l.business.orderNo}`}>{l.business.orderNo}</Link>
            <Typography.Text type="secondary">
              {l.business.store.name}，预计 {formatFen(l.business.expectedCommissionFen)}
            </Typography.Text>
          </Space>
        ) : (
          "-"
        ),
    },
  ];
  const missingColumns: TableColumnsType<Missing> = [
    { title: "业务单号", dataIndex: "orderNo", render: (v: string) => <Link href={`/carrier?q=${v}`}>{v}</Link> },
    { title: "日期", dataIndex: "bizDate", render: (v: Date) => formatDate(v) },
    { title: "门店", render: (_, m) => m.store.name },
    { title: "经办", render: (_, m) => m.handledBy.name },
    { title: "业务", dataIndex: "bizType", render: (v: Missing["bizType"]) => CARRIER_BIZ_TYPE_LABELS[v] },
    { title: "号码", dataIndex: "phoneMasked" },
    { title: "受理单号", dataIndex: "carrierOrderNo", render: (v: string | null) => v ?? "-" },
    { title: "预计佣金（元）", dataIndex: "expectedCommissionFen", align: "right", render: (v: number) => formatFen(v) },
  ];
  const problem = detail.diffCount + detail.unmatchedCount + detail.missing.length;

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        title={`结算单 ${detail.settlementNo}`}
        extra={
          <Link href="/carrier/settlements">
            <Button>返回结算对账</Button>
          </Link>
        }
      >
        <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }}>
          <Descriptions.Item label="运营商">{CARRIER_LABELS[detail.carrier]}</Descriptions.Item>
          <Descriptions.Item label="结算月份">{detail.month}</Descriptions.Item>
          <Descriptions.Item label="来源">{detail.source === "FILE" ? "导入文件" : "模拟（演示）"}</Descriptions.Item>
          <Descriptions.Item label="导入">{`${detail.importedBy.name} ${formatDateTime(detail.createdAt)}`}</Descriptions.Item>
          <Descriptions.Item label="佣金合计（元）">{formatFen(detail.totalCommissionFen)}</Descriptions.Item>
          <Descriptions.Item label="扣回合计（元）">{formatFen(detail.totalClawbackFen)}</Descriptions.Item>
        </Descriptions>
        {problem > 0 ? (
          <Alert
            type="warning"
            showIcon
            title={`有 ${problem} 处要跟运营商核对：金额不符 ${detail.diffCount} 笔、结算单里有但我们没登记 ${detail.unmatchedCount} 笔、我们开通了但结算单里没有的现在还剩 ${detail.missing.length} 笔`}
            description="金额不符的按运营商给的记实收；漏给的还是“已开通”，下个月结算单补给了会对上，或者拿着清单找运营商渠道经理申诉。"
          />
        ) : (
          <Alert type="success" showIcon title="全部对上了" />
        )}
      </Card>
      <Card title={`结算单明细（${detail.lines.length} 行）`}>
        <Table rowKey="id" size="small" columns={lineColumns} dataSource={detail.lines} scroll={{ x: true }} pagination={{ pageSize: 50, hideOnSinglePage: true }} />
      </Card>
      <Card title={`我们开通了、这张结算单里没有的：导入时 ${detail.missingCount} 笔，现在还有 ${detail.missing.length} 笔没给`}>
        <Typography.Paragraph type="secondary">清单按现在的状态算：后面月份的结算单补给了的，就不在这里了。</Typography.Paragraph>
        <Table rowKey="id" size="small" columns={missingColumns} dataSource={detail.missing} scroll={{ x: true }} locale={{ emptyText: "没有漏给的" }} pagination={{ pageSize: 50, hideOnSinglePage: true }} />
      </Card>
    </Space>
  );
}
