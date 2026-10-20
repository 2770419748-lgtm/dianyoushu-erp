"use client";

import { useMemo, useState, useTransition } from "react";
import {
  App,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tree,
  Typography,
} from "antd";
import type { TableColumnsType, TreeDataNode } from "antd";
import type { Role } from "@/generated/prisma/enums";
import { ROLE_LABELS } from "@/server/auth/permissions";
import type { OrgRegion, OrgStore, OrgTree, OrgUser } from "@/server/org/org-service";
import {
  createRegionAction,
  createStoreAction,
  createUserAction,
  resetUserPasswordAction,
  setRegionActiveAction,
  setStoreActiveAction,
  setUserActiveAction,
  updateRegionAction,
  updateStoreAction,
  updateUserAction,
  type ActionResult,
} from "./actions";

// 组织管理页：左边树（总部 / 区域 → 门店 → 员工），右边三个页签的列表和表单。
// 数据由 page.tsx 在服务端查好传进来；所有写操作走 actions.ts → 服务层，成功后页面自动刷新。

type Selection = { kind: "all" } | { kind: "hq" } | { kind: "region"; id: number } | { kind: "store"; id: number };

const ROLE_OPTIONS = (Object.keys(ROLE_LABELS) as Role[]).map((r) => ({ value: r, label: ROLE_LABELS[r] }));

function StatusTag({ active }: { active: boolean }) {
  return active ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>;
}

function ToggleButton({ active, onConfirm, disabled }: { active: boolean; onConfirm: () => void; disabled?: boolean }) {
  return (
    <Popconfirm title={active ? "确定停用？停用后不能再用，但历史记录保留。" : "确定启用？"} onConfirm={onConfirm} disabled={disabled}>
      <Button size="small" danger={active} disabled={disabled}>
        {active ? "停用" : "启用"}
      </Button>
    </Popconfirm>
  );
}

export function OrgView({ data, currentUserId, showWecom }: { data: OrgTree; currentUserId: number; showWecom: boolean }) {
  const { message } = App.useApp();
  const [pending, startTransition] = useTransition();
  const [selection, setSelection] = useState<Selection>({ kind: "all" });
  const [activeTab, setActiveTab] = useState("stores");
  const [expandedKeys, setExpandedKeys] = useState<React.Key[] | null>(null); // null = 全部展开

  const [regionModal, setRegionModal] = useState<{ open: boolean; record?: OrgRegion }>({ open: false });
  const [storeModal, setStoreModal] = useState<{ open: boolean; record?: OrgStore }>({ open: false });
  const [userModal, setUserModal] = useState<{ open: boolean; record?: OrgUser }>({ open: false });
  const [passwordModal, setPasswordModal] = useState<{ open: boolean; record?: OrgUser }>({ open: false });

  const [regionForm] = Form.useForm<{ name: string }>();
  const [storeForm] = Form.useForm<{ code: string; name: string; regionId: number; address?: string }>();
  const [userForm] = Form.useForm<{ username: string; name: string; role: Role; storeId?: number; regionId?: number; password?: string; wecomUserid?: string }>();
  const [passwordForm] = Form.useForm<{ password: string }>();
  const watchedRole = Form.useWatch("role", userForm);

  const allStores = useMemo(() => data.regions.flatMap((r) => r.stores), [data.regions]);
  const storeById = useMemo(() => new Map(allStores.map((s) => [s.id, s])), [allStores]);
  const regionById = useMemo(() => new Map(data.regions.map((r) => [r.id, r])), [data.regions]);

  // ---------- 树 ----------
  const treeData = useMemo<TreeDataNode[]>(() => {
    const userNode = (u: OrgUser): TreeDataNode => ({
      key: `user-${u.id}`,
      title: `${u.name}（${ROLE_LABELS[u.role]}）${u.isActive ? "" : "·停用"}`,
      isLeaf: true,
    });
    const hqUsers = data.users.filter((u) => u.role === "HQ");
    const nodes: TreeDataNode[] = [{ key: "hq", title: `总部（${hqUsers.length} 人）`, children: hqUsers.map(userNode) }];
    for (const region of data.regions) {
      const managers = data.users.filter((u) => u.role === "REGIONAL_MANAGER" && u.regionId === region.id);
      nodes.push({
        key: `region-${region.id}`,
        title: `${region.name}${region.isActive ? "" : "（停用）"}`,
        children: [
          ...managers.map(userNode),
          ...region.stores.map((store) => ({
            key: `store-${store.id}`,
            title: `${store.code} ${store.name}${store.isActive ? "" : "（停用）"}`,
            children: data.users.filter((u) => u.storeId === store.id).map(userNode),
          })),
        ],
      });
    }
    return nodes;
  }, [data]);

  // 有子节点的 key 全部列出来，默认全展开；用户手动收起后就按用户的来
  const allTreeKeys = useMemo(() => {
    const keys: React.Key[] = [];
    const walk = (nodes: TreeDataNode[]) => {
      for (const n of nodes) {
        if (n.children?.length) {
          keys.push(n.key);
          walk(n.children);
        }
      }
    };
    walk(treeData);
    return keys;
  }, [treeData]);

  function onTreeSelect(keys: React.Key[]) {
    const key = String(keys[0] ?? "");
    if (key === "hq") setSelection({ kind: "hq" });
    else if (key.startsWith("region-")) setSelection({ kind: "region", id: Number(key.slice(7)) });
    else if (key.startsWith("store-")) setSelection({ kind: "store", id: Number(key.slice(6)) });
    else if (key.startsWith("user-")) {
      const user = data.users.find((u) => u.id === Number(key.slice(5)));
      if (user?.storeId) setSelection({ kind: "store", id: user.storeId });
      else if (user?.regionId) setSelection({ kind: "region", id: user.regionId });
      else setSelection({ kind: "hq" });
      setActiveTab("users");
    } else setSelection({ kind: "all" });
  }

  // ---------- 按树的选择过滤右边的列表 ----------
  const visibleStores = useMemo(() => {
    if (selection.kind === "region") return allStores.filter((s) => s.regionId === selection.id);
    if (selection.kind === "store") return allStores.filter((s) => s.id === selection.id);
    if (selection.kind === "hq") return [];
    return allStores;
  }, [allStores, selection]);

  const visibleUsers = useMemo(() => {
    if (selection.kind === "hq") return data.users.filter((u) => u.role === "HQ");
    if (selection.kind === "region") {
      const storeIds = new Set(allStores.filter((s) => s.regionId === selection.id).map((s) => s.id));
      return data.users.filter((u) => u.regionId === selection.id || (u.storeId !== null && storeIds.has(u.storeId)));
    }
    if (selection.kind === "store") return data.users.filter((u) => u.storeId === selection.id);
    return data.users;
  }, [data.users, allStores, selection]);

  // ---------- 提交 ----------
  function submit(run: () => Promise<ActionResult>, onDone?: () => void) {
    startTransition(async () => {
      const result = await run();
      if (result.ok) {
        if (result.notice) message.warning(`已保存。${result.notice}`);
        else message.success("已保存");
        onDone?.();
      } else {
        message.error(result.error);
      }
    });
  }

  function openRegion(record?: OrgRegion) {
    regionForm.resetFields();
    if (record) regionForm.setFieldsValue({ name: record.name });
    setRegionModal({ open: true, record });
  }

  function openStore(record?: OrgStore) {
    storeForm.resetFields();
    if (record) storeForm.setFieldsValue({ code: record.code, name: record.name, regionId: record.regionId, address: record.address ?? undefined });
    else if (selection.kind === "region") storeForm.setFieldsValue({ regionId: selection.id });
    setStoreModal({ open: true, record });
  }

  function openUser(record?: OrgUser) {
    userForm.resetFields();
    if (record) {
      userForm.setFieldsValue({
        username: record.username,
        name: record.name,
        role: record.role,
        storeId: record.storeId ?? undefined,
        regionId: record.regionId ?? undefined,
        wecomUserid: record.wecomUserid ?? undefined,
      });
    } else if (selection.kind === "store") {
      userForm.setFieldsValue({ role: "STAFF", storeId: selection.id });
    } else if (selection.kind === "region") {
      userForm.setFieldsValue({ role: "REGIONAL_MANAGER", regionId: selection.id });
    } else if (selection.kind === "hq") {
      userForm.setFieldsValue({ role: "HQ" });
    }
    setUserModal({ open: true, record });
  }

  function openPassword(record: OrgUser) {
    passwordForm.resetFields();
    setPasswordModal({ open: true, record });
  }

  // ---------- 列表 ----------
  const regionColumns: TableColumnsType<OrgRegion> = [
    { title: "区域", dataIndex: "name" },
    { title: "门店数", render: (_, r) => r.stores.length },
    { title: "状态", dataIndex: "isActive", render: (v: boolean) => <StatusTag active={v} /> },
    {
      title: "操作",
      render: (_, r) => (
        <Space>
          <Button size="small" onClick={() => openRegion(r)}>
            编辑
          </Button>
          <ToggleButton active={r.isActive} onConfirm={() => submit(() => setRegionActiveAction(r.id, !r.isActive))} />
        </Space>
      ),
    },
  ];

  const storeColumns: TableColumnsType<OrgStore> = [
    { title: "编码", dataIndex: "code" },
    { title: "门店", dataIndex: "name" },
    { title: "区域", render: (_, s) => regionById.get(s.regionId)?.name ?? "-" },
    { title: "地址", dataIndex: "address", render: (v: string | null) => v ?? "-" },
    { title: "状态", dataIndex: "isActive", render: (v: boolean) => <StatusTag active={v} /> },
    {
      title: "操作",
      render: (_, s) => (
        <Space>
          <Button size="small" onClick={() => openStore(s)}>
            编辑
          </Button>
          <ToggleButton active={s.isActive} onConfirm={() => submit(() => setStoreActiveAction(s.id, !s.isActive))} />
        </Space>
      ),
    },
  ];

  const userColumns: TableColumnsType<OrgUser> = [
    { title: "账号", dataIndex: "username" },
    { title: "姓名", dataIndex: "name" },
    { title: "角色", dataIndex: "role", render: (r: Role) => ROLE_LABELS[r] },
    {
      title: "门店 / 区域",
      render: (_, u) =>
        u.storeId ? (storeById.get(u.storeId)?.name ?? "-") : u.regionId ? (regionById.get(u.regionId)?.name ?? "-") : "总部",
    },
    { title: "状态", dataIndex: "isActive", render: (v: boolean) => <StatusTag active={v} /> },
    ...(showWecom ? [{ title: "企业微信", dataIndex: "wecomUserid", render: (v: string | null) => v ?? <Typography.Text type="secondary">未填</Typography.Text> }] : []),
    {
      title: "操作",
      render: (_, u) => (
        <Space>
          <Button size="small" onClick={() => openUser(u)}>
            编辑
          </Button>
          <Button size="small" onClick={() => openPassword(u)}>
            重置密码
          </Button>
          <ToggleButton
            active={u.isActive}
            disabled={u.id === currentUserId}
            onConfirm={() => submit(() => setUserActiveAction(u.id, !u.isActive))}
          />
        </Space>
      ),
    },
  ];

  const activeRegionOptions = data.regions.filter((r) => r.isActive).map((r) => ({ value: r.id, label: r.name }));
  const activeStoreOptions = allStores.filter((s) => s.isActive).map((s) => ({ value: s.id, label: `${s.code} ${s.name}` }));

  const selectionLabel =
    selection.kind === "all"
      ? "全部"
      : selection.kind === "hq"
        ? "总部"
        : selection.kind === "region"
          ? (regionById.get(selection.id)?.name ?? "")
          : (storeById.get(selection.id)?.name ?? "");

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} md={8}>
        <Card
          title="组织树"
          extra={
            <Button size="small" onClick={() => setSelection({ kind: "all" })}>
              看全部
            </Button>
          }
        >
          <Tree
            treeData={treeData}
            expandedKeys={expandedKeys ?? allTreeKeys}
            onExpand={(keys) => setExpandedKeys(keys)}
            onSelect={onTreeSelect}
            blockNode
          />
        </Card>
      </Col>
      <Col xs={24} md={16}>
        <Card
          title={
            <Space>
              <span>当前范围：</span>
              <Typography.Text strong>{selectionLabel}</Typography.Text>
            </Space>
          }
        >
          <Tabs
            activeKey={activeTab}
            onChange={setActiveTab}
            items={[
              {
                key: "regions",
                label: `区域（${data.regions.length}）`,
                children: (
                  <Space orientation="vertical" style={{ width: "100%" }}>
                    <Button type="primary" onClick={() => openRegion()}>
                      新增区域
                    </Button>
                    <Table rowKey="id" size="small" pagination={false} columns={regionColumns} dataSource={data.regions} />
                  </Space>
                ),
              },
              {
                key: "stores",
                label: `门店（${visibleStores.length}）`,
                children: (
                  <Space orientation="vertical" style={{ width: "100%" }}>
                    <Button type="primary" onClick={() => openStore()}>
                      新增门店
                    </Button>
                    <Table rowKey="id" size="small" pagination={false} columns={storeColumns} dataSource={visibleStores} scroll={{ x: true }} />
                  </Space>
                ),
              },
              {
                key: "users",
                label: `员工（${visibleUsers.length}）`,
                children: (
                  <Space orientation="vertical" style={{ width: "100%" }}>
                    <Button type="primary" onClick={() => openUser()}>
                      新增员工
                    </Button>
                    <Table rowKey="id" size="small" pagination={false} columns={userColumns} dataSource={visibleUsers} scroll={{ x: true }} />
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      </Col>

      {/* 区域表单 */}
      <Modal
        title={regionModal.record ? "编辑区域" : "新增区域"}
        open={regionModal.open}
        confirmLoading={pending}
        onCancel={() => setRegionModal({ open: false })}
        onOk={() => regionForm.submit()}
        destroyOnHidden
      >
        <Form
          form={regionForm}
          name="region"
          layout="vertical"
          onFinish={(values) =>
            submit(
              () => (regionModal.record ? updateRegionAction(regionModal.record.id, values) : createRegionAction(values)),
              () => setRegionModal({ open: false }),
            )
          }
        >
          <Form.Item name="name" label="区域名称" rules={[{ required: true, message: "请输入区域名称" }]}>
            <Input maxLength={50} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 门店表单 */}
      <Modal
        title={storeModal.record ? "编辑门店" : "新增门店"}
        open={storeModal.open}
        confirmLoading={pending}
        onCancel={() => setStoreModal({ open: false })}
        onOk={() => storeForm.submit()}
        destroyOnHidden
      >
        <Form
          form={storeForm}
          name="store"
          layout="vertical"
          onFinish={(values) =>
            submit(
              () => (storeModal.record ? updateStoreAction(storeModal.record.id, values) : createStoreAction(values)),
              () => setStoreModal({ open: false }),
            )
          }
        >
          <Form.Item name="code" label="门店编码" rules={[{ required: true, message: "请输入门店编码，如 S003" }]}>
            <Input maxLength={20} placeholder="如 S003" />
          </Form.Item>
          <Form.Item name="name" label="门店名称" rules={[{ required: true, message: "请输入门店名称" }]}>
            <Input maxLength={50} />
          </Form.Item>
          <Form.Item name="regionId" label="所属区域" rules={[{ required: true, message: "请选择区域" }]}>
            <Select options={activeRegionOptions} placeholder="选择区域" showSearch optionFilterProp="label" />
          </Form.Item>
          <Form.Item name="address" label="地址">
            <Input maxLength={200} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 员工表单 */}
      <Modal
        title={userModal.record ? "编辑员工" : "新增员工"}
        open={userModal.open}
        confirmLoading={pending}
        onCancel={() => setUserModal({ open: false })}
        onOk={() => userForm.submit()}
        destroyOnHidden
      >
        <Form
          form={userForm}
          name="user"
          layout="vertical"
          onFinish={(values) =>
            submit(
              () =>
                userModal.record
                  ? updateUserAction(userModal.record.id, showWecom ? { ...values, wecomUserid: values.wecomUserid ?? "" } : values)
                  : createUserAction({ ...values, username: values.username, password: values.password ?? "" }),
              () => setUserModal({ open: false }),
            )
          }
        >
          <Form.Item name="username" label="登录账号" rules={[{ required: true, message: "请输入登录账号" }]}>
            <Input maxLength={30} disabled={Boolean(userModal.record)} placeholder="小写字母、数字、下划线，3 到 30 位" />
          </Form.Item>
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: "请输入姓名" }]}>
            <Input maxLength={30} />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true, message: "请选择角色" }]}>
            <Select options={ROLE_OPTIONS} />
          </Form.Item>
          {watchedRole === "STAFF" || watchedRole === "STORE_MANAGER" ? (
            <Form.Item name="storeId" label="所属门店" rules={[{ required: true, message: "请选择门店" }]}>
              <Select options={activeStoreOptions} placeholder="选择门店" showSearch optionFilterProp="label" />
            </Form.Item>
          ) : null}
          {watchedRole === "REGIONAL_MANAGER" ? (
            <Form.Item name="regionId" label="所辖区域" rules={[{ required: true, message: "请选择区域" }]}>
              <Select options={activeRegionOptions} placeholder="选择区域" showSearch optionFilterProp="label" />
            </Form.Item>
          ) : null}
          {userModal.record && showWecom ? (
            <Form.Item name="wecomUserid" label="企业微信账号" extra="企业微信管理后台“通讯录”里这个成员的账号（userid）。加好友时按它找跟进员工；留空表示不绑。">
              <Input maxLength={64} placeholder="如 zhangsan" />
            </Form.Item>
          ) : null}
          {userModal.record ? null : (
            <Form.Item name="password" label="初始密码" rules={[{ required: true, min: 6, message: "密码至少 6 位" }]}>
              <Input.Password maxLength={72} autoComplete="new-password" />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* 重置密码 */}
      <Modal
        title={`重置密码：${passwordModal.record?.name ?? ""}`}
        open={passwordModal.open}
        confirmLoading={pending}
        onCancel={() => setPasswordModal({ open: false })}
        onOk={() => passwordForm.submit()}
        destroyOnHidden
      >
        <Form
          form={passwordForm}
          name="password"
          layout="vertical"
          onFinish={(values) =>
            submit(
              () => resetUserPasswordAction(passwordModal.record!.id, values.password),
              () => setPasswordModal({ open: false }),
            )
          }
        >
          <Form.Item name="password" label="新密码" rules={[{ required: true, min: 6, message: "密码至少 6 位" }]}>
            <Input.Password maxLength={72} autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </Row>
  );
}
