#!/bin/sh
# 数据库定时备份（docker compose 的 backup 服务跑这个脚本）。
# - 每天凌晨 3 点（北京时间）用 pg_dump 导出一份压缩备份，用 BACKUP_PASSPHRASE 加密（openssl AES-256-CBC + PBKDF2）后
#   放到 /backups（宿主机的 ./backups 目录），文件名 .dump.enc，留 14 天（口径第 20 节：备份里不能有明文）。
# - 没配 BACKUP_PASSPHRASE 拒绝启动。口令要另外离线存一份，丢了备份打不开。
# - 手动备份一份（比如升级前）：docker compose exec backup sh /backup.sh now
# - 解密：openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in 某个.dump.enc -out 某个.dump（见 docs/部署.md 恢复演练）
# - 这只是“同一台服务器上的备份”；硬盘坏了会一起丢，所以还要把 ./backups 同步到对象存储（见 docs/部署.md 上线前检查清单）。
# - 连哪个库：默认 db 容器里的 dianyoushu_erp（用户 erp）；CI 里用 PGHOST、PGUSER、PGDATABASE 指到临时库。
set -eu

if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  echo "[backup] 没有设置 BACKUP_PASSPHRASE，拒绝备份（备份要加密，口径第 20 节）；在 .env 里配上再启动" >&2
  exit 1
fi

DB_HOST="${PGHOST:-db}"
DB_USER="${PGUSER:-erp}"
DB_NAME="${PGDATABASE:-dianyoushu_erp}"

backup_once() {
  file="/backups/${DB_NAME}-$(date +%Y%m%d-%H%M%S).dump.enc"
  failed="/tmp/backup-pg_dump-failed"
  rm -f "$failed"
  # 导出和加密走管道，明文不落盘。sh 的管道只看最后一个命令的结果，pg_dump 失败要自己记下来，不然会留下一份坏备份
  { pg_dump -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -Fc --no-owner || touch "$failed"; } \
    | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$file.tmp"
  if [ -e "$failed" ]; then
    rm -f "$file.tmp" "$failed"
    echo "[backup] $(date '+%F %T') pg_dump 失败，这次没有备份" >&2
    return 1
  fi
  mv "$file.tmp" "$file"
  echo "[backup] $(date '+%F %T') 完成 $file（$(du -h "$file" | cut -f1)）"
  find /backups -name "${DB_NAME}-*.dump.enc" -mtime +14 -delete
}

if [ "${1:-}" = "now" ]; then
  backup_once
  exit 0
fi

echo "[backup] 已启动，每天 03:00 备份一次（加密）"
while true; do
  now=$(date +%s)
  next=$(date -d "03:00" +%s)
  if [ "$next" -le "$now" ]; then next=$(date -d "tomorrow 03:00" +%s); fi
  sleep $((next - now))
  backup_once || echo "[backup] $(date '+%F %T') 备份失败，明天再试；请检查数据库是否正常"
done
