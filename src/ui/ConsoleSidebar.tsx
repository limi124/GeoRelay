import { useRef, useState } from 'react'
import type { CommunityModel } from '../domain/community/model.ts'
import type { Engine } from '../domain/sim/engine.ts'
import { RANKING_LABELS } from '../domain/sim/ranker.ts'
import type { Candidate, InventoryPoint, PlanSet } from '../domain/sim/types.ts'
import type { ImpactEvent } from '../domain/disaster/types.ts'
import { formatSimTime } from '../domain/sim/clock.ts'
import { DisasterBar, type DisasterUiState } from './DisasterBar.tsx'
import { ModelEvidencePanel } from './ModelEvidencePanel.tsx'
import { RelayBoard } from './RelayBoard.tsx'
import { PresetBar } from './PresetBar.tsx'
import { ReplayPanel } from './ReplayPanel.tsx'
import { ComparePanel } from './ComparePanel.tsx'
import type { DrillPreset } from '../domain/sim/presets.ts'
import type { ReplayEntry } from '../domain/sim/replay.ts'
import { AiPanel, type AiUiState } from './AiPanel.tsx'
import type { AiQuestion } from '../services/lbsClient.ts'
import { buildReplay } from '../domain/sim/replay.ts'
import { relayViewOf } from '../domain/sim/relay.ts'

/**
 * 指挥台侧栏：三个视图切换 + 任务 + 候选比较 + 事件记录。
 * 视图只改变图层强调与筛选，不改变演练状态；选中的任务在三个视图间共享。
 */

export type ViewMode = 'global' | 'internal' | 'external'

export interface ConsoleUiState {
  view: ViewMode
  selectedTaskId: string | null
  selectedRoadId: string | null
  selectedCandidateId: string | null
  aiText: string | null
  aiMode: 'rules' | 'ai'
  lbsMode: 'amap' | 'sample'
  busy: boolean
}

export interface ConsoleActions {
  setView(v: ViewMode): void
  selectTask(id: string): void
  selectCandidate(id: string): void
  toggleClock(): void
  stepSeconds(s: number): void
  regenerate(): void | Promise<void>
  askAi(): void
  reset(): void
  backToEdit(): void
  setInventory(next: InventoryPoint[]): void
  exportRecord(): void
}

export interface ConsoleProps {
  engine: Engine
  model: CommunityModel
  ui: ConsoleUiState
  planSet: PlanSet | null
  inventory: InventoryPoint[]
  actions: ConsoleActions
  /** 灾种与灾情证据 */
  disaster: DisasterUiState
  disasterBusy: boolean
  onSwitchDisaster(kind: 'flood' | 'fire' | 'earthquake'): void
  onSelectImpact(id: string): void
  /** AI 调度分析（只分析建议，不改状态） */
  ai: AiUiState
  aiModeLabel: string
  onAskAi(question: AiQuestion): void
  onJumpToTask(taskId: string): void
  onJumpToCandidate(candidateId: string): void
  /** 一键演练 */
  presets: DrillPreset[]
  activePresetId: string | null
  presetMode: boolean
  onLoadPreset(id: string): void
  /** 复盘（只读） */
  replaySelectedId: string | null
  onSelectReplay(entry: ReplayEntry): void
  /** 专业模型算例：入口与来源切换（引擎与灾情由 App 重建） */
  onStartModelRun(runId: string): void
  onSwitchProvenance(level: 'model' | 'simplified'): void
  /** 点击模型证据：定位地图对象并选中任务/候选集 */
  onFocusModelEvidence(ev: ImpactEvent): void
}

const PHASE_TEXT: Record<string, string> = {
  planned: '待出发',
  external_enroute: '外部取货中',
  pickup_wait: '取货中',
  handover_wait: '待交接',
  delivering: '配送中',
  delivered: '已送达',
  blocked: '受阻等待',
}

export function ConsoleSidebar(props: ConsoleProps): React.ReactElement {
  const { engine, ui, planSet, actions } = props
  const s = engine.state
  const [stockDraft, setStockDraft] = useState<Record<string, number>>({})
  /** 数据来源：专业模型算例时非空（简化演示为空），徽标与证据面板据此切换 */
  const provenance = engine.disaster.plan.provenance ?? null
  const evidenceAnchorRef = useRef<HTMLDivElement | null>(null)

  const closure = ui.selectedRoadId ? s.closures[ui.selectedRoadId] : null
  const road = ui.selectedRoadId ? props.model.net.roads.find((r) => r.id === ui.selectedRoadId) : null

  return (
    <aside className="side-panel right">
      <div className="panel-header">
        <span className="panel-title">指挥台</span>
        <span className={`badge ${s.clock.running ? 'ok' : 'muted'}`}>{s.clock.running ? '演练进行中' : '已暂停'}</span>
      </div>
      <nav className="tabs" aria-label="调度范围">
        <button className={`tab ${ui.view === 'global' ? 'is-active' : ''}`} aria-pressed={ui.view === 'global'} onClick={() => actions.setView('global')}>全局</button>
        <button className={`tab ${ui.view === 'internal' ? 'is-active' : ''}`} aria-pressed={ui.view === 'internal'} onClick={() => actions.setView('internal')}>社区内部</button>
        <button className={`tab ${ui.view === 'external' ? 'is-active' : ''}`} aria-pressed={ui.view === 'external'} onClick={() => actions.setView('external')}>外部支援</button>
      </nav>

      <div className="panel-scroll">
        {/* 候选比较 */}
        {planSet ? (
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">改派候选</span>
              <span className={`badge ${planSet.rankingMode === 'rules' ? 'muted' : 'info'}`} title={planSet.rankingNote}>{RANKING_LABELS[planSet.rankingMode]}</span>
            </div>
            <div className="panel-body stack-sm">
              <details className="hud-details"><summary>规划快照</summary><p className="field-hint">{planSet.snapshot}</p></details>
              {planSet.candidates.map((c) => (
                <CandidateCard
                  key={c.id}
                  candidate={c}
                  selected={ui.selectedCandidateId === c.id}
                  confirmed={planSet.confirmedCandidateId === c.id}
                  onSelect={() => actions.selectCandidate(c.id)}
                />
              ))}
              {!planSet.candidates.length ? <div className="empty"><div className="empty-title">还没有可行候选</div><div className="empty-hint">调整接驳点或库存后重新生成</div></div> : null}
              {planSet.confirmedCandidateId ? (
                <div className="notice info">已确认：{planSet.candidates.find((c) => c.id === planSet.confirmedCandidateId)?.title}</div>
              ) : (
                <div className="notice warn">待确认，当前派单尚未改变。</div>
              )}
              <button className="btn sm block ghost" onClick={actions.askAi} disabled={ui.busy}>{ui.aiMode === 'ai' ? 'AI' : '规则'} 解释候选</button>
              {ui.aiText ? <pre className="field-hint" style={{ whiteSpace: 'pre-wrap' }}>{ui.aiText}</pre> : null}
            </div>
          </section>
        ) : null}

        {/* 任务 */}
        <section className="panel">
          <div className="panel-header"><span className="panel-title">任务状态</span><span className="badge muted">{s.tasks.length}</span></div>
          <div className="panel-body stack-sm">
            {s.tasks.map((t) => {
              const planId = s.assignments[t.id]
              const plan = planId ? s.plans[planId] : null
              const blocked = plan?.phase === 'blocked'
              return (
                <button
                  key={t.id}
                  data-testid={`task-${t.id}`}
                  className={`task-card ${ui.selectedTaskId === t.id ? 'is-selected' : ''} ${blocked ? 'is-blocked' : ''}`}
                  aria-pressed={ui.selectedTaskId === t.id}
                  onClick={() => actions.selectTask(t.id)}
                >
                  <div className="row-between">
                    <strong>{t.code} · {t.targetName}</strong>
                    <span className={`badge ${plan?.phase === 'delivered' ? 'ok' : blocked ? 'warn' : 'muted'}`}>{plan ? PHASE_TEXT[plan.phase] ?? plan.phase : '未派单'}</span>
                  </div>
                  <div className="field-hint">
                    {t.need.qty} 份 {t.need.item} · {t.deadlineLabel} · {plan?.agentName ?? '—'}
                    {plan ? ` · 方案 v${plan.version}` : ''}
                    {plan?.blockedRoadId ? ` · 受阻路段：${roadName(props.model, plan.blockedRoadId)}` : ''}
                  </div>
                  {(() => {
                    const rv = relayViewOf(plan ?? undefined, s.tasks, s.agents)
                    if (!rv) return null
                    return (
                      <div className="field-hint" data-testid={`task-relay-${t.id}`}>
                        交接点 {rv.stagingLabel ?? '—'} · 外部 {rv.externalAgentName ?? '—'} · 内部 {rv.internalAgentName ?? '—'} · {rv.waitingText}
                      </div>
                    )
                  })()}
                  <div className="depth-bar" title="演练进度">
                    <div className="depth-bar-fill" style={{ width: `${Math.round((plan?.progress ?? 0) * 100)}%` }} />
                  </div>
                </button>
              )
            })}
          </div>
        </section>

        {/* 路段详情 */}
        {road ? (
          <section className="panel">
            <div className="panel-header"><span className="panel-title">路段详情</span></div>
            <div className="panel-body stack-sm">
              <div className="row-between"><strong>{road.name}</strong><span className="data-flag">演练数据</span></div>
              <div className="field-hint">当前水深 {((closure?.depthM ?? s.depths[road.id] ?? 0)).toFixed(2)} 米 / 阈值 {s.config.depthThresholdM.toFixed(2)} 米</div>
              <div className="depth-bar"><div className="depth-bar-fill" style={{ width: `${Math.min(100, ((s.depths[road.id] ?? 0) / s.config.depthThresholdM) * 100)}%` }} /></div>
              {closure ? (
                <>
                  <div className="notice warn">已于 {formatSimTime(closure.at, s.config.startLabel)} 触发封路（水深 {(closure.depthM ?? 0).toFixed(2)} 米 ≥ 阈值 {closure.thresholdM.toFixed(2)} 米）</div>
                  <div className="field-hint">涨水过程：{closure.history?.map(([tt, d]) => `${Math.round(tt)}s:${d.toFixed(2)}m`).join(' → ')}</div>
                </>
              ) : (
                <div className="notice info">未封路：水深尚未达到阈值</div>
              )}
            </div>
          </section>
        ) : null}

        <details className="hud-details console-settings" data-testid="console-settings">
          <summary>演练设置与灾情</summary>
          <div className="hud-details-body">
            <PresetBar presets={props.presets} activeId={props.activePresetId} presetMode={props.presetMode} busy={props.disasterBusy} onLoad={props.onLoadPreset} />

            <DisasterBar
              ui={props.disaster}
              busy={props.disasterBusy}
              onSwitch={props.onSwitchDisaster}
              onSelectImpact={props.onSelectImpact}
              provenance={provenance}
              onStartModelRun={props.onStartModelRun}
              onSwitchProvenance={props.onSwitchProvenance}
              onJumpToEvidence={() => evidenceAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            />

            {/* 两层证据：模型算出了什么 / GeoRelay 按哪条规则判定（简化演示时不渲染） */}
            <div ref={evidenceAnchorRef} className="evidence-anchor">
              <ModelEvidencePanel engine={engine} onFocus={props.onFocusModelEvidence} />
            </div>

            {/* 时钟与灾情 */}
            <section className="panel">
              <div className="panel-body stack-sm">
                <div className="row-between">
                  <span className="kbd">{formatSimTime(s.clock.t, s.config.startLabel)}</span>
                  <span className="field-hint">演练 {Math.floor(s.clock.t / 60)} 分 {Math.floor(s.clock.t % 60)} 秒</span>
                </div>
                <div className="row">
                  <button className="btn sm" onClick={actions.toggleClock}>{s.clock.running ? '暂停' : '继续'}</button>
                  <button className="btn sm ghost" onClick={() => actions.stepSeconds(60)}>+1 分钟</button>
                  <button className="btn sm ghost" onClick={() => actions.stepSeconds(300)}>+5 分钟</button>
                  <button className="btn sm" onClick={() => void actions.regenerate()} disabled={ui.busy || !Object.keys(s.closures).length}>重新生成候选</button>
                </div>
                <div className="metric">
                  <div><span className="metric-value">{Object.keys(s.closures).length}</span><span className="metric-label">封路</span></div>
                  <div><span className="metric-value">{Object.values(s.assignments).filter((id) => s.plans[id]?.phase === 'blocked').length}</span><span className="metric-label">受阻</span></div>
                  <div><span className="metric-value">{s.record.results.length}</span><span className="metric-label">已送达</span></div>
                  <div><span className="metric-value">{Object.keys(s.planSets).length}</span><span className="metric-label">候选集</span></div>
                </div>
                <p className="field-hint">水深阈值 {s.config.depthThresholdM.toFixed(2)} 米 · 种子 {engine.seed} · 演练数据</p>
              </div>
            </section>

          </div>
        </details>

        <details className="hud-details" data-testid="console-replay">
          <summary>分析与复盘</summary>
          <div className="hud-details-body">
            <AiPanel ui={props.ai} modeLabel={props.aiModeLabel} onAsk={props.onAskAi} onJumpTask={props.onJumpToTask} onJumpCandidate={props.onJumpToCandidate} />

            <RelayBoard engine={engine} selectedTaskId={ui.selectedTaskId} />

            {provenance ? (
              <p className="field-hint replay-provenance" data-testid="replay-provenance">
                复盘来源：{provenance.label} · {provenance.caseId} · 引擎 {provenance.engineVersion}
              </p>
            ) : null}
            <ReplayPanel
              entries={buildReplay(engine.state)}
              selectedId={props.replaySelectedId}
              tasks={engine.state.tasks.map((t) => ({ id: t.id, code: t.code, targetName: t.targetName }))}
              onSelect={props.onSelectReplay}
            />

            <ComparePanel />

          </div>
        </details>

        <details className="hud-details" data-testid="console-inventory">
          <summary>物资点与库存</summary>
          <div className="hud-details-body">
            {/* 药店与库存 */}
            <section className="panel">
              <div className="panel-header"><span className="panel-title">物资点（{ui.lbsMode === 'amap' ? '高德周边' : '示例数据'}）</span></div>
              <div className="panel-body stack-sm">
                {props.inventory.map((p) => (
                  <div key={p.id} className="panel">
                    <div className="row-between">
                      <span>{p.name}</span>
                      <span className={`badge ${p.availability === 'out' ? 'warn' : 'ok'}`}>{p.availability === 'out' ? '不可用' : p.availability === 'limited' ? '有限' : '可用'}</span>
                    </div>
                    <div className="field-hint">{p.address ?? '（示例地址）'} · <span className="data-flag">演练库存</span></div>
                    <div className="row">
                      {Object.entries(p.stock).map(([item, qty]) => (
                        <label key={item} className="field" style={{ minWidth: 92 }}>
                          <span className="field-label">{item}</span>
                          <input
                            className="input"
                            type="number"
                            value={stockDraft[`${p.id}:${item}`] ?? qty}
                            onChange={(e) => setStockDraft({ ...stockDraft, [`${p.id}:${item}`]: Number(e.target.value) })}
                            onBlur={() => {
                              const v = stockDraft[`${p.id}:${item}`]
                              if (v === undefined) return
                              actions.setInventory(props.inventory.map((x) => (x.id === p.id ? { ...x, stock: { ...x.stock, [item]: v } } : x)))
                            }}
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
                <p className="field-hint">药店位置来自{ui.lbsMode === 'amap' ? '高德周边搜索' : '示例数据'}；库存与可用性由演练配置或指挥员录入。</p>
              </div>
            </section>

          </div>
        </details>

        <details className="hud-details" data-testid="console-events">
          <summary>事件记录 · {s.events.length}</summary>
          <div className="hud-details-body">
            {/* 事件记录 */}
            <section className="panel">
              <div className="panel-header"><span className="panel-title">事件记录</span><span className="badge muted">{s.events.length}</span></div>
              <div className="panel-body">
                <div className="event-log">
                  {[...s.events].reverse().slice(0, 40).map((e) => (
                    <div key={e.id} className="event-item">
                      <span className="event-time">{formatSimTime(e.at, s.config.startLabel)}</span>
                      <span className={`event-kind ${e.kind === 'road_closed' ? 'badge warn' : e.kind === 'plan_confirmed' ? 'badge ok' : 'badge muted'}`}>{e.kind}</span>
                      <span>{e.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>

          </div>
        </details>

        <section className="panel">
          <div className="panel-body stack-sm">
            <div className="row">
              <button className="btn sm ghost" onClick={actions.exportRecord}>导出演练记录</button>
              <button className="btn sm" onClick={actions.reset}>重置演练</button>
              <button className="btn sm ghost" onClick={actions.backToEdit}>返回编辑</button>
            </div>
          </div>
        </section>
      </div>
    </aside>
  )
}

function roadName(model: CommunityModel, id: string): string {
  return model.net.roads.find((r) => r.id === id)?.name ?? id
}

function CandidateCard(props: {
  candidate: Candidate
  selected: boolean
  confirmed: boolean
  onSelect(): void
}): React.ReactElement {
  const { candidate: c } = props
  const arrival = Math.max(...c.eta)
  const minutes = Math.round(arrival / 60)
  return (
    <article className={`candidate-card ${props.selected ? 'is-selected' : ''} ${c.feasible ? '' : 'is-infeasible'}`} aria-label={c.title} data-candidate-id={c.id}>
      <div className="row-between">
        <button className="sb-link candidate-title" type="button" aria-pressed={props.selected} aria-label={`预览方案：${c.title}`} onClick={props.onSelect}>{c.title}</button>
        <span className={`badge ${c.feasible ? 'ok' : 'warn'}`}>{c.feasible ? `可行 · 第 ${c.rank} 位` : '不可行'}</span>
      </div>
      <div className="field-hint">{c.summary}</div>
      <div className="field-hint">
        预计 {minutes} 分钟送达 · 时限余量 {(c.slackS / 60).toFixed(1)} 分钟 · {c.isRelay ? '接力配送' : '直接配送'}
      </div>
      <div className="check-list">
        {c.checks.map((ck) => (
          <div key={ck.id} className={`check-item ${ck.ok ? 'ok' : 'fail'}`}>
            <span>{ck.ok ? '✓' : '✕'} {ck.label}</span>
            <span className="field-hint">{ck.detail}</span>
          </div>
        ))}
      </div>
      <div className="field-hint">改派理由：{c.dispatchReason}</div>
      <div className="field-hint">路线来源：{c.route.source === 'internal_astar' ? '内部路网 Dijkstra' : c.route.source === 'amap' ? '高德驾车路线' : '示例路线（非真实导航）'}</div>
      <div className="row">
        {props.confirmed ? (
          <span className="chip is-active">已确认生效</span>
        ) : null}
      </div>
    </article>
  )
}
