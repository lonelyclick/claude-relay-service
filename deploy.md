# TokenQiao 部署

本仓库生产部署只保留腾讯新加坡机器链路，不再恢复 ncu 旧部署。

## 当前生产拓扑

| 项 | 值 |
|---|---|
| 生产主机 | 腾讯云新加坡 `43.160.224.233` |
| SSH | `ssh -i ~/.ssh/id_ed25519_tencent_43_160_224_233 ubuntu@43.160.224.233` |
| 生产目录 | `/home/ubuntu/projects/tokenqiao` |
| 分支 | `main` |
| 包管理 | `pnpm` |
| PM2 进程 | `tokenqiao-relay`、`tokenqiao-server` |
| relay 端口 | `3560` |
| server/admin 端口 | `3561` |
| 前端发布 | Cloudflare Pages project `ccdash` |

域名入口：

| 域名 | Nginx upstream | 用途 |
|---|---|---|
| `api.tokenqiao.com` | `127.0.0.1:3560` | Claude Code / OpenAI-compatible relay API |
| `ccproxy.yohomobile.dev` | `127.0.0.1:3560` | 兼容旧 ccproxy 入口 |
| `ccapi.yohomobile.dev` | `127.0.0.1:3560` | 兼容旧 API 入口 |
| `dash.tokenqiao.com` | `ccdash.pages.dev` | Cloudflare Pages 管理台前端 |

## 快速部署

从开发机触发部署。`relay`、`server`、`frontend` 必须分开执行：

```bash
./deploy.sh relay
./deploy.sh server
./deploy.sh frontend
```

部署前强制要求：

- 当前本地仓库必须在 `main` 分支。
- 本地工作区必须干净，没有未提交文件。
- 本地 `HEAD` 必须已经推送到 `origin/main`。
- `relay` / `server` 的腾讯生产目录也必须在 `main` 分支，且 pull 前工作区干净。

部署脚本会执行：

1. 在开发机检查 `main`、clean worktree、`HEAD == origin/main`。
2. `relay` 目标 SSH 到腾讯，pull 最新代码，`pnpm run build:relay`，只重启 `tokenqiao-relay`。
3. `server` 目标 SSH 到腾讯，pull 最新代码，`pnpm run build:server`，只重启 `tokenqiao-server`。
4. `frontend` 目标在开发机 build `web`，然后用 Wrangler 发布 `web/dist` 到 Cloudflare Pages project `ccdash`。
5. 校验目标对应的本地或公网 HTTP 端点。

## 可覆盖参数

```bash
REMOTE_HOST=ubuntu@43.160.224.233
SSH_KEY=~/.ssh/id_ed25519_tencent_43_160_224_233
APP_DIR=/home/ubuntu/projects/tokenqiao
BRANCH=main
REMOTE_NAME=origin
```

`frontend` 目标会自动读取本机未提交文件 `.deploy.cloudflare.env`，文件格式：

```bash
CLOUDFLARE_EMAIL=...
CLOUDFLARE_API_KEY=...
CLOUDFLARE_ACCOUNT_ID=...
```

这个文件已被 `.gitignore` 忽略，不要提交。也可以用 `CLOUDFLARE_ENV_FILE=/path/to/file ./deploy.sh frontend` 指定其他凭证文件。

## 必要环境变量

`relay` 目标要求生产机根目录 `.env` 至少配置：

- `DATABASE_URL`
- `INTERNAL_TOKEN`

`server` 目标要求生产机根目录 `.env` 至少配置：

- `DATABASE_URL`
- `ADMIN_UI_SESSION_SECRET`
- `INTERNAL_TOKEN`
- `RELAY_CONTROL_URL`
- `BETTER_AUTH_DATABASE_URL`
- `BETTER_AUTH_API_URL=https://tokenqiao.com/api/auth`
- `ADMIN_UI_ALLOWED_ORIGINS=https://dash.tokenqiao.com`

`frontend` 目标要求开发机 `web/.env.production` 至少配置：

- `VITE_API_BASE_URL=https://api.tokenqiao.com`

不要把真实 `.env`、数据库连接串、token 或 OAuth secret 提交到 git。

## 手工验证

```bash
pm2 list | grep -E 'tokenqiao-relay|tokenqiao-server'
curl -sS -o /dev/null -w "relay local HTTP %{http_code}\n" http://127.0.0.1:3560/healthz
curl -sS -o /dev/null -w "server local HTTP %{http_code}\n" http://127.0.0.1:3561/healthz
curl -sS -o /dev/null -w "api HTTP %{http_code}\n" https://api.tokenqiao.com/healthz
curl -sS -o /dev/null -w "ccproxy HTTP %{http_code}\n" https://ccproxy.yohomobile.dev/healthz
curl -sS -o /dev/null -w "dash HTTP %{http_code}\n" https://dash.tokenqiao.com/
```

`/healthz` 响应体可能包含账号摘要，排障时不要在公开渠道粘贴完整输出。

## 回滚

优先使用 git 正向回滚，生成一条新的 revert commit 后重新部署：

```bash
git log --oneline -20
git revert <bad-commit-sha>
./deploy.sh relay
# 或
./deploy.sh server
# 或
./deploy.sh frontend
```

## 常见问题

- `pnpm install --frozen-lockfile` 失败：在开发机执行 `pnpm install --lockfile-only`，提交 `pnpm-lock.yaml` 后再部署。
- PM2 显示 online 但端口不通：先等几秒，再分别看 `pm2 logs tokenqiao-relay --lines 120 --nostream` 和 `pm2 logs tokenqiao-server --lines 120 --nostream`。
- `dash.tokenqiao.com` 页面没有更新：确认执行的是 `./deploy.sh frontend`，并查看 Wrangler 输出的 Cloudflare Pages deployment id。
- 管理台报 `RELAY_CONTROL_URL is not configured`：检查生产 `.env` 中 `RELAY_CONTROL_URL=http://127.0.0.1:3560` 是否存在，并 `pm2 restart tokenqiao-server --update-env`。
- `BETTER_AUTH_DATABASE_URL is not configured`：检查生产 `.env` 中该 key 是否存在，值应指向 cc-webapp 使用的 Better Auth 数据库。
- CORS 报“当前来源未被允许访问管理台”：确认 `dash.tokenqiao.com` 仍由 Nginx 指向 `127.0.0.1:3561`，且相关 allowed origins 没被改回旧域名。
