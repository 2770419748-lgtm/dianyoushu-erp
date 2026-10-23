"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Card, Checkbox, Input, InputNumber, Segmented, Space, Tag, Typography } from "antd";
import { nameKey } from "@/lib/import/specs";
import { LIBRARY_BRANDS, libraryKey, MODEL_LIBRARY, type LibraryModel } from "@/lib/model-library";
import { addFromLibraryAction } from "./actions";

// 一个型号的勾选状态：勾了哪些颜色（可以自己加颜色）、哪些容量、每个容量的指导价
type Pick = { colors: string[]; extraColors: string[]; storages: string[]; prices: Record<string, number> };

function emptyPick(m: LibraryModel): Pick {
  return { colors: [], extraColors: [], storages: [], prices: Object.fromEntries(m.variants.map((v) => [v.storage, v.guideYuan])) };
}

export function LibraryView({ existing }: { existing: string[] }) {
  const { message } = App.useApp();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [brand, setBrand] = useState(LIBRARY_BRANDS[0]!);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [newColor, setNewColor] = useState<Record<string, string>>({});
  const have = useMemo(() => new Set(existing), [existing]);

  const pickOf = (m: LibraryModel) => picks[libraryKey(m)] ?? emptyPick(m);
  const update = (m: LibraryModel, fn: (p: Pick) => Pick) => setPicks((all) => ({ ...all, [libraryKey(m)]: fn(all[libraryKey(m)] ?? emptyPick(m)) }));

  // 要建的商品：勾了的型号 × 颜色 × 容量，去掉系统里已经有的
  const selected = MODEL_LIBRARY.flatMap((m) => {
    const p = picks[libraryKey(m)];
    if (!p || p.colors.length === 0 || p.storages.length === 0) return [];
    return [{ m, p }];
  });
  const newCount = selected.reduce((sum, { m, p }) => sum + p.colors.reduce((n, c) => n + p.storages.filter((s) => !have.has(nameKey(m.brand, m.name, c, s))).length, 0), 0);

  const submit = () =>
    startTransition(async () => {
      const r = await addFromLibraryAction(
        selected.map(({ m, p }) => ({ brand: m.brand, name: m.name, colors: p.colors, variants: p.storages.map((s) => ({ storage: s, guideYuan: p.prices[s] ?? 0 })) })),
      );
      if (!r.ok) return void message.error(r.error);
      message.success(`新建商品 ${r.created} 个${r.skipped ? `，已有 ${r.skipped} 个跳过` : ""}`);
      setPicks({});
      router.refresh();
    });

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        title="勾型号的颜色和容量，改一下指导价，点下面的“添加”一次建好商品"
        description="价格是首发价或大致行情，只是建议；颜色以厂商为准，没有的可以自己加。系统里已有的组合标了“已有”，不会重复建。库里没有的机型在商品页手工建，或者用 Excel 导。"
      />
      <Segmented value={brand} onChange={(v) => setBrand(v as string)} options={LIBRARY_BRANDS} />
      {MODEL_LIBRARY.filter((m) => m.brand === brand).map((m) => {
        const p = pickOf(m);
        const colors = [...m.colors, ...p.extraColors];
        const existed = colors.flatMap((c) => m.variants.filter((v) => have.has(nameKey(m.brand, m.name, c, v.storage))).map(() => 1)).length;
        return (
          <Card
            key={libraryKey(m)}
            size="small"
            title={
              <Space>
                <span>{m.name}</span>
                <Tag>{m.category}</Tag>
                {existed > 0 ? <Tag color="green">已有 {existed} 个</Tag> : null}
              </Space>
            }
          >
            <Space orientation="vertical" style={{ width: "100%" }}>
              <Space wrap>
                <Typography.Text type="secondary">颜色</Typography.Text>
                <Checkbox.Group value={p.colors} onChange={(v) => update(m, (x) => ({ ...x, colors: v as string[] }))} options={colors} />
                <Input
                  size="small"
                  style={{ width: 140 }}
                  placeholder="加一个颜色"
                  maxLength={20}
                  value={newColor[libraryKey(m)] ?? ""}
                  onChange={(e) => setNewColor((all) => ({ ...all, [libraryKey(m)]: e.target.value }))}
                  onPressEnter={() => {
                    const c = (newColor[libraryKey(m)] ?? "").trim();
                    if (!c || colors.includes(c)) return;
                    update(m, (x) => ({ ...x, extraColors: [...x.extraColors, c], colors: [...x.colors, c] }));
                    setNewColor((all) => ({ ...all, [libraryKey(m)]: "" }));
                  }}
                />
              </Space>
              <Space wrap size="large">
                {m.variants.map((v) => (
                  <Space key={v.storage}>
                    <Checkbox
                      checked={p.storages.includes(v.storage)}
                      onChange={(e) => update(m, (x) => ({ ...x, storages: e.target.checked ? [...x.storages, v.storage] : x.storages.filter((s) => s !== v.storage) }))}
                    >
                      {v.storage}
                    </Checkbox>
                    <InputNumber
                      size="small"
                      min={0}
                      max={10_000_000}
                      precision={2}
                      prefix="¥"
                      style={{ width: 130 }}
                      value={p.prices[v.storage]}
                      onChange={(n) => update(m, (x) => ({ ...x, prices: { ...x.prices, [v.storage]: Number(n ?? 0) } }))}
                    />
                  </Space>
                ))}
              </Space>
            </Space>
          </Card>
        );
      })}
      <Card size="small" style={{ position: "sticky", bottom: 0, zIndex: 2 }}>
        <Space wrap>
          <span>
            已勾 {selected.length} 个型号，要新建 {newCount} 个商品
          </span>
          <Button type="primary" loading={pending} disabled={selected.length === 0} onClick={submit}>
            添加
          </Button>
        </Space>
      </Card>
    </Space>
  );
}
