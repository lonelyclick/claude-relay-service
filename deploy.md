# claude-oauth-relay 部署

本仓库生产部署只保留腾讯新加坡机器链路，不再恢复 ncu 旧部署。

## 当前生产拓扑

| 项 | 值 |
|---|---|
| 生产主机 | 腾讯云新加坡 `43.160.224.233` |
| SSH | `ssh -i ~/.ssh/id_ed25519_tencent_43_160_224_233 ubuntu@43.160.224.233` |
| 生产目录 | `/home/ubuntu/projects/claude-oauth-relay` |
| 分支 | `main` |
| 包管理 | `pnpm` |
| PM2 进程 | `cor-relay`、`cor-server` |
| relay 端口 | `3560` |
| server/admin 端口 | `3561` |

域名入口：

| 域名 | Nginx upstream | 用途 |
|---|---|---|
| `api.tokenqiao.com` | `127.0.0.1:3560` | Claude Code / OpenAI-compatible relay API |
| `ccproxy.yohomobile.dev` | `127.0.0.1:3560` | 兼容旧 ccproxy 入口 |
| `ccapi.yohomobile.dev` | `127.0.0.1:3560` | 兼容旧 API 入口 |
| `dash.tokenqiao.com` | `127.0.0.1:3561` | 管理台与 `/admin/*` 控制面 |

## 快速部署

从开发机触发腾讯机器部署。`relay` 和 `server` 必须分开执行，脚本不会一次性重启两个 PM2 进程：

```bash
./deploy.sh relay
./deploy.sh server
```

部署前强制要求：

- 当前本地仓库必须在 `main` 分支。
- 本地工作区必须干净，没有未提交文件。
- 本地 `HEAD` 必须已经推送到 `origin/main`。
- 腾讯生产目录也必须在 `main` 分支，且 pull 前工作区干净。

部署脚本会执行：

1. 在开发机检查 `main`、clean worktree、`HEAD == origin/main`。
2. SSH 到腾讯新加坡机器的 `/home/ubuntu/projects/claude-oauth-relay`。
3. 在生产目录检查 `main` 和 clean worktree。
4. `git fetch origin main && git pull --ff-only origin main`。
5. 检查目标所需 env key 是否存在，但不会打印密钥值。
6. `pnpm install --frozen-lockfile`。
7. `relay` 目标只执行 `pnpm run build:relay` 并重启 `cor-relay`。
8. `server` 目标执行 `pnpm run build:server`、`pnpm run build:web` 并重启 `cor-server`。
9. `pm2 save` 并校验目标对应的本地和公网 HTTP 端点。

## 可覆盖参数

```bash
REMOTE_HOST=ubuntu@43.160.224.233
SSH_KEY=~/.ssh/id_ed25519_tencent_43_160_224_233
APP_DIR=/home/ubuntu/projects/claude-oauth-relay
BRANCH=main
REMOTE_NAME=origin
```

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
- `BETTER_AUTH_API_URL`

`server` 目标还要求生产机 `web/.env.production` 至少配置：

- `VITE_API_BASE_URL=https://api.tokenqiao.com`

不要把真实 `.env`、数据库连接串、token 或 OAuth secret 提交到 git。

## 手工验证

```bash
pm2 list | grep -E 'cor-relay|cor-server'
curl -sS -o /dev/null -w "relay local HTTP %{http_code}\n" http://127.0.0.1:3560/healthz
curl -sS -o /dev/null -w "server local HTTP %{http_code}\n" http://127.0.0.1:3561/healthz
curl -sS -o /dev/null -w "api HTTP %{http_code}\n" https://api.tokenqiao.com/healthz
curl -sS -o /dev/null -w "ccproxy HTTP %{http_code}\n" https://ccproxy.yohomobile.dev/healthz
curl -sS -o /dev/null -w "dash HTTP %{http_code}\n" https://dash.tokenqiao.com/login
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
```

## 常见问题

- `pnpm install --frozen-lockfile` 失败：在开发机执行 `pnpm install --lockfile-only`，提交 `pnpm-lock.yaml` 后再部署。
- PM2 显示 online 但端口不通：先等几秒，再分别看 `pm2 logs cor-relay --lines 120 --nostream` 和 `pm2 logs cor-server --lines 120 --nostream`。
- 管理台报 `RELAY_CONTROL_URL is not configured`：检查生产 `.env` 中 `RELAY_CONTROL_URL=http://127.0.0.1:3560` 是否存在，并 `pm2 restart cor-server --update-env`。
- `BETTER_AUTH_DATABASE_URL is not configured`：检查生产 `.env` 中该 key 是否存在，值应指向 cc-webapp 使用的 Better Auth 数据库。
- CORS 报“当前来源未被允许访问管理台”：确认 `dash.tokenqiao.com` 仍由 Nginx 指向 `127.0.0.1:3561`，且相关 allowed origins 没被改回旧域名。
