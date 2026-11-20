export interface Rng {
  next(): number
  int(n: number): number
}

/** mulberry32：固定种子的确定性随机数（演练可复现） */
export function rng(seed: number): Rng {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (n: number) => Math.floor(next() * n) }
}

export function hashSeed(seed: number, salt: string): number {
  let h = seed >>> 0
  for (let i = 0; i < salt.length; i++) {
    h = Math.imul(h ^ salt.charCodeAt(i), 0x01000193) >>> 0
  }
  return h || 1
}
