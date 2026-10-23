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
# 发出去了（或者没配机器人）返回 0；配了却没发出去返回 1，并在日志里说为什么。脚本里直接告警用下面的 alert
send_alert() {
  local text="[店有数 ERP $(hostname)] $*"
  echo "[$(date '+%F %T')] 告警：$*" >&2
  [ -n "${ALERT_WEBHOOK_URL:-}" ] || return 0
  if ! command -v python3 > /dev/null; then
    echo "[$(date '+%F %T')] 告警没发出去：没装 python3（拼消息要用），apt-get install -y python3" >&2
    return 1
  fi
  local body resp
  body=$(printf '%s' "$text" | python3 -c 'import json,sys; print(json.dumps({"msgtype":"text","text":{"content":sys.stdin.read()}}))') || {
    echo "[$(date '+%F %T')] 告警没发出去：拼消息出错" >&2
    return 1
  }
  if ! resp=$(curl -fsS -m 10 -H 'Content-Type: application/json' -d "$body" "$ALERT_WEBHOOK_URL"); then
    echo "[$(date '+%F %T')] 告警没发出去：群机器人地址不通" >&2
    return 1
  fi
  # 地址里的 key 写错、机器人被移出群，企业微信也回 200，要看 errcode
  if [[ "$resp" != *'"errcode":0'* ]]; then
    echo "[$(date '+%F %T')] 告警没发出去：群机器人回的是 ${resp:0:200}" >&2
    return 1
  fi
}

# 直接告警：总是返回 0。脚本都开着 set -e，告警发不出去不能让巡检停在这一家、升级停在半路（复查第 91 条）；
# 没发出去的原因已经写进日志。要知道发没发出去（节流要用）调 send_alert
alert() { send_alert "$@" || true; }

# 同一件事一小时内只告警一次（每分钟跑的巡检不刷屏）；key 用来区分是哪件事。没发出去不算数，下一分钟再试
alert_throttled() {
  local key=$1
  shift
  local dir="$ERP_ROOT/.ops"
  mkdir -p "$dir"
  local mark="$dir/alert-$key"
  if [ -f "$mark" ] && [ $(($(date +%s) - $(cat "$mark"))) -lt 3600 ]; then return 0; fi
  if send_alert "$@"; then date +%s > "$mark"; fi
  return 0
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

# 共享 Caddy 上一家的站点块：$1 代号，$2 站点地址
site_block() {
  cat << EOF
# 客户 $1（deploy/ 下的脚本写的）
$2 {
	encode gzip
	log
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy $1-app:3000
}
EOF
}

# 比较站点地址用：去掉 http://、不分大小写
site_key() { local s=${1#http://}; echo "${s,,}"; }

# 站点地址 $2 能不能给 $1 这家用（复查第 85 条）：只能是域名或 IP（不能带端口，共享 Caddy 只开 80、443）、不和别家重复、
# 连同现有的站点一起 caddy validate 过（一个站点写错，Caddy 一重启所有客户都打不开）。不行就 die，什么都不留
check_site() {
  local code=$1 site=$2 f other check out
  [[ "$site" =~ ^(http://)?[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die "站点地址只能是域名或 IP（可以带 http://，不能带端口和路径）：$site"
  mkdir -p "$PROXY_DIR/sites"
  for f in "$PROXY_DIR"/sites/*.caddy; do
    [ -f "$f" ] || continue
    other=$(basename "$f" .caddy)
    [ "$other" != "$code" ] || continue
    if [ "$(site_key "$(tenant_site "$other")")" = "$(site_key "$site")" ]; then die "站点地址 $site 已经给 $other 用了"; fi
  done
  check=$(mktemp -d)
  cp -r "$PROXY_DIR/sites" "$check/sites"
  site_block "$code" "$site" > "$check/sites/$code.caddy"
  cp "$APP_DIR/deploy/proxy/Caddyfile" "$check/Caddyfile"
  chmod -R a+rX "$check"
  if ! out=$(docker run --rm -v "$check/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$check/sites:/etc/caddy/sites:ro" caddy:2 caddy validate --config /etc/caddy/Caddyfile 2>&1); then
    rm -rf "$check"
    echo "$out" | tail -3 >&2
    die "加上 $site 以后共享 Caddy 的配置校验不过（站点地址写错，或者现有的站点文件被改坏了，看上面的报错）"
  fi
  rm -rf "$check"
}

# 把 $1 这家的站点 $2 写进共享 Caddy、reload（先过 check_site）；reload 失败把这家拿掉，别让共享 Caddy 下次重启时起不来
install_site() {
  local code=$1 site=$2
  site_block "$code" "$site" > "$PROXY_DIR/sites/$code.caddy"
  chmod 644 "$PROXY_DIR/sites/$code.caddy"
  if [ -z "$(proxy_dc ps -q caddy 2> /dev/null)" ]; then
    proxy_dc up -d
  elif ! proxy_dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile; then
    rm -f "$PROXY_DIR/sites/$code.caddy"
    proxy_dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile || true
    die "共享 Caddy 加不上 $site（已拿掉这家的站点，别家不受影响）"
  fi
}

# 这个代号在 docker 里留下的卷（库卷 erp-<代号>_pgdata 等；下线时没加 --purge 会留着）
tenant_volumes() { docker volume ls -q --filter "label=com.docker.compose.project=erp-$1"; }

# 在这家的库里跑一句 SQL，打印结果（不带表头、竖线分隔）。stdin 接 /dev/null：在 while read 循环里调也不会吃掉循环的输入
tenant_sql() { dc "$1" exec -T db psql -U erp -d dianyoushu_erp -tA -c "$2" < /dev/null; }

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
applied_migrations() { tenant_sql "$1" "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY 1"; }

# 版本 $1 的镜像里，迁移 $2 给哪些枚举加了值：一行一个“类型 值”
enum_values_added() {
  docker run --rm "$TOOLS_REPO:$1" cat "prisma/migrations/$2/migration.sql" |
    sed -nE "s/.*ALTER TYPE \"?([a-z0-9_]+)\"? ADD VALUE (IF NOT EXISTS )?'([^']+)'.*/\1 \3/p"
}

# 这家库里有没有哪一行用到了枚举类型 $2 的值 $3（所有用这个类型的列，数组列也算）；用到了返回 0
enum_value_used() {
  local t=$1 type=$2 value=$3 q
  q=$(tenant_sql "$t" "SELECT string_agg(format('(SELECT 1 FROM %I WHERE %s LIMIT 1)', table_name,
      CASE WHEN data_type = 'ARRAY' THEN format('%L = ANY(%I::text[])', '$value', column_name) ELSE format('%I::text = %L', column_name, '$value') END), ' UNION ALL ')
    FROM information_schema.columns WHERE table_schema = 'public' AND udt_name IN ('$type', '_$type')")
  [ -n "$q" ] || return 1
  [ -n "$(tenant_sql "$t" "SELECT 1 FROM ($q) x LIMIT 1")" ]
}

# 回到 $2 版本前要看：库里做过、$2 里没有、而且标了“不能直接回滚”的迁移（清单取自较新的版本 $3 的镜像）。
# 打印挡着回滚的迁移（迁移名 原因），没有就什么都不打印（口径第 24 节、复查第 86 条）。
# 原因写“枚举加值”开头的只加了枚举值：库里还没有哪一行用到新值（新版本没健康过、没录过这种单），旧版本就读不到它不认识的值，
# 照样能回滚；用到了才挡（复查第 92 条）
irreversible_since() {
  local t=$1 target=$2 newer=$3 applied old list m line used type value
  applied=$(applied_migrations "$t") || die "$t 读不到库里的迁移记录"
  old=$(release_migrations "$target") || die "读不到版本 $target 的迁移清单"
  list=$(docker run --rm "$TOOLS_REPO:$newer" cat prisma/migrations-not-rollback-safe.txt 2>/dev/null || true)
  for m in $applied; do
    grep -qx "$m" <<< "$old" && continue
    line=$(grep -E "^$m( |$)" <<< "$list" || true)
    [ -n "$line" ] || continue
    if [[ "${line#* }" == 枚举加值* ]]; then
      used=""
      while read -r type value; do
        [ -n "$type" ] || continue
        if enum_value_used "$t" "$type" "$value"; then used="$used $type.$value"; fi
      done < <(enum_values_added "$newer" "$m")
      [ -n "$used" ] || continue
      line="$line（库里已经用到了：${used# }）"
    fi
    echo "$line"
  done
  return 0
}

# 回滚以后用旧版本对一遍账（db:check）：其中第 16 类把每个枚举列用到的值和旧版本代码认识的比，
# 新版本写进去、旧版本不认识的枚举值（读的时候 Prisma 会报错）在这里查得出来
read_check() { dc "$1" run --rm -T tools pnpm -s db:check > /dev/null 2>&1; }
