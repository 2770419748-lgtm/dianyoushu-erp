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
};

export const AUDIT_ENTITY_LABELS: Record<string, string> = {
  region: "区域",
  store: "门店",
  user: "员工",
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

export function auditEntityLabel(entity: string | null): string {
  if (!entity) return "";
  return AUDIT_ENTITY_LABELS[entity] ?? entity;
}
