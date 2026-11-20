import type { Candidate, DisasterKind, Task } from './types.ts'

export type RankingMode = 'rules' | 'ai' | 'rl'
export const RANKING_LABELS: Record<RankingMode, string> = { rules: '规则排序', ai: 'AI 排序', rl: '强化学习排序' }

/**
 * 候选排序接口：默认实现按规则打分（可行性 → 时限余量 → 可靠性 → 改动量）。
 *
 * 这是刻意留出的**可替换接口**：后续接入 AI 调度 Agent 时，让它查询状态、
 * 调用规划器，再实现本接口提交排序与解释；也可以用同一个模拟器训练强化学习排序策略。
 * 无论谁实现，规则校验与指挥员确认始终保留，排序结果不会自动生效。
 */
export interface RankingInput {
  task: Task | null
  candidates: Candidate[]
  now: number
  disaster?: DisasterKind
}

export interface RankingResult {
  order: string[]
  scores: Record<string, number>
  explanation?: string
  mode: RankingMode
}

export interface CandidateRanker {
  readonly id: string
  readonly mode: RankingMode
  rank(input: RankingInput): Promise<RankingResult>
}

/** 默认规则排序 */
export class RuleRanker implements CandidateRanker {
  readonly id = 'rules.default'
  readonly mode = 'rules' as const

  async rank(input: RankingInput): Promise<RankingResult> {
    const scores: Record<string, number> = {}
    for (const c of input.candidates) {
      // 不可行候选永远排在最后
      const feasiblePenalty = c.feasible ? 0 : -100000
      const latePenalty = c.slackS < 0 ? -5000 + c.slackS * 0.05 : 0
      // 时限余量：越充裕越好（按秒计，权重压低避免压过可靠性）
      const slackBonus = Math.max(-3000, Math.min(3000, c.slackS * 0.02))
      // 可靠性：需要外部取货扣分，接力交接扣分（交接越多越容易出错）
      const hopPenalty = (c.external ? -25 : 0) + (c.isRelay ? -40 : 0)
      // 改动量：换组重派比同组改道代价大
      const churnPenalty = c.kind === 'ext_reroute' ? -30 : c.kind === 'staging_relay' ? -10 : 0
      scores[c.id] = Math.round((feasiblePenalty + latePenalty + slackBonus + hopPenalty + churnPenalty) * 10) / 10
    }
    const order = [...input.candidates].sort((a, b) => scores[b.id] - scores[a.id]).map((c) => c.id)
    return { order, scores, mode: 'rules' }
  }
}
