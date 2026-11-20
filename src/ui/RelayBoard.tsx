import type { Engine } from '../domain/sim/engine.ts'
import { relaySteps, relayViewOf } from '../domain/sim/relay.ts'
import { formatSimTime } from '../domain/sim/clock.ts'

/**
 * 接力看板：同一个任务从「外部出发 → 取货 → 接驳点交接 → 内部配送 → 送达」的全过程，
 * 并明确写出此刻谁在等谁。只读状态，不改演练。
 */

export interface RelayBoardProps {
  engine: Engine
  selectedTaskId: string | null
}

export function RelayBoard({ engine, selectedTaskId }: RelayBoardProps): React.ReactElement | null {
  const s = engine.state
  const planId = selectedTaskId ? s.assignments[selectedTaskId] : null
  const plan = planId ? s.plans[planId] : null
  const view = relayViewOf(plan ?? undefined, s.tasks, s.agents)
  const task = s.tasks.find((t) => t.id === selectedTaskId)
  if (!task) return null
  if (!view) {
    return (
      <section className="panel" data-testid="relay-board">
        <div className="panel-header">
          <span className="panel-title">接力看板</span>
          <span className="badge muted">未派单</span>
        </div>
        <div className="panel-body">
          <p className="field-hint">{task.code} {task.targetName} 还没有生效派单。</p>
        </div>
      </section>
    )
  }

  const steps = relaySteps(view)
  const blockedStaging = Object.values(s.blockedStaging)
  return (
    <section className="panel" data-testid="relay-board">
      <div className="panel-header">
        <span className="panel-title">接力看板</span>
        <span className={`badge ${view.stage === 'delivered' ? 'ok' : view.stage === 'blocked' ? 'warn' : 'info'}`}>{view.stageLabel}</span>
      </div>
      <div className="panel-body stack-sm">
        <div className="row-between">
          <strong data-testid="relay-task">{task.code} · {task.targetName}</strong>
          <span className="badge muted">方案 v{view.version}{view.isRelay ? ' · 含接力' : ''}</span>
        </div>

        <div className="field-hint" data-testid="relay-waiting">{view.waitingText}</div>

        <div className="timeline" data-testid="relay-steps">
          {steps.map((st) => (
            <div key={st.key} className={`timeline-item ${st.done ? 'is-active' : ''}`}>
              <span className="timeline-dot" />
              <div className="row-between">
                <span>{st.label}</span>
                <span className="field-hint">{st.at !== null ? formatSimTime(st.at, s.config.startLabel) : st.done ? '已完成' : '未开始'}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="grid-2">
          <div className="panel"><div className="panel-body stack-sm">
            <span className="field-label">外部 Agent</span>
            <strong>{view.externalAgentName ?? '—'}</strong>
            <span className="field-hint">{view.externalArrived ? '已到达接驳点' : '在途'}</span>
          </div></div>
          <div className="panel"><div className="panel-body stack-sm">
            <span className="field-label">内部 Agent</span>
            <strong>{view.internalAgentName ?? '—'}</strong>
            <span className="field-hint">{view.internalStarted ? '已接手，配送中' : '尚未开始配送（等交接）'}</span>
          </div></div>
        </div>

        <div className="field-hint">交接点：<strong data-testid="relay-staging">{view.stagingLabel ?? '—'}</strong>
          {view.handoverAt !== null ? ` · 交接时刻 ${formatSimTime(view.handoverAt, s.config.startLabel)}` : ''}
        </div>
        {blockedStaging.length ? (
          <div className="notice warn" data-testid="relay-blocked-staging">
            原接驳点已不可用：{blockedStaging.map((b) => `${b.targetName}（${b.reason}）`).join('；')}
          </div>
        ) : null}
        {view.internalStarted ? null : (
          <div className="notice info">交接完成前，内部 Agent 不会开始配送（这是接力流程的硬规则）。</div>
        )}
      </div>
    </section>
  )
}
