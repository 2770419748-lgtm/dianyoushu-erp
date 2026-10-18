#!/bin/sh
# 数据库定时备份（docker compose 的 backup 服务跑这个脚本）。
# - 每天凌晨 3 点（北京时间）用 pg_dump 导出一份压缩备份到 /backups（宿主机的 ./backups 目录），留 14 天。
# - 手动备份一份（比如升级前）：docker compose exec backup sh /backup.sh now
# - 这只是“同一台服务器上的备份”；硬盘坏了会一起丢，所以还要把 ./backups 同步到对象存储（见 docs/部署.md 上线前检查清单）。
set -eu

backup_once() {
  file="/backups/dianyoushu_erp-$(date +%Y%m%d-%H%M%S).dump"
  pg_dump -h db -U erp -d dianyoushu_erp -Fc --no-owner -f "$file.tmp"
  mv "$file.tmp" "$file"
  echo "[backup] $(date '+%F %T') 完成 $file（$(du -h "$file" | cut -f1)）"
  find /backups -name 'dianyoushu_erp-*.dump' -mtime +14 -delete
}

if [ "${1:-}" = "now" ]; then
  backup_once
  exit 0
fi

echo "[backup] 已启动，每天 03:00 备份一次"
while true; do
  now=$(date +%s)
  next=$(date -d "03:00" +%s)
  if [ "$next" -le "$now" ]; then next=$(date -d "tomorrow 03:00" +%s); fi
  sleep $((next - now))
  backup_once || echo "[backup] $(date '+%F %T') 备份失败，明天再试；请检查数据库是否正常"
done
