# StarVote

轻量级的**评分 / 投票后端服务**。1–5 星评分与 up/down 投票计数，使用 SQLite 持久化，可 Docker 容器化部署，CI 自动构建镜像。

**零第三方运行时依赖**：HTTP 用 Node 内置 `node:http`，数据库用 Node 内置 `node:sqlite`，即开即用。

## 特性

- 1–5 星评分计数（按分数分列统计）
- up / down 投票计数
- SQLite 持久化（容器挂 volume，重启不丢数据）
- Referer 域名白名单校验，防盗链
- 零依赖、单文件入口、轻量镜像

## 快速开始（本地）

```bash
npm start           # 需先设置环境变量，见下方
```

或一次性指定：

```bash
PORT=5556 DB_PATH=./data/starvote.db HOSTS=localhost npm start
```

启动后，数据库文件自动创建于 `DB_PATH`（目录不存在会自动建立）。

> 注意：`HOSTS` 为空时服务会**拒绝所有请求**，因此本地调试务必设置 `HOSTS=localhost`。

## Docker 部署

### 方式一：直接运行镜像

```bash
# 本地构建
docker build -t star-vote .

# 运行（挂 volume 持久化，5556 端口）
docker run -d \
  -p 5556:5556 \
  -v starvote_data:/data \
  -e HOSTS=yourdomain.com \
  star-vote
```

### 方式二：docker-compose

复制 `docker-compose.yml`，把 `<owner>` 换成你的 GitHub 用户名（或直接改为本地镜像名 `star-vote`），并填写 `HOSTS`，然后：

```bash
docker compose up -d
```

### 反向代理（可选）

用 Nginx / Caddy 将你的域名转发到 `127.0.0.1:5556`，并确保 `HOSTS` 包含该域名。

## 构建镜像（CI）

`.github/workflows/deploy.yml` 在 push 到 `main` 时自动执行：

1. 用 buildx 构建镜像（`linux/amd64`）
2. 推送至 GHCR：`ghcr.io/<owner>/star-vote:latest`

GHCR 鉴权使用自动提供的 `GITHUB_TOKEN`，无需额外配置。构建完成后可在任意环境 `docker pull ghcr.io/<owner>/star-vote` 使用。

## 接口文档

统一规则：`info` 用 GET，`update` 用 POST；参数走 query；请求需带**白名单内的 `Referer`**，否则返回 `403`。

| 路径 | 方法 | 参数 | 成功响应 |
|---|---|---|---|
| `/api/rating/info` | GET | `id` | `{ "rating": { id, "1".."5": 计数 } }` |
| `/api/rating/update` | POST | `id`, `value`(1–5 整数) | `{ "success": true }` |
| `/api/vote/info` | GET | `id` | `{ "votes": { id, "up", "down" } }` |
| `/api/vote/update` | POST | `id`, `value`(`up`/`down`) | `{ "success": true }` |

### 示例

```bash
# 查询评分（id=article-1）
curl -H "Referer: https://example.com" \
  "http://localhost:5556/api/rating/info?id=article-1"
# → {"rating":{}}

# 提交 5 星评分
curl -X POST -H "Referer: https://example.com" \
  "http://localhost:5556/api/rating/update?id=article-1&value=5"
# → {"success":true}

# 查询投票
curl -H "Referer: https://example.com" \
  "http://localhost:5556/api/vote/info?id=article-1"
# → {"votes":{}}

# 投 up 票
curl -X POST -H "Referer: https://example.com" \
  "http://localhost:5556/api/vote/update?id=article-1&value=up"
# → {"success":true}
```

再次查询 `rating/info`，可看到 `"5"` 计数累加。

### 错误响应

| 状态码 | 场景 | 响应体 |
|---|---|---|
| `400` | 缺少 `id` 或参数非法（如 `value` 非整数、超出 1–5、投票非 `up/down`） | `{ "error": "Missing id" }` / `{ "error": "Invalid ... parameters" }` |
| `403` | 无 `Referer` 或不在白名单 | `{ "error": "Forbidden Referer" }` |
| `404` | 未知路径 | `{ "error": "Not Found" }` |
| `500` | 服务内部异常 | `{ "error": "Internal server error" }` |

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
├── Dockerfile             # node:24-alpine 单阶段镜像（零依赖）
├── docker-compose.yml     # 部署模板
├── .github/workflows/deploy.yml   # CI：构建并推送镜像
└── docs/superpowers/      # 设计与实现文档
```
