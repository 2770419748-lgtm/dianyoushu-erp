"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, Empty, Input, Space, Tag, Typography } from "antd";
import { ScanButton } from "@/components/scan-button";
import { DEVICE_STATUS_COLORS, DEVICE_STATUS_LABELS } from "@/lib/stock-labels";
import type { StockLookup } from "@/server/sales/lookup";

// 查询词放在地址栏（?q=），刷新、分享链接、返回上一页都能保留结果。
export function MobileStockView({ q, result }: { q: string; result: StockLookup | null }) {
  const router = useRouter();
  const [text, setText] = useState(q);

  function search(value: string) {
    const v = value.trim();
    router.push(v ? `/m/stock?q=${encodeURIComponent(v)}` : "/m/stock");
  }

  const empty = result && result.devices.length === 0 && result.accessories.length === 0;

  return (
    <div style={{ maxWidth: 560, margin: "0 auto" }}>
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        <ScanButton
          size="large"
          block
          label="扫码查库存"
          onCode={(code) => {
            setText(code);
            search(code);
          }}
        />
        <Input.Search size="large" placeholder="或输串号、条码、型号，如 iPhone 16" value={text} onChange={(e) => setText(e.target.value)} onSearch={search} enterButton="查" allowClear />

        {!result ? (
          <Card size="small">
            <Typography.Text type="secondary">能查本人权限范围内所有门店：机器显示在哪家店、什么状态；配件显示每家店剩几件，低于安全库存标红。</Typography.Text>
          </Card>
        ) : empty ? (
          <Empty description={`没找到“${q}”的在库机器或配件`} />
        ) : (
          <>
            {result.devices.length > 0 ? (
              <Card size="small" title={`机器 ${result.devices.length} 台${result.devices.length >= 50 ? "（只显示前 50 台，词再具体点）" : ""}`}>
                <Space orientation="vertical" style={{ width: "100%" }} size={10}>
                  {result.devices.map((d) => (
                    <div key={d.id} style={{ borderBottom: "1px solid #f5f5f5", paddingBottom: 8 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                        <Typography.Text strong>{d.name}</Typography.Text>
                        <Tag color={DEVICE_STATUS_COLORS[d.status]} style={{ marginInlineEnd: 0 }}>
                          {DEVICE_STATUS_LABELS[d.status]}
                        </Tag>
                      </div>
                      <Typography.Text type="secondary">
                        <Link href={`/stock/devices/${d.code}`}>{d.code}</Link> · {d.store}
                      </Typography.Text>
                    </div>
                  ))}
                </Space>
              </Card>
            ) : null}
            {result.accessories.length > 0 ? (
              <Card size="small" title="配件">
                <Space orientation="vertical" style={{ width: "100%" }} size={10}>
                  {result.accessories.map((a) => (
                    <div key={a.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, borderBottom: "1px solid #f5f5f5", paddingBottom: 8 }}>
                      <div style={{ minWidth: 0 }}>
                        <Typography.Text strong>{a.name}</Typography.Text>
                        <br />
                        <Typography.Text type="secondary">{a.store}</Typography.Text>
                      </div>
                      <Typography.Text strong type={a.qty < a.safetyQty ? "danger" : undefined} style={{ fontSize: 18, whiteSpace: "nowrap" }}>
                        {a.qty} 件
                      </Typography.Text>
                    </div>
                  ))}
                </Space>
              </Card>
            ) : null}
          </>
        )}
      </Space>
    </div>
  );
}
