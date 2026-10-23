"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Card, Checkbox, Popconfirm, Segmented, Space, Table, Tag, Typography } from "antd";
import { toCsv } from "@/lib/csv";
import { formatDateTime } from "@/lib/format";
import { IMPORT_COLUMNS, IMPORT_KIND_LABELS, IMPORT_KIND_ORDER, OPENING_KINDS, type ImportKindKey } from "@/lib/import/specs";
import type { ImportCheck, ImportDone } from "@/server/import/import-service";
import { revokeImportAction } from "./actions";

type History = {
  id: number;
  batchNo: string;
  kind: ImportKindKey;
  status: "DONE" | "REVOKED";
  fileName: string | null;
  rowCount: number;
  createdCount: number;
  summary: string[];
  createdBy: string;
  createdAt: Date;
  revokedBy: string | null;
  revokedAt: Date | null;
  canRevoke: boolean;
};

const KIND_HINTS: Record<ImportKindKey, string> = {
  STORES: "区域没有会新建；门店编码不能和系统里的重复。",
  USERS: "初始密码系统随机生成，导入后只显示这一次，记得下载发给各人；第一次登录先改密码。",
  PRODUCTS: "也可以在“商品 → 从机型库添加”里勾选。系统里已有的商品跳过、不改价格。",
  DEVICES: "生成期初入库单：机器直接在库，成本记表里的成本。还没开过销售单之前可以整张撤销。",
  ACCESSORIES: "生成期初入库单：配件按门店加数量。还没开过销售单之前可以整张撤销。",
  CUSTOMERS: "手机号系统里已有的跳过；手机号加密保存。还没开过销售单之前可以整批撤销。",
};

async function post(kind: ImportKindKey, mode: "check" | "commit", file: File, legal: boolean): Promise<{ check?: ImportCheck; done?: ImportDone; error?: string }> {
  const form = new FormData();
  form.set("kind", kind);
  form.set("mode", mode);
  form.set("file", file);
  if (legal) form.set("legal", "1");
  try {
    const res = await fetch("/api/import", { method: "POST", body: form });
    return (await res.json()) as { check?: ImportCheck; done?: ImportDone; error?: string };
  } catch {
    return { error: "上传失败：网络不通或者文件太大" };
  }
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function ImportView({ history }: { history: History[] }) {
  const { message } = App.useApp();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState<ImportKindKey>("STORES");
  const [file, setFile] = useState<File | null>(null);
  const [check, setCheck] = useState<ImportCheck | null>(null);
  const [done, setDone] = useState<ImportDone | null>(null);
  const [legal, setLegal] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const reset = (next?: ImportKindKey) => {
    if (next) setKind(next);
    setFile(null);
    setCheck(null);
    setDone(null);
    setLegal(false);
    if (input.current) input.current.value = "";
  };

  const run = (mode: "check" | "commit") =>
    startTransition(async () => {
      if (!file) return;
      const r = await post(kind, mode, file, legal);
      if (r.error) return void message.error(r.error);
      if (r.check) {
        setCheck(r.check);
        if (mode === "commit") message.error("写库前再查一遍发现了问题，整批没进，看下面的清单");
      }
      if (r.done) {
        setDone(r.done);
        setCheck(null);
        message.success(`导入完成：${r.done.batchNo}`);
        router.refresh();
      }
    });

  const columns = IMPORT_COLUMNS[kind];

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        title="按顺序导：门店 → 员工 → 商品 → 在库机器 → 配件期初 → 客户（可选）"
        description="下载模板按列填好上传，系统先整张检查，有一条不对整批都不进；没问题再点“确认导入”。一个文件最多 5000 行。供应商、没修完的维修单、没结的欠款手工补。"
      />

      <Card title="导入">
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          {/* 手机上这一条自己横着滑，不把整页撑宽（复查第 81 条） */}
          <div style={{ maxWidth: "100%", overflowX: "auto" }}>
            <Segmented<ImportKindKey> value={kind} onChange={(v) => reset(v)} options={IMPORT_KIND_ORDER.map((k) => ({ value: k, label: IMPORT_KIND_LABELS[k] }))} />
          </div>
          <Typography.Text type="secondary">{KIND_HINTS[kind]}</Typography.Text>
          <Table
            size="small"
            pagination={false}
            rowKey="label"
            dataSource={columns.map((c) => ({ ...c }))}
            columns={[
              { title: "列名", dataIndex: "label", width: 120 },
              { title: "必填", dataIndex: "required", width: 60, render: (r?: boolean) => (r ? "是" : "") },
              { title: "说明", dataIndex: "note", render: (n?: string) => n ?? "" },
              { title: "例子", dataIndex: "example", width: 160 },
            ]}
          />
          <Space wrap>
            <a href={`/api/import/template?kind=${kind}`}>
              <Button>下载模板（.xlsx）</Button>
            </a>
            <input
              ref={input}
              type="file"
              accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              aria-label="选择要导入的文件"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setCheck(null);
                setDone(null);
              }}
            />
            <Button type="primary" disabled={!file} loading={pending} onClick={() => run("check")}>
              上传并检查
            </Button>
          </Space>

          {check && check.problemCount > 0 ? (
            <>
              <Alert
                type="error"
                showIcon
                title={`有 ${check.problemCount} 处问题，整批都不进：改好表格再上传`}
                description={check.problemCount > check.problems.length ? `下面只列出前 ${check.problems.length} 处。` : undefined}
              />
              <Table
                size="small"
                rowKey={(_, i) => String(i)}
                pagination={{ pageSize: 20, hideOnSinglePage: true }}
                dataSource={check.problems}
                columns={[
                  { title: "第几行", dataIndex: "line", width: 80, render: (l: number) => (l === 0 ? "整张表" : l) },
                  { title: "列", dataIndex: "column", width: 120 },
                  { title: "问题", dataIndex: "message" },
                ]}
              />
            </>
          ) : null}

          {check && check.problemCount === 0 ? (
            <Space orientation="vertical" style={{ width: "100%" }}>
              <Alert type="success" showIcon title={`检查通过：表里 ${check.rowCount} 行`} description={check.summary.join("；")} />
              {kind === "CUSTOMERS" ? (
                <Checkbox checked={legal} onChange={(e) => setLegal(e.target.checked)}>
                  这些手机号是门店在经营中合法收集的，客户知道会用于售后服务和回访（服务协议里有写）
                </Checkbox>
              ) : null}
              <Button type="primary" loading={pending} disabled={check.createCount === 0 || (kind === "CUSTOMERS" && !legal)} onClick={() => run("commit")}>
                确认导入
              </Button>
            </Space>
          ) : null}

          {done ? (
            <Space orientation="vertical" style={{ width: "100%" }}>
              <Alert type="success" showIcon title={`导入完成：${done.batchNo}，新建 ${done.created} 条${done.skipped ? `，跳过 ${done.skipped} 条` : ""}`} description={done.summary.join("；")} />
              {done.passwords ? (
                <>
                  <Alert type="warning" showIcon title="初始密码只显示这一次：现在下载，发给各人；第一次登录要先改密码" />
                  <Button onClick={() => download(`初始密码-${done.batchNo}.csv`, toCsv([["账号", "姓名", "初始密码"], ...done.passwords!.map((p) => [p.username, p.name, p.password])]))}>下载初始密码表</Button>
                  <Table
                    size="small"
                    rowKey="username"
                    pagination={{ pageSize: 20, hideOnSinglePage: true }}
                    dataSource={done.passwords}
                    columns={[
                      { title: "账号", dataIndex: "username" },
                      { title: "姓名", dataIndex: "name" },
                      { title: "初始密码", dataIndex: "password", render: (p: string) => <Typography.Text code>{p}</Typography.Text> },
                    ]}
                  />
                </>
              ) : null}
              <Button onClick={() => reset()}>再导一个文件</Button>
            </Space>
          ) : null}
        </Space>
      </Card>

      <Card title="历次导入">
        <Table
          size="small"
          rowKey="id"
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          dataSource={history}
          columns={[
            {
              title: "单号",
              dataIndex: "batchNo",
              render: (no: string, r: History) => (OPENING_KINDS.includes(r.kind) ? <Link href={`/setup/import/${r.id}`}>{no}</Link> : no),
            },
            { title: "类型", dataIndex: "kind", render: (k: ImportKindKey) => IMPORT_KIND_LABELS[k] },
            { title: "文件", dataIndex: "fileName", ellipsis: true },
            { title: "表里行数", dataIndex: "rowCount", align: "right" },
            { title: "新建", dataIndex: "createdCount", align: "right" },
            { title: "导入人", dataIndex: "createdBy" },
            { title: "时间", dataIndex: "createdAt", render: (d: Date) => formatDateTime(d) },
            {
              title: "状态",
              dataIndex: "status",
              render: (s: History["status"], r: History) => (s === "DONE" ? <Tag color="green">已导入</Tag> : <Tag color="red">已撤销（{r.revokedBy}）</Tag>),
            },
            {
              title: "",
              key: "op",
              render: (_: unknown, r: History) =>
                r.canRevoke ? (
                  <Popconfirm
                    title="整批撤销？"
                    description={r.kind === "CUSTOMERS" ? "这批客户全部删掉" : "这张单进来的机器、配件数量全部撤掉"}
                    onConfirm={() =>
                      startTransition(async () => {
                        const res = await revokeImportAction(r.id);
                        if (!res.ok) return void message.error(res.error);
                        message.success("已撤销");
                        router.refresh();
                      })
                    }
                  >
                    <Button size="small" danger loading={pending}>
                      撤销
                    </Button>
                  </Popconfirm>
                ) : null,
            },
          ]}
        />
      </Card>
    </Space>
  );
}
