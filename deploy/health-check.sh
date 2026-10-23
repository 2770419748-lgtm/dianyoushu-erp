#!/usr/bin/env bash
# 每分钟的巡检（口径第 24 节，crontab 调）。在服务器自己身上看，所以服务器整个死机时它也发不出告警——外部拨测是另一道。
# - 共享 Caddy 在不在跑；每家：应用的健康检查、经共享 Caddy 按这家的站点地址请求 /api/health（和客户从外面访问走同一条路），
#   连续 3 次不通告警，恢复了再说一声；
# - 每家的备份：备份容器在不在跑、最新一份备份超过 26 小时（复查第 84 条）；
# - 定时任务好久没成功跑过：每日任务、对账超过 26 小时，智能提醒超过 14 小时；备份同步配了却超过 26 小时没成功（包括从来没成功过）；
# - 硬盘用了 80% 以上。
# 开户不满这么久的不算。同一件事一小时只告警一次（没发出去下一分钟再试）。用法：deploy/health-check.sh
. "$(dirname "$0")/lib.sh"

now=$(date +%s)
problems=0
hours_ago() { echo $(((now - $1) / 3600)); }

# 共享 Caddy：没在跑就所有客户都打不开
if [ -d "$PROXY_DIR/sites" ] && [ -n "$(ls "$PROXY_DIR"/sites/*.caddy 2> /dev/null)" ]; then
  pid=$(proxy_dc ps -q caddy 2> /dev/null || true)
  if [ -z "$pid" ] || [ "$(docker inspect -f '{{.State.Running}}' "$pid" 2> /dev/null)" != true ]; then
    problems=$((problems + 1))
    alert_throttled "proxy" "共享 Caddy 没在跑，所有客户都打不开：cd $APP_DIR && docker compose -p erp-proxy -f deploy/proxy/docker-compose.yml logs caddy"
  fi
fi

for t in $(list_tenants); do
  dir=$(tenant_dir "$t")
  mkdir -p "$dir/.ops"
  born=$(stat -c %Y "$dir/.env")

  # 应用 + 经共享 Caddy 访问
  id=$(app_container "$t" || true)
  status=missing
  [ -n "$id" ] && status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2> /dev/null || echo missing)
  why=""
  if [ "$status" != healthy ]; then
    why="应用 $status"
  elif [ -f "$PROXY_DIR/sites/$t.caddy" ] && ! site_health "$t"; then
    why="应用正常，但经共享 Caddy 访问 $(tenant_site "$t") 不通"
  fi
  fails=$(cat "$dir/.ops/health-fails" 2> /dev/null || echo 0)
  if [ -z "$why" ]; then
    if [ "$fails" -ge 3 ]; then alert "$t 恢复了（之前连续 $fails 次健康检查不通）"; fi
    echo 0 > "$dir/.ops/health-fails"
  else
    fails=$((fails + 1))
    echo "$fails" > "$dir/.ops/health-fails"
    problems=$((problems + 1))
    log "$t 健康检查不通（$why），连续第 $fails 次"
    if [ "$fails" -ge 3 ]; then alert_throttled "health-$t" "$t 连续 $fails 次健康检查不通（$why）：deploy/dc.sh $t logs app"; fi
  fi

  # 备份：备份容器要在跑，最新一份不能超过 26 小时（开户不满 26 小时的不算）
  if [ -z "$(dc "$t" ps -q backup 2> /dev/null || true)" ]; then
    problems=$((problems + 1))
    alert_throttled "backup-down-$t" "$t 的备份容器没在跑，每天的备份停了：deploy/dc.sh $t up -d backup"
  fi
  newest=$(find "$dir/backups" -maxdepth 1 -name '*.dump.enc' -printf '%T@\n' 2> /dev/null | sort -n | tail -1 | cut -d. -f1)
  if [ $((now - born)) -gt $((26 * 3600)) ]; then
    if [ -z "$newest" ]; then
      problems=$((problems + 1))
      alert_throttled "backup-none-$t" "$t 一份备份都没有：deploy/dc.sh $t logs backup"
    elif [ $((now - newest)) -gt $((26 * 3600)) ]; then
      problems=$((problems + 1))
      alert_throttled "backup-old-$t" "$t 最新一份备份是 $(hours_ago "$newest") 小时前的，每天的备份停了：deploy/dc.sh $t logs backup"
    fi
  fi

  # 定时任务好久没成功
  for spec in "daily:26" "db-check:26" "alerts-run:14"; do
    task=${spec%%:*}
    hours=${spec##*:}
    last=$(cat "$dir/.ops/last-$task" 2> /dev/null || echo "$born")
    if [ $((now - last)) -gt $((hours * 3600)) ]; then
      problems=$((problems + 1))
      alert_throttled "stale-$t-$task" "$t 的定时任务 $task 超过 $hours 小时没成功跑过：看 crontab 和 /var/log/erp/ 的日志"
    fi
  done
done

# 备份同步：配了 OFFSITE_REMOTE 就要每天成功一次；从来没成功过的，从配上的时候（ops.env 的修改时间）算
if [ -n "${OFFSITE_REMOTE:-}" ]; then
  since=$(stat -c %Y "$ERP_ROOT/ops.env" 2> /dev/null || echo "$now")
  last=$(cat "$ERP_ROOT/.ops/last-offsite" 2> /dev/null || echo "$since")
  if [ $((now - last)) -gt $((26 * 3600)) ]; then
    problems=$((problems + 1))
    alert_throttled "stale-offsite" "备份同步到对象存储超过 26 小时没成功：看 /var/log/erp/offsite.log"
  fi
fi

used=$(df -P "$ERP_ROOT" | awk 'NR==2 { gsub("%", "", $5); print $5 }')
if [ "${used:-0}" -ge 80 ]; then
  problems=$((problems + 1))
  alert_throttled "disk" "硬盘用了 ${used}%：清旧镜像（docker image prune）、看备份和日志目录"
fi

[ "$problems" -eq 0 ] && log "巡检正常"
exit 0
