# StarVote

轻量级的评分投票后端服务，使用 **SQLite** 作为唯一数据库，可通过 **Docker** 容器部署，并提供 GitHub Actions 自动构建与服务器部署。

## 功能

- 1–5 星评分计数
- up / down 投票计数
- SQLite 持久化（容器挂载 volume，重启不丢数据）
- Referer 域名白名单校验，防盗链
- 零第三方运行时依赖（HTTP 与数据库均用 Node 内置模块）

## 快速开始（本地）

```bash
npm install
PORT=5556 DB_PATH=./data/starvote.db HOSTS=localhost npm start
```

浏览器/接口访问 `http://localhost:5556/api/rating/info?id=1`（需带 Referer 白名单内的来源）。

## 对外 API

统一规则：`info` 用 GET，`update` 用 POST；带 query 参数 `id`；Referer 不在白名单返回 `403`。

| 路径 | 方法 | 参数 | 成功响应 |
|---|---|---|---|
| `/api/rating/info` | GET | `id` | `{ "rating": { id, '1'..'5': 计数 } }` |
| `/api/rating/update` | POST | `id`, `value`(1–5 整数) | `{ "success": true }` |
| `/api/vote/info` | GET | `id` | `{ "votes": { id, up, down } }` |
| `/api/vote/update` | POST | `id`, `value`(`up`/`down`) | `{ "success": true }` |

## 数据库（SQLite）

- 表 `rating_counts(id, s1..s5)` 与 `vote_counts(id, up, down)`，启动时自动创建。
- 自增经 `INSERT ... ON CONFLICT DO UPDATE` 原子完成，避免并发丢计数。
- 数据文件路径由 `DB_PATH` 控制（默认 `/data/starvote.db`）。

## Docker 部署

1. **构建镜像**（或直接使用 CI 推送的 `ghcr.io/<你的用户名>/star-vote`）：

   ```bash
   docker build -t star-vote .
   docker run -d -p 5556:5556 -v starvote_data:/data -e HOSTS=yourdomain.com star-vote
   ```

2. **docker-compose**：复制 `docker-compose.yml` 到服务器，替换 `<owner>` 与 `HOSTS`，执行：

   ```bash
   docker compose up -d
   ```

3. **（可选）反向代理**：Nginx/Caddy 将你的域名转发到 `127.0.0.1:5556`，并确保 `HOSTS` 含你的域名。

## GitHub Actions 构建镜像

`.github/workflows/deploy.yml` 在 push 到 `main` 时，用 buildx 构建镜像并推送至 GHCR（`ghcr.io/<repo>`），供任何环境拉取使用。

> GHCR 鉴权使用自动提供的 `GITHUB_TOKEN`，无需额外配置。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `5556` | 服务监听端口 |
| `DB_PATH` | `/data/starvote.db` | SQLite 数据库文件路径 |
| `HOSTS` | 空 | 允许的 Referer 域名，逗号分隔；为空拒绝所有请求 |

## 开发

```bash
npm test            # 运行全部测试（node:test）
```

- `src/db.js`：SQLite 数据层（`createDb/getRating/updateRating/getVote/updateVote`）
- `src/server.js`：`node:http` 路由服务（对外 API 分发 + Referer 校验 + CORS）

## 目录结构

```
star-vote/
├── src/
│   ├── server.js          # HTTP 路由服务
│   └── db.js              # SQLite 数据层
├── test/                  # node:test 单元/接口测试
├── Dockerfile             # node:24-alpine 单阶段镜像
├── docker-compose.yml     # 服务器部署模板
├── .github/workflows/deploy.yml   # CI：构建+推送+SSH 部署
└── docs/superpowers/      # 设计与实现计划文档
```