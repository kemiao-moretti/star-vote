# StarVote — 项目结构说明（agents.md）

> 面向 AI Agent 与开发者的项目导读。项目是一个**轻量级的评分 / 投票后端服务**，独立 Node HTTP 服务 + SQLite 唯一数据库，可 Docker 容器化部署，含 GitHub Actions 自动构建部署。

## 1. 项目概览

- **定位**：自部署的轻量评分（1–5 星）与投票（up/down）计数服务。
- **运行时**：独立 Node HTTP 服务（内置 `node:http`），非 Serverless。
- **数据库**：SQLite（Node 内置 `node:sqlite`），**唯一后端**。
- **部署**：Docker 镜像 → 推 GHCR → SSH 到服务器 `docker compose pull && up -d`。
- **依赖**：`axios`（唯一第三方依赖）；数据库用 Node 内置模块，免编译。

## 2. 目录结构

```
star-vote/
├── src/
│   ├── server.js          # node:http 路由服务（对外 API + Referer 校验 + CORS）
│   └── db.js              # SQLite 数据层（表结构 + 原子自增）
├── test/
│   ├── db.test.js         # 数据层单元测试
│   └── server.test.js     # 接口测试（含边界）
├── Dockerfile             # node:24-alpine 单阶段镜像
├── .dockerignore
├── docker-compose.yml     # 服务器部署模板（volume 持久化 + 5556 端口）
├── .env.example
├── .github/workflows/deploy.yml   # CI：构建→推送 GHCR→SSH 部署
├── docs/superpowers/
│   ├── specs/             # 设计 spec
│   └── plans/             # 实现计划
└── agents.md              # 本文件
```

## 3. 对外 API

统一规则：`info` GET，`update` POST；query 传参；均先 Referer 白名单校验（失败 `403`）、带 CORS headers、支持 `OPTIONS` 预检。

| 路径 | 方法 | 参数 | 成功响应 |
|---|---|---|---|
| `/api/rating/info` | GET | `id` | `{ "rating": { id, '1'..'5': 计数 } }` |
| `/api/rating/update` | POST | `id`, `value`(1–5 整数) | `{ "success": true }` |
| `/api/vote/info` | GET | `id` | `{ "votes": { id, up, down } }` |
| `/api/vote/update` | POST | `id`, `value`(`up`/`down`) | `{ "success": true }` |

错误响应：`403 Forbidden Referer`、`400 Missing id` / `Invalid ... parameters`、`404 Not Found`、`500 Internal server error`。

## 4. 核心模块

### 4.1 `src/server.js`
- `createServer({ db, hosts })` 返回 `http.Server`，`hosts` 用于测试注入；未传则从 env 解析。
- 路由表按 `METHOD pathname` 分发；未命中 `404`；`OPTIONS` 预检返回 200。
- `checkReferer(req)`：`HOSTS` 逗号分隔白名单，`new URL(referer).hostname` 匹配；**`HOSTS` 为空拒绝一切请求**（防配置疏漏）—— `server.js` 中已实现。
- 作为主模块运行时读 `PORT`（默认 5556）监听。

### 4.2 `src/db.js`
- `createDb(dbPath)`：打开/初始化（`':memory:'` 或磁盘路径，目录自动创建），建两表。
- `getRating(db,id)` → `{ id, '1'..'5' }`；`updateRating(db,id,score)`（score 1–5，非法抛错）。
- `getVote(db,id)` → `{ id, up, down }`；`updateVote(db,id,type)`（`up`/`down`，非法抛错）。
- 自增用单条 `INSERT ... ON CONFLICT DO UPDATE SET col = col + 1`，原子、并发安全。

## 5. 数据模型

| 表 | 列 |
|---|---|
| `rating_counts` | `id TEXT PK`、`s1..s5 INTEGER NOT NULL DEFAULT 0` |
| `vote_counts` | `id TEXT PK`、`up INTEGER NOT NULL DEFAULT 0`、`down INTEGER NOT NULL DEFAULT 0` |

数据库文件由 `DB_PATH` 决定（默认 `/data/starvote.db`），Docker 下挂 volume `/data` 持久化。

## 6. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `5556` | 服务监听端口 |
| `DB_PATH` | `/data/starvote.db` | SQLite 文件路径 |
| `HOSTS` | 空 | 允许的 Referer 域名，逗号分隔；为空拒绝所有请求 |

## 7. 测试

`npm test`（`node --test`）：
- `test/db.test.js`：数据层（计数累加、分列、非法参数抛错）。
- `test/server.test.js`：接口（合法/非法入参、403/400/404/500、OPTIONS、`HOSTS` 为空的 403）。

服务测试用 `createServer` + `createDb(':memory:')` + 随机端口，不依赖外部服务。

## 8. 部署

- **Dockerfile**：单阶段 `node:24-alpine`，`npm ci --omit=dev`，`node:sqlite` 免编译，`EXPOSE 5556`，`VOLUME /data`。
- **compose**：`ghcr.io/<owner>/star-vote:latest`，`5556:5556`，`starvote_data:/data`。
- **CI（deploy.yml）**：push `main` → buildx 构建（amd64）→ 推 GHCR（`GITHUB_TOKEN`）→ SSH 执行 `docker compose pull && up -d`。

服务器 secrets：`SSH_HOST`、`SSH_USERNAME`、`SSH_KEY`、`SSH_PORT`、`DEPLOY_PATH`。

## 9. 常见改动点 / Agent 注意事项

- **新增接口**：在 `src/server.js` 的 `routes` 表加一行 `METHOD path` 路由 + 写对应 handler（先用 `checkReferer`，再参数校验，外层 try/catch），并在 `test/server.test.js` 补测试。
- **新增数据操作**：在 `src/db.js` 加函数（prepared statement + 单条 SQL），配 `test/db.test.js` 测试。
- **HOSTS 校验**：改 env `HOSTS`，逻辑在 `src/server.js#checkReferer`。
- **保持零新增运行时依赖**：除非必要，勿引入需编译的原生模块——`node:sqlite` 已覆盖数据库需求。
- **端口/DB 路径**：容器由 `PORT`/`DB_PATH` 环境变量控制，勿硬编码。