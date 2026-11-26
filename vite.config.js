import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  assetsInclude: ['**/*.glsl'],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1400,
    sourcemap: false
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    cors: true
  },
  preview: { host: '0.0.0.0', allowedHosts: true }
})
