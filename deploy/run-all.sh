#!/usr/bin/env bash
# 给每家客户跑一个定时任务（口径第 24 节，crontab 调）：pnpm daily、pnpm alerts:run、pnpm db:check。
# 一家失败不影响别家，跑完有失败的告警、退出码 1；成功的记下时间（$TENANT/.ops/last-<任务>），巡检据此发现“好久没成功跑过”。
# 用法：deploy/run-all.sh daily | alerts:run | db:check
. "$(dirname "$0")/lib.sh"

TASK=${1:-}
case "$TASK" in
  daily | alerts:run | db:check) ;;
  *) die "用法：deploy/run-all.sh daily | alerts:run | db:check" ;;
esac

failed=()
for t in $(list_tenants); do
  log "$t：pnpm $TASK"
  if dc "$t" run --rm -T tools pnpm -s "$TASK"; then
    mkdir -p "$(tenant_dir "$t")/.ops"
    date +%s > "$(tenant_dir "$t")/.ops/last-${TASK//:/-}"
  else
    failed+=("$t")
  fi
done
if [ ${#failed[@]} -gt 0 ]; then
  alert "定时任务 pnpm $TASK 失败：${failed[*]}"
  exit 1
fi
log "pnpm $TASK 全部跑完"
