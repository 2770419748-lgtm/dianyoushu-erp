#!/usr/bin/env bash
# 恢复演练（口径第 24 节，crontab 每月 1 号调）：每家拿最新的一份备份，解开、恢复进这家数据库里的临时库 restore_drill，
# 核对迁移记录条数和正式库一样、每张表都在、有数据的表恢复出来也有数据，然后删掉临时库。不动正式库。
# 用法：deploy/restore-drill.sh [代号]（不写就每家都做）
. "$(dirname "$0")/lib.sh"

if [ -n "${1:-}" ]; then
  require_tenant "$1"
  targets=("$1")
else
  mapfile -t targets < <(list_tenants)
fi

# 在这家的备份容器里做（里面有 pg_restore、openssl 和备份口令；连这家的 db 容器）
DRILL='set -euo pipefail
f=$(ls -1t /backups/*.dump.enc 2>/dev/null | head -1)
[ -n "$f" ] || { echo "没有备份文件"; exit 1; }
echo "最新的备份：$(basename "$f")"
export PGHOST=db PGUSER=erp
dropdb --if-exists restore_drill
createdb restore_drill
trap "dropdb --if-exists restore_drill" EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$f" | pg_restore -d restore_drill --no-owner --exit-on-error
q="SELECT count(*) FROM information_schema.tables WHERE table_schema = '"'"'public'"'"'"
live_tables=$(psql -d dianyoushu_erp -tAc "$q")
drill_tables=$(psql -d restore_drill -tAc "$q")
live_mig=$(psql -d dianyoushu_erp -tAc "SELECT count(*) FROM _prisma_migrations")
drill_mig=$(psql -d restore_drill -tAc "SELECT count(*) FROM _prisma_migrations")
empty=$(psql -d restore_drill -tAc "SELECT count(*) FROM users")
echo "表：正式库 $live_tables 张，恢复出来 $drill_tables 张；迁移记录：$live_mig / $drill_mig；员工：$empty 个"
[ "$live_tables" = "$drill_tables" ] || { echo "表的数量对不上"; exit 1; }
[ "$live_mig" = "$drill_mig" ] || echo "注意：迁移记录条数不一样（备份之后升过级？），看一下是不是这个原因"
[ "$empty" -gt 0 ] || { echo "恢复出来的库里一个员工都没有"; exit 1; }'

failed=()
for t in "${targets[@]}"; do
  log "$t：恢复演练"
  if ! dc "$t" exec -T backup bash -c "$DRILL"; then
    failed+=("$t")
  fi
done
if [ ${#failed[@]} -gt 0 ]; then
  alert "恢复演练失败：${failed[*]}（备份可能有问题，马上看）"
  exit 1
fi
log "恢复演练全部通过"
