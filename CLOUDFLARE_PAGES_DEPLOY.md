# Cloudflare Pages 部署指南

## 双模式部署架构

### 模式 1：本地部署（已有）
```
┌──────────────────────────────────────┐
│  ncu 服务器                          │
│  域名: token.yohomobile.dev          │
│  ├─ 后端 API（端口 3300）            │
│  └─ 前端 SPA（/admin-next/）         │
└──────────────────────────────────────┘
```

### 模式 2：Cloudflare Pages（新增）
```
┌──────────────────────────────────────┐
│  Cloudflare Pages (全球 CDN)         │
│  域名: token.yohomobile.com          │
│  内容: Vue 3 SPA 管理前端            │
└──────────────┬───────────────────────┘
               │ HTTPS 跨域请求（CORS）
               ▼
┌──────────────────────────────────────┐
│  ncu 服务器                          │
│  域名: token.yohomobile.dev          │
│  端口: 3300                          │
│  内容: Express API 后端服务          │
└──────────────────────────────────────┘
```

**两种模式共存**，互不影响：
- `token.yohomobile.dev/admin-next/` → 本地部署，同源访问
- `token.yohomobile.com` → Cloudflare Pages，跨域访问（CDN 加速）

## Cloudflare Pages 项目配置

### 基本设置

- **项目名称**: `claude-relay-admin`
- **生产分支**: `main`
- **框架预设**: None（或 Vue）

### 构建配置

**构建命令**:
```bash
cd web/admin-spa && ./build-cloudflare.sh
```

**构建输出目录**:
```
web/admin-spa/dist
```

**根目录**:
```
/
```

### 环境变量（Build Environment Variables）

在 Cloudflare Pages 项目设置中添加：

| 变量名 | 值 |
|--------|---|
| `NODE_VERSION` | `18` |

**注意**: 前端的 API 地址配置在 `web/admin-spa/.env.cloudflare` 中，构建时会自动使用。

### Node.js 版本

Cloudflare Pages 默认使用 Node.js 12，需要在项目根目录添加 `.nvmrc` 或 `.node-version` 文件：

```bash
18
```

## 自定义域名配置

1. 登录 Cloudflare Pages Dashboard
2. 进入项目 `claude-relay-admin`
3. 点击 **Custom domains**
4. 添加域名: `token.yohomobile.com`
5. 按照提示配置 DNS CNAME 记录（自动完成）

## 部署方式

### 方式 1: Git Push 自动部署（推荐）

```bash
git add .
git commit -m "feat: 前端 Cloudflare Pages 部署配置"
git push origin main
```

Cloudflare Pages 会自动检测到代码变更并触发构建。

### 方式 2: Wrangler CLI 手动部署

```bash
# 安装 Wrangler（如未安装）
npm install -g wrangler

# 登录
wrangler login

# 部署
cd web/admin-spa
./build-cloudflare.sh
wrangler pages deploy dist --project-name=claude-relay-admin
```

## 后端 CORS 配置

后端已配置允许 `token.yohomobile.com` 跨域访问：

**`.env` 配置**:
```bash
CRS_CORS_ORIGINS=https://token.yohomobile.com
```

**生效**: 重启后端服务后生效。

## 验证部署

1. 访问 `https://token.yohomobile.com`
2. 检查登录功能
3. 检查 API 调用（打开浏览器开发者工具 Network 面板）
4. 确认 CORS 请求正常（响应头包含 `Access-Control-Allow-Origin`）

## 故障排查

### CORS 错误

**症状**: 浏览器控制台显示 CORS 错误

**解决**:
1. 确认后端 `.env` 包含 `CRS_CORS_ORIGINS=https://token.yohomobile.com`
2. 重启后端服务: `pm2 restart crs`
3. 清除浏览器缓存

### API 请求失败

**症状**: Network 面板显示 404 或 500 错误

**解决**:
1. 检查前端 `.env.cloudflare` 中的 `VITE_API_BASE_URL` 是否正确
2. 检查后端服务是否正常运行: `pm2 status crs`
3. 检查后端日志: `pm2 logs crs`

### 静态资源 404

**症状**: 页面空白，控制台显示 `.js` 或 `.css` 404

**解决**:
1. 检查 `.env.cloudflare` 中的 `VITE_APP_BASE_URL` 是否为 `/`
2. 重新构建: `cd web/admin-spa && ./build-cloudflare.sh`
3. 重新部署到 Cloudflare Pages

## 回滚策略

Cloudflare Pages 支持一键回滚：

1. 登录 Cloudflare Pages Dashboard
2. 进入项目 `claude-relay-admin`
3. 点击 **Deployments**
4. 选择历史版本
5. 点击 **Rollback to this deployment**

## 性能优化

Cloudflare Pages 默认提供：

- ✅ 全球 CDN（300+ 数据中心）
- ✅ HTTP/3 支持
- ✅ Brotli 压缩
- ✅ 自动缓存策略
- ✅ 免费 HTTPS

无需额外配置即可获得最佳性能。

## 后续维护

### 前端代码更新流程

1. 在 `web/admin-spa/` 目录修改代码
2. 本地测试: `npm run dev`
3. 提交代码: `git commit -m "fix: ..."`
4. 推送: `git push origin main`
5. Cloudflare Pages 自动构建部署（约 2-3 分钟）
6. 访问 `token.yohomobile.com` 验证

### 环境变量更新

如需修改 API 地址等配置：

1. 编辑 `web/admin-spa/.env.cloudflare`
2. 提交并推送
3. Cloudflare Pages 自动重新构建

**注意**: Cloudflare Pages 的 Environment Variables 仅用于构建时，运行时配置需通过 `.env.cloudflare` 文件传递。
