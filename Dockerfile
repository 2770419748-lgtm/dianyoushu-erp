# 店有数 ERP 生产镜像（第 9 周写好，等有服务器再用）。
# 三段：装依赖 → 构建（standalone 输出）→ 运行（只带运行所需文件，镜像小）。
# 数据库迁移、灌演示数据用 build 阶段的镜像跑（里面有 prisma CLI 和 tsx），见 docker-compose.yml 的 tools 服务。

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# 1. 装依赖（只拷依赖清单，改代码不会让这一层重来）
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# postinstall 会跑 prisma generate，这里给个占位连接串（generate 不连库）
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" pnpm install --frozen-lockfile

# 2. 构建
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" pnpm exec prisma generate
ENV NEXT_TELEMETRY_DISABLED=1 BUILD_STANDALONE=1
# 构建时收集路由配置会加载 src/lib/prisma.ts，它要求有 DATABASE_URL；构建不连库，给个占位串（运行时用 compose 里的真连接串）
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" pnpm build

# 3. 运行
FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd --system app && useradd --system --gid app app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
CMD ["node", "server.js"]
