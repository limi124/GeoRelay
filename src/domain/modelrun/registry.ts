import indexJson from '../../data/model-runs/index.json'
import type { ModelDrillBundle } from './types.ts'

/**
 * 专业模型算例注册表（Web 只读缓存产物）。
 *
 * `src/data/model-runs/index.json` 与 `<runId>.json` 都由 `npm run model:ingest` 生成：
 * 求解器原始输出 → 规范化摘要 → 映射 → 演练规则 → 统一回放包。
 * 前端不做求解、不做插值，只按 runId 读取缓存。
 */

export interface ModelRunIndexEntry {
  runId: string
  model: 'fds' | 'openquake'
  disaster: 'fire' | 'earthquake'
  caseId: string
  engineVersion: string
  solverCommand?: string
  status: 'ok' | 'failed'
  level?: 'model' | 'imported' | 'simplified'
  label?: string
  ranAt?: string | null
  title?: string
  sampleCount?: number
  assetCount?: number
  eventCount?: number
  closureCount?: number
  available: boolean
  failure?: { stage: string; message: string; log?: string }
}

const data = indexJson as unknown as { generatedFrom: string; runs: ModelRunIndexEntry[] }

export const MODEL_RUNS: ModelRunIndexEntry[] = data.runs ?? []

export function modelRunById(runId: string): ModelRunIndexEntry | null {
  return MODEL_RUNS.find((r) => r.runId === runId) ?? null
}

export function modelRunsFor(disaster: 'fire' | 'earthquake'): ModelRunIndexEntry[] {
  return MODEL_RUNS.filter((r) => r.disaster === disaster && r.status === 'ok' && r.available)
}

/**
 * 按 runId 读取回放包。用 `import.meta.glob` 静态收集，
 * 这样 Vite 会打包进产物，不需要在运行时请求文件（离线可用）。
 */
const bundles = import.meta.glob<{ default: ModelDrillBundle }>('../../data/model-runs/*.json', { eager: true })

export function modelBundleOf(runId: string): ModelDrillBundle | null {
  for (const [path, mod] of Object.entries(bundles)) {
    if (path.endsWith('/index.json')) continue
    if (path.endsWith(`/${runId}.json`)) return (mod as { default: ModelDrillBundle }).default
  }
  return null
}
