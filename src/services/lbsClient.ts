import type { LngLat } from '../domain/geo/types.ts'
import type { ExternalRoute, LbsClient, LbsStatus, Pharmacy, RoutePoint } from '../domain/lbs/types.ts'
import { SampleLbsClient } from '../domain/lbs/sample.ts'

/**
 * 面向浏览器的位置服务客户端：只访问同源 /api/amap（由服务端代理高德 Web 服务）。
 * 凭据缺失或接口失败时，明确返回失败原因，由界面提示；不会静默把直线当路线。
 */
export class RemoteLbsClient implements LbsClient {
  private lastStatus: LbsStatus
  private readonly sample: SampleLbsClient

  constructor(sample: SampleLbsClient, webKeyConfigured: boolean, reason?: string) {
    this.sample = sample
    this.lastStatus = webKeyConfigured
      ? { mode: 'amap', configuredKey: true }
      : { mode: 'sample', configuredKey: false, reason: reason ?? '未配置高德 Key' }
  }

  status(): LbsStatus {
    return this.lastStatus
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`/api/amap${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const json = (await res.json()) as T & { ok?: boolean; error?: string; code?: string }
    if (!res.ok || json.ok === false) {
      const err = new Error(json.error ?? `接口错误 HTTP ${res.status}`)
      ;(err as Error & { code?: string }).code = json.code
      throw err
    }
    return json
  }

  async aroundSearch(center: LngLat, radiusM: number, keywords: string): Promise<Pharmacy[]> {
    if (this.lastStatus.mode !== 'amap') return this.sample.aroundSearch(center, radiusM, keywords)
    const out = await this.post<{ items: Pharmacy[] }>('/around', { center, radius: radiusM, keywords })
    return out.items
  }

  async driveRoute(points: RoutePoint[]): Promise<ExternalRoute> {
    if (this.lastStatus.mode !== 'amap') return this.sample.driveRoute(points)
    try {
      const out = await this.post<{ path: LngLat[]; distanceM: number; durationS: number; steps?: ExternalRoute['steps'] }>('/route', {
        points: points.map((p) => p.lngLat),
      })
      return { ok: true, path: out.path, distanceM: out.distanceM, durationS: out.durationS, source: 'amap', steps: out.steps }
    } catch (err) {
      // 失败时明确给出原因；调用方据此禁用候选，而不是用直线冒充导航
      return { ok: false, path: [], distanceM: 0, durationS: 0, source: 'amap', error: (err as Error).message }
    }
  }

  async geocode(query: string, city?: string): Promise<{ lngLat: LngLat; formatted?: string } | null> {
    if (this.lastStatus.mode !== 'amap') return this.sample.geocode(query, city)
    try {
      const out = await this.post<{ lngLat: LngLat; formatted?: string }>('/geocode', { query, city })
      return { lngLat: out.lngLat, formatted: out.formatted }
    } catch {
      return null
    }
  }

  async inputTips(query: string, city?: string): Promise<Array<{ name: string; address?: string; lngLat: LngLat }>> {
    if (this.lastStatus.mode !== 'amap') return this.sample.inputTips(query, city)
    try {
      const out = await this.post<{ items: Array<{ name: string; address?: string; lngLat: LngLat }> }>('/tips', { query, city })
      return out.items
    } catch {
      return []
    }
  }
}

export interface ServerStatus {
  ok: boolean
  amap: { webKeyConfigured: boolean; securityCodeConfigured: boolean; restConfigured: boolean; maskedKey: string }
  ai: { enabled: boolean; mode: 'ai' | 'rules'; label: string; model: string | null; note: string; protocolVersion: number }
}

/** 读取服务端能力（是否配置高德/AI）。服务端不可用时返回空能力，不阻塞演练。 */
export async function fetchServerStatus(): Promise<ServerStatus | null> {
  try {
    const res = await fetch('/api/health', { headers: { accept: 'application/json' } })
    if (!res.ok) return null
    return (await res.json()) as ServerStatus
  } catch {
    return null
  }
}

export interface AiExplanation {
  ok: boolean
  mode: 'ai' | 'rules'
  model?: string | null
  order?: string[]
  explanations?: Record<string, string>
  summary?: string
  text?: string | null
  error?: string
  note?: string
}

export async function requestAiExplanation(payload: unknown): Promise<AiExplanation> {
  try {
    const res = await fetch('/api/ai/explain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    return (await res.json()) as AiExplanation
  } catch (err) {
    return { ok: false, mode: 'rules', error: (err as Error).message }
  }
}

/** AI 分析的三种入口 */
export type AiQuestion = 'situation' | 'affected' | 'compare' | 'resilience'

export interface AiAnalysisItem {
  id: string
  text: string
  taskIds: string[]
  candidateIds: string[]
  eventIds: string[]
}

export interface AiAnalysis {
  ok: boolean
  mode: 'rules' | 'ai' | 'mock' | 'error'
  label: string
  summary: string
  items: AiAnalysisItem[]
  warnings: string[]
  /** 失败原因（mode=error 时一定有） */
  message?: string
  code?: string
  protocolVersion?: number
}

export interface AiAnalysisRequest {
  question: AiQuestion
  disaster: string
  clock: number
  events: unknown[]
  tasks: unknown[]
  candidates: unknown[]
  agents: unknown[]
  inventory: unknown[]
  resilience?: { summary: unknown; priorities: Array<{ targets: string[]; action: string }> }
  /** 当前演练里已过期（被新灾情覆盖/已确认失效）的候选 ID，供校验对照 */
  expiredCandidateIds?: string[]
  /** 仅在 AI_MOCK=1 时生效：normal | timeout | bad-id | expired | bad-format（可用 URL ?ai=xxx 指定） */
  mockScenario?: string
}

/** 调用服务端 AI 分析（密钥只在服务端）。失败时抛出带原因的异常，界面据此提示并保留规则候选。 */
export async function requestAiAnalysis(payload: AiAnalysisRequest, signal?: AbortSignal): Promise<AiAnalysis> {
  const res = await fetch('/api/ai/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  const json = (await res.json().catch(() => null)) as AiAnalysis | null
  if (!json) throw new Error('AI 接口返回内容无法解析')
  if (!res.ok || json.ok === false) {
    throw new Error(json.message ?? `AI 接口失败（HTTP ${res.status}）`)
  }
  if (!Array.isArray(json.items)) throw new Error('AI 返回格式异常：items 不是数组')
  return json
}
