// 生产预览：只启动 API + 静态资源服务（需要先 npm run build）
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const child = spawn(process.execPath, [join(root, 'server', 'api.mjs')], { cwd: root, stdio: 'inherit', env: process.env })
child.on('exit', (code) => process.exit(code ?? 0))
const port = process.env.PORT ?? '8791'
console.log(`\n[preview] 打开 http://127.0.0.1:${port} 查看构建产物\n`)
