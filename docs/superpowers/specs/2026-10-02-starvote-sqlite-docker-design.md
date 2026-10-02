# StarVote 改造：SQLite + Docker + GitHub Actions 部署

- 日期：2026-10-02
- 状态：设计稿（等待用户审查）

## 背景与目标

StarVote 当前为 Vercel Serverless Functions 形态（`api/*` 文件路径即路由），通过 `DATA_BACKEND` 在 LeanCloud / Supabase 双后端间切换。需求：

1. 引入 **SQLite** 作为**唯一**数据库后端，剥离 LeanCloud / Supabase 及对应环境变量。
2. 将运行时改造为**独立 Node HTTP 服务**，可在 Docker 容器中运行。
3. 新增 **GitHub Actions** 工作流：push 到 `main` 自动构建 Docker 镜像 → 推送 GHCR → SSH 到服务器 `docker compose pull && up -d` 快速部署。

用户已确认的决策：

| # | 决策 | 结论 |
|---|---|---|
| 1 | 后端 | SQLite 替换为唯一后端 |
| 2 | 运行时 | 独立 Node HTTP 服务（内置 `node:http`，零新增运行时依赖，除 SQLite 驱动） |
| 3 | 对外 API | 保留原路径 `/api/rating/info` 等，**响应格式不变** |
| 4 | 部署 | GHCR 推送 + SSH 到服务器部署 |
| 5 | 触发 | push 到 `main` → 构建 + 部署全流程 |
| 6 | 架构 | amd64 单平台 |
| 7 | 端口 | 容器监听 **5556**，由 Nginx/Caddy 反代转发 |

## 架构总览

```
┌─────────────┐   HTTP   ┌──────────────────────────┐   node:http + better-sqlite3   ┌──────────────┐
│ Nginx/Caddy │ ─5556──▶ │  Node HTTP Service        │ ───────────────────────────────▶│ /data/       │
│  反代        │          │  src/server.js (路由分发)  │                                  │ starvote.db  │
└─────────────┘          │  src/db.js (SQLite)       │                                   │ (volume)     │
                         └──────────────────────────┘
```

- 对外路径：由 `src/server.js` 手写路由分发，映射关系与旧 Vercel 路径一致。
- 数据层：`src/db.js` 用 `better-sqlite3` 封装两个表与原子自增操作。
- 持久化：SQLite 文件在容器内 `/data/starvote.db`，经 `data` volume 挂载。

## 现有代码 → 目标代码映射

### 删除
- `api/_leancloud.js`、`api/_supabase.js`
- `api/_utils.js` 中的双后端选择逻辑（保留 `checkReferer` 与 CORS headers）
- `api/rating/*`、`api/vote/*` 的 Vercel handler（改造为 server.js 中的路由）
- `supabase/` 目录及 `schema.sql`
- `.env.example` 中的 LeanCloud / Supabase 变量

### 新增
- `src/server.js`：`node:http` 入口 + 路由分发（解析 `req.method`/`req.url` → 路由 → JSON 响应），保留 `checkReferer` 与 CORS headers。
- `src/db.js`：`better-sqlite3` 封装，提供 `getRating(id)`、`updateRating(id, score)`、`getVote(id)`、`updateVote(id, type)`。
- `Dockerfile`：多阶段构建（node:20-alpine → 编译 better-sqlite3 → 精简运行）。
- `docker-compose.yml`：服务定义、`data` volume、`5556:5556`、环境变量注入。
- `.github/workflows/deploy.yml`：构建推送 + SSH 部署。
- `docs/superpowers/specs/...`（本文件）。

## 数据层设计（src/db.js）

沿用现有表结构与并发安全策略，用 SQLite 实现原子自增：

- 表 `rating_counts(id TEXT PRIMARY KEY, s1 INT DEFAULT 0, s2 INT, s3 INT, s4 INT, s5 INT)`
- 表 `vote_counts(id TEXT PRIMARY KEY, up INT DEFAULT 0, down INT DEFAULT 0)`

原子自增采用单条 `INSERT ... ON CONFLICT(id) DO UPDATE SET sX = sX + 1`，避免 read-modify-write 并发丢计数。

- `getRating(id)` → 返回 `{ id, '1'..'5': 计数 }`（无记录返回 `{}`）
- `updateRating(id, score)`（score: 1–5 整数）→ 对 `s<score>` 列自增
- `getVote(id)` → 返回 `{ id, up, down }`（无记录返回 `{}`）
- `updateVote(id, type)`（type: `'up'`/`'down'`）→ 对对应列自增

连接：`better-sqlite3` 打开数据库文件路径由环境变量 `DB_PATH`（默认 `/data/starvote.db`）决定。首次打开执行 `CREATE TABLE IF NOT EXISTS`。

## 对外 API（保持不变）

### 统一规则
- 先 `checkReferer(req)`：读取 `HOSTS` 逗号分隔白名单，用 `new URL(referer).hostname` 匹配，无 Referer / 不匹配抛错 → `403`。
- 设置 CORS headers 并处理 `OPTIONS`（返回 200）。
- 经 query 传参；`info` GET，`update` POST。

| 路径 | 方法 | 参数 | 成功响应 |
|---|---|---|---|
| `/api/rating/info` | GET | `id` | `{ rating: { id, '1'..'5': n } }` |
| `/api/rating/update` | POST | `id`, `value`(1–5 整数) | `{ success: true }` |
| `/api/vote/info` | GET | `id` | `{ votes: { id, up, down } }` |
| `/api/vote/update` | POST | `id`, `value`(`up`/`down`) | `{ success: true }` |

### 错误响应
- `403`：`{ error: "Forbidden Referer" }`
- `400`：`{ error: "Missing id" }` 或 `{ error: "Invalid ... parameters" }`
- `500`：`{ error: "Internal server error" }`（异常详情打印到 console）

## 架构抽象（src/server.js 路由分发）

`server.js` 维护一个路由表：

```
{
  'GET  /api/rating/info':  handlerRatingInfo,
  'POST /api/rating/update': handlerRatingUpdate,
  'GET  /api/vote/info':    handlerVoteInfo,
  'POST /api/vote/update':  handlerVoteUpdate,
  'OPTIONS *':              handlerCORS,
}
```

解析 `req.url`（用 `URL` 对象取 `pathname` 与 `query`），按 `METHOD + pathname` 查表分发；未命中返回 `404`。每个 handler 内部先 `checkReferer`，再做参数校验，再调用 `src/db.js`。`server.js` 监听 `process.env.PORT || 5556`。

## 参数校验（沿用现有）

- rating/update：`value` 须能 `parseInt` 且 1–5，否则 `400`。
- vote/update：`value` 须为 `'up'` 或 `'down'`，否则 `400`。
- info：`id` 缺失 → `400`。

## Docker 化

### Dockerfile（多阶段）
1. **builder**：`node:20-alpine`，复制 `package*.json`，`npm ci`（编译 better-sqlite3 原生模块需要 `python3`/`make`/`g++`，在此阶段安装）。
2. **runtime**：`node:20-alpine`，复制 `package.json` 与 `node_modules`（含已编译原生模块），复制 `src/`。
   - `EXPOSE 5556`
   - 环境变量：`PORT=5556`、`DB_PATH=/data/starvote.db`
   - `CMD ["node", "src/server.js"]`

### docker-compose.yml（部署模板，可放服务器或由 CI 放置）
- 服务 `starvote`：`image: ghcr.io/<owner>/star-vote:latest`
- `ports: ["5556:5556"]`
- `volumes: ["starvote_data:/data"]`
- `environment: HOSTS=...`
- （可选）`restart: unless-stopped`

## GitHub Actions（.github/workflows/deploy.yml）

触发：`on: { push: { branches: [main] } }`

步骤：
1. **构建镜像**：`docker/metadata-action` 生成 tags（`latest` + `sha-<shortsha>`）+ `docker/login-action`（registry `ghcr.io`，用 `GITHUB_TOKEN`，即 `secrets.GITHUB_TOKEN`）+ `docker/build-push-action`（`platforms: linux/amd64`）。
2. **SSH 部署**：`appleboy/ssh-action` 连接服务器，执行：
   ```
   cd <deploy_dir>
   docker compose pull
   docker compose up -d
   ```
   服务器需已放置 `docker-compose.yml`。

仓库 secrets（服务器侧，非代码）：`SSH_HOST`、`SSH_USERNAME`、`SSH_KEY`（及可选 `SSH_PORT`）。部署目录可经 secret `DEPLOY_PATH` 注入。

## 服务器前置条件（文档说明，非代码交付）
- 安装 Docker Engine 与 Docker Compose plugin。
- 创建非 root 运行用户，配置对部署目录的写权限与 SSH。
- 放置 `docker-compose.yml` 于部署目录。
- 在 GitHub 仓库配置上述 secrets。
- 反向代理（Nginx/Caddy）将域名转发到 `127.0.0.1:5556`。

## 错误处理
- 请求层：`checkReferer` 失败 → 403；参数非法 → 400；各 handler 外层 try/catch → 500，并 `console.error` 打印异常。
- 数据层：SQLite 操作抛错向上传播至 handler 的 catch。
- 启动时：`DB_PATH` 目录不存在则用 `fs.mkdirSync(recursive)` 创建；建表失败直接导致进程报错退出（fail-fast 便于排查）。

## 测试策略
- 单元：`src/db.js` 用临时数据库文件（如 `:memory:`）验证四个函数与原子自增（幂等、并发）行为。
- 接口：启动 `server.js`（`PORT` 随机 + `DB_PATH` 临时 + 无需真实 Referer 白名单或临时 `HOSTS`），对四个端点发请求断言状态码与 JSON；分别覆盖合法入参与非法入参（403/400/404/500）。
- 不依赖外部服务，全部本地可跑。

## 文件变更清单
- 新增：`src/server.js`、`src/db.js`、`Dockerfile`、`.dockerignore`、`docker-compose.yml`、`.github/workflows/deploy.yml`、`docs/superpowers/specs/2026-10-02-starvote-sqlite-docker-design.md`
- 删除：`api/_leancloud.js`、`api/_supabase.js`、`api/_utils.js`、`api/rating/*`、`api/vote/*`、`supabase/*`
- 修改：`package.json`（加 `better-sqlite3`；`scripts.start`）、`.env.example`（改为 `PORT`/`DB_PATH`/`HOSTS`）、`.gitignore`（忽略 `data/`）、`README.md`（更新部署说明）