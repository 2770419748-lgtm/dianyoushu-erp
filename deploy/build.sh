#!/usr/bin/env bash
# 打一个版本的镜像（口径第 24 节）：应用 dianyoushu-erp:<版本>、工具 dianyoushu-erp-tools:<版本>，版本是代码的提交号（前 12 位）。
# 一个版本只打一次，所有客户都用它，不在每家重新打。
# 用法（服务器上）：cd /srv/erp/app && git fetch && git checkout <要发的提交或标签> && deploy/build.sh
# 打完打印版本号，接着 deploy/deploy.sh demo <版本>（先发演示站）。
. "$(dirname "$0")/lib.sh"

cd "$APP_DIR"
if [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then
  die "$APP_DIR 里有没提交的改动：发布的版本要和仓库里的一模一样，先 git stash 或 git checkout ."
fi
TAG="${1:-$(git rev-parse --short=12 HEAD)}"
[[ "$TAG" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "版本号只能有字母、数字和 . _ -：$TAG"

log "打镜像 $APP_REPO:$TAG（应用）"
docker build -t "$APP_REPO:$TAG" .
log "打镜像 $TOOLS_REPO:$TAG（迁移、开户、每日任务用）"
docker build --target build -t "$TOOLS_REPO:$TAG" .
log "打镜像 $BACKUP_REPO:$TAG（定时备份）"
docker build -t "$BACKUP_REPO:$TAG" -f docker/backup.Dockerfile docker
log "打好了：版本 $TAG"
echo "$TAG"
