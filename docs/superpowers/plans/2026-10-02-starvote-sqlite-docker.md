# StarVote SQLite + Docker 改造实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 StarVote 从 Vercel Serverless Functions + LeanCloud/Supabase 双后端，改造为 SQLite 唯一后端、可 Docker 化部署的独立 Node HTTP 服务，并新增 GitHub Actions 自动构建部署。

**Architecture:** `src/server.js` 用内置 `node:http` 手写路由分发，映射原 `/api/*` 路径；`src/db.js` 用 `better-sqlite3` 封装两表原子自增。Dockerfile 多阶段构建，compose 挂载 volume 持久化，GH Actions push 到 main 时构建推送 GHCR 并 SSH 部署。

**Tech Stack:** Node.js 20 (ESM)、`better-sqlite3`、内置 `node:http`、Docker + Docker Compose、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-10-02-starvote-sqlite-docker-design.md`

## Global Constraints

- ESM 语法：所有 `import`/`export`。
- Node 版本：20（`node:20-alpine`）。
- SQLite 驱动：`better-sqlite3`。
- 端口：容器监听 `5556`；通过 `process.env.PORT || 5556`。
- DB 路径：默认 `/data/starvote.db`；通过 `process.env.DB_PATH` 覆盖。
- 对外 API 路径与响应格式**保持原样**：`/api/rating/info`、`/api/rating/update`、`/api/vote/info`、`/api/vote/update`。
- Referer 白名单校验保留，读取 `HOSTS`（逗号分隔）。
- 删除 LeanCloud/Supabase 相关文件与 `.env.example` 中对应变量。
- 提交用中文 message。

## Review Focus

- `checkReferer`：`HOSTS` 为空时拒绝所有请求（即使是配置疏漏）而非放行。
- 原子自增：同 `id` 连续 `update` 多次计数正确累加，不覆盖。
- 参数校验：`rating/update` 的 `value` 为 `NaN`、`0`、`6`、小数均 `400`。
- CORS 预检：`OPTIONS` 请求返回 200 且带 CORS headers，不进业务路由。
- 未知路由返回 `404` 而非崩溃或 500。

---

### Task 1: package.json 与依赖脚手架

**Files:**
- Modify: `package.json`
- Test: 无（依赖安装验证）

**Interfaces:**
- Consumes: 现有 `package.json`（`"type": "module"`）
- Produces: 新增 `better-sqlite3` 依赖、`scripts`（`start`、`test`）

- [ ] **Step 1: 更新 `package.json`，加入 `better-sqlite3` 依赖**

```json
{
  "type": "module",
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test"
  },
  "dependencies": {
    "axios": "^1.6.0",
    "better-sqlite3": "^11.0.0"
  }
}
```

- [ ] **Step 2: 安装依赖**

Run: `npm install`
Expected: 成功，生成 `package-lock.json`，且 `node_modules/better-sqlite3` 存在。

- [ ] **Step 3: 验证模块可加载**

Run: `node -e "import('better-sqlite3').then(m=>console.log('ok', typeof m.default))"`
Expected: 输出 `ok function`（0 失败）。

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: 添加 better-sqlite3 依赖与 npm scripts"
```

---

### Task 2: SQLite 数据层 `src/db.js`

**Files:**
- Create: `src/db.js`
- Create: `test/db.test.js`

**Interfaces:**
- Consumes: `better-sqlite3`
- Produces:
  - `createDb(dbPath) -> db`：打开/初始化数据库（建表），`dbPath` 目录不存在自动创建，`':memory:'` 支持。
  - `getRating(db, id) -> { id?, '1'..'5'? }`（无记录返回 `{}`）
  - `updateRating(db, id, score) -> void`（score 1–5 整数，对 `s<score>` 原子自增）
  - `getVote(db, id) -> { id?, up?, down? }`（无记录返回 `{}`）
  - `updateVote(db, id, type) -> void`（type `'up'`/`'down'`，对对应列原子自增）

- [ ] **Step 1: 写失败测试 `test/db.test.js`**

用 `node:test` 与 `node:assert`，DB 用 `':memory:'`。覆盖：
- `getRating` 无记录返回 `{}`。
- `updateRating` 后 `getRating` 返回正确计数；同一 `id` 连续 `updateRating(id, 5)` 两次 → `'5' === 2`。
- `getVote` 无记录返回 `{}`；`updateVote(id,'up')` ×2 + `updateVote(id,'down')` → `{up:2, down:1}`。
- `updateRating(id, value)` 对非 `1..5` 抛错（由调用方先校验，但防呆）；此处仅测合法范围自增正确，非法抛错可在本任务顺带断言。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- test/db.test.js`
Expected: FAIL（找不到 `createDb` 等导出）。

- [ ] **Step 3: 实现 `src/db.js`**

导出 `createDb(dbPath)` 打开 `better-sqlite3` 连接（`dbPath !== ':memory:'` 时先 `mkdirSync(dirname, {recursive:true})`），执行建表：

```sql
CREATE TABLE IF NOT EXISTS rating_counts (id TEXT PRIMARY KEY, s1 INTEGER DEFAULT 0, s2 INTEGER DEFAULT 0, s3 INTEGER DEFAULT 0, s4 INTEGER DEFAULT 0, s5 INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS vote_counts    (id TEXT PRIMARY KEY, up  INTEGER DEFAULT 0, down INTEGER DEFAULT 0);
```

`updateRating` 用单条 `INSERT ... ON CONFLICT(id) DO UPDATE SET s<sc> = s<sc> + 1`（构造时校验 score 在 1..5，否则 throw）。`getRating` 查询后映射 `s1..s5` → `'1'..'5'`。`updateVote` 同理，`type` 校验 `up`/`down`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- test/db.test.js`
Expected: PASS（全部断言通过，含连续自增计数正确）。

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/db.test.js
git commit -m "feat: 实现 SQLite 数据层与原子自增测试"
```

---

### Task 3: HTTP 服务与路由 `src/server.js`

**Files:**
- Create: `src/server.js`
- Create: `test/server.test.js`

**Interfaces:**
- Consumes:
  - `createDb`（Task 2）
  - Task 2 的 `getRating/updateRating/getVote/updateVote`
  - `checkReferer`（本任务内置，或抽到 `src/http.js`）
- Produces:
  - `createServer(opts) -> (db, req, res) => void` 或 `startServer(opts) -> http.Server`
  - 启动时读取 `PORT`（默认 `5556`）、`DB_PATH`、`HOSTS`。
  - `checkReferer(req)`：解析 `req.headers.referer`，`new URL(referer).hostname` 必须在 `HOSTS` 白名单，否则 throw；`HOSTS` 为空则拒绝一切（见 Review Focus）。

- [ ] **Step 1: 写失败测试 `test/server.test.js`**

用 `node:test` 启动一个 `EPHEMERAL_PORT` 的真实 server（随机可用端口，如二次 `server.address().port`），`DB_PATH` 用 `':memory:'` 或临时文件，`HOSTS` 设为测试域名。用全局 `fetch`（Node 20 内置）发请求。覆盖 Review Focus 各点：
- `GET /api/rating/info?id=x` 且 Referer 命中白名单 → 200 `{rating:{}}`。
- 不带 Referer / Referer 不匹配 → 403 `{error:"Forbidden Referer"}`。
- `OPTIONS /api/rating/info` → 200 且响应头含 `Access-Control-Allow-Origin`。
- `POST /api/rating/update?id=x&value=5` → 200 `{success:true}`；随后 info 返回 `{'5':1}`。
- `POST /api/rating/update?id=x&value=9` → 400 `{error:"Invalid rating parameters"}`。
- `POST /api/vote/update?id=x&value=bad` → 400 `{error:"Invalid vote parameters"}`。
- `GET /api/unknown` → 404。
- `HOSTS` 为空时任意 Referer → 403。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- test/server.test.js`
Expected: FAIL（找不到 `src/server.js` 导出 / 模块不存在）。

- [ ] **Step 3: 实现 `src/server.js`**

用 `node:http.createServer`，`req.url` 用 `new URL(req.url, 'http://x')` 拆出 `pathname` 与 `searchParams`。维护路由表 `'GET /api/rating/info'` 等四个条目 + OPTIONS 兜底 + 未命中 404。每个 handler 先 `checkReferer`（失败 → 403 + 不继续），再参数校验，再调 db。输出统一 `res.setHeader` CORS headers + `res.writeHead` + `res.end(JSON.stringify(...))`。监听 `process.env.PORT || 5556`。提供 `export function createServer()` 返回 server 供测试注入 db/选项（`createServer({ db, hosts, port })`），启动分支仅当作为主模块执行时自动监听。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- test/server.test.js`
Expected: PASS（全部端点 + Review Focus 断言通过）。

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: 实现 node:http 路由服务与接口测试"
```

---

### Task 4: 清理旧 Vercel/云后端文件

**Files:**
- Delete: `api/*`（`_leancloud.js`、`_supabase.js`、`_utils.js`、`rating/*`、`vote/*`）
- Delete: `supabase/`

**Interfaces:**
- Consumes: （无）
- Produces: 仓库纯净，仅保留 `src/` 服务与配套文件。

- [ ] **Step 1: 删除云后端与 Vercel 函数文件**

```bash
git rm -r api supabase
```

- [ ] **Step 2: 用 `node -c` 或快速启动验证无残留引用**

Run: `node --check src/server.js`
Expected: PASS（无语法错误）；且 `grep -r "leancloud\|supabase" src || true` 无输出。

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor: 移除 LeanCloud/Supabase 后端与 Vercel functions"
```

---

### Task 5: Dockerfile、.dockerignore、docker-compose.yml

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `docker-compose.yml`

**Interfaces:**
- Consumes: `src/server.js`（入口）、`package*.json`
- Produces: 可运行的容器镜像 `star-vote`（node:20-alpine，监听 5556，DB 在 `/data/starvote.db`）

- [ ] **Step 1: 写 `Dockerfile`（多阶段）**

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
WORKDIR /app
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=5556 DB_PATH=/data/starvote.db
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
EXPOSE 5556
CMD ["node", "src/server.js"]
```

- [ ] **Step 2: 写 `.dockerignore`**

```text
node_modules
data
.git
docs
test
README.md
agents.md
```

- [ ] **Step 3: 写 `docker-compose.yml`**

镜像 `ghcr.io/<owner>/star-vote:latest`（`<owner>` 用户运行时替换），`ports: ["5556:5556"]`，`volumes: ["starvote_data:/data"]`，`environment: HOSTS=...`，`restart: unless-stopped`。

- [ ] **Step 4: 本地验证镜像可构建可运行**

Run: `docker build -t star-vote:test . && docker run --rm -e HOSTS=localhost -p 5556:5556 star-vote:test`
Expected: 容器启动；`curl -H "Referer: http://localhost" "http://localhost:5556/api/rating/info?id=1"` 返回 `{"rating":{}}`。结束后清理容器。

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml
git commit -m "feat: 添加 Dockerfile 与 compose 部署模板"
```

---

### Task 6: GitHub Actions 工作流 `deploy.yml`

**Files:**
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: Docker 镜像 `star-vote`、GHCR、SSH 服务器
- Produces: push 到 main 自动构建→推 GHCR→SSH 部署

- [ ] **Step 1: 写 `deploy.yml`**

```yaml
name: build-and-deploy
on:
  push:
    branches: [main]
jobs:
  build-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=ref,event=branch
            type=sha
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          platforms: linux/amd64
          cache-from: type=gha
          cache-to: type=gha,mode=max
  deploy:
    runs-on: ubuntu-latest
    needs: build-push
    steps:
      - uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USERNAME }}
          key: ${{ secrets.SSH_KEY }}
          port: ${{ secrets.SSH_PORT }}
          script: |
            cd ${{ secrets.DEPLOY_PATH }}
            docker compose pull
            docker compose up -d
```

- [ ] **Step 2: 校验 YAML 语法**

Run: `node -e "const y=require('js-yaml')"` 若已装，否则用 `python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/deploy.yml'))"`（可用）验证解析。
Expected: 解析成功（无 YAML 错误）。

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: 添加 GitHub Actions 构建推送与 SSH 部署"
```

---

### Task 7: 文档与环境变量收尾

**Files:**
- Modify: `.env.example`（改为 `PORT`/`DB_PATH`/`HOSTS`）
- Modify: `.gitignore`（忽略 `data/`）
- Modify: `README.md`（更新部署说明为 Docker + compose）
- Modify: `agents.md`（如存在，同步新结构）

**Interfaces:**
- Consumes: 前序全部产物
- Produces: 与实现一致的项目文档

- [ ] **Step 1: 重写 `.env.example`**

```dotenv
PORT=5556
DB_PATH=/data/starvote.db
# 允许的 Referer 域名（逗号分隔）
HOSTS=localhost, xaoxuu.com, xaox.cc
```

- [ ] **Step 2: 更新 `.gitignore`** 追加 `data/`。

- [ ] **Step 3: 更新 `README.md`**：删除 LeanCloud/Supabase 段落，改为「Docker 构建 + compose 部署 + GH Actions 自动部署」说明，列出 `PORT`/`DB_PATH`/`HOSTS`。

- [ ] **Step 4: 同步 `agents.md`** 反映 `src/`、`Dockerfile`、`deploy.yml` 新结构与 SQLite 唯一后端。

- [ ] **Step 5: 全量回归**

Run: `npm test`
Expected: ALL PASS（`test/db.test.js` + `test/server.test.js`）。

- [ ] **Step 6: Commit**

```bash
git add .env.example .gitignore README.md agents.md
git commit -m "docs: 同步环境变量/Docker 部署说明与项目结构"
```