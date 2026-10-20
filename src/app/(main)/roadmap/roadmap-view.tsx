"use client";

import { Card, Col, Row, Space, Tag, Typography } from "antd";

interface Item {
  name: string;
  why: string; // 为什么这版不做
  hook: string; // 以后从哪儿接进来
}

// 内容对应方案文档 4.3、9.3。新想法只往这里加，不进开发清单。
const LATER: Item[] = [
  {
    name: "人事：考勤、排班、工资、绩效",
    why: "和进销存主链路无关，规则每家公司都不一样；工资是敏感数据，演示版不碰。",
    hook: "先接排班，能和看板的员工业绩排名对上。",
  },
  {
    name: "售后：备用机、外送厂家、维修配件进销存",
    why: "接件、报价、维修、取机结算的主线已经做了；这几项各是一条独立链路，维修配件费现在手填。",
    hook: "屏幕、电池建成小件，维修时从库存出库；外送加一个状态和运单号。",
  },
  {
    name: "发票与财务核算",
    why: "应收应付、总账要按会计口径做，演示版只做到收银对账。",
    hook: "支付明细和日结已按支付方式汇总，可以直接作为记账来源。",
  },
  {
    name: "审批流 / OA",
    why: "演示版用角色权限代替审批，比如作废单据要店长、日结要店长确认。",
    hook: "在作废、调拨、改价这几处加“待审批”状态即可。",
  },
  {
    name: "国补",
    why: "补贴政策按地区和时间变，还要对接政府平台，演示里跑不了真流程。",
    hook: "收款方式里加一种“国补”，日结按方式对账的逻辑不用改。",
  },
  {
    name: "运营商系统接口、号码库存、话费代收",
    why: "登记、开通、佣金政策和按月对账已经做了；运营商渠道系统不对门店开放接口，现在靠店员确认和导入结算单，演示里用模拟器。",
    hook: "对账是一个纯函数（结算单行 → 业务单），拿到接口数据喂给同一个函数就行；白卡、靓号按小件管数量。",
  },
  {
    name: "物流对接",
    why: "调拨在门店之间人工送，演示版只记在途状态。",
    hook: "调拨单加运单号和轨迹查询。",
  },
  {
    name: "会员营销：积分、券、短信",
    why: "要有真实客户和真实消费才有意义，演示数据做出来是摆设。",
    hook: "客户档案和购买记录已经有了。",
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
  "财务只做了收银对账，没有发票、应收应付、总账。",
  "权限做到角色和门店级，没做到字段级。",
  "没对接扫码枪以外的外接硬件。",
  "没做数据迁移工具。",
  "没经过真实门店的压力和安全测试。",
];

export function RoadmapView() {
  return (
    <Space orientation="vertical" size="large" style={{ width: "100%", maxWidth: 1100 }}>
      <Card title="后续规划：知道，但这一版故意不做">
        <Typography.Paragraph type="secondary">
          演示版先做手机门店每天离不开的主链路：进货、串号库存、调拨盘点、开单收银、回收、日结、看板，再补了服务权益、企业微信（模拟）、售后维修、运营商业务。下面这些都清楚它们在真实 ERP 里的位置，也想好了以后从哪儿接进来。
        </Typography.Paragraph>
        <Row gutter={[12, 12]}>
          {LATER.map((item) => (
            <Col key={item.name} xs={24} md={12} xl={8}>
              <Card size="small" title={item.name} style={{ height: "100%" }}>
                <Typography.Paragraph style={{ marginBottom: 8 }}>
                  <Tag>为什么不做</Tag>
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
