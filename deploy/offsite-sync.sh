#!/usr/bin/env bash
# 把每家的备份同步到另一个地域的对象存储（口径第 24 节，crontab 每天 05:00 调）。
# 备份本来就是加密的（口令不在对象存储上）；只往上加、不删远端的（rclone copy）：本机只留 14 天，
# 对象存储开版本保留和生命周期规则（比如 180 天后删），误删、被勒索也能找回来。
# 配置在 $ERP_ROOT/ops.env：OFFSITE_REMOTE=rclone 的远端路径，比如 oss:dianyoushu-erp-backup（rclone config 先配好 oss 这个远端，
# 用只能上传、不能删除的子账号密钥）。用法：deploy/offsite-sync.sh
. "$(dirname "$0")/lib.sh"

[ -n "${OFFSITE_REMOTE:-}" ] || die "没配异地备份：在 $ERP_ROOT/ops.env 里写 OFFSITE_REMOTE（见 deploy/ops.env.example）"
command -v rclone > /dev/null || die "没装 rclone：apt-get install -y rclone"

failed=()
stale=()
for t in $(list_tenants); do
  dir=$(tenant_dir "$t")/backups
  [ -d "$dir" ] || continue
  # 本机最新的备份超过 26 小时：同步过去的也是旧的，算失败（复查第 84 条）
  if [ -z "$(find "$dir" -maxdepth 1 -name '*.dump.enc' -mmin -1560 2> /dev/null)" ]; then stale+=("$t"); fi
  log "$t：同步备份到 $OFFSITE_REMOTE/$t"
  if ! rclone copy "$dir" "$OFFSITE_REMOTE/$t" --include "*.dump.enc" --immutable --checksum; then
    failed+=("$t")
  fi
done
if [ ${#failed[@]} -gt 0 ]; then
  alert "备份同步到对象存储失败：${failed[*]}"
  exit 1
fi
if [ ${#stale[@]} -gt 0 ]; then
  alert "备份同步了，但这几家本机最新的备份超过 26 小时（每天的备份停了）：${stale[*]}"
  exit 1
fi
mkdir -p "$ERP_ROOT/.ops"
date +%s > "$ERP_ROOT/.ops/last-offsite"
log "备份同步完成"
