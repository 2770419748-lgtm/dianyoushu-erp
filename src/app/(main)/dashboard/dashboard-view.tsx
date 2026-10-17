"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { Card, Col, Progress, Row, Select, Space, Statistic, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { EChart, type EChartOption } from "@/components/echart";
import { formatFen } from "@/lib/format";
import type { Dashboard } from "@/server/dashboard/dashboard-service";

const yuan = (fen: number) => Math.round(fen) / 100;
const wan = (fen: number) => (fen / 1000000).toFixed(1); // 分 → 万元
const pct = (v: number | null) => (v === null ? "-" : `${(v * 100).toFixed(0)}%`);

type KpiRow = Dashboard["kpi"][number];
type StockRow = Dashboard["stock"][number];
type StaleRow = Dashboard["staleList"][number];

export function DashboardView({ data, storeId }: { data: Dashboard; storeId?: number }) {
  const router = useRouter();

  const trendOption = useMemo<EChartOption>(
    () => ({
      tooltip: { trigger: "axis" },
      legend: { type: "scroll", top: 0, data: ["销售额（元）", "毛利（元）", "单数"] },
      grid: { left: 8, right: 16, top: 48, bottom: 8, containLabel: true },
      xAxis: { type: "category", data: data.trend.map((t) => t.date.slice(5)) },
      yAxis: [
        { type: "value", name: "元" },
        { type: "value", name: "单", splitLine: { show: false } },
      ],
      series: [
        { name: "销售额（元）", type: "line", smooth: true, data: data.trend.map((t) => yuan(t.sales)), areaStyle: { opacity: 0.08 } },
        { name: "毛利（元）", type: "line", smooth: true, data: data.trend.map((t) => yuan(t.profit)) },
        { name: "单数", type: "bar", yAxisIndex: 1, data: data.trend.map((t) => t.orders), itemStyle: { opacity: 0.35 } },
      ],
    }),
    [data.trend],
  );

  const monthOption = useMemo<EChartOption>(
    () => ({
      tooltip: { trigger: "axis", valueFormatter: (v: number) => `${v} 万元` },
      legend: { data: data.months.map((m) => `${Number(m.slice(5))} 月`) },
      grid: { left: 8, right: 16, top: 48, bottom: 8, containLabel: true },
      xAxis: { type: "category", data: data.storeMonth.map((s) => s.label.split(" ")[1]), axisLabel: { rotate: 30 } },
      yAxis: { type: "value", name: "万元" },
      series: data.months.map((m, i) => ({ name: `${Number(m.slice(5))} 月`, type: "bar", data: data.storeMonth.map((s) => Number(wan(s.months[i] ?? 0))) })),
    }),
    [data.months, data.storeMonth],
  );

  const staffOption = useMemo<EChartOption>(
    () => ({
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      legend: { type: "scroll", top: 0, data: ["销售额（元）", "毛利（元）"] },
      grid: { left: 8, right: 16, top: 48, bottom: 8, containLabel: true },
      xAxis: { type: "value" },
      yAxis: { type: "category", inverse: true, data: data.staff.map((s) => `${s.name}·${s.store}`) },
      series: [
        { name: "销售额（元）", type: "bar", data: data.staff.map((s) => yuan(s.sales)) },
        { name: "毛利（元）", type: "bar", data: data.staff.map((s) => yuan(s.profit)) },
      ],
    }),
    [data.staff],
  );

  const hotOption = useMemo<EChartOption>(
    () => ({
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      grid: { left: 8, right: 16, top: 10, bottom: 8, containLabel: true },
      xAxis: { type: "value", name: "台" },
      yAxis: { type: "category", inverse: true, data: data.hot.map((h) => h.model) },
      series: [{ name: "台数", type: "bar", data: data.hot.map((h) => h.qty), label: { show: true, position: "right" } }],
    }),
    [data.hot],
  );

  const kpiOption = useMemo<EChartOption>(
    () => ({
      tooltip: { trigger: "axis", valueFormatter: (v: number) => `${v}%` },
      legend: { type: "scroll", top: 0, data: ["销售额完成率", "毛利完成率", "主机量完成率"] },
      grid: { left: 8, right: 16, top: 48, bottom: 8, containLabel: true },
      xAxis: { type: "category", data: data.kpi.map((k) => k.label.split(" ")[1]), axisLabel: { rotate: 30 } },
      yAxis: { type: "value", name: "%", max: (v: { max: number }) => Math.max(110, Math.ceil(v.max / 10) * 10) },
      series: [
        {
          name: "销售额完成率",
          type: "bar",
          data: data.kpi.map((k) => (k.salesRate === null ? 0 : Math.round(k.salesRate * 100))),
          markLine: { symbol: "none", data: [{ yAxis: Math.round(data.progress * 100), name: "时间进度" }], label: { formatter: `时间进度 ${Math.round(data.progress * 100)}%`, position: "insideEndTop" }, lineStyle: { color: "#fa541c", type: "dashed" } },
        },
        { name: "毛利完成率", type: "bar", data: data.kpi.map((k) => (k.profitRate === null ? 0 : Math.round(k.profitRate * 100))) },
        { name: "主机量完成率", type: "bar", data: data.kpi.map((k) => (k.deviceRate === null ? 0 : Math.round(k.deviceRate * 100))) },
      ],
    }),
    [data.kpi, data.progress],
  );

  const stockOption = useMemo<EChartOption>(
    () => ({
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      legend: { type: "scroll", top: 0, data: ["在库", "近 30 天卖出", "在库超 30 天"] },
      grid: { left: 8, right: 16, top: 48, bottom: 8, containLabel: true },
      xAxis: { type: "category", data: data.stock.map((s) => s.label.split(" ")[1]), axisLabel: { rotate: 30 } },
      yAxis: { type: "value", name: "台" },
      series: [
        { name: "在库", type: "bar", data: data.stock.map((s) => s.inStock) },
        { name: "近 30 天卖出", type: "bar", data: data.stock.map((s) => s.sold30) },
        { name: "在库超 30 天", type: "bar", data: data.stock.map((s) => s.stale), itemStyle: { color: "#ff4d4f" } },
      ],
    }),
    [data.stock],
  );

  const kpiColumns: TableColumnsType<KpiRow> = [
    { title: "门店", dataIndex: "label" },
    { title: "本月销售（万元）", align: "right", render: (_, k) => wan(k.actual.sales) },
    { title: "目标（万元）", align: "right", render: (_, k) => (k.target ? wan(k.target.sales) : "-") },
    {
      title: "完成率",
      render: (_, k) =>
        k.salesRate === null ? "-" : <Progress percent={Math.round(k.salesRate * 100)} size="small" status={k.salesRate >= data.progress ? "success" : "exception"} style={{ width: 120 }} />,
    },
    {
      title: "门店日均差额（元/天）",
      align: "right",
      render: (_, k) =>
        k.gap === null ? "-" : k.gap.gap > 0 ? <Typography.Text type="danger">每天要多卖 {formatFen(Math.round(k.gap.gap))}</Typography.Text> : <Typography.Text type="success">照现在能完成</Typography.Text>,
    },
    { title: "主机量（实际/目标）", align: "right", render: (_, k) => `${k.actual.devices} / ${k.target?.devices ?? "-"}` },
    { title: "旧机回收（台）", align: "right", render: (_, k) => `${k.actual.tradeIns} / ${k.target?.tradeIns ?? "-"}` },
  ];

  const stockColumns: TableColumnsType<StockRow> = [
    { title: "门店", dataIndex: "label" },
    { title: "在库（台）", dataIndex: "inStock", align: "right" },
    { title: "近 30 天卖出", dataIndex: "sold30", align: "right" },
    {
      title: "周转天数",
      align: "right",
      render: (_, s) => (s.turnoverDays === null ? <Tag color="red">滞销</Tag> : <Tag color={s.turnoverDays > 30 ? "red" : s.turnoverDays > 15 ? "orange" : "green"}>{s.turnoverDays.toFixed(0)} 天</Tag>),
    },
    { title: "在库超 30 天", dataIndex: "stale", align: "right", render: (v: number) => (v > 0 ? <Typography.Text type="danger">{v}</Typography.Text> : 0) },
  ];

  const staleColumns: TableColumnsType<StaleRow> = [
    { title: "门店", dataIndex: "store" },
    { title: "商品", dataIndex: "sku" },
    { title: "台数", dataIndex: "qty", align: "right" },
    { title: "最久（天）", dataIndex: "oldestDays", align: "right" },
    { title: "压货成本（元）", dataIndex: "cost", align: "right", render: (v: number) => formatFen(v) },
  ];

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title={`经营看板 · ${data.scope}`}
        extra={
          data.stores.length > 1 ? (
            <Select
              allowClear
              placeholder="全部门店"
              style={{ width: 200 }}
              value={storeId}
              showSearch
              optionFilterProp="label"
              options={data.stores.map((s) => ({ value: s.id, label: s.label }))}
              onChange={(v) => router.push(v ? `/dashboard?storeId=${v}` : "/dashboard")}
            />
          ) : null
        }
      >
        <Row gutter={[16, 16]}>
          <Col xs={12} md={4}>
            <Statistic title="今日销售（元）" value={formatFen(data.cards.todaySales)} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="今日单数" value={data.cards.todayOrders} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="本月销售（万元）" value={wan(data.cards.monthSales)} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="本月毛利（万元）" value={wan(data.cards.monthProfit)} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic title="本月主机量（台）" value={data.cards.monthDevices} />
          </Col>
          <Col xs={12} md={4}>
            <Statistic
              title={`本月完成率（时间进度 ${pct(data.progress)}）`}
              value={data.cards.monthTarget > 0 ? pct(data.cards.monthSales / data.cards.monthTarget) : "-"}
              styles={{ content: { color: data.cards.monthTarget > 0 && data.cards.monthSales / data.cards.monthTarget >= data.progress ? "#389e0d" : "#cf1322" } }}
            />
          </Col>
        </Row>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <Card title="门店日销趋势（近 30 天）">
            <EChart option={trendOption} />
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card title="门店月销对比（近 3 个月）">
            <EChart option={monthOption} />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="员工业绩排名（本月前 10）">
            <EChart option={staffOption} height={360} />
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="热销机型 TOP10（近 30 天）">
            <EChart option={hotOption} height={360} />
          </Card>
        </Col>
        <Col xs={24}>
          <Card title={`KPI 完成率与门店日均差额（截至 ${data.today}）`}>
            <EChart option={kpiOption} />
            <Table rowKey="storeId" size="small" pagination={false} columns={kpiColumns} dataSource={data.kpi} scroll={{ x: true }} style={{ marginTop: 12 }} />
          </Card>
        </Col>
        <Col xs={24}>
          <Card title="库存周转和滞销预警">
            <EChart option={stockOption} height={280} />
            <Row gutter={[16, 16]} style={{ marginTop: 12 }}>
              <Col xs={24} xl={10}>
                <Table rowKey="storeId" size="small" pagination={false} columns={stockColumns} dataSource={data.stock} scroll={{ x: true }} />
              </Col>
              <Col xs={24} xl={14}>
                <Typography.Text strong>在库超过 30 天的机器（压货最久的在前）</Typography.Text>
                <Table rowKey={(r) => `${r.store}-${r.sku}`} size="small" pagination={false} columns={staleColumns} dataSource={data.staleList} scroll={{ x: true }} style={{ marginTop: 8 }} />
              </Col>
            </Row>
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
