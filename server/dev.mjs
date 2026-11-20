// 开发模式启动器：同时启动 Vite dev server 与 API 服务（/api 由 Vite 代理到 API 服务）。
// 安全密钥、AI 凭据只存在于 API 服务进程中。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from './env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
loadEnv(root)

const apiPort = process.env.API_PORT ?? '8791'
const children = []

function run(name, args, extraEnv) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  })
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[dev] ${name} 退出，退出码 ${code}`)
      shutdown(code)
    }
  })
  children.push(child)
  return child
}

function shutdown(code = 0) {
  for (const c of children) {
    if (!c.killed) c.kill()
  }
  setTimeout(() => process.exit(code), 120)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js')
if (!existsSync(viteBin)) {
  console.error('[dev] 未找到依赖，请先运行 npm install')
  process.exit(1)
}

if (!existsSync(join(root, '.env'))) {
  console.log('[dev] 未找到 .env：将以“示例地图 + 示例路线 + 规则模式”启动（配置见 .env.example）')
}

run('api', [join(root, 'server', 'api.mjs')], { PORT: apiPort })
run('vite', [viteBin, '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {})
console.log(`\n[dev] 打开 http://127.0.0.1:5173 开始演练\n`)
