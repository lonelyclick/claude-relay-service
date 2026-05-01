# Relay / Server 拆分实施清单（基于当前仓库）

> 文档状态：`active-implementation-checklist`
>
> 本文档是 [relay-server-split-deployment.md](./relay-server-split-deployment.md) 的实施版补充。
> 目标不是重复讲原则，而是把原则拆成“当前仓库应该怎么改”的任务清单，尽量细到文件、进程和发布动作。

---

## 1. 使用方式

本文档按五个层面拆解任务：

1. 仓库入口与构建
2. 路由装配与运行时边界
3. `relay` 的无中断发布能力
4. systemd / nginx / 发布脚本
5. 验收与上线顺序

每个任务用以下状态语义：

- `P0`：不做就无法建立正确边界
- `P1`：不做就无法建立稳定发布能力
- `P2`：增强项，可后置

本文档默认：

- 只基于当前仓库事实给出建议
- “建议新增文件”都是目标改造入口，不表示这些文件当前已存在
- 发布条件不满足时直接失败，不允许 fallback 到 `SERVICE_MODE=all`、单实例硬重启或“先上再说”

---

## 2. 当前仓库的关键改造入口

### 2.0 阶段进度快照

- `P0-A`：已完成代码侧收口，仓库不再提供单进程 `all` 入口
- `P0-B`：已完成第一版拆包，`apps/relay` 与 `apps/server` 可以独立构建与启动
- `P1-A`：已完成，`relay` 已有 readiness / draining / 连接计数
- `P1-B`：未完成，systemd / nginx / 发布脚本还需要收口
- `P2`：进行中，control API 已覆盖第一批关键写路径

### 2.1 入口与初始化

当前入口：

- [apps/relay/src/main.ts](/home/workspaces/repos/claude-oauth-relay/apps/relay/src/main.ts:1)
- [apps/server/src/main.ts](/home/workspaces/repos/claude-oauth-relay/apps/server/src/main.ts:1)

当前问题：

1. `src/bootstrap/baseRuntime.ts` 仍统一初始化 `OAuthService`、`UsageStore`、`UserStore`、`ApiKeyStore`、`BillingStore`、`SupportStore`
2. `server` 仍直接持有多类数据层依赖，而不是只保留最小控制面依赖
3. 根入口虽已删除，但共享 runtime 还没有收缩到真正清晰的边界

### 2.2 路由装配

当前总装配文件：

- [src/server.ts](/home/workspaces/repos/claude-oauth-relay/src/server.ts:1261)

当前问题：

1. 同一个文件里仍同时装配 `/admin/*`、`/internal/ccwebapp/*`、管理台静态页面、relay catch-all
2. admin/internal 与 relay 仍共享一套装配 helper，而不是完全拆成独立模块
3. `/livez`、`/readyz` 已落地，但路由级代码边界仍偏厚

### 2.3 构建与包管理

当前构建入口：

- [package.json](/home/workspaces/repos/claude-oauth-relay/package.json:10)
- [apps/relay/package.json](/home/workspaces/repos/claude-oauth-relay/apps/relay/package.json:1)
- [apps/server/package.json](/home/workspaces/repos/claude-oauth-relay/apps/server/package.json:1)
- [apps/admin-web/package.json](/home/workspaces/repos/claude-oauth-relay/apps/admin-web/package.json:1)
- [web/package.json](/home/workspaces/repos/claude-oauth-relay/web/package.json:6)

当前问题：

1. 根 `build` / `check` 仍是聚合入口，不是完全解耦后的独立发布仓位
2. `admin-web` 目前还是对 `web/` 的包装，不是迁移完成后的独立源码树
3. `packages/shared` 还没有抽出

---

## 3. 总体实施顺序

建议按以下五阶段推进：

1. `P0-A`：先把进程与域名边界跑正确，哪怕代码暂时还没拆包
2. `P0-B`：拆入口、拆构建、拆产物
3. `P1-A`：给 `relay` 增加 readiness / draining / 连接计数
4. `P1-B`：补 systemd / nginx / 发布脚本，形成滚动发布链路
5. `P2`：把控制面写操作下沉为 `server -> relay control API`

原则：

- 不要一上来同时做“拆包 + control API + 无中断发布”
- 先拿到正确边界，再补无中断能力，最后再清理深层耦合
- 如果某阶段前置条件不满足，就停在该阶段，不做 fallback

---

## 4. Phase P0-A：先把进程边界跑正确

### 4.1 目标

在不大改代码结构的前提下，先做到：

1. `server` 重启不影响外部 API
2. 公网流量不再经过 `server`
3. 生产禁用 `SERVICE_MODE=all`

### 4.2 仓库任务

#### 任务 A1

- 优先级：`P0`
- 类型：约束落地
- 改动位置：README / 部署说明

动作：

1. 把生产建议从“可选双开”升级为“生产必须双开”
2. 明确写出：生产禁用 `SERVICE_MODE=all`
3. 明确写出：公网域名只指向 `relay`

完成标准：

- 任何生产 runbook 都不再出现单进程 `all` 模式

#### 任务 A2

- 优先级：`P0`
- 类型：部署调整
- 改动位置：systemd / nginx

动作：

1. 单独启动一个 `SERVICE_MODE=relay` 实例
2. 单独启动一个 `SERVICE_MODE=server` 实例
3. 把管理域名与公网 API 域名分开

完成标准：

- 只重启 `server` 时，公网 `/v1/*` 和 WebSocket 不抖动

### 4.3 本阶段不做的事

1. 不做 workspace 拆包
2. 不做 control API
3. 不承诺 `relay` 无中断发布

---

## 5. Phase P0-B：拆入口与构建

### 5.1 目标

把当前单体启动改造成三个独立产物：

- `relay`
- `server`
- `admin-web`

### 5.2 建议新增文件

以下是建议目标结构，不代表必须一次性完全照搬，但至少应朝这个方向收敛：

```text
apps/
  relay/
    package.json
    tsconfig.json
    src/
      main.ts
      app.ts
      runtime.ts
  server/
    package.json
    tsconfig.json
    src/
      main.ts
      app.ts
      runtime.ts
  admin-web/
    package.json
    tsconfig.json
    src/...
packages/
  shared/
    package.json
    src/
      types/
      schemas/
      dto/
```

### 5.3 现有文件改造清单

#### 任务 B1：拆共享入口

- 优先级：`P0`
- 当前文件：
  - [apps/relay/src/main.ts](/home/workspaces/repos/claude-oauth-relay/apps/relay/src/main.ts:1)
  - [apps/server/src/main.ts](/home/workspaces/repos/claude-oauth-relay/apps/server/src/main.ts:1)
  - [src/bootstrap/baseRuntime.ts](/home/workspaces/repos/claude-oauth-relay/src/bootstrap/baseRuntime.ts:1)

动作：

1. 已完成：把入口拆成 `relay main` 与 `server main`
2. 继续把共享初始化逻辑从 `baseRuntime` 进一步收缩
3. 持续约束 `server main` 不要重新长回 `RelayService`、upgrade handler、keepAliveRefresher

建议目标：

- `buildRelayRuntime()`
- `buildServerRuntime()`

完成标准：

1. `relay` 启动日志只反映数据面依赖
2. `server` 启动日志只反映控制面依赖
3. `server` 进程中不再创建 relay WebSocket upgrade 逻辑

#### 任务 B2：拆 `src/server.ts`

- 优先级：`P0`
- 当前文件：[src/server.ts](/home/workspaces/repos/claude-oauth-relay/src/server.ts:1261)

动作：

1. 把当前 `createServer()` 拆成：
   - `createRelayApp()`
   - `createServerApp()`
2. 把 admin/internal/UI 注册逻辑搬到 `server` 侧
3. 把 relay catch-all、OpenAI bare path normalize、upgrade 相关逻辑搬到 `relay` 侧
4. 把共享 helper 抽到更小的纯函数模块

建议拆分方向：

- `src/server/adminRoutes.ts`
- `src/server/internalRoutes.ts`
- `src/server/adminUi.ts`
- `src/relay/httpRoutes.ts`
- `src/relay/upgrade.ts`

完成标准：

1. `server` app 不再 import `RelayService`
2. `relay` app 不再装配 admin/internal/UI 路由
3. 单测或 smoke test 能分别启动两套 app

#### 任务 B3：拆包管理

- 优先级：`P0`
- 当前文件：
  - [package.json](/home/workspaces/repos/claude-oauth-relay/package.json:1)
  - [web/package.json](/home/workspaces/repos/claude-oauth-relay/web/package.json:1)

动作：

1. 新增 `pnpm-workspace.yaml`
2. 根 `package.json` 改成 workspace orchestration
3. 新建 `apps/relay/package.json`
4. 新建 `apps/server/package.json`
5. 把 `web/` 平移或映射为 `apps/admin-web`

建议脚本：

- 根：
  - `build:relay`
  - `build:server`
  - `build:web`
  - `build`
- 子包：
  - 各自独立 `dev/build/start/check`

完成标准：

1. 不再存在“构建一个后端顺手构建整个前端”的隐式耦合
2. 可以只发布 `server`
3. 可以只发布 `relay`

#### 任务 B4：共享层收敛

- 优先级：`P0`

动作：

1. 把纯类型、schema、DTO 抽到 `packages/shared`
2. 保证 `shared` 内没有 runtime 状态和数据库连接

完成标准：

- `shared` 只承载静态复用内容，不承载进程级逻辑

---

## 6. Phase P1-A：给 `relay` 增加无中断发布能力

### 6.1 目标

让 `relay` 从“能跑”进化到“能滚动发布”。

### 6.2 代码任务

#### 任务 C1：增加实例状态机

- 优先级：`P1`
- 建议新增文件：
  - `src/relay/instanceState.ts`

状态：

- `starting`
- `ready`
- `draining`
- `stopped`

动作：

1. 进程启动时进入 `starting`
2. runtime 初始化完成后切到 `ready`
3. 收到 drain / `SIGTERM` 时切到 `draining`
4. 退出前切到 `stopped`

完成标准：

- app 内部可以可靠判断“是否还能接新流量”

#### 任务 C2：增加 `/livez` 与 `/readyz`

- 优先级：`P1`
- 建议新增文件：
  - `src/relay/healthRoutes.ts`

动作：

1. 保留现有 `/healthz` 兼容用途
2. 新增 `/livez`
3. 新增 `/readyz`
4. `/readyz` 与实例状态联动，而不是只看进程是否启动

完成标准：

1. nginx / systemd / 发布脚本可用 `/readyz` 判定是否接流量
2. `draining` 状态下 `/readyz` 必须非 200

补充说明：

- 如果生产继续使用 stock nginx，`/readyz` 主要服务于发布脚本和外部控制逻辑
- 不应假设 nginx 会主动轮询 `readyz` 并自动摘除 upstream 成员

#### 任务 C3：增加连接计数

- 优先级：`P1`
- 建议新增文件：
  - `src/relay/connectionTracker.ts`

动作：

1. 统计 `activeHttpRequests`
2. 统计 `activeStreams`
3. 统计 `activeWebSockets`

接入点建议：

1. HTTP 请求入口 middleware
2. 流式响应发送路径
3. `RelayService.handleUpgrade()` 成功 upgrade 后

完成标准：

- 可以在 shutdown / drain 时读取精确计数

#### 任务 C4：增加 drain 协议

- 优先级：`P1`
- 当前入口：
  - [src/bootstrap/relayMain.ts](/home/workspaces/repos/claude-oauth-relay/src/bootstrap/relayMain.ts:1)
  - [src/bootstrap/serverMain.ts](/home/workspaces/repos/claude-oauth-relay/src/bootstrap/serverMain.ts:1)

动作：

1. 已完成：`shutdown()` 已改造成 draining 优先的两阶段流程
2. 已完成：draining 后先等待 `DRAIN_DETACH_GRACE_MS`
3. 已完成：随后拒绝新请求和新 upgrade
4. 已完成：等待连接计数排空
5. 已完成：达到 `DRAIN_TIMEOUT_MS` 后强制清理剩余连接
6. 剩余工作：把进程级 drain 与 upstream 摘流量编排脚本真正串起来

建议新增参数：

- `DRAIN_TIMEOUT_MS`
- `DRAIN_POLL_INTERVAL_MS`
- `DRAIN_DETACH_GRACE_MS`

完成标准：

1. `SIGTERM` 不再直接等价于“立刻退出”
2. 单个实例可先摘流量、再排空、再退出
3. readiness 变红后，应用层会等待摘流量传播窗口，而不是立刻把仍可能打进来的请求全部拒掉

#### 任务 C5：拒绝新流量的应用层钩子

- 优先级：`P1`

动作：

1. 在 HTTP 入口判断实例状态
2. 在 upgrade 前判断实例状态
3. 在 `draining` 状态下，结合 `DRAIN_DETACH_GRACE_MS` 或等价子状态决定何时开始真正拒绝新流量

建议行为：

- 摘流量传播窗口结束后：
  - HTTP：`503 draining`
  - WebSocket upgrade：直接拒绝 upgrade

完成标准：

- 摘流量传播窗口结束后，`draining` 实例不会继续吸入新流量

---

## 7. Phase P1-B：infra 与发布脚本

### 7.1 systemd 清单

#### 任务 D1：`relay` 模板服务

- 优先级：`P1`
- 目标文件：部署机上的 `cor-relay@.service`

建议参数：

1. 每个实例独立 `EnvironmentFile`
2. 每个实例独立 `PORT`
3. `ExecStartPre` 可做轻量检查，但不做重迁移
4. `ExecStop` 不要直接 `kill -9`
5. `TimeoutStopSec` 要大于 `DRAIN_TIMEOUT_MS`

补充建议：

1. 如果要支持“先起新实例再摘旧实例”，部署侧要么预留第三个端口 / 实例槽位，要么由编排层提供 surge 能力
2. 如果只有两个固定端口，则发布策略必须改成“先 drain 再在空槽位拉新实例”

完成标准：

- systemd 不会在 drain 未完成时过早杀进程

#### 任务 D2：`server` 独立服务

- 优先级：`P0`
- 目标文件：部署机上的 `cor-server.service`

建议要求：

1. 与 `relay` 独立
2. 重启不触发 `relay` restart
3. 有自己的 env 文件

### 7.2 nginx 清单

#### 任务 D3：`relay` upstream 池

- 优先级：`P1`

建议形态：

```nginx
upstream cor_relay {
    server 127.0.0.1:3560;
    server 127.0.0.1:3562;
    keepalive 64;
}
```

补充说明：

- 上面只是最小双实例形态
- 如果部署策略要求“先起新实例再摘旧实例”，还需要额外 surge 槽位，例如临时第三端口或第三实例

要求：

1. 公网 API 域名只代理到 `cor_relay`
2. 开启 WebSocket upgrade 所需 header
3. 发布脚本能够暂时摘除某个实例
4. 如果使用 stock nginx，发布脚本必须显式控制 upstream 成员或端口映射，而不是依赖被动健康检查

#### 任务 D4：`server` 独立 upstream

- 优先级：`P0`

建议形态：

```nginx
upstream cor_server {
    server 127.0.0.1:3561;
}
```

要求：

1. 管理域名只代理到 `cor_server`
2. 不兜底承接 `/v1/*` 与 WebSocket

### 7.3 发布脚本清单

#### 任务 D5：`relay` 滚动发布脚本

- 优先级：`P1`

脚本应做的事：

1. 先判断本次发布模式：
   - 有 surge 槽位：走“先起新实例，再摘旧实例”
   - 无 surge 槽位：走“先 drain 旧实例，再在空槽位拉起新实例”
2. 若为无 surge 模式，先确认剩余实例有能力承接全部流量
3. 若为 surge 模式，先启动新实例并等待 `/readyz`
4. 将一个旧实例切为 `draining`
5. 执行 upstream 摘流量动作
6. 等待 `DRAIN_DETACH_GRACE_MS` 或等价确认
7. 等待连接排空
8. 超时后再停旧实例
9. 若为无 surge 模式，则在该空槽位启动新实例并等待 `/readyz`
10. 重复处理其他旧实例

硬门禁：

1. 在线实例数小于 2 时，脚本直接失败
2. 若当前采用 surge 模式，且新实例未 ready，则不得摘旧实例
3. 若采用“先起新实例再摘旧实例”模型，却没有 surge 槽位，脚本直接失败
4. 若采用无 surge 模式，但剩余实例容量不足，则脚本直接失败
5. 若 upstream 摘流量动作失败，脚本直接失败

#### 任务 D6：`server` 独立发布脚本

- 优先级：`P0`

脚本应做的事：

1. 只发 `server`
2. 只重启 `cor-server.service`
3. 不碰 `relay`

---

## 8. Phase P2：control API 化

### 8.1 目标

让 `server` 变成真正的控制面，而不是“半个 relay”。

### 8.2 优先迁移的写操作

建议按以下顺序迁移：

1. accounts
2. routing groups
3. sticky sessions / session routes
4. scheduler stats / proxy probe
5. relay users
6. API keys
7. billing 写操作

### 8.3 当前文件级清理点

#### 任务 E1：清理 `server` 对 relay runtime 的直接依赖

- 优先级：`P2`
- 当前文件：[src/server.ts](/home/workspaces/repos/claude-oauth-relay/src/server.ts:1261)

动作：

1. 把直接调用 `services.oauthService`、`services.userStore`、`services.billingStore` 的写操作改为调用 relay control API
2. `server` 保留必要的读聚合或改为 API 聚合层

#### 任务 E2：清理硬编码数据库连接

- 优先级：`P1`
- 当前文件：[src/server.ts](/home/workspaces/repos/claude-oauth-relay/src/server.ts:72)

动作：

1. 移除硬编码 `postgresql://guang@/cor?host=/var/run/postgresql`
2. 改为显式配置项
3. 明确区分 relay DB 与 server 侧外部系统连接

完成标准：

- `server` 不再依赖机器本地特定路径和用户名假设

---

## 9. 验收清单

### 9.1 P0 验收

1. 生产上不再使用 `SERVICE_MODE=all`
2. `server` 与 `relay` 独立进程运行
3. 只重启 `server` 时，对外 `/v1/*` 和 WebSocket 不受影响

### 9.2 P1 验收

1. `relay` 存在 `/readyz`
2. `relay` 能进入 `draining`
3. 摘流量传播窗口结束后，`draining` 实例不再接新流量
4. 滚动发布期间，新请求无明显失败峰值
5. 发布脚本不会在只剩一个实例时继续执行

### 9.3 P2 验收

1. `server` 不再持有完整 relay runtime
2. 关键写操作都经由 relay control API
3. `server` 可单独扩容、回滚，而不拖动 relay 数据面

---

## 10. 推荐实施顺序

最务实的落地顺序：

1. 先完成 `P0-A`：双进程、双域名、禁用生产 `all`
2. 再完成 `P0-B`：拆入口、拆构建、拆产物
3. 再完成 `P1-A`：实例状态、`/readyz`、连接计数、drain
4. 再完成 `P1-B`：systemd、nginx、滚动发布脚本
5. 最后完成 `P2`：control API 化

不建议的顺序：

1. 先做 control API，边界却还没跑正确
2. 还在单实例时就尝试承诺 `relay` 无中断发布
3. 一次性同时改动路由、包管理、发布链路和 DB 契约
4. 发布条件不满足时临时 fallback 到 `SERVICE_MODE=all` 或“全部实例一起重启”

---

## 11. 最终提醒

这份实施清单最重要的约束只有两条：

1. `server` 的高可用问题，本质是“边界问题”，先靠拆进程和拆域名解决
2. `relay` 的高可用问题，本质是“状态与发布问题”，必须靠多实例、drain 和滚动发布解决

只要这两条顺序不搞反，整个改造就不会走偏。
