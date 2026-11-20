// 脚本运行环境的最小类型声明（避免为一个 Node 类型包再拉一次依赖）
declare const process: {
  argv: string[]
  env: Record<string, string | undefined>
  exitCode?: number
  cwd(): string
  stdout: { write(chunk: string): void }
}
interface ImportMeta {
  glob<T = unknown>(pattern: string, options?: Record<string, unknown>): Record<string, T>
}

declare const console: {
  log(...args: unknown[]): void
  error(...args: unknown[]): void
  warn(...args: unknown[]): void
}

declare module 'node:fs' {
  export function writeFileSync(path: string, data: string | Uint8Array, encoding?: string): void
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function readFileSync(path: string): Uint8Array
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void
  export function existsSync(path: string): boolean
  export function readdirSync(path: string, options: { withFileTypes: true }): Array<{
    name: string
    isDirectory(): boolean
    isFile(): boolean
  }>
  export function readdirSync(path: string): string[]
  export function copyFileSync(src: string, dest: string): void
}

declare module 'node:path' {
  export function dirname(path: string): string
  export function join(...parts: string[]): string
  export function resolve(...parts: string[]): string
  export function basename(path: string): string
}

declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(data: string | Uint8Array): { digest(encoding: 'hex'): string }
  }
}

declare module 'node:assert/strict' {
  interface AssertStrict {
    (value: unknown, message?: string): void
    equal(actual: unknown, expected: unknown, message?: string): void
    notEqual(actual: unknown, expected: unknown, message?: string): void
    deepEqual(actual: unknown, expected: unknown, message?: string): void
    ok(value: unknown, message?: string): void
  }
  const assert: AssertStrict
  export default assert
}
