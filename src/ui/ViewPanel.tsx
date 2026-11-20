import type { CommunityModel } from '../domain/community/model.ts'
import type { Engine } from '../domain/sim/engine.ts'
import { agentPosition } from '../domain/sim/engine.ts'
import { formatSimTime } from '../domain/sim/clock.ts'
import type { ViewMode } from './ConsoleSidebar.tsx'

/**
 * 指挥台左栏：三个视图各自的说明、图例、接力状态与任务时间线。
 *
 * 视图只改变「强调什么」，共享同一份演练状态与同一份当前选中任务，
 * 所以切换视图不会丢失进度（这一点在验收里要能直接看到）。
 */

export interface ViewPanelProps {
  engine: Engine
  model: CommunityModel
  view: ViewMode
  selectedTaskId: string | null
}

const VIEW_INFO: Record<ViewMode, { title: string; detail: string; focus: string[] }> = {
  global: {
    title: '全局',
    detail: '围栏内外的任务路线、社区大门接驳点与任务时间线。',
    focus: ['已生效路线（绿色实线）', '待确认候选（橙色虚线）', '大门 / 接驳点', '任务时间线'],
  },
  internal: {
    title: '社区内部',
    detail: '突出用户楼栋、积水、受阻路段、内部 Agent 的路线与位置。',
    focus: ['用户楼栋与入口', '积水与受阻路段', '内部 Agent 轨迹', '接驳点接力状态'],
  },
  external: {
    title: '外部支援',
    detail: '突出外围道路、候选药店、外部 Agent 的取货路线与预计到达时间。',
    focus: ['外围道路与药店', '外部 Agent 取货路线', '预计到达时间', '货量/运力约束'],
  },
}

const RELAY_TEXT: Record<string, string> = {
  pending_arrival: '待到达',
  pending_handover: '待交接',
  relayed: '已接力',
  delivered: '已送达',
  blocked: '受阻',
}

export function ViewPanel(props: ViewPanelProps): React.ReactElement {
  const { engine, model, view } = props
  const s = engine.state
  const info = VIEW_INFO[view]

  // 接驳点接力状态：按当前生效方案的阶段推导
  const relayRows = useMemoRows(engine, model)
  const selected = s.tasks.find((t) => t.id === props.selectedTaskId) ?? null

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
    <aside className="side-panel left">
      <div className="panel-header">
        <span className="panel-title">{info.title}视图</span>
        <span className="badge muted">{model.name}</span>
      </div>
      <div className="panel-scroll">
        <section className="panel">
          <div className="panel-body stack-sm">
            <p className="field-hint">{info.detail}</p>
            <div className="legend">
              {info.focus.map((f) => (
                <span key={f} className="legend-item"><span className="legend-swatch solid" />{f}</span>
              ))}
            </div>
            <div className="row">
              <span className="data-flag">演练数据</span>
              <span className="field-hint">切换视图不会丢失演练进度，选中的任务保持一致。</span>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header"><span className="panel-title">接力状态</span><span className="badge muted">{relayRows.length}</span></div>
          <div className="panel-body stack-sm">
            {relayRows.length === 0 ? (
              <div className="empty"><div className="empty-title">还没有接力任务</div><div className="empty-hint">确认改派后，这里会显示接驳点的待到达 / 待交接 / 已接力</div></div>
            ) : (
              relayRows.map((r) => (
                <div key={r.planId} className="task-card">
                  <div className="row-between">
                    <strong>{r.taskCode} · {r.taskName}</strong>
                    <span className={`badge ${r.state === 'blocked' ? 'warn' : r.state === 'delivered' ? 'ok' : 'info'}`}>{RELAY_TEXT[r.state] ?? r.state}</span>
                  </div>
                  <div className="field-hint">{r.agentName} · 经 {r.gate} · {r.isRelay ? '含内外接力' : '单一 Agent 送达'}</div>
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
                  <span className="timeline-dot" />
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

        {selected ? (
          <section className="panel">
            <div className="panel-header"><span className="panel-title">当前选中任务</span></div>
            <div className="panel-body stack-sm">
              <div className="row-between"><strong>{selected.code} · {selected.title}</strong><span className="badge muted">{selected.deadlineLabel}</span></div>
              <p className="field-hint">需求：{selected.need.qty} 份 {selected.need.item} · 重量 {selected.weightKg}kg · 目标 {selected.targetName}</p>
              <p className="field-hint">三个视图共享这个选中状态；点击右侧任务卡可切换。</p>
            </div>
          </section>
        ) : null}
      </div>
    </aside>
  )
}

function useMemoRows(engine: Engine, model: CommunityModel) {
  const s = engine.state
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
      const pos = agentPosition(engine, plan)
      void pos
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
