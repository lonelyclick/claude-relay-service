<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-semibold text-gray-900 dark:text-white">Recharge</h1>
      <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">
        Redeem quota cards to add balance to your API keys
      </p>
    </div>

    <!-- Balance Overview -->
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <div
        v-for="key in apiKeys"
        :key="key.id"
        class="overflow-hidden rounded-lg bg-white shadow dark:bg-gray-800"
      >
        <div class="p-5">
          <div class="flex items-center justify-between">
            <div class="truncate text-sm font-medium text-gray-500 dark:text-gray-400">
              {{ key.name }}
            </div>
            <span
              class="inline-flex rounded-full px-2 text-xs font-semibold leading-5"
              :class="
                key.isActive
                  ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                  : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
              "
            >
              {{ key.isActive ? 'Active' : 'Inactive' }}
            </span>
          </div>
          <div class="mt-2 flex items-baseline">
            <span class="text-2xl font-semibold" :class="balanceColor(key)">
              ${{ remaining(key).toFixed(2) }}
            </span>
            <span class="ml-2 text-sm text-gray-500 dark:text-gray-400">
              / ${{ (key.totalCostLimit || 0).toFixed(2) }}
            </span>
          </div>
          <div class="mt-3">
            <div class="h-2 rounded-full bg-gray-200 dark:bg-gray-700">
              <div
                class="h-2 rounded-full transition-colors"
                :class="progressBarColor(key)"
                :style="{ width: Math.min(usagePercent(key), 100) + '%' }"
              ></div>
            </div>
            <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Used: ${{ (key.totalCost || 0).toFixed(4) }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Redeem Card Form -->
    <div class="rounded-lg bg-white shadow dark:bg-gray-800">
      <div class="p-6">
        <h3 class="text-lg font-medium text-gray-900 dark:text-white">Redeem Quota Card</h3>
        <div class="mt-4 space-y-4">
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300"
                >API Key</label
              >
              <select
                v-model="selectedKeyId"
                class="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              >
                <option disabled value="">Select API Key</option>
                <option v-for="key in apiKeys" :key="key.id" :value="key.id">{{ key.name }}</option>
              </select>
            </div>
            <div class="sm:col-span-2">
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300"
                >Card Code</label
              >
              <div class="mt-1 flex gap-2">
                <input
                  v-model="cardCode"
                  class="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm placeholder-gray-400 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:placeholder-gray-500"
                  placeholder="CC_XXXX_XXXX_XXXX"
                  @keydown.enter="handleRedeem"
                />
                <button
                  class="inline-flex items-center rounded-md border border-transparent bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600"
                  :disabled="!cardCode || !selectedKeyId || redeeming"
                  @click="handleRedeem"
                >
                  {{ redeeming ? 'Redeeming...' : 'Redeem' }}
                </button>
              </div>
            </div>
          </div>

          <!-- Redeem Result -->
          <div
            v-if="redeemResult"
            class="rounded-md p-4"
            :class="
              redeemResult.success
                ? 'border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/20'
                : 'border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20'
            "
          >
            <div class="flex">
              <svg
                v-if="redeemResult.success"
                class="h-5 w-5 text-green-400"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  clip-rule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                  fill-rule="evenodd"
                />
              </svg>
              <svg v-else class="h-5 w-5 text-red-400" fill="currentColor" viewBox="0 0 20 20">
                <path
                  clip-rule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                  fill-rule="evenodd"
                />
              </svg>
              <div class="ml-3">
                <p
                  class="text-sm"
                  :class="
                    redeemResult.success
                      ? 'text-green-700 dark:text-green-400'
                      : 'text-red-700 dark:text-red-400'
                  "
                >
                  {{ redeemResult.message }}
                </p>
                <p
                  v-if="redeemResult.data?.quotaAdded"
                  class="mt-1 text-sm text-green-600 dark:text-green-300"
                >
                  Added: ${{ redeemResult.data.quotaAdded.toFixed(2) }}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Redemption History -->
    <div class="rounded-lg bg-white shadow dark:bg-gray-800">
      <div class="p-6">
        <h3 class="text-lg font-medium text-gray-900 dark:text-white">Redemption History</h3>
        <div class="mt-4">
          <div
            v-if="redemptions.length === 0"
            class="py-8 text-center text-sm text-gray-500 dark:text-gray-400"
          >
            No redemption history yet
          </div>
          <div v-else class="overflow-x-auto">
            <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead class="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <th
                    class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  >
                    Date
                  </th>
                  <th
                    class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  >
                    Card
                  </th>
                  <th
                    class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  >
                    Quota Added
                  </th>
                  <th
                    class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  >
                    API Key
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
                <tr
                  v-for="r in redemptions"
                  :key="r.id"
                  class="hover:bg-gray-50 dark:hover:bg-gray-700/50"
                >
                  <td class="whitespace-nowrap px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
                    {{ formatDate(r.timestamp || r.redeemedAt) }}
                  </td>
                  <td
                    class="whitespace-nowrap px-4 py-3 font-mono text-sm text-gray-600 dark:text-gray-300"
                  >
                    {{ r.cardCode || r.code || '-' }}
                  </td>
                  <td
                    class="whitespace-nowrap px-4 py-3 text-sm font-medium text-green-600 dark:text-green-400"
                  >
                    +${{ (r.quotaAdded || 0).toFixed(2) }}
                  </td>
                  <td class="whitespace-nowrap px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
                    {{ r.apiKeyName || '-' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useUserStore } from '@/stores/user'
import { showToast } from '@/utils/tools'

const userStore = useUserStore()

const apiKeys = ref([])
const selectedKeyId = ref('')
const cardCode = ref('')
const redeeming = ref(false)
const redeemResult = ref(null)
const redemptions = ref([])

const remaining = (key) => Math.max(0, (key.totalCostLimit || 0) - (key.totalCost || 0))
const usagePercent = (key) =>
  key.totalCostLimit > 0 ? ((key.totalCost || 0) / key.totalCostLimit) * 100 : 0

const balanceColor = (key) => {
  const pct = usagePercent(key)
  if (pct >= 90) return 'text-red-600 dark:text-red-400'
  if (pct >= 80) return 'text-yellow-600 dark:text-yellow-400'
  return 'text-green-600 dark:text-green-400'
}

const progressBarColor = (key) => {
  const pct = usagePercent(key)
  if (pct >= 90) return 'bg-red-500'
  if (pct >= 80) return 'bg-yellow-500'
  return 'bg-blue-500'
}

const formatDate = (dateStr) => {
  if (!dateStr) return '-'
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

const handleRedeem = async () => {
  if (!cardCode.value || !selectedKeyId.value) return
  redeeming.value = true
  redeemResult.value = null

  try {
    const result = await userStore.redeemCard({
      code: cardCode.value.trim(),
      apiKeyId: selectedKeyId.value
    })
    redeemResult.value = {
      success: true,
      message: 'Card redeemed successfully!',
      data: result.data
    }
    cardCode.value = ''
    showToast('Card redeemed successfully!', 'success')
    await loadData()
  } catch (err) {
    redeemResult.value = {
      success: false,
      message: err.response?.data?.message || err.message || 'Redeem failed'
    }
  } finally {
    redeeming.value = false
  }
}

const loadData = async () => {
  try {
    const [keys, history] = await Promise.all([
      userStore.getUserApiKeys(),
      userStore.getRedemptionHistory()
    ])
    apiKeys.value = keys
    if (keys.length > 0 && !selectedKeyId.value) {
      selectedKeyId.value = keys[0].id
    }
    redemptions.value = history.redemptions || history || []
  } catch (err) {
    console.error('Failed to load data:', err)
  }
}

onMounted(loadData)
</script>
