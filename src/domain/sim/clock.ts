import type { SimTime } from './types.ts'

/**
 * 演练时钟（纯函数）。
 *
 * 真实时间推进时调用 `advance(clock, realSeconds)` 得到新的演练时刻；
 * 模拟器只依据 `tick(state, dt)` 推进，事件序列因此可以固定、可脱离 Web 复现。
 */
export const MAX_TICK_SECONDS = 5
export const SPEED_OPTIONS = [1, 2, 4, 8, 16, 60] as const

export interface ClockLike {
  t: SimTime
  running: boolean
  speed: number
}

/** 真实秒 → 演练秒（限制单次步长，避免掉帧导致“跳跃”与事件丢失） */
export function advance(clock: ClockLike, realSeconds: number): number {
  if (!clock.running) return 0
  const scaled = realSeconds * clock.speed
  return Math.max(0, Math.min(MAX_TICK_SECONDS, scaled))
}

export function wallClock(startMs: number, t: SimTime): Date {
  return new Date(startMs + t * 1000)
}

export function labelAt(startLabel: string, t: SimTime): string {
  const [hh, mm] = startLabel.split(':').map((x) => Number.parseInt(x, 10))
  const total = hh * 3600 + mm * 60 + Math.floor(t)
  const h = Math.floor(total / 3600) % 24
  const m = Math.floor((total % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function elapsedLabel(t: SimTime): string {
  const s = Math.floor(t)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** 演练秒 → HH:mm:ss（按演练起始墙上时间偏移） */
export function formatSimTime(t: number, startLabel = '08:00'): string {
  const [hh, mm] = startLabel.split(':').map((x) => Number.parseInt(x, 10))
  const total = (hh || 0) * 3600 + (mm || 0) * 60 + Math.floor(t)
  const h = Math.floor(total / 3600) % 24
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':')
}
