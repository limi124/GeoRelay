import type { DrillState } from './types.ts'
import { formatSimTime } from './clock.ts'

/**
 * 复盘时间线：只把「当场记录」翻译成可读条目，不修改演练状态。
 *
 * 数据来源就是引擎已经写入的 record/events（灾情事件、候选、确认、送达），
 * 不另存一份，因此复盘和当场看到的内容必然一致。
 */

export type ReplayKind = 'impact' | 'route_blocked' | 'candidates' | 'confirm' | 'relay' | 'delivered' | 'agent'

export interface ReplayEntry {
  id: string
  at: number
  kind: ReplayKind
  title: string
  detail: string
  /** 点击后可定位的对象 */
  refs: { roadIds?: string[]; taskIds?: string[]; agentIds?: string[]; planId?: string; candidateId?: string }
}

export function buildReplay(state: DrillState): ReplayEntry[] {
  const entries: ReplayEntry[] = []
  const label = (t: number): string => formatSimTime(t, state.config.startLabel)

  for (const ev of Object.values(state.impacts)) {
    entries.push({
      id: `impact:${ev.id}`,
      at: ev.at,
      kind: 'impact',
      title: `${disasterName(ev.disaster)}：${ev.targetName}（${ev.level}）`,
      detail: `${ev.reason}｜判据：${ev.basis.slice(0, 2).join('；')}`,
      refs: {
        roadIds: ev.targetType === 'road' ? [ev.targetId] : undefined,
        taskIds: state.tasks.filter((t) => t.targetName === ev.targetName).map((t) => t.id),
      },
    })
  }

  for (const ps of Object.values(state.planSets)) {
    const feasible = ps.candidates.filter((c) => c.feasible).length
    const confirmed = ps.candidates.find((c) => c.id === ps.confirmedCandidateId)
    entries.push({
      id: `cand:${ps.id}`,
      at: ps.at,
      kind: 'candidates',
      title: `生成改派候选 ${ps.candidates.length} 个（可行 ${feasible} 个）`,
      detail: ps.snapshot,
      refs: { taskIds: [...new Set(ps.candidates.map((c) => c.taskId))] },
    })
    if (confirmed) {
      entries.push({
        id: `confirm:${ps.id}`,
        at: ps.confirmedAt ?? ps.at,
        kind: 'confirm',
        title: `人工确认：${confirmed.title}`,
        detail: `指挥员 ${ps.confirmedBy ?? '—'} 确认候选 ${confirmed.id}；改派理由：${confirmed.dispatchReason}`,
        refs: { taskIds: [confirmed.taskId], candidateId: confirmed.id, planId: state.assignments[confirmed.taskId] },
      })
    }
  }

  for (const r of state.record.results) {
    const task = state.tasks.find((t) => t.id === r.taskId)
    const plan = state.plans[r.planId]
    entries.push({
      id: `result:${r.planId}:${r.at}`,
      at: r.at,
      kind: 'delivered',
      title: `${task?.code ?? ''} ${task?.targetName ?? ''} ${r.status === 'delivered' ? '送达' : r.status}`,
      detail: `${plan?.relay ? `经 ${plan.legs.internal?.enterGate ?? '接驳点'} 交接后` : '由同一 Agent'}送达，方案 v${plan?.version ?? 0}，${r.slaMet ? '满足时限' : '超出时限'}`,
      refs: { taskIds: [r.taskId], planId: r.planId },
    })
  }

  for (const ev of state.events) {
    if (ev.kind === 'agent_relay') {
      entries.push({ id: `relay:${ev.id}`, at: ev.at, kind: 'relay', title: '接驳点交接完成', detail: ev.message, refs: ev.refs ?? {} })
    }
    if (ev.kind === 'agent_blocked') {
      entries.push({ id: `blocked:${ev.id}`, at: ev.at, kind: 'route_blocked', title: '原路线受阻，Agent 原地等待', detail: ev.message, refs: ev.refs ?? {} })
    }
  }

  return entries
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .map((e) => ({ ...e, title: `${label(e.at)} ${e.title}` }))
}

function disasterName(d: string): string {
  return d === 'flood' ? '内涝' : d === 'fire' ? '火灾' : '地震'
}
