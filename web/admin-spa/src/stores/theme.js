import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'

// 主题模式枚举
export const ThemeMode = {
  LIGHT: 'light',
  DARK: 'dark',
  AUTO: 'auto'
}

// 固定紫色调色板（供图表等组件引用）
const PurpleScheme = {
  name: '默认紫',
  primary: '#667eea',
  secondary: '#764ba2',
  accent: '#f093fb',
  darkPrimary: '#818cf8',
  darkSecondary: '#a78bfa',
  darkAccent: '#c084fc'
}

export const useThemeStore = defineStore('theme', () => {
  const themeMode = ref(ThemeMode.AUTO)
  const systemPrefersDark = ref(false)

  const isDarkMode = computed(() => {
    if (themeMode.value === ThemeMode.DARK) return true
    if (themeMode.value === ThemeMode.LIGHT) return false
    return systemPrefersDark.value
  })

  const currentTheme = computed(() => {
    return isDarkMode.value ? ThemeMode.DARK : ThemeMode.LIGHT
  })

  // 兼容：图表等组件通过 currentColorScheme 获取颜色
  const currentColorScheme = computed(() => PurpleScheme)

  const initTheme = () => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    systemPrefersDark.value = mediaQuery.matches

    const savedMode = localStorage.getItem('themeMode')
    if (savedMode && Object.values(ThemeMode).includes(savedMode)) {
      themeMode.value = savedMode
    } else {
      themeMode.value = ThemeMode.AUTO
    }

    applyTheme()
    watchSystemTheme()
  }

  const applyTheme = () => {
    const root = document.documentElement

    if (isDarkMode.value) {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }

    applyColors()
  }

  // 应用品牌色 + RGB 变量（背景/表面/边框由 CSS 负责，不再 JS 动态设）
  const applyColors = () => {
    const root = document.documentElement
    const dark = isDarkMode.value

    const primary = dark ? PurpleScheme.darkPrimary : PurpleScheme.primary
    const secondary = dark ? PurpleScheme.darkSecondary : PurpleScheme.secondary
    const accent = dark ? PurpleScheme.darkAccent : PurpleScheme.accent

    root.style.setProperty('--primary-color', primary)
    root.style.setProperty('--secondary-color', secondary)
    root.style.setProperty('--accent-color', accent)

    const hexToRgb = (hex) => {
      const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
      return result
        ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`
        : '102, 126, 234'
    }

    root.style.setProperty('--primary-rgb', hexToRgb(primary))
    root.style.setProperty('--secondary-rgb', hexToRgb(secondary))
    root.style.setProperty('--accent-rgb', hexToRgb(accent))
  }

  const setThemeMode = (mode) => {
    if (Object.values(ThemeMode).includes(mode)) {
      themeMode.value = mode
    }
  }

  const cycleThemeMode = () => {
    const modes = [ThemeMode.LIGHT, ThemeMode.DARK, ThemeMode.AUTO]
    const currentIndex = modes.indexOf(themeMode.value)
    const nextIndex = (currentIndex + 1) % modes.length
    themeMode.value = modes[nextIndex]
  }

  watch(themeMode, (newMode) => {
    localStorage.setItem('themeMode', newMode)
    applyTheme()
  })

  watch(systemPrefersDark, () => {
    if (themeMode.value === ThemeMode.AUTO) {
      applyTheme()
    }
  })

  const watchSystemTheme = () => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    const handleChange = (e) => {
      systemPrefersDark.value = e.matches
    }

    systemPrefersDark.value = mediaQuery.matches
    mediaQuery.addEventListener('change', handleChange)

    return () => {
      mediaQuery.removeEventListener('change', handleChange)
    }
  }

  // 兼容旧版 API
  const toggleTheme = () => cycleThemeMode()

  const setTheme = (theme) => {
    if (theme === 'dark') setThemeMode(ThemeMode.DARK)
    else if (theme === 'light') setThemeMode(ThemeMode.LIGHT)
  }

  return {
    themeMode,
    isDarkMode,
    currentTheme,
    systemPrefersDark,
    currentColorScheme,
    ThemeMode,
    initTheme,
    setThemeMode,
    cycleThemeMode,
    watchSystemTheme,
    toggleTheme,
    setTheme
  }
})
