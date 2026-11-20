import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 高德安全密钥与 AI 凭据只在 Node 服务端使用：
// 浏览器只访问同源 /api/*，由 server/ 代理转发，构建产物里不含密钥。
const apiTarget = `http://127.0.0.1:${process.env.API_PORT ?? '8791'}`

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
    // 编辑器/工具用原子写入时会在源码目录留下临时目录，文件监听器会因 EBUSY 崩溃，这里忽略掉。
    // 求解器安装目录、Python 虚拟环境、模型运行产物（FDS 安装包/输出）体积大且常被占用，
    // 一并排除，否则 dev server 会因为 EBUSY 直接退出。
    watch: {
      ignored: [
        '**/*.tmpdir/**',
        '**/*.tmp',
        '**/.*.tmpdir/**',
        '**/.tools/**',
        '**/.venv-oq/**',
        '**/artifacts/**',
        '**/models/**/output*/**',
        '**/node_modules/**',
      ],
    },
  },
  build: { outDir: 'dist', sourcemap: false },
})
