#!/usr/bin/env bash
# 下线一家客户（口径第 21、24 节：客户不续了、数据留满 90 天以后；或者开户开了一半要重来）：
# 先手动备份一份 → 停掉这家的容器 → 共享 Caddy 拿掉这家的站点 → 目录挪到 $ERP_ROOT/removed/<代号>-<时间>/（里面有备份和 .env）。
# 默认留着库卷：老客户回来续费，用 deploy/tenant-restore.sh <代号> 原样起回来（不要用 tenant-new.sh 重开）。
# 加 --purge 连库卷一起删（真删，复查第 93 条）：要再输一遍代号确认；开好了的客户，下线前这份备份没做成就不删。
# 删之前确认备份能恢复（deploy/restore-drill.sh <代号>）、已经整库导出交给客户。
# 用法：deploy/tenant-remove.sh <代号> [--purge]（--purge 从标准输入读确认的代号，脚本里可以 echo <代号> | deploy/tenant-remove.sh <代号> --purge）
. "$(dirname "$0")/lib.sh"

CODE=${1:-}
PURGE=${2:-}
valid_code "$CODE" || die "用法：deploy/tenant-remove.sh <代号> [--purge]"
[ -z "$PURGE" ] || [ "$PURGE" = --purge ] || die "不认识的参数：$PURGE"
DIR=$(tenant_dir "$CODE")
[ -d "$DIR" ] || die "没有这家客户：$DIR"

if [ "$PURGE" = --purge ]; then
  printf '要连数据库一起删掉 %s（删了只能用备份恢复）。确认请再输一遍代号：' "$CODE" >&2
  answer=""
  read -r answer || true
  [ "$answer" = "$CODE" ] || die "输入的代号对不上，什么都没动"
fi

if [ -f "$DIR/.env" ] && [ -n "$(current_tag "$CODE")" ]; then
  # 开好了的客户（tenant-new.sh 跑完记“开户完成”）下线前要备份；开了一半的还没有数据，不用
  if grep -q "开户完成" "$DIR/.deploy/history.log" 2> /dev/null; then
    log "下线前再备份一份"
    # 用 run 不用 exec：备份容器没在跑（比如停过）也能备，数据库没起会先起
    if ! dc "$CODE" run --rm -T backup now; then
      [ "$PURGE" = --purge ] && die "下线前的备份没做成，没删库、什么都没动：先 deploy/dc.sh $CODE logs backup 看原因"
      warn "下线前的备份没做成；库卷留着，之前的备份在 $DIR/backups"
    fi
  fi
  log "停掉 $CODE 的容器$([ "$PURGE" = --purge ] && echo "，删掉数据库卷")"
  if [ "$PURGE" = --purge ]; then dc "$CODE" down -v --remove-orphans; else dc "$CODE" down --remove-orphans; fi
fi

if [ -f "$PROXY_DIR/sites/$CODE.caddy" ]; then
  log "共享 Caddy 拿掉 $CODE 的站点"
  rm -f "$PROXY_DIR/sites/$CODE.caddy"
  if [ -n "$(proxy_dc ps -q caddy 2>/dev/null)" ]; then proxy_dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile || warn "共享 Caddy reload 失败，看 deploy/proxy 的日志"; fi
fi

mkdir -p "$ERP_ROOT/removed"
DEST="$ERP_ROOT/removed/$CODE-$(date +%Y%m%d-%H%M%S)"
mv "$DIR" "$DEST"
record_dest() { echo "$(date '+%F %T') 下线$([ "$PURGE" = --purge ] && echo "，删了库" || echo "，库卷留着")" >> "$DEST/.deploy/history.log"; }
[ -d "$DEST/.deploy" ] && record_dest
if [ "$PURGE" = --purge ]; then
  log "$CODE 已下线、库已删：目录挪到 $DEST（备份、.env 都在里面，确认不要了再手动删）"
else
  log "$CODE 已下线：目录挪到 $DEST，库卷留着；要起回来用 deploy/tenant-restore.sh $CODE"
fi
