// 读取 .env（不依赖 dotenv）。只读取项目根目录的 .env，不覆盖已有环境变量。
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

export function loadEnv(root) {
  const file = resolve(root, '.env')
  if (!existsSync(file)) return
  const text = readFileSync(file, 'utf8')
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

export function env(name, fallback = '') {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

export function envBool(name, fallback = false) {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  return /^(1|true|yes|on)$/i.test(v)
}

/** 脱敏：日志与接口中绝不输出完整密钥 */
export function mask(secret) {
  if (!secret) return ''
  if (secret.length <= 6) return '*'.repeat(secret.length)
  return `${secret.slice(0, 3)}***${secret.slice(-2)}`
}
