# Relay / Server 拆分与无中断部署方案（基于当前仓库）

> 文档状态：`active-spec`
>
> 本文档只以当前仓库现状为依据，目标是把 `relay` 与 `server` 的拆分、部署边界、发布顺序和中断控制策略收敛成一份可执行方案。
> 未能从仓库直接确认的能力，统一标记为“新增要求”或“目标态”，不得误当成现状已具备。
> 对应的实施版任务清单见 [relay-server-split-implementation-checklist.md](./relay-server-split-implementation-checklist.md)。

---

## 1. 文档目标

本文档解决两类问题：

1. `server` 重启时，不应影响对外 API / WebSocket 服务
2. `relay` 发布或重启时，新请求不应中断；已在使用中的用户应尽量无感，至少不能因为单次发布把所有在线用户同时踢掉

本文档采用以下硬约束：

1. 不使用“发布失败时回退到 `SERVICE_MODE=all`”这种 fallback
2. 不使用“只有一个 `relay` 实例也照常硬重启”这种 fallback
3. 任何不满足前置条件的发布，都应直接失败并停止推进

这里的术语统一为：

- `relay`：公网数据面，承接 `/v1/*`、`/api/*`、WebSocket、上游转发、账号调度、token refresh、usage 写入
- `server`：控制面，承接 `/admin/*`、`/internal/ccwebapp/*`、管理台登录态、管理台静态资源、内部同步
- `admin-web`：管理台前端静态资源

---

## 2. 当前仓库基线

### 2.1 已完成的拆分基础

当前仓库已经完成第一轮包级拆分：

- 已有独立子包：`apps/relay`、`apps/server`、`apps/admin-web`
- 已有独立入口：`apps/relay/src/main.ts`、`apps/server/src/main.ts`
- 根入口 `src/index.ts` 已移除，不再提供单进程根入口
- `server` 进程不注册 relay catch-all 和 WebSocket upgrade
- `relay` 进程会把 `/admin`、`/internal` 直接挡掉
- `server` 的关键管理写接口已经改为转发到 relay private control API

这意味着：

- 当前已经具备独立构建、独立启动、独立重启的基础边界
- 但这还不是“代码层彻底解耦”和“发布链路完全闭环”

### 2.2 当前仍然耦合的点

以下现状决定了“已经拆包，但还没彻底拆干净”：

1. `src/server.ts` 仍同时承载 admin/internal/UI 与 relay 路由装配
2. `src/bootstrap/baseRuntime.ts` 仍是共享初始化中心，`server` 仍直接持有多类 DB-backed store
3. `admin-web` 目前还是对 `web/` 子项目的包级包装，不是真正迁移后的独立源码树
4. 仍有部分控制面写路径未完全下沉到 relay private control API
5. `server` 内还存在硬编码的 `cor` PostgreSQL 连接，不适合长期作为独立可部署控制面

结论：

- 当前仓库已经具备“进程边界正确”的基础
- 但还没达到“控制面 / 数据面代码边界彻底清晰”

### 2.3 当前对无中断发布的限制

当前代码已经补上了第一层无中断能力，但还不能虚假承诺“重启完全无感”。

已确认现状：

1. 已有实例级 draining 状态、`/livez`、`/readyz`
2. 已有 `activeHttpRequests` / `activeStreams` / `activeWebSockets` 连接计数
3. 已有 shutdown drain 轮询与 detach grace
4. WebSocket 连接仍然是 client socket 与 upstream socket 的进程内直接桥接
5. 账号级 `handoff` / `session route` 只能解决“换账号继续”，不能解决“进程退出后接管现有 socket”
6. 仓库内仍缺少强约束的多实例滚动发布脚本与编排收口

因此：

- 单实例 `relay` 无法承诺“重启时用户完全不断”
- 只有多实例滚动发布，才有资格讨论“尽量无感”

---

## 3. 目标态

### 3.1 目标一：`server` 重启不影响外部服务

目标定义：

- 外部用户请求只进入 `relay`
- `server` 不再承接任何必须在线的公网数据面流量
- `server` 挂掉或重启时，只影响：
  - 管理后台
  - `/internal/ccwebapp/*`
  - 管理员登录态与控制操作

不应影响：

- `/v1/*`
- `/api/*`
- WebSocket upgrade
- 正在进行中的模型请求

### 3.2 目标二：`relay` 发布时尽量无感

目标定义分两档：

#### A. 必须保证

1. 新请求不因发布而返回 502 / 连接拒绝
2. 短连接 HTTP 请求不因发布而被粗暴中断
3. 单个实例退出时，不应把所有在线用户一起踢掉

#### B. 尽量保证

1. 流式响应尽量自然跑完
2. WebSocket 尽量保持到会话自然结束
3. 若 WebSocket 最终因 drain 超时被切断，客户端重连后应尽量回到同一条 session route，而不是随机换上下文

#### C. 不应虚假承诺

以下能力不应写成默认保证：

1. 单实例 `relay` 重启时用户完全不断
2. 进程退出后现有 WebSocket 连接被新进程“接管”
3. 任意时长的长连接在发布窗口内 100% 零断线

---

## 4. 推荐架构

### 4.1 包结构

目标目录结构：

- `apps/relay`
- `apps/server`
- `apps/admin-web`
- `packages/shared`

职责如下：

#### `apps/relay`

只承接数据面：

- `/v1/*`
- `/api/*`
- WebSocket
- OAuth / API key 上游转发
- account scheduling
- keepalive / refresh
- usage / billing preflight / session route

#### `apps/server`

只承接控制面：

- `/admin/*`
- `/internal/ccwebapp/*`
- Better Auth / 组织同步
- admin session
- admin-web runtime config 注入

#### `apps/admin-web`

只承接前端构建产物：

- Vite / React 构建
- 运行时 `apiBaseUrl`、Keycloak 配置注入

#### `packages/shared`

只放共享静态内容：

- DTO
- zod schema
- types
- 少量纯函数 helper

明确禁止放入 `packages/shared` 的内容：

- Express app bootstrap
- runtime service container
- 直接连接数据库的 store 实现
- 含进程状态的调度器、keepalive、WebSocket 桥接逻辑

### 4.2 域名与流量边界

建议的生产流量边界：

- 公网 API 域名 -> `relay`
- 管理域名 -> `server`

以当前 README 中的命名习惯为例：

- `api.tokenqiao.com` 或对外 API 域名 -> `relay`
- 独立 `admin` 子域或管理域名 -> `server`

硬约束：

1. 公网域名不得反代到 `server`
2. 管理域名不得兜底承接 `relay` catch-all
3. `server` 不参与 WebSocket upgrade
4. `relay` 不暴露 `/admin/*` 与 `/internal/*`

### 4.3 进程模型

生产环境至少包含以下进程：

- `cor-relay@1.service`
- `cor-relay@2.service`
- `cor-server.service`

说明：

- `relay` 至少双实例，才有滚动发布空间
- `server` 单实例通常可接受；如果管理台本身也要求高可用，可再扩成双实例
- 严禁把 `relay` 与 `server` 放进同一个 systemd service 或同一个 restart 单元

---

## 5. 控制面 / 数据面边界

### 5.1 总原则

`server` 不应继续直接承载完整 relay runtime。

目标态下：

- `server` 负责“发控制命令”
- `relay` 负责“持有和执行数据面状态”

### 5.2 推荐的边界迁移方式

推荐新增 `relay private control API`，只对内网开放，由 `server` 调用。

优先迁移到 `relay` control API 的能力：

1. account 管理
2. routing group 管理
3. sticky session / session route 管理
4. scheduler stats / account health / proxy probe
5. relay user、API key、billing 写操作

保留在 `server` 的能力：

1. admin session
2. Better Auth / 组织同步
3. admin-web 静态资源
4. 管理台页面级聚合接口

### 5.3 过渡期允许的方案

在完全切到 control API 前，可以有一个过渡阶段：

- `apps/relay` 与 `apps/server` 已独立构建、独立部署
- 但两者暂时仍共享一部分数据库表和 store 库

这个阶段可以作为过渡，但不能视为终态。原因：

1. 发布边界仍然会受共享运行时逻辑影响
2. 长期会造成 schema 和职责继续缠绕
3. 很难建立清晰的 ownership

---

## 6. 无中断发布策略

### 6.1 `server` 的发布策略

`server` 的目标很简单：

- 重启不影响外部 API

要求：

1. `server` 独立 systemd 服务
2. `server` 独立 health check
3. 管理域名只指向 `server`
4. 发布 `server` 时不得顺带 reload / restart `relay`

推荐发布顺序：

1. 发布 `server`
2. 重启 `cor-server.service`
3. 验证 `/admin/session/me`、`/admin/*`
4. 不动 `relay`

### 6.2 `relay` 的发布策略

`relay` 必须使用“多实例 + drain + 滚动”的方式。

最小要求：

1. 至少 2 个 `relay` 实例
2. 前面有可摘流量的 nginx upstream
3. 每个实例有独立 readiness
4. 发布时先摘流量，再等连接排空，再停实例

补充要求：

1. 发布开始前，至少应有 2 个 `ready` 的 `relay` 实例
2. 剩余 `ready` 实例的容量必须足以承接被摘除实例的流量
3. 若要执行“先起新实例、再摘旧实例”，则必须具备 surge 槽位

这里的 surge 槽位是指：

- 预留第三个实例位 / 端口
- 或由容器编排层提供 `maxSurge`
- 或存在其他可先拉起新副本、再摘除旧副本的能力

若生产只有两个固定端口、没有 surge 槽位：

- 仍可做滚动发布
- 但发布顺序必须改为“先 drain 一个旧实例 -> 停止 -> 在该槽位拉起新实例 -> 等 ready -> 再处理另一槽”
- 这要求剩余单实例能短时间承接全部流量

### 6.3 `relay` 的实例状态机

新增要求：每个 `relay` 实例应有以下状态。

- `starting`
- `ready`
- `draining`
- `stopped`

状态语义：

#### `starting`

- 进程已启动
- 还未通过 readiness
- 不接新流量

#### `ready`

- 可以接新 HTTP / stream / WebSocket
- health check 返回可用

#### `draining`

- 不再接新请求
- 不再接新 WebSocket upgrade
- 已有请求继续执行
- 已有 WebSocket 尽量保留到自然结束

#### `stopped`

- 进程退出

### 6.4 `relay` 的 readiness / liveness

新增要求：

- `/livez`：只回答“进程还活着”
- `/readyz`：回答“是否可以接新流量”

建议语义：

#### `/livez`

返回 200 的条件：

- 进程事件循环正常
- 必需依赖没有进入不可恢复异常

#### `/readyz`

返回 200 的条件：

- 实例状态为 `ready`
- 数据库可用
- relay runtime 初始化完成

返回非 200 的条件：

- `starting`
- `draining`
- 数据库不可用
- runtime 初始化失败

注意：

- 当前仓库已有 `/healthz`，但它更接近“混合状态页”，不能直接当最终 readiness 设计
- `readyz` 是应用层 readiness 信号，不等于 stock nginx 会自动探测并摘实例
- 如果继续使用开源 nginx 静态 upstream，摘流量动作仍需要由发布脚本改 upstream 成员、切换端口映射或 reload nginx 配置来完成

### 6.5 `relay` 的连接计数

新增要求：实例内维护至少三类计数器。

- `activeHttpRequests`
- `activeStreams`
- `activeWebSockets`

用途：

1. 发布时决定是否允许实例退出
2. 暴露给管理接口或 metrics
3. 作为 drain 超时判断依据

### 6.6 `relay` 的 drain 行为

当实例收到 `SIGTERM` 或显式 drain 命令时，必须按以下顺序处理：

1. 将实例状态切为 `draining`
2. `/readyz` 立刻返回非 200
3. 触发 upstream 摘流量动作
4. 等待摘流量传播窗口，或显式确认 upstream 已停止把新流量送到该实例
5. 再拒绝新的 HTTP 请求或 upgrade
6. 继续处理当前已经进入实例的请求
7. 继续保留当前已建立的 WebSocket，直到自然结束或达到超时
8. 超过 `DRAIN_TIMEOUT_MS` 后，再强制关闭剩余连接
9. 所有计数归零后退出进程

补充要求：

- `server.close()` 只能作为最后阶段动作，不能代替整个 drain 协议
- 需要在应用层显式区分“停止接新流量”和“强制关连接”
- 建议引入 `DRAIN_DETACH_GRACE_MS` 或等价机制，避免 readiness 刚变红时就把尚未完成摘流量的请求打成 `503`

### 6.7 长连接的现实边界

必须明确写清楚：

1. 现有 WebSocket 是进程内桥接，无法跨进程接管
2. 因此“已建立的单条 WebSocket 永不掉线”不是可默认承诺
3. 正确目标是：
   - 发布期间尽量不主动切现有连接
   - 真到 drain 超时才切
   - 被切后依赖客户端重连
   - 重连后尽量回到同一 session route 或获得 handoff summary

---

## 7. 生产部署要求

### 7.1 systemd

禁止使用：

- 单 service 同时启动 `relay` 和 `server`
- 一个 restart 脚本同时重启所有数据面实例

建议：

- `cor-relay@.service`
- `cor-server.service`

每个实例独立：

- `EnvironmentFile`
- 端口
- 日志
- 健康检查

### 7.2 nginx upstream

建议：

- `relay` 使用 upstream 池
- `server` 单独 upstream

对 `relay` upstream 的要求：

1. 支持临时摘除某个实例
2. 支持 WebSocket upgrade
3. 发布期间只把新流量发给已保留在 upstream 中的实例
4. 如果使用 stock nginx，需要把“谁还在 upstream 池里”作为发布脚本的显式控制动作，而不是假设 nginx 会主动探测 `readyz`

### 7.3 数据库迁移

所有涉及 `relay` / `server` 的 schema 变更必须按兼容顺序执行：

1. `expand`
2. `deploy`
3. `contract`

禁止：

1. 先发 `server`，再做会让旧版 `relay` 直接崩溃的 schema 变更
2. 先删旧字段，再让新旧实例混跑

### 7.4 环境变量

建议拆成独立 env：

- `/etc/cor/relay.env`
- `/etc/cor/server.env`

要求：

1. `relay` 与 `server` 不共享完全相同的 env 模板
2. `server` 不应继续依赖硬编码数据库连接
3. `relay` 的发布配置中应包含 drain 超时相关参数

---

## 8. 发布 Runbook

### 8.1 `server` 发布 Runbook

适用场景：

- 管理台
- Better Auth 相关
- `/internal/ccwebapp/*`
- admin 聚合接口

步骤：

1. 构建并发布 `server`
2. 重启 `cor-server.service`
3. 验证管理域名 `/healthz`、`/admin/session/me`
4. 验证管理台页面可加载
5. 验证 `/internal/ccwebapp/*` 关键接口
6. 确认 `relay` 实例无任何变更

预期结果：

- 外部模型请求无影响
- 管理台短暂不可用是可接受范围

### 8.2 `relay` 发布 Runbook

适用场景：

- `/v1/*`
- `/api/*`
- WebSocket
- routing / scheduling / proxy / upstream forwarding

步骤：

1. 先完成兼容性数据库迁移
2. 判断本次发布模型：
   - 若存在 surge 槽位：先启动一个新 `relay` 实例并等待 `ready`
   - 若不存在 surge 槽位：确认剩余实例有能力承接全部流量
3. 选择一个旧实例，切换为 `draining`
4. 执行 upstream 摘流量动作
5. 等待摘流量传播窗口或确认 upstream 已停止转发新流量
6. 等待 `activeHttpRequests=0`
7. 等待 `activeStreams` 和 `activeWebSockets` 尽量归零
8. 达到超时后，强制关闭仍存活的剩余连接
9. 停止旧实例
10. 如果本轮是“无 surge 槽位”模式，则在该槽位启动新实例并等待 `ready`
11. 对其他旧实例重复上述动作

发布门禁：

1. 任何时候至少保留 1 个 `ready` 的 `relay` 实例
2. 若在线实例数只有 1 个，则禁止执行 `relay` 发布
3. 若当前采用 surge 模式，且新实例未通过 readiness，则不得摘除旧实例
4. 若不满足容量、槽位或摘流量能力前提，则发布脚本必须失败，不能 fallback 到硬重启

### 8.3 紧急回滚

回滚原则：

1. 优先恢复 `relay` 数据面
2. `server` 可后置恢复

若 `relay` 新版本异常：

1. 立即把新实例从 upstream 摘掉
2. 保持旧实例继续承接流量
3. 恢复上一版本实例
4. 若做过 `expand` 迁移，则旧版必须仍可兼容

---

## 9. 阶段化落地建议

### 阶段 A：先把边界跑通

目标：

- 即使代码还没完全拆包，也先把生产流量边界跑正确

当前状态：

- 已基本完成：仓库已具备独立 `relay` / `server` 入口，且不再提供 `SERVICE_MODE=all`

动作：

1. 使用独立 `start:relay` / `start:server` 入口
2. 以两个独立 systemd 服务运行
3. 公网域名只指向 `relay`
4. 管理域名只指向 `server`
5. 生产环境禁止恢复单进程混部

效果：

- `server` 重启不影响外部服务
- 但还不能称为“彻底分包”

### 阶段 B：拆包与独立构建

目标：

- `apps/relay`
- `apps/server`
- `apps/admin-web`

当前状态：

- 已完成首版拆包与独立构建
- 剩余问题主要是 `web/` 真正迁移、`packages/shared` 抽取，以及共享 runtime 收口

动作：

1. 保持独立入口与独立构建脚本
2. 继续抽 `packages/shared`
3. 让 `admin-web` 不再仅仅包装 `web/`
4. 继续削减根聚合脚本对三者的耦合

效果：

- 独立构建、独立制品、独立发布

### 阶段 C：control API 化

目标：

- `server` 不再直接持有完整 relay runtime

当前状态：

- 进行中：accounts / routing / oauth / proxy / user / apiKey / billing 已覆盖第一批关键写路径
- 剩余工作是把余下写操作与聚合边界继续下沉

动作：

1. 把 account / routing / scheduler / proxy / user / apiKey / billing 写操作逐步下沉到 `relay control API`
2. `server` 改为调用私有控制接口

效果：

- 控制面 / 数据面边界清晰
- `server` 的重启、扩容、回滚与 `relay` 解耦

### 阶段 D：真正的无中断 relay 发布

目标：

- 多实例滚动
- readiness
- draining
- 连接计数

当前状态：

- readiness / draining / 连接计数已落地
- 剩余工作集中在多实例发布脚本、systemd / nginx 联动，以及发布前置条件校验

动作：

1. 增加实例状态机
2. 增加 `/readyz`
3. 增加连接计数
4. 增加 drain 协议
5. 改造发布脚本

效果：

- 新请求无损
- 在线用户尽量无感

### 阶段 E：仓库级改造清单

本节不是目标态能力，而是把目标态落到当前仓库时，最直接的一组代码改造入口。

#### 入口与构建

1. 已完成：原单入口已拆成 `relay` 与 `server` 两个 bootstrap
2. 已完成：根 `package.json` 不再提供单体 `build` / `start`
3. 把当前 `web/` 迁到真正独立的 `admin-web` 包源码树

#### 路由装配

1. 把当前 `src/server.ts` 中的 admin/internal/UI 注册逻辑抽成 `server` 侧 route registrar
2. 把当前 relay catch-all 与 upgrade 逻辑抽成 `relay` 侧 route registrar
3. 让 `server` 与 `relay` 各自只装配本侧需要的依赖

#### 运行时状态

1. 为 `relay` 增加实例状态管理：`starting` / `ready` / `draining` / `stopped`
2. 为 `relay` 增加连接计数器：HTTP、stream、WebSocket
3. 为 `relay` 增加 `/livez` 与 `/readyz`
4. 为 `relay` 增加 drain 协议与退出超时

#### 控制面边界

1. 逐步把 account / routing / scheduler / proxy / user / apiKey / billing 写操作改为 `server -> relay control API`
2. 清理 `server` 内对 relay runtime 的直接依赖
3. 清理 `server` 内硬编码数据库连接，改为显式配置

#### 发布脚本

1. 把“重启单实例”脚本改成支持两种模型：
   - 有 surge 槽位：`启动新实例 -> readiness -> 旧实例 draining -> 排空 -> 停止`
   - 无 surge 槽位：`旧实例 draining -> 排空 -> 停止 -> 在空槽位启动新实例 -> readiness`
2. 为 `server` 与 `relay` 准备独立发布命令
3. 为回滚准备“保留旧实例在线”的发布策略

---

## 10. 验收标准

### 10.1 `server` 验收

满足以下条件才算达标：

1. `server` 重启期间，公网 `/v1/*` 和 `/api/*` 无 5xx 抖动
2. `server` 重启期间，WebSocket upgrade 成功率不下降
3. 管理域名恢复后，admin session 和关键管理操作可正常使用

### 10.2 `relay` 验收

满足以下条件才算达标：

1. 单个 `relay` 实例进入 `draining` 后，不再接新流量
2. 发布期间，短连接请求无明显失败峰值
3. 发布期间，流式请求大多数自然完成
4. 达到超时前，不主动粗暴关闭现有 WebSocket
5. 若 WebSocket 被迫断开，客户端重连后能继续命中既有 session route / handoff 语义

### 10.3 不达标信号

出现以下情况，说明方案未落成：

1. 发布 `server` 会触发 `relay` 重启
2. 单个实例 drain 前仍然持续接新流量
3. 只有 1 个 `relay` 实例也照常发布
4. 发布脚本直接 `restart all relay`
5. 把账号级 `handoff` 误当成进程级连接接管

---

## 11. 最终结论

结论分三层：

1. 仅从当前仓库出发，`server` 与 `relay` 已经可以做“进程级分流”，但还不是“彻底分包”
2. `server` 重启不影响外部服务，是可以做成强保证的
3. `relay` 重启时“用户完全不断”，单实例做不到；正确目标是“多实例滚动 + drain + 新请求无损 + 长连接尽量无感”

因此，推荐落地顺序是：

1. 先把生产边界改对：公网只进 `relay`，管理只进 `server`
2. 再拆包和独立构建
3. 再把控制面改成 `server -> relay private control API`
4. 最后补齐 readiness、draining、连接计数和滚动发布

只有做到第四步，才能把“`relay` 发布时尽量不打断正在使用的用户”从口头目标变成工程能力。
