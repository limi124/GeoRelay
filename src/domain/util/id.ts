let counter = 0
let namespace = ''

/**
 * 对象 ID 生成。
 *
 * 两种模式：
 *  - 浏览器编辑：不设命名空间，ID 带随机后缀，跨会话不会撞车；
 *  - 无头批处理：`setIdNamespace('s42')` + `resetIdCounter()` 后 ID 完全确定，
 *    同一个种子在不同进程里得到同一个社区与同一串事件 —— 这是「可复现」的前提。
 */
export function setIdNamespace(ns: string): void {
  namespace = ns
}

export function resetIdCounter(): void {
  counter = 0
}

export function uid(prefix: string): string {
  counter += 1
  if (namespace) return `${prefix}-${namespace}${counter.toString(36)}`
  const t = Date.now().toString(36).slice(-5)
  const c = counter.toString(36).padStart(2, '0')
  const r = Math.floor(Math.random() * 46656).toString(36).padStart(3, '0')
  return `${prefix}-${t}${c}${r}`
}
