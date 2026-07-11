FROM node:22-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装后端依赖(含 better-sqlite3 原生编译)。
COPY package.json package-lock.json* ./
RUN npm ci

# 构建前端 SPA:独立的 web/ 子项目,产物落在 web/dist。
COPY web/package.json web/package-lock.json* ./web/
RUN cd web && npm ci
COPY web ./web
RUN cd web && npm run build

# 构建后端并裁剪掉 devDependencies。
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev

FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist

RUN mkdir -p /app/data

EXPOSE 42110

CMD ["node", "dist/server.js"]
