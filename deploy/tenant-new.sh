#!/usr/bin/env bash
# 在这台服务器上开一家新客户（口径第 21、24 节）：先校验站点地址 → 建目录和 .env（随机生成密码和钥匙）→ 起数据库 → 建表 →
# 开户（演示站灌演示数据）→ 起应用和备份 → 共享 Caddy 加上这家的子域名。
# 用法：deploy/tenant-new.sh <代号> <站点地址> <版本> --name "公司名"      （真用：开户，打印 admin 的初始密码一次）
#       deploy/tenant-new.sh demo <站点地址> <版本> --demo                  （演示站：灌演示数据）
# 站点地址写域名（mouxie.example.com，自动 HTTPS；中文域名写成 xn-- 开头的 punycode），没备案时写 http://IP 或 http://名字（只走 HTTP）。
# 不能带端口：共享 Caddy 只开了 80、443，写别的端口客户也打不开（同一个 IP 没备案只能放一家）。
# .env 里的 DATA_ENCRYPTION_KEY、DATA_INDEX_KEY、BACKUP_PASSPHRASE 开完马上离线存一份（丢了数据、备份就解不开）。
# 下线过的老客户回来续费不要用这个重开，用 deploy/tenant-restore.sh 原样起回来（库还在）。
# 中途失败会留下半家：照提示跑 deploy/tenant-remove.sh <代号> --purge 清掉再重开。
. "$(dirname "$0")/lib.sh"

CODE=${1:-}
SITE=${2:-}
TAG=${3:-}
shift 3 || die "用法：deploy/tenant-new.sh <代号> <站点地址> <版本> --name 公司名 | --demo"
MODE=""
NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --demo) MODE=demo ;;
    --name)
      NAME=${2:-}
      shift
      ;;
    *) die "不认识的参数：$1" ;;
  esac
  shift
done
valid_code "$CODE" || die "客户代号只能用小写字母、数字、横线，字母开头、2～31 位：$CODE"
[ -n "$MODE" ] || [ -n "$NAME" ] || die "真用客户要写公司名 --name，演示站写 --demo"
release_exists "$TAG" || die "没有版本 $TAG 的镜像，先 deploy/build.sh"

DIR=$(tenant_dir "$CODE")
[ -e "$DIR" ] && die "已经有这家客户（或者上次开了一半）：$DIR；开了一半的先 deploy/tenant-remove.sh $CODE --purge"
# 同一个代号下线过、库卷还留着：新 .env 的密码连不上老库，建表会失败；照失败提示 --purge 就把老客户的库删了（复查第 93 条）
LEFT=$(tenant_volumes "$CODE")
[ -z "$LEFT" ] || die "代号 $CODE 下线过，库还留着（卷 $(echo $LEFT)）：
  老客户回来了：deploy/tenant-restore.sh $CODE 原样起回来；
  确定不要了：先确认 $ERP_ROOT/removed/ 里这家的备份能恢复，再 docker volume rm $(echo $LEFT)；
  或者换一个代号开户"

# 站点地址：格式、不和别家重复、连同所有站点一起校验（复查第 85 条）；不行就停，什么都不留
check_site "$CODE" "$SITE"

mkdir -p "$DIR/backups" "$DIR/exports" "$DIR/.deploy" "$DIR/.ops"
trap 's=$?; [ $s -eq 0 ] || echo "开户中途失败：先 deploy/tenant-remove.sh $CODE --purge 清掉这半家（要再输一遍代号），改好再重开" >&2' EXIT

secret_hex() { openssl rand -hex 32; }
secret_b64() { openssl rand -base64 32; }
{
  echo "# 店有数 ERP 客户 $CODE 的配置（$(date '+%F') 由 deploy/tenant-new.sh 生成）。只有 root 能读；最后三项另外离线存一份"
  echo "POSTGRES_PASSWORD=$(secret_hex)"
  echo "APP_DB_PASSWORD=$(secret_hex)"
  echo "READONLY_DB_PASSWORD=$(secret_hex)"
  echo "SESSION_SECRET=$(secret_b64)"
  echo "DEMO_MODE=$([ "$MODE" = demo ] && echo 1 || echo 0)"
  echo "BACKUP_PASSPHRASE=$(secret_b64)"
  echo "DATA_ENCRYPTION_KEY=$(secret_b64)"
  echo "DATA_INDEX_KEY=$(secret_b64)"
} > "$DIR/.env"
chmod 600 "$DIR/.env"
echo "$TAG" > "$DIR/.deploy/current"
echo "$SITE" > "$DIR/.deploy/site"
record "$CODE" "开户 版本 $TAG 站点 $SITE"

# 共享网络（应用接在上面，共享 Caddy 按名字找到它）：compose 起任何服务前都要它在
docker network inspect erp-proxy > /dev/null 2>&1 || docker network create erp-proxy > /dev/null

log "1/5 起数据库"
dc "$CODE" up -d db
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$(dc "$CODE" ps -q db)" 2>/dev/null)" = healthy ] && break
  sleep 2
done
log "2/5 建表"
dc "$CODE" run --rm -T tools pnpm exec prisma migrate deploy > /dev/null
log "3/5 $([ "$MODE" = demo ] && echo 灌演示数据 || echo 开户)"
if [ "$MODE" = demo ]; then
  dc "$CODE" run --rm -T tools pnpm db:reset > /dev/null
else
  # 开户脚本会打印 admin 的初始密码，只这一次：交给客户老板本人
  dc "$CODE" run --rm -T tools pnpm -s tenant:init --name "$NAME"
fi

log "4/5 起应用和备份"
dc "$CODE" up -d --no-build app backup
wait_healthy "$CODE" 180 || die "$CODE 的应用没起来：deploy/dc.sh $CODE logs app"

log "5/5 共享 Caddy 加上 $SITE"
install_site "$CODE" "$SITE"
# 下线脚本据此区分“开好了的客户”（下线前必须备份成功）和“开了一半的”
record "$CODE" "开户完成"
log "开好了：$CODE（版本 $TAG，站点 $SITE）。.env 在 $DIR/.env，里面的两把数据钥匙和备份口令现在就离线存一份"
