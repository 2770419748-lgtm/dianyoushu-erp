#!/usr/bin/env bash
# 部署脚本共用的函数（口径第 24 节）。其他脚本用 `. "$(dirname "$0")/lib.sh"` 引进来，不单独跑。
#
# 服务器上的目录（ERP_ROOT 默认 /srv/erp，CI 演练时指到临时目录）：
#   $ERP_ROOT/app                 代码（检出要发的版本）；APP_DIR 可以另指
#   $ERP_ROOT/tenants/<代号>/      一家客户：.env（密钥，600）、backups/、exports/、.deploy/（当前版本、上一个版本、发布记录）、.ops/（定时任务成功时间、告警节流）
#   $ERP_ROOT/proxy/sites/        共享 Caddy 的站点配置，一家一个 <代号>.caddy
#   $ERP_ROOT/ops.env             运维配置：告警群机器人地址、异地备份目标（不进仓库，见 deploy/ops.env.example）
# 镜像：dianyoushu-erp:<版本>（应用）、dianyoushu-erp-tools:<版本>（迁移、开户、每日任务）、dianyoushu-erp-backup:<版本>（定时备份），
# 版本是代码的提交号，deploy/build.sh 打。

set -euo pipefail
umask 077

ERP_ROOT="${ERP_ROOT:-/srv/erp}"
APP_DIR="${APP_DIR:-$ERP_ROOT/app}"
TENANTS_DIR="$ERP_ROOT/tenants"
PROXY_DIR="$ERP_ROOT/proxy"
APP_REPO="dianyoushu-erp"
TOOLS_REPO="dianyoushu-erp-tools"
BACKUP_REPO="dianyoushu-erp-backup"

if [ -f "$ERP_ROOT/ops.env" ]; then
  # shellcheck disable=SC1091
  . "$ERP_ROOT/ops.env"
fi

log() { echo "[$(date '+%F %T')] $*"; }
warn() { echo "[$(date '+%F %T')] 注意：$*" >&2; }
die() {
  echo "[$(date '+%F %T')] 出错：$*" >&2
  exit 1
}

# 发到运维用的企业微信群机器人（ops.env 的 ALERT_WEBHOOK_URL）；没配就只写日志。消息里不放密钥、密码。
# 发出去了（或者没配机器人）返回 0；配了却没发出去返回 1，并在日志里说为什么
alert() {
  local text="[店有数 ERP $(hostname)] $*"
  echo "[$(date '+%F %T')] 告警：$*" >&2
  [ -n "${ALERT_WEBHOOK_URL:-}" ] || return 0
  if ! command -v python3 > /dev/null; then
    echo "[$(date '+%F %T')] 告警没发出去：没装 python3（拼消息要用），apt-get install -y python3" >&2
    return 1
  fi
  local body
  body=$(printf '%s' "$text" | python3 -c 'import json,sys; print(json.dumps({"msgtype":"text","text":{"content":sys.stdin.read()}}))') || {
    echo "[$(date '+%F %T')] 告警没发出去：拼消息出错" >&2
    return 1
  }
  if ! curl -fsS -m 10 -H 'Content-Type: application/json' -d "$body" "$ALERT_WEBHOOK_URL" > /dev/null; then
    echo "[$(date '+%F %T')] 告警没发出去：群机器人地址不通" >&2
    return 1
  fi
}

# 同一件事一小时内只告警一次（每分钟跑的巡检不刷屏）；key 用来区分是哪件事。没发出去不算数，下一分钟再试
alert_throttled() {
  local key=$1
  shift
  local dir="$ERP_ROOT/.ops"
  mkdir -p "$dir"
  local mark="$dir/alert-$key"
  if [ -f "$mark" ] && [ $(($(date +%s) - $(cat "$mark"))) -lt 3600 ]; then return 0; fi
  if alert "$@"; then date +%s > "$mark"; fi
}

# 这家共享 Caddy 上的站点地址（tenant-new.sh 记在 .deploy/site）
tenant_site() { cat "$(tenant_dir "$1")/.deploy/site" 2>/dev/null || true; }

# 经共享 Caddy、按这家的站点地址请求健康检查（和客户从外面访问走同一条路）。
# 要看到应用回的 {"ok":true}：Caddy 对没配的站点也回 200（空的），只看状态码会把“站点没配上”当成正常
site_health() {
  local site body
  site=$(tenant_site "$1")
  [ -n "$site" ] || return 1
  if [[ "$site" == http://* ]]; then
    body=$(curl -fsS -m 5 -H "Host: ${site#http://}" "http://127.0.0.1:${PROXY_HTTP_PORT:-80}/api/health") || return 1
  else
    body=$(curl -fsS -m 5 --resolve "$site:${PROXY_HTTPS_PORT:-443}:127.0.0.1" "https://$site:${PROXY_HTTPS_PORT:-443}/api/health") || return 1
  fi
  [[ "$body" == *'"ok":true'* ]]
}

# 共享 Caddy 的 compose
proxy_dc() { env -i PATH="$PATH" HOME="${HOME:-/root}" ERP_ROOT="$ERP_ROOT" PROXY_HTTP_PORT="${PROXY_HTTP_PORT:-80}" PROXY_HTTPS_PORT="${PROXY_HTTPS_PORT:-443}" docker compose -p erp-proxy -f "$APP_DIR/deploy/proxy/docker-compose.yml" "$@"; }

valid_code() { [[ "$1" =~ ^[a-z][a-z0-9-]{1,30}$ ]]; }

tenant_dir() { echo "$TENANTS_DIR/$1"; }

require_tenant() {
  valid_code "$1" || die "客户代号只能用小写字母、数字、横线，字母开头：$1"
  [ -f "$(tenant_dir "$1")/.env" ] || die "没有这家客户：$1（$(tenant_dir "$1")/.env 不存在）"
}

list_tenants() {
  [ -d "$TENANTS_DIR" ] || return 0
  local d
  for d in "$TENANTS_DIR"/*/; do
    [ -f "$d.env" ] && basename "$d"
  done
  return 0
}

current_tag() { cat "$(tenant_dir "$1")/.deploy/current" 2>/dev/null || true; }
previous_tag() { cat "$(tenant_dir "$1")/.deploy/previous" 2>/dev/null || true; }

record() {
  local t=$1
  shift
  mkdir -p "$(tenant_dir "$t")/.deploy"
  echo "$(date '+%F %T') $*" >> "$(tenant_dir "$t")/.deploy/history.log"
}

image_exists() { docker image inspect "$1" > /dev/null 2>&1; }

# 一个版本的三个镜像都在
release_exists() { image_exists "$APP_REPO:$1" && image_exists "$TOOLS_REPO:$1" && image_exists "$BACKUP_REPO:$1"; }

# 这家客户的 docker compose：项目名 erp-<代号>（库、备份卷都按项目分开）；版本默认用这家当前的，DC_TAG 可以临时指定（迁移用新版本跑）
dc() {
  local t=$1
  shift
  local dir tag
  dir=$(tenant_dir "$t")
  tag="${DC_TAG:-$(current_tag "$t")}"
  [ -n "$tag" ] || die "$t 还没有部署过版本"
  # 用干净的环境跑 compose：shell 里碰巧有同名变量（SESSION_SECRET、DATA_ENCRYPTION_KEY、DEMO_MODE……）会盖过这家 .env 里的值，
  # 一家的应用就用上了别人的、甚至示例里的钥匙。只留找得到 docker 要的几个
  env -i PATH="$PATH" HOME="${HOME:-/root}" ${DOCKER_HOST:+DOCKER_HOST="$DOCKER_HOST"} ${DOCKER_CONFIG:+DOCKER_CONFIG="$DOCKER_CONFIG"} \
    APP_IMAGE="$APP_REPO:$tag" TOOLS_IMAGE="$TOOLS_REPO:$tag" BACKUP_IMAGE="$BACKUP_REPO:$tag" BACKUP_DIR="$dir/backups" EXPORT_DIR="$dir/exports" TENANT="$t" \
    docker compose -p "erp-$t" --project-directory "$APP_DIR" \
    -f "$APP_DIR/docker-compose.yml" -f "$APP_DIR/deploy/docker-compose.tenant.yml" \
    --env-file "$dir/.env" "$@"
}

app_container() { dc "$1" ps -q app 2>/dev/null | head -1; }

# 等应用健康检查通过：最多 $2 秒（默认 120）；容器反复重启（新版本一起来就崩）提前判失败
wait_healthy() {
  local t=$1 limit=${2:-120} waited=0 id status restarts
  while [ "$waited" -lt "$limit" ]; do
    id=$(app_container "$t")
    if [ -n "$id" ]; then
      status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo missing)
      restarts=$(docker inspect -f '{{.RestartCount}}' "$id" 2>/dev/null || echo 0)
      [ "$status" = "healthy" ] && return 0
      if [ "$restarts" -ge 3 ]; then
        warn "$t 的应用反复重启（$restarts 次），不等了"
        return 1
      fi
    fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

# 只在晚上 22 点到第二天早上 6 点之间发（口径第 24 节，门店都关门了）；别的时间要发加 --force
check_window() {
  local force=${1:-}
  local hour
  hour=$((10#$(TZ=Asia/Shanghai date +%H)))
  if [ "$force" != "--force" ] && [ "$hour" -ge 6 ] && [ "$hour" -lt 22 ]; then
    die "现在是北京时间 $hour 点，门店还在营业：22 点到第二天 6 点之间再发；确实要现在发加 --force"
  fi
}

# 一个版本的镜像里有哪些迁移（一行一个名字）
release_migrations() { docker run --rm "$TOOLS_REPO:$1" ls prisma/migrations | grep -E '^[0-9]{14}_'; }

# 这家库里做过的迁移
applied_migrations() { dc "$1" exec -T db psql -U erp -d dianyoushu_erp -tAc "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY 1"; }

# 回到 $2 版本前要看：库里做过、$2 里没有、而且标了“不能直接回滚”的迁移（清单取自较新的版本 $3 的镜像）。
# 打印这些迁移（迁移名 原因），没有就什么都不打印（口径第 24 节、复查第 86 条）
irreversible_since() {
  local t=$1 target=$2 newer=$3 applied old list m line
  applied=$(applied_migrations "$t") || die "$t 读不到库里的迁移记录"
  old=$(release_migrations "$target") || die "读不到版本 $target 的迁移清单"
  list=$(docker run --rm "$TOOLS_REPO:$newer" cat prisma/migrations-not-rollback-safe.txt 2>/dev/null || true)
  for m in $applied; do
    grep -qx "$m" <<< "$old" && continue
    line=$(grep -E "^$m( |$)" <<< "$list" || true)
    [ -n "$line" ] && echo "$line"
  done
  return 0
}

# 回滚以后用旧版本把主要业务表都读一遍（就是对账）：旧版本读不了新版本写的数据（比如新的枚举值）时这里会报错
read_check() { dc "$1" run --rm -T tools pnpm -s db:check > /dev/null 2>&1; }
