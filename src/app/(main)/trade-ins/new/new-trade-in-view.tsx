"use client";

import { useRouter } from "next/navigation";
import { Card, Select, Typography } from "antd";
import { TradeInForm, type TradeInSkuOption } from "../trade-in-form";

export function NewTradeInView({ stores, storeId, skuOptions }: { stores: { id: number; label: string }[]; storeId: number; skuOptions: TradeInSkuOption[] }) {
  const router = useRouter();
  return (
    <Card
      title="新建回收单"
      style={{ maxWidth: 720 }}
      extra={
        <Select
          value={storeId}
          style={{ width: 200 }}
          showSearch
          optionFilterProp="label"
          options={stores.map((s) => ({ value: s.id, label: s.label }))}
          onChange={(v) => router.push(`/trade-ins/new?storeId=${v}`)}
          disabled={stores.length === 1}
        />
      }
    >
      <Typography.Paragraph type="secondary">
        旧机提交后进本店回收库（状态“回收”，成本 = 估价）。开单时可以选这张回收单抵扣；也可以直接在开单页点“以旧换新”现场收。
      </Typography.Paragraph>
      <TradeInForm storeId={storeId} skuOptions={skuOptions} onCreated={() => router.push("/trade-ins")} />
    </Card>
  );
}
