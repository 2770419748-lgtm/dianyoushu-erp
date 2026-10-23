#!/usr/bin/env bash
# 恢复演练（口径第 24 节，crontab 每月 1 号调）：每家拿最新的一份备份，解开、恢复进这家数据库里的临时库 restore_drill，
# 最新一份超过 26 小时算失败（每天的备份停了）；逐张表列出恢复出来和正式库的行数，正式库有的表恢复出来没有、
# 员工是空的算失败（正式库备份之后还在记账，行数本来对不上，只列出来，正式库有数据而恢复出来是空的标出来）；
# 迁移记录条数不一样只提示。最后删掉临时库，不动正式库。
# 用法：deploy/restore-drill.sh [代号]（不写就每家都做）
. "$(dirname "$0")/lib.sh"

if [ -n "${1:-}" ]; then
  require_tenant "$1"
  targets=("$1")
else
  mapfile -t targets < <(list_tenants)
fi

# 在这家的备份容器里做（里面有 pg_restore、openssl 和备份口令；连这家的 db 容器）：核对的那一段在 restore-drill-check.sh
CHECK="$(dirname "$0")/restore-drill-check.sh"

failed=()
for t in "${targets[@]}"; do
  log "$t：恢复演练"
  if ! dc "$t" exec -T backup bash -s < "$CHECK"; then
    failed+=("$t")
  fi
done
if [ ${#failed[@]} -gt 0 ]; then
  alert "恢复演练失败：${failed[*]}（备份可能有问题，马上看）"
  exit 1
fi
log "恢复演练全部通过"
