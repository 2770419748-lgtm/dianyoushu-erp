// 操作日志里 action 的中文说明。新加动作时在这里补一行，日志页就能显示成人话。

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  login: "登录",
  login_failed: "登录失败",
  logout: "登出",
  "region.create": "新增区域",
  "region.update": "修改区域",
  "region.activate": "启用区域",
  "region.deactivate": "停用区域",
  "store.create": "新增门店",
  "store.update": "修改门店",
  "store.activate": "启用门店",
  "store.deactivate": "停用门店",
  "user.create": "新增员工",
  "user.update": "修改员工",
  "user.reset_password": "重置密码",
  "user.activate": "启用员工",
  "user.deactivate": "停用员工",
  "category.create": "新增品类",
  "category.update": "修改品类",
  "brand.create": "新增品牌",
  "brand.update": "修改品牌",
  "model.create": "新增型号",
  "model.update": "修改型号",
  "sku.create": "新增商品",
  "sku.update": "修改商品",
  "sku.activate": "启用商品",
  "sku.deactivate": "停用商品",
  "price.set": "设置门店售价",
  "price.reset": "恢复指导价",
  "purchase.create": "新建采购单",
  "purchase.update": "修改采购单",
  "purchase.submit": "提交采购单",
  "purchase.void": "作废采购单",
  "purchase.receive": "到货入库",
  "transfer.create": "申请调拨",
  "transfer.ship": "调拨发出",
  "transfer.receive": "调拨收货",
  "transfer.void": "作废调拨",
  "stocktake.create": "发起盘点",
  "stocktake.count": "录入实盘",
  "stocktake.confirm": "确认盘点",
  "stocktake.void": "作废盘点",
  "customer.create": "新增客户",
  "customer.update": "修改客户",
  "sale.create": "开单",
  "sale.void": "作废销售单",
};

export const AUDIT_ENTITY_LABELS: Record<string, string> = {
  region: "区域",
  store: "门店",
  user: "员工",
  category: "品类",
  brand: "品牌",
  model: "型号",
  sku: "商品",
  purchase_order: "采购单",
  transfer_order: "调拨单",
  stocktake: "盘点单",
  customer: "客户",
  sales_order: "销售单",
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

export function auditEntityLabel(entity: string | null): string {
  if (!entity) return "";
  return AUDIT_ENTITY_LABELS[entity] ?? entity;
}
