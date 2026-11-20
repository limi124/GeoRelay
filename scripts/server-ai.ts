/**
 * 服务端 AI 分析函数的类型化入口。
 *
 * 服务端是 `.mjs`，脚本侧只做宽松引用，把 any 关在这一个文件里，
 * 业务代码仍然拿到明确类型。
 */

export interface ServerAnalysisItem {
  id: string
  text: string
  taskIds?: string[]
  candidateIds?: string[]
  eventIds?: string[]
}

export interface ServerAnalysis {
  ok: boolean
  mode: string
  label?: string
  summary?: string
  items?: ServerAnalysisItem[]
  warnings?: string[]
  protocolVersion?: number
}

// @ts-expect-error 服务端模块是 .mjs，没有类型声明；这里集中收口
import * as serverAi from '../server/ai.mjs'

const mod = serverAi as unknown as {
  analyzeDisaster: (body: unknown) => Promise<ServerAnalysis>
  aiStatus: () => { enabled: boolean; mode: string; label: string }
  explainCandidates: (body: unknown) => Promise<unknown>
}

export const analyzeDisaster = mod.analyzeDisaster
export const aiStatus = mod.aiStatus
