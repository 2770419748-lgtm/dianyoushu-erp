#!/usr/bin/env bash
# 每分钟的巡检（口径第 24 节，crontab 调）。在服务器自己身上看，所以服务器整个死机时它也发不出告警——外部拨测是另一道。
# - 每家应用的健康检查：连续 3 次不通告警，恢复了再说一声；
# - 定时任务好久没成功跑过：每日任务、对账、备份同步超过 26 小时，智能提醒超过 14 小时（开户不满这么久的不算）；
# - 硬盘用了 80% 以上。
# 同一件事一小时只告警一次。用法：deploy/health-check.sh
. "$(dirname "$0")/lib.sh"

now=$(date +%s)
problems=0

for t in $(list_tenants); do
  dir=$(tenant_dir "$t")
  mkdir -p "$dir/.ops"
  id=$(app_container "$t" || true)
  status=missing
  [ -n "$id" ] && status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo missing)
  fails=$(cat "$dir/.ops/health-fails" 2>/dev/null || echo 0)
  if [ "$status" = healthy ]; then
    if [ "$fails" -ge 3 ]; then alert "$t 恢复了（之前连续 $fails 次健康检查不通）"; fi
    echo 0 > "$dir/.ops/health-fails"
  else
    fails=$((fails + 1))
    echo "$fails" > "$dir/.ops/health-fails"
    problems=$((problems + 1))
    log "$t 健康检查不通（$status），连续第 $fails 次"
    if [ "$fails" -ge 3 ]; then alert_throttled "health-$t" "$t 连续 $fails 次健康检查不通（$status）：docker compose -p erp-$t logs app"; fi
  fi

  # 定时任务好久没成功：开户时间按 .env 的修改时间算，开户不满这么久的不算
  born=$(stat -c %Y "$dir/.env")
  for spec in "daily:26" "db-check:26" "alerts-run:14"; do
    task=${spec%%:*}
    hours=${spec##*:}
    last=$(cat "$dir/.ops/last-$task" 2>/dev/null || echo "$born")
    if [ $((now - last)) -gt $((hours * 3600)) ]; then
      problems=$((problems + 1))
      alert_throttled "stale-$t-$task" "$t 的定时任务 $task 超过 $hours 小时没成功跑过：看 crontab 和 deploy/run-all.sh 的日志"
    fi
  done
done

if [ -n "${OFFSITE_REMOTE:-}" ]; then
  last=$(cat "$ERP_ROOT/.ops/last-offsite" 2>/dev/null || echo 0)
  if [ "$last" -gt 0 ] && [ $((now - last)) -gt $((26 * 3600)) ]; then
    problems=$((problems + 1))
    alert_throttled "stale-offsite" "备份同步到对象存储超过 26 小时没成功：看 deploy/offsite-sync.sh 的日志"
  fi
fi

used=$(df -P "$ERP_ROOT" | awk 'NR==2 { gsub("%", "", $5); print $5 }')
if [ "${used:-0}" -ge 80 ]; then
  problems=$((problems + 1))
  alert_throttled "disk" "硬盘用了 ${used}%：清旧镜像（docker image prune）、看备份和日志目录"
fi

[ "$problems" -eq 0 ] && log "巡检正常"
exit 0
