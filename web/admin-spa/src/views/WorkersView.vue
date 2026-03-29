<template>
  <div class="tab-content">
    <div class="card p-4 sm:p-6">
      <!-- Header -->
      <div class="mb-4 flex flex-col gap-4 sm:mb-4">
        <div class="flex items-center justify-between">
          <div>
            <h3 class="mb-1 text-lg font-bold text-gray-900 dark:text-gray-100 sm:mb-2 sm:text-xl">
              Worker 管理
            </h3>
            <p class="text-sm text-gray-600 dark:text-gray-400 sm:text-base">
              管理分布式 Worker 节点，实现多 IP 出口请求分发
            </p>
          </div>
          <button
            class="inline-flex items-center rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            @click="showCreateModal = true"
          >
            <i class="fas fa-plus mr-2" />
            创建 Worker
          </button>
        </div>

        <!-- Stats -->
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-3">
          <div class="stat-card">
            <div class="flex items-center justify-between">
              <div>
                <p class="mb-1 text-xs font-semibold text-gray-600 dark:text-gray-400 sm:text-sm">
                  总 Workers
                </p>
                <p class="text-xl font-bold text-gray-900 dark:text-gray-100 sm:text-2xl">
                  {{ workers.length }}
                </p>
              </div>
              <div class="stat-icon flex-shrink-0 bg-gradient-to-br from-blue-500 to-blue-600">
                <i class="fas fa-network-wired" />
              </div>
            </div>
          </div>

          <div class="stat-card">
            <div class="flex items-center justify-between">
              <div>
                <p class="mb-1 text-xs font-semibold text-gray-600 dark:text-gray-400 sm:text-sm">
                  在线
                </p>
                <p class="text-xl font-bold text-green-600 dark:text-green-400 sm:text-2xl">
                  {{ onlineCount }}
                </p>
              </div>
              <div class="stat-icon flex-shrink-0 bg-gradient-to-br from-green-500 to-green-600">
                <i class="fas fa-signal" />
              </div>
            </div>
          </div>

          <div class="stat-card">
            <div class="flex items-center justify-between">
              <div>
                <p class="mb-1 text-xs font-semibold text-gray-600 dark:text-gray-400 sm:text-sm">
                  离线
                </p>
                <p class="text-xl font-bold text-red-600 dark:text-red-400 sm:text-2xl">
                  {{ workers.length - onlineCount }}
                </p>
              </div>
              <div class="stat-icon flex-shrink-0 bg-gradient-to-br from-red-500 to-red-600">
                <i class="fas fa-plug" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="flex items-center justify-center py-12">
        <i class="fas fa-spinner fa-spin mr-2 text-blue-500" />
        <span class="text-gray-500 dark:text-gray-400">Loading...</span>
      </div>

      <!-- Worker List -->
      <div v-else-if="workers.length > 0" class="space-y-3">
        <div
          v-for="worker in workers"
          :key="worker.id"
          class="rounded-lg border border-gray-200 p-4 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800/50"
        >
          <div class="flex items-start justify-between">
            <!-- Left info -->
            <div class="flex-1">
              <div class="flex items-center gap-2">
                <h4 class="text-base font-semibold text-gray-900 dark:text-gray-100">
                  {{ worker.name }}
                </h4>
                <span
                  :class="[
                    'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                    worker.status === 'online'
                      ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                      : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                  ]"
                >
                  <span
                    :class="[
                      'mr-1.5 inline-block h-1.5 w-1.5 rounded-full',
                      worker.status === 'online' ? 'bg-green-500' : 'bg-gray-400'
                    ]"
                  />
                  {{ worker.status === 'online' ? 'Online' : 'Offline' }}
                </span>
              </div>

              <div
                class="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-500 dark:text-gray-400"
              >
                <span class="font-mono text-xs">{{ worker.id.slice(0, 8) }}...</span>
                <span v-if="worker.region"
                  ><i class="fas fa-map-marker-alt mr-1" />{{ worker.region }}</span
                >
                <span><i class="fas fa-layer-group mr-1" />{{ worker.type || 'remote' }}</span>
                <span><i class="fas fa-tasks mr-1" />Max: {{ worker.maxConcurrency }}</span>
                <span v-if="worker.currentLoad !== undefined">
                  <i class="fas fa-tachometer-alt mr-1" />Load: {{ worker.currentLoad }}
                </span>
                <span v-if="worker.ip"><i class="fas fa-globe mr-1" />{{ worker.ip }}</span>
                <span v-if="worker.lastHeartbeat">
                  <i class="fas fa-heartbeat mr-1" />{{ formatTime(worker.lastHeartbeat) }}
                </span>
              </div>
            </div>

            <!-- Right actions -->
            <div class="ml-4 flex items-center gap-2">
              <button
                class="rounded-md px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
                title="查看详情"
                @click="viewWorker(worker)"
              >
                <i class="fas fa-eye" />
              </button>
              <button
                class="rounded-md px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
                title="编辑"
                @click="editWorker(worker)"
              >
                <i class="fas fa-edit" />
              </button>
              <button
                v-if="worker.status === 'online'"
                class="rounded-md px-2.5 py-1.5 text-sm text-orange-600 hover:bg-orange-50 dark:text-orange-400 dark:hover:bg-orange-900/20"
                title="断开连接"
                @click="disconnectWorker(worker)"
              >
                <i class="fas fa-unlink" />
              </button>
              <button
                class="rounded-md px-2.5 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
                title="删除"
                @click="confirmDelete(worker)"
              >
                <i class="fas fa-trash" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Empty state -->
      <div v-else class="py-12 text-center">
        <i class="fas fa-network-wired mb-3 text-4xl text-gray-300 dark:text-gray-600" />
        <p class="text-gray-500 dark:text-gray-400">还没有 Worker 节点</p>
        <p class="mt-1 text-sm text-gray-400 dark:text-gray-500">点击上方按钮创建第一个 Worker</p>
      </div>
    </div>

    <!-- Create Modal -->
    <div
      v-if="showCreateModal"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click.self="showCreateModal = false"
    >
      <div class="mx-4 w-full max-w-lg rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800">
        <h3 class="mb-4 text-lg font-bold text-gray-900 dark:text-gray-100">创建 Worker</h3>
        <div class="space-y-4">
          <div>
            <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >名称</label
            >
            <input
              v-model="createForm.name"
              class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              placeholder="Worker-01"
            />
          </div>
          <div>
            <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >地区</label
            >
            <input
              v-model="createForm.region"
              class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              placeholder="us-west, jp-tokyo, ..."
            />
          </div>
          <div>
            <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >最大并发数</label
            >
            <input
              v-model.number="createForm.maxConcurrency"
              class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              min="1"
              type="number"
            />
          </div>
        </div>
        <div class="mt-6 flex justify-end gap-3">
          <button
            class="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            @click="showCreateModal = false"
          >
            取消
          </button>
          <button
            class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            :disabled="creating"
            @click="handleCreate"
          >
            <i v-if="creating" class="fas fa-spinner fa-spin mr-1" />
            创建
          </button>
        </div>
      </div>
    </div>

    <!-- Token Display Modal -->
    <div
      v-if="showTokenModal"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click.self="showTokenModal = false"
    >
      <div class="mx-4 w-full max-w-lg rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800">
        <h3 class="mb-2 text-lg font-bold text-gray-900 dark:text-gray-100">Worker Token</h3>
        <p class="mb-4 text-sm text-orange-600 dark:text-orange-400">
          <i class="fas fa-exclamation-triangle mr-1" />
          此 Token 仅显示一次，请妥善保存！
        </p>
        <div class="relative rounded-md bg-gray-100 p-3 dark:bg-gray-700">
          <code class="block break-all text-sm text-gray-800 dark:text-gray-200">{{
            newToken
          }}</code>
          <button
            class="absolute right-2 top-2 rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/20"
            @click="copyToken"
          >
            <i class="fas fa-copy mr-1" />Copy
          </button>
        </div>
        <div class="mt-4 flex justify-end">
          <button
            class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            @click="showTokenModal = false"
          >
            已保存
          </button>
        </div>
      </div>
    </div>

    <!-- Edit Modal -->
    <div
      v-if="showEditModal"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click.self="showEditModal = false"
    >
      <div class="mx-4 w-full max-w-lg rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800">
        <h3 class="mb-4 text-lg font-bold text-gray-900 dark:text-gray-100">编辑 Worker</h3>
        <div class="space-y-4">
          <div>
            <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >名称</label
            >
            <input
              v-model="editForm.name"
              class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
          </div>
          <div>
            <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >地区</label
            >
            <input
              v-model="editForm.region"
              class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
          </div>
          <div>
            <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >最大并发数</label
            >
            <input
              v-model.number="editForm.maxConcurrency"
              class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              min="1"
              type="number"
            />
          </div>
        </div>
        <div class="mt-4 flex items-center justify-between">
          <button
            class="text-sm text-orange-600 hover:text-orange-700 dark:text-orange-400"
            @click="handleRegenerateToken"
          >
            <i class="fas fa-sync-alt mr-1" />重新生成 Token
          </button>
          <div class="flex gap-3">
            <button
              class="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
              @click="showEditModal = false"
            >
              取消
            </button>
            <button
              class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              :disabled="saving"
              @click="handleUpdate"
            >
              <i v-if="saving" class="fas fa-spinner fa-spin mr-1" />
              保存
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Detail Modal -->
    <div
      v-if="showDetailModal"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click.self="showDetailModal = false"
    >
      <div class="mx-4 w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800">
        <h3 class="mb-4 text-lg font-bold text-gray-900 dark:text-gray-100">
          Worker 详情 - {{ selectedWorker?.name }}
        </h3>

        <!-- Info -->
        <div class="mb-4 grid grid-cols-2 gap-3 text-sm">
          <div>
            <span class="text-gray-500 dark:text-gray-400">ID:</span>
            <span class="font-mono text-gray-900 dark:text-gray-100">{{ selectedWorker?.id }}</span>
          </div>
          <div>
            <span class="text-gray-500 dark:text-gray-400">Type:</span>
            <span class="text-gray-900 dark:text-gray-100">{{ selectedWorker?.type }}</span>
          </div>
          <div>
            <span class="text-gray-500 dark:text-gray-400">Region:</span>
            <span class="text-gray-900 dark:text-gray-100">{{
              selectedWorker?.region || '-'
            }}</span>
          </div>
          <div>
            <span class="text-gray-500 dark:text-gray-400">Status:</span>
            <span
              :class="selectedWorker?.status === 'online' ? 'text-green-600' : 'text-gray-500'"
              >{{ selectedWorker?.status }}</span
            >
          </div>
          <div>
            <span class="text-gray-500 dark:text-gray-400">Max Concurrency:</span>
            <span class="text-gray-900 dark:text-gray-100">{{
              selectedWorker?.maxConcurrency
            }}</span>
          </div>
          <div>
            <span class="text-gray-500 dark:text-gray-400">Current Load:</span>
            <span class="text-gray-900 dark:text-gray-100">{{
              selectedWorker?.currentLoad ?? '-'
            }}</span>
          </div>
          <div>
            <span class="text-gray-500 dark:text-gray-400">Last IP:</span>
            <span class="font-mono text-gray-900 dark:text-gray-100">{{
              selectedWorker?.ip || '-'
            }}</span>
          </div>
          <div>
            <span class="text-gray-500 dark:text-gray-400">Created:</span>
            <span class="text-gray-900 dark:text-gray-100">{{
              formatTime(selectedWorker?.createdAt)
            }}</span>
          </div>
        </div>

        <!-- Bound Accounts -->
        <div v-if="selectedWorker?.boundAccounts?.length > 0" class="mt-4">
          <h4 class="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
            绑定的账户 ({{ selectedWorker.boundAccounts.length }})
          </h4>
          <div class="max-h-48 space-y-1 overflow-y-auto">
            <div
              v-for="acc in selectedWorker.boundAccounts"
              :key="acc.id"
              class="flex items-center justify-between rounded border border-gray-200 px-3 py-2 text-sm dark:border-gray-700"
            >
              <div>
                <span class="font-medium text-gray-900 dark:text-gray-100">{{
                  acc.name || acc.id.slice(0, 8)
                }}</span>
                <span class="ml-2 text-xs text-gray-500">{{ acc.platform }}</span>
              </div>
              <button
                class="text-xs text-red-500 hover:text-red-700"
                @click="unbindAccount(acc.id)"
              >
                解绑
              </button>
            </div>
          </div>
        </div>
        <div v-else class="mt-4 text-sm text-gray-500 dark:text-gray-400">暂无绑定的账户</div>

        <div class="mt-6 flex justify-end">
          <button
            class="rounded-md bg-gray-600 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
            @click="showDetailModal = false"
          >
            关闭
          </button>
        </div>
      </div>
    </div>

    <!-- Delete Confirm Modal -->
    <div
      v-if="showDeleteModal"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click.self="showDeleteModal = false"
    >
      <div class="mx-4 w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800">
        <h3 class="mb-2 text-lg font-bold text-red-600 dark:text-red-400">
          <i class="fas fa-exclamation-triangle mr-2" />确认删除
        </h3>
        <p class="mb-4 text-sm text-gray-600 dark:text-gray-400">
          确定要删除 Worker「{{ workerToDelete?.name }}」吗？ 绑定到该 Worker 的账户将被解除绑定。
        </p>
        <div class="flex justify-end gap-3">
          <button
            class="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            @click="showDeleteModal = false"
          >
            取消
          </button>
          <button
            class="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
            :disabled="deleting"
            @click="handleDelete"
          >
            <i v-if="deleting" class="fas fa-spinner fa-spin mr-1" />
            删除
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { showToast } from '@/utils/tools'
import * as httpApis from '@/utils/http_apis'

// State
const workers = ref([])
const loading = ref(false)
const creating = ref(false)
const saving = ref(false)
const deleting = ref(false)

// Modals
const showCreateModal = ref(false)
const showEditModal = ref(false)
const showDetailModal = ref(false)
const showTokenModal = ref(false)
const showDeleteModal = ref(false)

// Forms
const createForm = ref({ name: '', region: '', maxConcurrency: 10 })
const editForm = ref({ id: '', name: '', region: '', maxConcurrency: 10 })
const selectedWorker = ref(null)
const workerToDelete = ref(null)
const newToken = ref('')

// Computed
const onlineCount = computed(() => workers.value.filter((w) => w.status === 'online').length)

// Methods
async function loadWorkers() {
  loading.value = true
  try {
    const res = await httpApis.getWorkersApi()
    if (res.success) {
      workers.value = res.data || []
    }
  } catch (err) {
    showToast('Failed to load workers: ' + err.message, 'error')
  } finally {
    loading.value = false
  }
}

async function handleCreate() {
  creating.value = true
  try {
    const res = await httpApis.createWorkerApi(createForm.value)
    if (res.success) {
      showToast('Worker created', 'success')
      newToken.value = res.token
      showCreateModal.value = false
      showTokenModal.value = true
      createForm.value = { name: '', region: '', maxConcurrency: 10 }
      await loadWorkers()
    }
  } catch (err) {
    showToast('Failed to create worker: ' + err.message, 'error')
  } finally {
    creating.value = false
  }
}

function editWorker(worker) {
  editForm.value = {
    id: worker.id,
    name: worker.name,
    region: worker.region || '',
    maxConcurrency: worker.maxConcurrency || 10
  }
  showEditModal.value = true
}

async function handleUpdate() {
  saving.value = true
  try {
    const { id, ...fields } = editForm.value
    const res = await httpApis.updateWorkerApi(id, fields)
    if (res.success) {
      showToast('Worker updated', 'success')
      showEditModal.value = false
      await loadWorkers()
    }
  } catch (err) {
    showToast('Failed to update worker: ' + err.message, 'error')
  } finally {
    saving.value = false
  }
}

async function viewWorker(worker) {
  try {
    const res = await httpApis.getWorkerApi(worker.id)
    if (res.success) {
      selectedWorker.value = res.data
      showDetailModal.value = true
    }
  } catch (err) {
    showToast('Failed to load worker details: ' + err.message, 'error')
  }
}

async function disconnectWorker(worker) {
  try {
    await httpApis.disconnectWorkerApi(worker.id, 'Disconnected by admin')
    showToast(`Worker ${worker.name} disconnected`, 'success')
    await loadWorkers()
  } catch (err) {
    showToast('Failed to disconnect: ' + err.message, 'error')
  }
}

function confirmDelete(worker) {
  workerToDelete.value = worker
  showDeleteModal.value = true
}

async function handleDelete() {
  deleting.value = true
  try {
    const res = await httpApis.deleteWorkerApi(workerToDelete.value.id)
    if (res.success) {
      showToast('Worker deleted', 'success')
      showDeleteModal.value = false
      workerToDelete.value = null
      await loadWorkers()
    }
  } catch (err) {
    showToast('Failed to delete worker: ' + err.message, 'error')
  } finally {
    deleting.value = false
  }
}

async function handleRegenerateToken() {
  try {
    const res = await httpApis.regenerateWorkerTokenApi(editForm.value.id)
    if (res.success) {
      newToken.value = res.token
      showEditModal.value = false
      showTokenModal.value = true
    }
  } catch (err) {
    showToast('Failed to regenerate token: ' + err.message, 'error')
  }
}

async function unbindAccount(accountId) {
  try {
    await httpApis.unbindWorkerAccountApi(selectedWorker.value.id, accountId)
    showToast('Account unbound', 'success')
    // Reload worker details
    await viewWorker(selectedWorker.value)
  } catch (err) {
    showToast('Failed to unbind: ' + err.message, 'error')
  }
}

function copyToken() {
  navigator.clipboard.writeText(newToken.value).then(() => {
    showToast('Token copied!', 'success')
  })
}

function formatTime(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ts
  return d.toLocaleString()
}

// Init
onMounted(() => {
  loadWorkers()
})
</script>
