# Worker 选择功能实现文档

**日期**: 2026-03-31
**功能**: 在账号创建/编辑界面添加 Worker 选择功能
**版本**: v1.1.300+

---

## 功能概述

为 Claude Relay Service 的账号管理界面添加了 Worker 节点选择功能，允许管理员在创建或编辑账号时指定使用哪个远程 Worker 处理请求，或选择本地执行。

## 业务背景

### 为什么需要 Worker？

Worker 是 CRS 的远程执行节点，可以：
1. **绕过网络限制** — Hub 在国内时，Worker 可部署在国外直接访问 AI API
2. **IP 隔离** — 不同账号使用不同 Worker，避免限流连坐
3. **网络优化** — Worker 部署在靠近上游 API 的地区，减少延迟
4. **负载分散** — 多个 Worker 分担请求压力

### 什么时候应该使用 Worker？

**强烈建议**：
- Hub 在国内，上游 API 在国外
- 多个账号共享 Hub IP
- 高价值生产账号

**不需要**：
- 测试/开发账号
- Hub 已在国外且网络良好
- 单用户低频使用

## 实现细节

### 1. 前端改动

#### 文件：`web/admin-spa/src/components/accounts/AccountForm.vue`

##### 1.1 数据模型
在表单数据中添加 `workerId` 字段（第 4045 行）：

```javascript
const form = ref({
  // ... 其他字段
  priority: props.account?.priority || 50,
  workerId: props.account?.workerId || null,  // Worker 选择
  endpointType: props.account?.endpointType || 'anthropic',
  // ...
})
```

##### 1.2 Workers 列表状态（第 3799 行）

```javascript
// Workers 列表
const workers = ref([])
const loadingWorkers = ref(false)
```

##### 1.3 获取 Workers 列表（第 6158 行）

```javascript
// 获取 Workers 列表
const fetchWorkers = async () => {
  try {
    loadingWorkers.value = true
    const res = await httpApis.getWorkersApi()
    if (res.success) {
      workers.value = res.data || []
    }
  } catch (error) {
    console.error('Failed to fetch workers:', error)
  } finally {
    loadingWorkers.value = false
  }
}
```

##### 1.4 组件挂载时加载（第 6174 行）

```javascript
onMounted(() => {
  // ... 其他初始化
  fetchWorkers()  // 获取 Workers 列表
  // ...
})
```

##### 1.5 UI 界面（第 2844-2875 行）

```vue
<!-- Worker 选择（所有平台通用） -->
<div>
  <label class="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300">
    Worker 节点 (可选)
  </label>
  <select
    v-model="form.workerId"
    class="form-input w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
    :disabled="loadingWorkers"
  >
    <option :value="null">本地执行（不使用 Worker）</option>
    <option
      v-for="worker in workers"
      :key="worker.id"
      :disabled="worker.status !== 'online'"
      :value="worker.id"
    >
      {{ worker.name }}
      <template v-if="worker.region">({{ worker.region }})</template>
      -
      {{ worker.status === 'online' ? '在线' : '离线' }}
    </option>
  </select>
  <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
    选择远程 Worker 节点处理请求，可实现 IP 隔离和网络优化。不选择则在本地执行。
    <br />
    <strong>提示：</strong>Worker 离线时会自动降级到本地执行。
  </p>
</div>
```

**UI 特性**：
- 下拉选择框，默认"本地执行"
- 显示 Worker 名称、地区、在线状态
- 离线的 Worker 禁用（灰色显示）
- 加载中时禁用选择框

##### 1.6 数据提交（第 4960-4968 行）

在所有平台的数据提交中统一添加 `workerId`：

```javascript
const data = {
  name: form.value.name,
  description: form.value.description,
  accountType: form.value.accountType,
  groupId: form.value.accountType === 'group' ? form.value.groupId : undefined,
  groupIds: form.value.accountType === 'group' ? form.value.groupIds : undefined,
  expiresAt: form.value.expiresAt || undefined,
  proxy: proxyPayload,
  workerId: form.value.workerId || null  // Worker 选择
}
```

### 2. 后端兼容性

后端已经支持 `workerId` 字段：
- 所有 RelayService 已实现 Worker 路由逻辑（见 `workerRouter.js`）
- 账号数据结构已支持 `workerId` 字段
- Worker 离线时自动降级到本地执行

**无需后端改动**，前端可直接使用。

### 3. 支持的 API 类型

所有主要 API 类型均已支持 Worker 路由：
- ✅ Claude (官方/Console)
- ✅ OpenAI Responses
- ✅ Gemini
- ✅ CCR
- ✅ Azure OpenAI
- ✅ Bedrock

## 用户体验设计

### 3.1 智能推荐（UI 提示）

选择框下方的提示文案：
> 选择远程 Worker 节点处理请求，可实现 IP 隔离和网络优化。不选择则在本地执行。
> **提示：**Worker 离线时会自动降级到本地执行。

### 3.2 降级保证

即使配置了 Worker，系统也会自动处理异常：
- Worker 离线 → 自动切换到本地执行
- Worker 连接失败 → 降级到本地执行
- 未配置 Worker → 直接本地执行

**零停机，高可用**。

### 3.3 可见性

- 在线 Worker：黑色文本，可选择
- 离线 Worker：灰色文本，禁用选择
- 实时状态：每次打开表单都重新获取 Worker 列表

## 测试场景

### 场景 1：创建新账号（选择 Worker）
1. 打开"创建账号"表单
2. 填写基本信息
3. 在"Worker 节点"下拉框选择在线的 Worker
4. 保存账号
5. **预期**：账号数据包含 `workerId`，请求通过该 Worker 执行

### 场景 2：创建新账号（本地执行）
1. 打开"创建账号"表单
2. 填写基本信息
3. "Worker 节点"保持默认"本地执行"
4. 保存账号
5. **预期**：账号 `workerId` 为 `null`，请求在 Hub 本地执行

### 场景 3：编辑已有账号（添加 Worker）
1. 编辑一个现有账号
2. 在"Worker 节点"下拉框选择 Worker
3. 保存更改
4. **预期**：账号更新 `workerId`，后续请求通过 Worker 执行

### 场景 4：编辑已有账号（移除 Worker）
1. 编辑一个配置了 Worker 的账号
2. 将"Worker 节点"改回"本地执行"
3. 保存更改
4. **预期**：账号 `workerId` 变为 `null`，请求恢复本地执行

### 场景 5：Worker 离线降级
1. 创建账号并选择某个 Worker
2. 该 Worker 离线
3. 发送请求到该账号
4. **预期**：请求自动降级到本地执行，不报错

## 性能影响

- **前端**：每次打开表单额外调用 1 次 `GET /api/admin/workers`，响应时间 < 100ms
- **后端**：无额外开销，Worker 路由逻辑已存在
- **用户体验**：Worker 选择下拉框加载中时禁用，避免竞态条件

## 安全考虑

- Workers 列表仅管理员可访问（通过 admin auth 中间件保护）
- `workerId` 字段在后端进行验证（Worker 必须存在且在线）
- 普通用户无法直接操作 Worker 配置

## 未来改进

### 可选功能
1. **智能推荐** — 根据 Hub 位置和账号类型自动推荐 Worker
2. **性能指标** — 显示每个 Worker 的延迟、负载、成功率
3. **批量配置** — 批量为多个账号分配 Worker
4. **Worker 健康度** — Worker 详情页显示更多诊断信息

### 架构优化
1. Workers 列表可以考虑缓存（当前每次打开表单都请求）
2. Worker 状态可以使用 WebSocket 实时推送（当前是轮询）

## 相关文档

- **Worker 架构设计**: `WORKER_BUGS_REPORT.md`
- **Worker 配置最佳实践**: 已保存到 yoho-memory
- **Worker 路由逻辑**: `src/services/worker/workerRouter.js`
- **Worker WebSocket 服务**: `src/services/worker/workerWsServer.js`

## 部署说明

### 前端部署

```bash
# 构建前端
npm run build:web

# 重启服务（自动加载新前端）
pm2 restart claude-relay-service
```

### 验证部署

1. 访问 `/admin-next/` 管理界面
2. 进入"账号管理"
3. 点击"创建账号"或编辑任意账号
4. 确认"Worker 节点"下拉框出现
5. 确认能看到 Workers 列表和在线状态

## 总结

**实现内容**：
- ✅ 前端 UI：Worker 选择下拉框
- ✅ 数据模型：表单数据中添加 `workerId`
- ✅ API 集成：获取 Workers 列表
- ✅ 数据提交：创建/更新账号时传递 `workerId`
- ✅ 用户体验：离线 Worker 禁用、降级提示
- ✅ 前端构建：已格式化并成功构建

**预期效果**：
- 管理员可以为每个账号灵活选择执行方式（本地 vs Worker）
- Worker 离线时自动降级，保证服务稳定性
- 支持后续扩展（多 Worker 负载均衡、智能调度等）

**优势**：
- 可选增强，不影响现有账号
- 零停机部署
- 自动降级保证高可用
- 为多地域部署打下基础
