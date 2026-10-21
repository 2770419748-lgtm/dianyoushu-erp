"use client";

import { Card, Col, Row, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";

interface Item {
  name: string;
  why: string; // 为什么这版不做
  hook: string; // 以后从哪儿接进来
}

type Stage = "done" | "next" | "todo";

interface RouteItem {
  order: number;
  name: string;
  stage: Stage;
  what: string; // 做了什么 / 要做什么
}

// v1.0 之后的路线（方案文档第 16 节），按顺序一项一项做；做完一项就把 stage 改成 done，下一项改成 next。
const ROUTE: RouteItem[] = [
  { order: 1, name: "售后维修", stage: "done", what: "接件扫码带出购买记录和保修、碎屏险、延保；报价时校验谁来付；修好取机结算进日结；客户的机器不动库存。" },
  { order: 2, name: "运营商业务", stage: "done", what: "号卡、合约机、宽带登记和确认开通；总部配佣金政策；按月导入运营商结算单对账，标出金额不符、没登记、漏给和返销。" },
  { order: 3, name: "国补", stage: "done", what: "总部配政策；开单填资格码立减、校验每人每类一台；国补单从提交审核到到账全程跟踪；退货作废自动撤销。" },
  { order: 4, name: "发票", stage: "done", what: "销售单上申请开票，明细按税率算税额；总部开具、红冲，纸质票到店；退货作废自动撤回或标需红冲；国补单自动带发票号码。开票接口先做模拟。" },
  { order: 5, name: "审批", stage: "done", what: "开单让利、低于成本卖、大额退款、作废、大额调拨、盘亏，总部按场景配规则（默认全关）；批了系统按当时的数据把事做掉，做不成写明原因。" },
  { order: 6, name: "企业微信剩下的", stage: "done", what: "聊天侧边栏（自己的登录票、只看自己的好友、按完整手机号认领）、微信客服规则答复和转人工、在职转接和离职继承，真接口写好，演示用模拟走真实回调。" },
  { order: 7, name: "AI 智能提醒", stage: "done", what: "数字由程序算，模型只负责排先后、写“今日待办”；没有模型时用模板兜底。" },
  { order: 8, name: "人事、财务、OA", stage: "next", what: "从头自建、不接钉钉飞书。已做：员工档案、公告、排班、打卡考勤、请假（审批扩成两级、可以不挂门店）、费用报销；在做：提成和工资条、门店收支和利润表。" },
];

const STAGE: Record<Stage, { label: string; color: string }> = {
  done: { label: "已做", color: "green" },
  next: { label: "下一项", color: "blue" },
  todo: { label: "待做", color: "default" },
};

// 知道、但还没排进路线的（方案文档 4.3、9.3、16.2 末尾）。新想法只往这里加，不进开发清单。
const LATER: Item[] = [
  {
    name: "售后：备用机、外送厂家、维修配件进销存",
    why: "接件、报价、维修、取机结算的主线已经做了；这几项各是一条独立链路，维修配件费现在手填。",
    hook: "屏幕、电池建成小件，维修时从库存出库；外送加一个状态和运单号。",
  },
  {
    name: "运营商系统接口、号码库存、话费代收",
    why: "登记、开通、佣金政策和按月对账已经做了；运营商渠道系统不对门店开放接口，现在靠店员确认和导入结算单，演示里用模拟器。",
    hook: "对账是一个纯函数（结算单行 → 业务单），拿到接口数据喂给同一个函数就行；白卡、靓号按小件管数量。",
  },
  {
    name: "发票：对接税控和数电票接口、PDF 版式、合并拆分",
    why: "申请、开具、红冲、到店和国补联动已经做了；开票接口要公司的税务数字账户，现在号码靠模拟或登记。",
    hook: "开具和红冲都是一个服务函数，接口开好后把返回的号码交给同一个函数就行。",
  },
  {
    name: "国补：对接各省平台、上传资料、地方补贴",
    why: "门店这一侧（算补贴、校验、跟踪到账）已经做了；各省平台不对门店系统开放，审核和到账现在靠导入平台结果，演示里用模拟器。",
    hook: "平台结果按核销码落到国补单上已经是一个函数，接口拿到结果直接调；地方叠加补贴在政策上多一层。",
  },
  {
    name: "物流对接",
    why: "调拨在门店之间人工送，演示版只记在途状态。",
    hook: "调拨单加运单号和轨迹查询。",
  },
  {
    name: "会员营销：积分、券、短信",
    why: "要有真实客户和真实消费才有意义，演示数据做出来是摆设。",
    hook: "客户档案、购买记录和企业微信好友关系已经有了。",
  },
  {
    name: "线上渠道库存同步（京东到家、抖店）",
    why: "要平台开放接口和商家资质。",
    hook: "所有库存增减都走同一个服务、有流水，在流水层加同步任务就行。",
  },
  {
    name: "外接硬件：扫码枪、小票打印机、POS",
    why: "打印机和 POS 要装本地驱动或桥接程序，网页直接调不了。",
    hook: "手机相机扫码已经做了；扫码枪本身就是键盘输入，现在的输入框直接能用。",
  },
  {
    name: "原生 App",
    why: "网页加“添加到桌面”已经够门店用，一个人维护两套代码不划算。",
    hook: "已留好路：业务都在服务层、扫码封装成一个接口，套壳打包时只换扫码实现。",
  },
];

const GAPS = [
  "没做高并发和高可用，一台机器跑。",
  "财务只做了收银对账和发票，应收应付、总账还在路线上。",
  "权限做到角色和门店级，没做到字段级。",
  "运营商、国补、企业微信这些外部系统，演示里是模拟的，真接要公司的账号和资质。",
  "没做数据迁移工具。",
  "没经过真实门店的压力和安全测试。",
];

export function RoadmapView() {
  const columns: TableColumnsType<RouteItem> = [
    { title: "顺序", dataIndex: "order", width: 60, align: "center" },
    { title: "项", dataIndex: "name", width: 140, render: (v: string, r) => <Typography.Text strong={r.stage !== "todo"}>{v}</Typography.Text> },
    { title: "状态", dataIndex: "stage", width: 90, render: (s: Stage) => <Tag color={STAGE[s].color}>{STAGE[s].label}</Tag> },
    { title: "做了什么 / 要做什么", dataIndex: "what" },
  ];
  return (
    <Space orientation="vertical" size="large" style={{ width: "100%", maxWidth: 1100 }}>
      <Card title="路线图：v1.0 之后按顺序一项一项做">
        <Typography.Paragraph type="secondary">
          演示版先做了手机门店每天离不开的主链路：进货、串号库存、调拨盘点、开单收银、回收、日结、看板，再补了服务权益和企业微信（模拟）。之后按下面的顺序逐项做，每做完一项都是能演示的状态；外部系统先做模拟，人事、财务、OA 从头自建。
        </Typography.Paragraph>
        <Table rowKey="order" size="small" columns={columns} dataSource={ROUTE} pagination={false} scroll={{ x: true }} />
      </Card>
      <Card title="知道，但还没排进路线">
        <Row gutter={[12, 12]}>
          {LATER.map((item) => (
            <Col key={item.name} xs={24} md={12} xl={8}>
              <Card size="small" title={item.name} style={{ height: "100%" }}>
                <Typography.Paragraph style={{ marginBottom: 8 }}>
                  <Tag>为什么还没做</Tag>
                  {item.why}
                </Typography.Paragraph>
                <Typography.Paragraph style={{ marginBottom: 0 }}>
                  <Tag color="blue">以后怎么接</Tag>
                  {item.hook}
                </Typography.Paragraph>
              </Card>
            </Col>
          ))}
        </Row>
      </Card>
      <Card title="和真正的 ERP 差在哪">
        <ul style={{ margin: 0, paddingInlineStart: 20, lineHeight: 2 }}>
          {GAPS.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      </Card>
    </Space>
  );
}
