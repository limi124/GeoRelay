import type { Agent, Plan, Task } from './types.ts'

/**
 * 接力视图：把方案的执行阶段翻译成「谁在等谁」。
 *
 * 界面（接力看板、地图标记、任务卡）与浏览器验收都读同一份推导，
 * 避免 UI 文案和实际状态机各说一套。这里只读状态，不改任何东西。
 */

export type RelayStage = 'external_enroute' | 'external_at_pharmacy' | 'handover' | 'internal_delivering' | 'delivered' | 'blocked' | 'idle'

export interface RelayView {
  stage: RelayStage
  stageLabel: string
  /** 当前谁在等待：external=外部还在路上（内部等它），internal=外部已到（等内部接手） */
  waitingFor: 'external' | 'internal' | null
  waitingText: string
  externalAgentName: string | null
  internalAgentName: string | null
  stagingLabel: string | null
  /** 外部 Agent 是否已到达接驳点（交接前） */
  externalArrived: boolean
  /** 内部 Agent 是否已开始配送（交接完成后才为 true；验收就用这个断言） */
  internalStarted: boolean
  handoverAt: number | null
  deliveredAt: number | null
  isRelay: boolean
  version: number
}

const STAGE_LABEL: Record<RelayStage, string> = {
  idle: '未派单',
  external_enroute: '外部前往取货',
  external_at_pharmacy: '外部取货中',
  handover: '接驳点交接',
  internal_delivering: '内部配送中',
  delivered: '已送达',
  blocked: '受阻等待',
}

export function relayViewOf(plan: Plan | undefined, tasks: Task[], agents: Agent[]): RelayView | null {
  if (!plan) return null
  const task = tasks.find((t) => t.id === plan.taskId)
  void task
  const externalAgent = agents.find((a) => a.id === plan.agentId && a.role === 'external') ?? agents.find((a) => a.id === plan.agentId)
  const carrier = agents.find((a) => a.id === plan.carryAgentId)
  const internalAgent = plan.relay ? (carrier?.role === 'internal' ? carrier : agents.find((a) => a.role === 'internal')) : null
  const stagingLabel = plan.legs.internal?.enterGate ?? null
  const handoverAt = plan.relayAt ?? null
  const internalStarted = handoverAt !== null && (plan.phase === 'delivering' || plan.phase === 'delivered')

  let stage: RelayStage = 'idle'
  if (plan.phase === 'blocked') stage = 'blocked'
  else if (plan.phase === 'delivered') stage = 'delivered'
  else if (plan.phase === 'delivering') stage = 'internal_delivering'
  else if (plan.phase === 'handover_wait' || plan.phase === 'internal_ready') stage = 'handover'
  else if (plan.phase === 'pickup_wait') stage = 'external_at_pharmacy'
  else if (plan.phase === 'external_enroute' || plan.phase === 'external_arrived') stage = 'external_enroute'

  const externalArrived = stage === 'handover' || stage === 'internal_delivering' || stage === 'delivered'
  let waitingFor: RelayView['waitingFor'] = null
  if (stage === 'external_enroute' || stage === 'external_at_pharmacy') waitingFor = internalAgent ? 'external' : null
  else if (stage === 'handover') waitingFor = interactiveWait(plan)

  const waitingText =
    stage === 'blocked'
      ? `${plan.agentName} 原地等待指挥部改派`
      : stage === 'delivered'
        ? '已完成交接并送达'
        : stage === 'internal_delivering'
          ? `${internalAgent?.name ?? carrier?.name ?? '内部 Agent'} 已接手，正在配送`
          : stage === 'handover'
            ? internalAgent
              ? `${externalAgent?.name ?? plan.agentName} 已到达 ${stagingLabel ?? '接驳点'}，等待 ${internalAgent.name} 接手`
              : `${plan.agentName} 在 ${stagingLabel ?? '接驳点'} 完成交接`
            : stage === 'external_at_pharmacy'
              ? internalAgent
                ? `${internalAgent.name} 在 ${stagingLabel ?? '接驳点'} 等待 ${externalAgent?.name ?? plan.agentName} 取货送达`
                : `${plan.agentName} 正在取货`
              : internalAgent
                ? `${internalAgent.name} 在 ${stagingLabel ?? '接驳点'} 等待 ${externalAgent?.name ?? plan.agentName} 到达`
                : `${plan.agentName} 正在前往社区入口`

  return {
    stage,
    stageLabel: STAGE_LABEL[stage],
    waitingFor,
    waitingText,
    externalAgentName: externalAgent?.name ?? (plan.relay ? null : plan.agentName),
    internalAgentName: internalAgent?.name ?? null,
    stagingLabel,
    externalArrived,
    internalStarted,
    handoverAt,
    deliveredAt: plan.deliveredAt,
    isRelay: Boolean(plan.relay),
    version: plan.version,
  }
}

/** 交接阶段：外部已到、内部还没接手 —— 此刻是内部在等 */
function interactiveWait(plan: Plan): RelayView['waitingFor'] {
  return plan.relayAt === null ? 'internal' : null
}

/** 五个阶段的可视化步骤（供看板与验收断言使用） */
export function relaySteps(view: RelayView | null): Array<{ key: string; label: string; done: boolean; at: number | null }> {
  if (!view) return []
  const order: RelayStage[] = ['external_enroute', 'external_at_pharmacy', 'handover', 'internal_delivering', 'delivered']
  const labels = ['外部出发', '取货', '接驳点交接', '内部配送', '送达']
  const currentIdx = order.indexOf(view.stage)
  return order.map((k, i) => ({
    key: k,
    label: labels[i],
    done: currentIdx >= i && view.stage !== 'blocked',
    at: k === 'handover' ? view.handoverAt : k === 'delivered' ? view.deliveredAt : null,
  }))
}
