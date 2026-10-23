#!/usr/bin/env bash
# 下线一家客户（口径第 21、24 节：客户不续了、数据留满 90 天以后；或者开户开了一半要重来）：
# 先手动备份一份（能备的话）→ 停掉这家的容器 → 共享 Caddy 拿掉这家的站点 → 目录挪到 $ERP_ROOT/removed/<代号>-<时间>/（里面有备份和 .env）。
# 默认留着数据库卷（反悔了还能起回来）；加 --purge 连数据库卷一起删（真删，删前确认那份备份能恢复、已经整库导出交给客户）。
# 用法：deploy/tenant-remove.sh <代号> [--purge]
. "$(dirname "$0")/lib.sh"

CODE=${1:-}
PURGE=${2:-}
valid_code "$CODE" || die "用法：deploy/tenant-remove.sh <代号> [--purge]"
DIR=$(tenant_dir "$CODE")
[ -d "$DIR" ] || die "没有这家客户：$DIR"

if [ -f "$DIR/.env" ] && [ -n "$(current_tag "$CODE")" ]; then
  if [ -n "$(dc "$CODE" ps -q backup 2>/dev/null)" ]; then
    log "下线前再备份一份"
    dc "$CODE" exec -T backup bash /backup.sh now || warn "下线前的备份没做成，用之前的备份"
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
log "$CODE 已下线：目录挪到 $DEST（备份、.env 都在里面，确认不要了再手动删）"
