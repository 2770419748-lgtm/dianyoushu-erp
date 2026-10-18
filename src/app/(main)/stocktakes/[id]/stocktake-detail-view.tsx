"use client";

import { useTransition } from "react";
import Link from "next/link";
import { App, Button, Card, Descriptions, Form, Input, InputNumber, Popconfirm, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import { formatDateTime } from "@/lib/format";
import { STOCKTAKE_STATUS_COLORS, STOCKTAKE_STATUS_LABELS } from "@/lib/stock-labels";
import { ScanButton } from "@/components/scan-button";
import { appendScannedCode } from "@/lib/device/scanner";
import { parseCodeList } from "@/server/stock/imei";
import type { StocktakeDetail } from "@/server/stocktake/stocktake-service";
import { confirmStocktakeAction, enterCountsAction, voidStocktakeAction, type StocktakeActionResult } from "../actions";

type Item = StocktakeDetail["items"][number];

function DiffTag({ diff }: { diff: number | null }) {
  if (diff === null) return <Tag>未录</Tag>;
  if (diff === 0) return <Tag color="green">相符</Tag>;
  return <Tag color={diff < 0 ? "red" : "orange"}>{diff < 0 ? `盘亏 ${-diff}` : `盘盈 ${diff}`}</Tag>;
}

export function StocktakeDetailView({ stocktake, canEnter, canConfirm }: { stocktake: StocktakeDetail; canEnter: boolean; canConfirm: boolean }) {
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [form] = Form.useForm<{ imeiText?: string; counts: Record<number, number | undefined> }>();
  const imeiText = Form.useWatch("imeiText", form) ?? "";

  const deviceItems = stocktake.items.filter((i) => i.deviceId);
  const accessoryItems = stocktake.items.filter((i) => !i.deviceId);
  const inProgress = stocktake.status === "IN_PROGRESS";
  const notCounted = stocktake.items.filter((i) => i.countedQty === null).length;
  const diffs = stocktake.items.filter((i) => (i.diffQty ?? 0) !== 0);
  const parsed = parseCodeList(imeiText);

  function run(fn: () => Promise<StocktakeActionResult>, success: string) {
    startTransition(async () => {
      const result = await fn();
      if (result.ok) message.success(result.info ?? success, result.info ? 6 : 3);
      else message.error(result.error);
    });
  }

  const deviceColumns: TableColumnsType<Item> = [
    { title: "主码", render: (_, i) => <Link href={`/stock/devices/${i.device!.code}`}>{i.device!.code}</Link> },
    { title: "商品", render: (_, i) => i.sku.name },
    { title: "应有", dataIndex: "expectedQty", align: "right" },
    { title: "实盘", dataIndex: "countedQty", align: "right", render: (v: number | null) => (v === null ? "-" : v) },
    { title: "结果", dataIndex: "diffQty", render: (d: number | null) => <DiffTag diff={d} /> },
  ];

  const accessoryColumns: TableColumnsType<Item> = [
    { title: "配件", render: (_, i) => i.sku.name },
    { title: "应有", dataIndex: "expectedQty", align: "right" },
    {
      title: "实盘",
      align: "right",
      render: (_, i) =>
        inProgress && canEnter ? (
          <Form.Item name={["counts", i.id]} style={{ marginBottom: 0 }} initialValue={i.countedQty ?? undefined}>
            <InputNumber min={0} precision={0} style={{ width: 100 }} />
          </Form.Item>
        ) : (
          (i.countedQty ?? "-")
        ),
    },
    { title: "结果", dataIndex: "diffQty", render: (d: number | null) => <DiffTag diff={d} /> },
  ];

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title={
          <Space>
            <span>盘点单 {stocktake.stocktakeNo}</span>
            <Tag color={STOCKTAKE_STATUS_COLORS[stocktake.status]}>{STOCKTAKE_STATUS_LABELS[stocktake.status]}</Tag>
          </Space>
        }
        extra={
          <Space>
            <Link href="/stocktakes">
              <Button size="small">返回列表</Button>
            </Link>
            {inProgress && canConfirm ? (
              <>
                <Popconfirm
                  title={notCounted > 0 ? `还有 ${notCounted} 项没录，先录完` : diffs.length > 0 ? `确认后 ${diffs.length} 项差异会写进库存流水（盘亏机器变"盘亏"），确定？` : "没有差异，确认完成？"}
                  disabled={notCounted > 0}
                  onConfirm={() => run(() => confirmStocktakeAction(stocktake.id), "盘点已确认")}
                >
                  <Button size="small" type="primary" disabled={notCounted > 0} loading={pending}>
                    确认盘点
                  </Button>
                </Popconfirm>
                <Popconfirm title="作废这张盘点单？" onConfirm={() => run(() => voidStocktakeAction(stocktake.id), "已作废")}>
                  <Button size="small" danger loading={pending}>
                    作废
                  </Button>
                </Popconfirm>
              </>
            ) : null}
          </Space>
        }
      >
        <Descriptions
          column={{ xs: 1, md: 3 }}
          items={[
            { key: "store", label: "门店", children: `${stocktake.store.code} ${stocktake.store.name}` },
            { key: "creator", label: "发起", children: `${stocktake.createdBy.name} · ${formatDateTime(stocktake.createdAt)}` },
            { key: "confirm", label: "确认", children: stocktake.confirmedAt ? `${stocktake.confirmedBy?.name ?? ""} · ${formatDateTime(stocktake.confirmedAt)}` : "-" },
            { key: "summary", label: "进度", children: `应有 ${stocktake.items.length} 项，已录 ${stocktake.items.length - notCounted} 项，差异 ${diffs.length} 项` },
            { key: "note", label: "备注", children: stocktake.note ?? "-", span: "filled" },
          ]}
        />
      </Card>

      <Form
        form={form}
        name="stocktake-count"
        layout="vertical"
        onFinish={(values) =>
          run(
            () =>
              enterCountsAction(stocktake.id, {
                imeiText: values.imeiText,
                accessoryCounts: accessoryItems.map((i) => ({ itemId: i.id, countedQty: values.counts?.[i.id] })),
              }),
            "实盘已录入",
          )
        }
      >
        {deviceItems.length > 0 ? (
          <Card title={`机器（应有 ${deviceItems.length} 台）`}>
            {inProgress && canEnter ? (
              <>
                <Typography.Paragraph type="secondary">把现场盘到的全部串号一次粘贴进来（扫码枪逐个扫也行）。框里有串号时按这次的清单算，没出现的机器记为没盘到，确认后算盘亏；框留空保存不改机器的结果，只更新配件数量。</Typography.Paragraph>
                <Form.Item name="imeiText" style={{ marginBottom: 4 }}>
                  <Input.TextArea rows={5} placeholder="粘贴实盘串号，一行一个" />
                </Form.Item>
                <Space wrap style={{ marginBottom: 4 }}>
                  <ScanButton continuous size="small" label="扫码盘点" onCode={(code) => form.setFieldValue("imeiText", appendScannedCode(form.getFieldValue("imeiText"), code))} />
                  <Typography.Text type="secondary">手机对着机器一台台扫，扫过的自动加进上面的框，重复的不会加两次</Typography.Text>
                </Space>
                <Typography.Text type={parsed.invalid.length ? "danger" : "secondary"} style={{ display: "block", marginBottom: 12 }}>
                  已识别 {parsed.valid.length} 个{parsed.invalid.length ? `，${parsed.invalid.length} 个格式不对` : ""}
                </Typography.Text>
              </>
            ) : null}
            <Table rowKey="id" size="small" columns={deviceColumns} dataSource={deviceItems} pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ x: true }} />
          </Card>
        ) : null}
        {accessoryItems.length > 0 ? (
          <Card title={`配件（应有 ${accessoryItems.length} 种）`} style={{ marginTop: 16 }}>
            <Table rowKey="id" size="small" columns={accessoryColumns} dataSource={accessoryItems} pagination={false} />
          </Card>
        ) : null}
        {inProgress && canEnter ? (
          <Button type="primary" htmlType="submit" loading={pending} style={{ marginTop: 16 }}>
            保存实盘
          </Button>
        ) : null}
      </Form>
    </Space>
  );
}
