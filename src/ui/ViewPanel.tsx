import type { Engine } from '../domain/sim/engine.ts'
import { formatSimTime } from '../domain/sim/clock.ts'

/** 外部支援详情：只展示当前演练的接力状态与任务时间线。 */
export interface ViewPanelProps {
  engine: Engine
}

const RELAY_TEXT: Record<string, string> = {
  pending_arrival: '待到达',
  pending_handover: '待交接',
  relayed: '已接力',
  delivered: '已送达',
  blocked: '受阻',
}

export function ViewPanel(props: ViewPanelProps): React.ReactElement {
  const { engine } = props
  const s = engine.state

  // 接驳点接力状态：按当前生效方案的阶段推导
  const relayRows = buildRelayRows(engine)

  const timeline = s.plans
    ? Object.values(s.assignments)
        .map((planId) => s.plans[planId])
        .filter(Boolean)
        .map((plan) => {
          const task = s.tasks.find((t) => t.id === plan.taskId)
          const eta = Math.max(...(plan.eta.length ? plan.eta : [0]))
          return { plan, task, eta }
        })
        .sort((a, b) => a.eta - b.eta)
    : []

  return (
    <div className="stack-sm">
      <section className="panel">
        <div className="panel-header"><span className="panel-title">接力状态</span><span className="badge muted">{relayRows.length}</span></div>
        <div className="panel-body stack-sm">
          {relayRows.length === 0 ? (
            <p className="field-hint">暂无接力任务</p>
          ) : (
            relayRows.map((r) => (
              <div key={r.planId} className="task-card">
                <div className="row-between">
                  <strong>{r.taskCode} · {r.taskName}</strong>
                  <span className={`badge ${r.state === 'blocked' ? 'warn' : r.state === 'delivered' ? 'ok' : 'info'}`}>{RELAY_TEXT[r.state] ?? r.state}</span>
                </div>
                <div className="field-hint">{r.agentName} · 经 {r.gate} · {r.isRelay ? '接力配送' : '直接配送'}</div>
                <div className="field-hint">预计送达 {formatSimTime(r.eta, s.config.startLabel)}{r.deadline ? ` · 时限 ${r.deadline}` : ''}</div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header"><span className="panel-title">任务时间线</span></div>
        <div className="panel-body">
          <div className="timeline">
            {timeline.map(({ plan, task, eta }) => (
              <div key={plan.id} className={`timeline-item ${plan.phase === 'delivered' ? 'is-active' : plan.phase === 'blocked' ? 'is-blocked' : ''}`}>
                <span className="timeline-dot" aria-hidden />
                <div>
                  <div className="row-between">
                    <strong>{task?.code ?? ''} {task?.targetName ?? ''}</strong>
                    <span className="field-hint">{formatSimTime(eta, s.config.startLabel)}</span>
                  </div>
                  <div className="field-hint">
                    {plan.agentName} · {plan.origin === 'baseline' ? '原方案' : '改派后'} · 版本 v{plan.version}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}

function buildRelayRows(engine: Engine) {
  const s = engine.state
  const model = engine.view.model
  return Object.entries(s.assignments)
    .map(([taskId, planId]) => {
      const plan = s.plans[planId]
      if (!plan) return null
      const task = s.tasks.find((t) => t.id === taskId)
      if (!task) return null
      const phase = plan.phase
      const state: string =
        phase === 'blocked'
          ? 'blocked'
          : phase === 'delivered'
            ? 'delivered'
            : phase === 'delivering'
              ? 'relayed'
              : phase === 'handover_wait' || phase === 'pickup_wait'
                ? 'pending_handover'
                : 'pending_arrival'
      const gateId = plan.legs.external?.atGate
      const gate = gateId ? (model.net.gates.find((g) => g.id === gateId)?.name ?? model.net.staging.find((x) => x.id === gateId)?.name ?? gateId) : '—'
      return {
        planId: plan.id,
        taskCode: task.code,
        taskName: task.targetName,
        agentName: plan.agentName,
        gate,
        isRelay: plan.relay,
        eta: Math.max(...(plan.eta.length ? plan.eta : [0])),
        deadline: task.deadlineLabel,
        state,
      }
    })
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
}
