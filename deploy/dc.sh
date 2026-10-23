#!/usr/bin/env bash
# 对一家客户跑 docker compose（口径第 24 节）：项目名、镜像版本、.env、备份目录都替你填好。
# 比在交互 shell 里 source lib.sh 安全（lib.sh 会开 set -e，敲错一条命令整个 shell 就退出）。
# 用法：deploy/dc.sh <代号> <docker compose 的参数>
#   deploy/dc.sh mouxie ps
#   deploy/dc.sh mouxie logs --tail 100 app
#   deploy/dc.sh mouxie run --rm tools pnpm license:set --days 365
. "$(dirname "$0")/lib.sh"

CODE=${1:-}
[ -n "$CODE" ] && [ $# -ge 2 ] || die "用法：deploy/dc.sh <代号> <docker compose 的参数>，比如 deploy/dc.sh mouxie ps"
require_tenant "$CODE"
shift
dc "$CODE" "$@"
