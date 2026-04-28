import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatBuildVersion(date: Date): string {
  const year = date.getUTCFullYear()
  const month = pad(date.getUTCMonth() + 1)
  const day = pad(date.getUTCDate())
  const hour = pad(date.getUTCHours())
  const minute = pad(date.getUTCMinutes())
  const second = pad(date.getUTCSeconds())
  return `v${year}${month}${day}-${hour}${minute}${second}Z`
}

function formatBuildTime(date: Date): string {
  const year = date.getUTCFullYear()
  const month = pad(date.getUTCMonth() + 1)
  const day = pad(date.getUTCDate())
  const hour = pad(date.getUTCHours())
  const minute = pad(date.getUTCMinutes())
  const second = pad(date.getUTCSeconds())
  return `${year}-${month}-${day} ${hour}:${minute}:${second} UTC`
}

const buildDate = new Date()
const buildVersion = formatBuildVersion(buildDate)
const buildTime = formatBuildTime(buildDate)

export default defineConfig({
  define: {
    __CCDASH_BUILD_VERSION__: JSON.stringify(buildVersion),
    __CCDASH_BUILD_TIME__: JSON.stringify(buildTime),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^~\//, replacement: fileURLToPath(new URL('./src/', import.meta.url)) },
    ],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/healthz': 'http://127.0.0.1:3560',
      '/admin': 'http://127.0.0.1:3560',
    },
  },
})
