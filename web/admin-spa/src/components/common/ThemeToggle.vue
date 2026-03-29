<template>
  <div class="theme-toggle-container">
    <!-- 紧凑模式：仅显示图标按钮 -->
    <div v-if="mode === 'compact'" class="flex items-center">
      <button class="theme-toggle-button" :title="themeTooltip" @click="handleCycleTheme">
        <transition mode="out-in" name="fade">
          <i v-if="themeStore.themeMode === 'light'" key="sun" class="fas fa-sun" />
          <i v-else-if="themeStore.themeMode === 'dark'" key="moon" class="fas fa-moon" />
          <i v-else key="auto" class="fas fa-circle-half-stroke" />
        </transition>
      </button>
    </div>

    <!-- dropdown 模式 — 简洁滑动开关 -->
    <div v-else-if="mode === 'dropdown'" class="theme-switch-wrapper">
      <button
        class="theme-switch"
        :class="{
          'is-dark': themeStore.themeMode === 'dark',
          'is-auto': themeStore.themeMode === 'auto'
        }"
        :title="themeTooltip"
        @click="handleCycleTheme"
      >
        <div class="switch-handle">
          <div class="handle-icon">
            <i v-if="themeStore.themeMode === 'light'" class="fas fa-sun" />
            <i v-else-if="themeStore.themeMode === 'dark'" class="fas fa-moon" />
            <i v-else class="fas fa-circle-half-stroke" />
          </div>
        </div>
      </button>
    </div>

    <!-- 分段按钮模式 -->
    <div v-else-if="mode === 'segmented'" class="theme-segmented">
      <button
        v-for="option in themeOptions"
        :key="option.value"
        class="theme-segment"
        :class="{ active: themeStore.themeMode === option.value }"
        :title="option.label"
        @click="selectTheme(option.value)"
      >
        <i :class="option.icon" />
        <span v-if="showLabel" class="ml-1 hidden sm:inline">{{ option.shortLabel }}</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useThemeStore } from '@/stores/theme'

defineProps({
  mode: {
    type: String,
    default: 'compact',
    validator: (value) => ['compact', 'dropdown', 'segmented'].includes(value)
  },
  showLabel: {
    type: Boolean,
    default: false
  }
})

const themeStore = useThemeStore()

const themeOptions = [
  { value: 'light', label: '浅色模式', shortLabel: '浅色', icon: 'fas fa-sun' },
  { value: 'dark', label: '深色模式', shortLabel: '深色', icon: 'fas fa-moon' },
  { value: 'auto', label: '跟随系统', shortLabel: '自动', icon: 'fas fa-circle-half-stroke' }
]

const themeTooltip = computed(() => {
  const current = themeOptions.find((opt) => opt.value === themeStore.themeMode)
  return current ? `点击切换主题 - ${current.label}` : '切换主题'
})

const handleCycleTheme = () => {
  themeStore.cycleThemeMode()
}

const selectTheme = (mode) => {
  themeStore.setThemeMode(mode)
}
</script>

<style scoped>
.theme-toggle-container {
  position: relative;
  display: inline-flex;
  align-items: center;
}

/* ===== 紧凑按钮 ===== */
.theme-toggle-button {
  @apply flex items-center justify-center;
  @apply h-9 w-9 rounded-lg;
  @apply text-gray-500 dark:text-gray-400;
  @apply border border-gray-200 dark:border-gray-700;
  @apply bg-white dark:bg-gray-800;
  @apply transition-colors duration-150;
  cursor: pointer;
}

.theme-toggle-button:hover {
  @apply text-gray-700 dark:text-gray-200;
  @apply border-gray-300 dark:border-gray-600;
}

.theme-toggle-button i {
  @apply text-sm;
}

.theme-toggle-button i.fa-sun {
  @apply text-amber-500;
}

.theme-toggle-button i.fa-moon {
  @apply text-indigo-400;
}

.theme-toggle-button i.fa-circle-half-stroke {
  @apply text-blue-500;
}

/* ===== 滑动开关 ===== */
.theme-switch-wrapper {
  @apply inline-flex items-center;
}

.theme-switch {
  position: relative;
  width: 64px;
  height: 32px;
  border-radius: 8px;
  padding: 3px;
  cursor: pointer;
  transition:
    background-color 0.25s ease,
    border-color 0.25s ease;
  background: #e5e7eb;
  border: 1px solid rgba(0, 0, 0, 0.06);
  display: flex;
  align-items: center;
}

.theme-switch:hover {
  background: #d1d5db;
}

.theme-switch.is-dark {
  background: #374151;
  border-color: rgba(255, 255, 255, 0.08);
}

.theme-switch.is-dark:hover {
  background: #4b5563;
}

.theme-switch.is-auto {
  background: var(--primary-color);
  border-color: transparent;
}

.theme-switch.is-auto:hover {
  filter: brightness(1.08);
}

/* ===== 滑块 ===== */
.switch-handle {
  position: absolute;
  width: 26px;
  height: 26px;
  background: white;
  border-radius: 6px;
  transition:
    transform 0.25s ease,
    background-color 0.25s ease;
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.12),
    0 1px 2px rgba(0, 0, 0, 0.06);
  display: flex;
  align-items: center;
  justify-content: center;
  top: 50%;
  transform: translateY(-50%) translateX(0);
  left: 3px;
}

.theme-switch.is-dark .switch-handle {
  transform: translateY(-50%) translateX(32px);
  background: #1e293b;
}

.theme-switch.is-auto .switch-handle {
  transform: translateY(-50%) translateX(16px);
  background: white;
}

/* ===== 滑块图标 ===== */
.handle-icon {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.handle-icon i {
  font-size: 0.75rem;
  transition: color 0.2s ease;
}

.handle-icon .fa-sun {
  color: #f59e0b;
}

.handle-icon .fa-moon {
  color: #fbbf24;
}

.handle-icon .fa-circle-half-stroke {
  color: var(--primary-color);
}

/* ===== 分段按钮 ===== */
.theme-segmented {
  @apply inline-flex;
  @apply bg-gray-100 dark:bg-gray-800;
  @apply rounded-lg p-1;
  @apply border border-gray-200 dark:border-gray-700;
}

.theme-segment {
  @apply px-3 py-1.5;
  @apply text-xs font-medium;
  @apply text-gray-500 dark:text-gray-400;
  @apply transition-colors duration-150;
  @apply rounded-md;
  @apply flex items-center gap-1;
  @apply cursor-pointer;
}

.theme-segment:hover {
  @apply text-gray-700 dark:text-gray-300;
  @apply bg-gray-200/50 dark:bg-gray-700/50;
}

.theme-segment.active {
  @apply bg-white dark:bg-gray-700;
  @apply text-gray-900 dark:text-white;
  @apply shadow-sm;
}

.theme-segment i {
  @apply text-xs;
}

/* ===== 过渡 ===== */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@media (max-width: 640px) {
  .theme-segment span {
    @apply hidden;
  }
}
</style>
