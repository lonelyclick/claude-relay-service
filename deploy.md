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

从开发机远程触发腾讯机器部署：

```bash
./deploy.sh --remote
```

在腾讯机器上直接部署：

```bash
cd /home/ubuntu/projects/claude-oauth-relay
./deploy.sh
```

部署脚本会执行：

1. 检查 git 工作区是否干净。
2. `git fetch origin && git pull --ff-only origin main`。
3. 检查必要 env key 是否存在，但不会打印密钥值。
4. `pnpm install --frozen-lockfile`。
5. `pnpm build`。
6. 分别 `pm2 restart cor-relay --update-env`、`pm2 restart cor-server --update-env`，然后 `pm2 save`。
7. 校验本地和公网 HTTP 端点。

## 可覆盖参数

```bash
REMOTE_HOST=ubuntu@43.160.224.233
SSH_KEY=~/.ssh/id_ed25519_tencent_43_160_224_233
APP_DIR=/home/ubuntu/projects/claude-oauth-relay
BRANCH=main
REMOTE_NAME=origin
```

跳过某些步骤：

```bash
SKIP_INSTALL=1 ./deploy.sh
SKIP_BUILD=1 ./deploy.sh
SKIP_VERIFY=1 ./deploy.sh
```

默认拒绝 dirty worktree。确实要在未提交状态下部署时才使用：

```bash
ALLOW_DIRTY=1 ./deploy.sh
```

## 必要环境变量

生产机根目录 `.env` 必须至少配置：

- `DATABASE_URL`
- `ADMIN_UI_SESSION_SECRET`
- `INTERNAL_TOKEN`
- `RELAY_CONTROL_URL`
- `BETTER_AUTH_DATABASE_URL`
- `BETTER_AUTH_API_URL`

生产机 `web/.env.production` 必须至少配置：

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
./deploy.sh --remote
```

紧急情况下可在腾讯机器短期切到已知可用 commit 并重启，确认服务恢复后再补 revert commit：

```bash
cd /home/ubuntu/projects/claude-oauth-relay
git fetch origin
git switch --detach <known-good-sha>
pnpm install --frozen-lockfile
pnpm build
pm2 restart cor-relay --update-env
pm2 restart cor-server --update-env
pm2 save
```

## 常见问题

- `pnpm install --frozen-lockfile` 失败：在开发机执行 `pnpm install --lockfile-only`，提交 `pnpm-lock.yaml` 后再部署。
- PM2 显示 online 但端口不通：先等几秒，再分别看 `pm2 logs cor-relay --lines 120 --nostream` 和 `pm2 logs cor-server --lines 120 --nostream`。
- 管理台报 `RELAY_CONTROL_URL is not configured`：检查生产 `.env` 中 `RELAY_CONTROL_URL=http://127.0.0.1:3560` 是否存在，并 `pm2 restart cor-server --update-env`。
- `BETTER_AUTH_DATABASE_URL is not configured`：检查生产 `.env` 中该 key 是否存在，值应指向 cc-webapp 使用的 Better Auth 数据库。
- CORS 报“当前来源未被允许访问管理台”：确认 `dash.tokenqiao.com` 仍由 Nginx 指向 `127.0.0.1:3561`，且相关 allowed origins 没被改回旧域名。
