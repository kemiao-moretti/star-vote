# StarVote 运行时镜像：node:24-alpine + 内置 node:sqlite（无原生编译依赖）
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=5556 \
    DB_PATH=/data/starvote.db

# 仅安装生产依赖（axios）；node:sqlite 为 Node 内置，无需额外包
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

EXPOSE 5556

# 数据目录（由 docker-compose 挂载 volume）
VOLUME ["/data"]

CMD ["node", "src/server.js"]