import { RuleRanker, type CandidateRanker, type RankingInput, type RankingResult } from './ranker.ts'
import type { Candidate } from './types.ts'

export type RewardTable = Record<string, { value: number; trials: number }>

export function learningKey(input: Pick<RankingInput, 'now' | 'disaster'>, candidate: Candidate): string {
  const duration = candidate.latestEta - input.now
  const timeBand = duration <= 300 ? 'short' : duration <= 900 ? 'medium' : 'long'
  return [input.disaster ?? 'flood', candidate.slackS >= 0 ? 'on-time' : 'late', candidate.kind, timeBand].join(':')
}

export class LearningRanker implements CandidateRanker {
  readonly id = 'rl.contextual-bandit.v1'
  readonly mode = 'rl' as const
  private readonly fallback = new RuleRanker()

  private readonly table: RewardTable
  constructor(table: RewardTable) {
    this.table = table
  }

  async rank(input: RankingInput): Promise<RankingResult> {
    const rules = await this.fallback.rank(input)
    const learned = new Map<string, number>()
    for (const candidate of input.candidates) {
      const estimate = this.table[learningKey(input, candidate)]
      if (candidate.feasible && !candidate.keepsAssignment && estimate?.trials >= 3) learned.set(candidate.id, estimate.value)
    }
    if (!learned.size) return { ...rules, explanation: '强化学习样本不足，本组按规则排序。' }
    // Keep untrained choices in their rule-ranked slots. Compare only alternatives with observed outcomes for the same task.
    const order = [...rules.order]
    for (const taskId of new Set(input.candidates.map((candidate) => candidate.taskId))) {
      const ids = new Set(input.candidates.filter((candidate) => candidate.taskId === taskId && learned.has(candidate.id)).map((candidate) => candidate.id))
      const slots = order.flatMap((id, index) => ids.has(id) ? [index] : [])
      const sorted = slots.map((index) => order[index]).sort((a, b) => learned.get(b)! - learned.get(a)!)
      slots.forEach((slot, index) => { order[slot] = sorted[index] })
    }
    return {
      order, scores: rules.scores, mode: 'rl',
      explanation: `仿真奖励估值覆盖 ${learned.size} 个候选，样本不足的候选沿用规则顺位。`,
    }
  }
}
