import { useEffect, useState } from 'react'
import type { BatchOptions, Building, CommunityModel, FenceValidation } from '../domain/community/model.ts'
import type { CommunityReadiness } from './communityReadiness.ts'

/**
 * 单列建模工作区：定位、围栏、楼栋、路网。
 *
 * 折叠规则：当前步骤展开，已完成的步骤收起并显示摘要；点击标题可手动展开/收起。
 * 只负责界面与输入校验提示；几何与规则判定都在 domain 层完成。
 */

export type FenceMode = 'off' | 'draw' | 'edit'
export type NetMode = 'idle' | 'gate' | 'staging' | 'road'

export interface EditorActions {
  startFence(): void
  clearFence(): void
  editFence(): void
  generate(opts: BatchOptions): void
  selectBuilding(id: string | null): void
  updateBuilding(id: string, patch: { floors?: number; floorHeightM?: number; vulnerable?: number }): void
  deleteBuilding(id: string): void
  rotateBuilding(id: string, delta: number): void
  setUnitsPerFloor(n: number): void
  setNetMode(mode: NetMode): void
  undoRoadPoint(): void
  finishRoad(): void
  cancelRoad(): void
  suggestNetwork(): void
  confirmRoads(): void
  confirmCommunity(): void
  toggleBasemap(v: boolean): void
  loadSample(): void
  locate(): void
  search(query: string): void
  exportJson(): void
}

export interface EditorProps {
  model: CommunityModel
  readiness: CommunityReadiness
  fenceMode: FenceMode
  fenceValidation: FenceValidation | null
  fenceDirty: boolean
  draftCount: number
  selectedBuilding: Building | null
  netMode: NetMode
  roadDraftCount: number
  basemapVisible: boolean
  busy: boolean
  netValidation: { ok: boolean; errors: string[]; warnings: string[] }
  status: { amap: string; ai: string }
  actions: EditorActions
}

type StepId = 'locate' | 'fence' | 'buildings' | 'network'

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('zh-CN')
}

function savedTimeLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function EditorSidebar(props: EditorProps): React.ReactElement {
  const { model, readiness, fenceValidation, selectedBuilding, actions } = props
  const [count, setCount] = useState(model.generation.count || 12)
  const [floors, setFloors] = useState(model.generation.floors || 8)
  const [floorHeight, setFloorHeight] = useState(model.generation.floorHeightM || 2.9)
  const [width, setWidth] = useState(model.generation.widthM || 22)
  const [depth, setDepth] = useState(model.generation.depthM || 15)
  const [keepExisting, setKeepExisting] = useState(false)
  const [query, setQuery] = useState('')
  const [floorsEdit, setFloorsEdit] = useState(selectedBuilding?.floors ?? 0)
  const [fhEdit, setFhEdit] = useState(selectedBuilding?.floorHeightM ?? 0)

  const fenceArea = fenceValidation?.areaM2 ?? 0
  const fenceReady = readiness.completed.fence
  const networkReady = readiness.completed.network
  const steps: Array<{ id: StepId; title: string; done: boolean; summary: string }> = [
    { id: 'locate', title: '定位', done: Boolean(model.address) || model.fence.polygon.length > 0, summary: model.address || (model.fence.polygon.length ? '已选点' : '未定位') },
    { id: 'fence', title: '围栏', done: fenceReady, summary: props.fenceDirty ? `草稿 ${props.draftCount} 点 · 未确认` : fenceReady ? `${Math.round(fenceArea)} m²` : '未绘制' },
    { id: 'buildings', title: '楼栋', done: readiness.completed.buildings, summary: model.buildings.length ? `${model.buildings.length} 栋` : '未生成' },
    { id: 'network', title: '入口与路网', done: networkReady, summary: props.netMode === 'road' ? `草稿 ${props.roadDraftCount} 个端点` : `${model.net.gates.length} 门 · ${model.net.staging.length} 接驳点 · ${model.net.roads.length} 路段` },
  ]
  const firstOpen = readiness.nextStep ?? 'network'
  const [openStep, setOpenStep] = useState<StepId | null>(firstOpen)

  // 社区数据仅从当前模型推导；展开时用于核对。
  const unitsPerFloor = model.unitsPerFloor ?? 4
  const totalFloorArea = model.buildings.reduce((s, b) => s + b.widthM * b.depthM * b.floors, 0)
  const households = model.buildings.reduce((s, b) => s + b.floors * unitsPerFloor, 0)
  const population = Math.round(households * 2.6)
  const vulnerableTotal = model.buildings.reduce((s, b) => s + (b.vulnerable ?? 0), 0)
  const vulnerableBuildings = model.buildings.filter((b) => (b.vulnerable ?? 0) > 0).length
  // Follow the same next requirement as the primary action, without closing a
  // manually opened step on unrelated model edits.
  useEffect(() => {
    if (readiness.nextStep) setOpenStep(readiness.nextStep)
  }, [readiness.nextStep])

  useEffect(() => {
    if (props.fenceDirty) setOpenStep('fence')
    else if (props.netMode !== 'idle') setOpenStep('network')
  }, [props.fenceDirty, props.netMode])

  useEffect(() => {
    if (openStep) document.querySelector(`[data-testid="rail-step-${openStep}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [openStep])

  const toggle = (id: StepId): void => setOpenStep((cur) => (cur === id ? null : id))

  const continueSetup = (): void => {
    if (readiness.ready) {
      actions.confirmCommunity()
      return
    }
    setOpenStep(readiness.nextStep)
    if (readiness.action === 'draw-fence') actions.startFence()
    // Resuming a draft only moves attention; startFence would clear its points.
    requestAnimationFrame(() => {
      const selector = readiness.nextStep === 'fence'
        ? '[data-testid="fence-toolbar"]'
        : readiness.nextStep === 'buildings'
          ? '#editor-step-buildings input'
          : readiness.action === 'resume-road'
            ? '[data-testid="road-live"]'
            : '#editor-heading-network'
      const target = document.querySelector<HTMLElement>(selector)
      target?.scrollIntoView({ block: 'nearest' })
      target?.focus({ preventScroll: true })
    })
  }

  useEffect(() => {
    setFloorsEdit(selectedBuilding?.floors ?? 0)
    setFhEdit(selectedBuilding?.floorHeightM ?? 0)
  }, [selectedBuilding?.id, selectedBuilding?.floors, selectedBuilding?.floorHeightM])

  useEffect(() => {
    if (selectedBuilding) setOpenStep('buildings')
  }, [selectedBuilding?.id])

  const stepHead = (step: { id: StepId; title: string; done: boolean; summary: string }, index: number): React.ReactElement => (
    <button id={`editor-heading-${step.id}`} className="rail-step-head" onClick={() => toggle(step.id)} aria-expanded={openStep === step.id} aria-current={readiness.nextStep === step.id ? 'step' : undefined} aria-controls={openStep === step.id ? `editor-step-${step.id}` : undefined} data-testid={`rail-step-${step.id}`}>
      <span className={`rail-step-idx ${step.done ? 'is-done' : ''}`}>{step.done ? '✓' : index + 1}</span>
      <span className="rail-step-title">{step.title}</span>
      <span className="rail-step-summary" title={step.summary}>{step.summary}</span>
      <span className="rail-step-chev" aria-hidden>{openStep === step.id ? '▾' : '▸'}</span>
    </button>
  )

  const vulnOfSelected = selectedBuilding?.vulnerable ?? 0

  return (
    <aside className="editor-rail" data-testid="editor-rail" aria-label="社区建模">
      <header className="rail-head">
        <h2>{model.name || '我的社区'}</h2>
      </header>
      <div className="rail-scroll">
        <div className="editor-start-actions">
          <button className="btn block" onClick={actions.loadSample} disabled={props.busy}>载入演示社区</button>
        </div>
        <section className={`rail-step ${openStep === 'locate' ? 'is-open' : ''}`}>
          {stepHead(steps[0], 0)}
          {openStep === 'locate' ? (
            <div id="editor-step-locate" className="rail-step-body stack-sm" role="region" aria-labelledby="editor-heading-locate">
              <div className="input-group" data-testid="rail-locate">
                <input
                  className="input"
                  placeholder="搜索社区地址"
                  aria-label="社区地址搜索"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !props.busy && query.trim()) actions.search(query) }}
                />
                <button className="btn sm" onClick={() => actions.search(query)} disabled={props.busy || !query.trim()}>搜索</button>
              </div>
              <div className="row">
                <button className="btn sm" onClick={actions.locate} disabled={props.busy}>定位到我</button>
                <button className="btn sm" onClick={() => { setOpenStep('fence'); actions.startFence() }} data-testid="draw-fence">绘制围栏</button>
              </div>
            </div>
          ) : null}
        </section>

        {/* 2. 围栏 */}
        <section className={`rail-step ${openStep === 'fence' ? 'is-open' : ''}`}>
          {stepHead(steps[1], 1)}
          {openStep === 'fence' ? (
            <div id="editor-step-fence" className="rail-step-body stack-sm" role="region" aria-labelledby="editor-heading-fence">
              <div className="btn-group">
                <button className={`btn sm ${props.fenceMode === 'draw' ? 'is-active' : ''}`} onClick={actions.startFence} aria-pressed={props.fenceMode === 'draw'}>绘制</button>
                <button className={`btn sm ${props.fenceMode === 'edit' ? 'is-active' : ''}`} onClick={actions.editFence} disabled={!model.fence.polygon.length} aria-pressed={props.fenceMode === 'edit'}>编辑顶点</button>
                <button className="btn sm ghost" onClick={actions.clearFence}>重画</button>
              </div>
              {fenceValidation && !fenceValidation.ok && Math.max(props.draftCount, model.fence.polygon.length) >= 3 ? <div className="notice error">{fenceValidation.errors.join('；')}</div> : null}
              {fenceValidation?.warnings.length ? <div className="notice warn">{fenceValidation.warnings.join('；')}</div> : null}
            </div>
          ) : null}
        </section>

        {/* 3. 楼栋 */}
        <section className={`rail-step ${openStep === 'buildings' ? 'is-open' : ''}`}>
          {stepHead(steps[2], 2)}
          {openStep === 'buildings' ? (
            <div id="editor-step-buildings" className="rail-step-body stack-sm" role="region" aria-labelledby="editor-heading-buildings">
              <div className="grid-2">
                <label className="field"><span className="field-label">数量</span><input className="input" type="number" min={1} max={200} value={count} onChange={(e) => setCount(Number(e.target.value))} /></label>
                <label className="field"><span className="field-label">默认层数</span><input className="input" type="number" min={1} max={60} value={floors} onChange={(e) => setFloors(Number(e.target.value))} /></label>
              </div>
              <details className="editor-details editor-details-inline">
                <summary>楼栋参数</summary>
                <div className="grid-2">
                  <label className="field"><span className="field-label">层高（米）</span><input className="input" type="number" min={2.2} max={6} step={0.1} value={floorHeight} onChange={(e) => setFloorHeight(Number(e.target.value))} /></label>
                  <label className="field"><span className="field-label">宽（米）</span><input className="input" type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} /></label>
                  <label className="field"><span className="field-label">深（米）</span><input className="input" type="number" value={depth} onChange={(e) => setDepth(Number(e.target.value))} /></label>
                </div>
                <label className="row"><input type="checkbox" checked={keepExisting} onChange={(e) => setKeepExisting(e.target.checked)} /><span className="field-label">保留已有楼栋</span></label>
              </details>
              <button className="btn primary block" onClick={() => actions.generate({ count, floors, floorHeightM: floorHeight, widthM: width, depthM: depth, keepExisting, seed: 42 })} disabled={!fenceReady || !fenceValidation?.ok || props.busy}>
                批量生成楼栋
              </button>
              {selectedBuilding ? (
                <div className="sub-panel" data-testid="selected-building">
                  <div className="sub-panel-head"><strong>{selectedBuilding.name}</strong><button className="btn sm ghost" onClick={() => actions.selectBuilding(null)} aria-label="取消选择楼栋">取消选择</button></div>
                  <div className="grid-2">
                    <label className="field"><span className="field-label">层数</span><input className="input" type="number" min={1} max={60} value={floorsEdit || selectedBuilding.floors} onChange={(e) => setFloorsEdit(Number(e.target.value))} /></label>
                    <label className="field"><span className="field-label">层高（米）</span><input className="input" type="number" min={2.2} max={6} step={0.1} value={fhEdit || selectedBuilding.floorHeightM} onChange={(e) => setFhEdit(Number(e.target.value))} /></label>
                  </div>
                  <div className="row">
                    <button className="btn sm" onClick={() => actions.updateBuilding(selectedBuilding.id, { floors: floorsEdit || selectedBuilding.floors, floorHeightM: fhEdit || selectedBuilding.floorHeightM })}>应用</button>
                    <button className="btn sm ghost" onClick={() => actions.rotateBuilding(selectedBuilding.id, 90)}>旋转 90°</button>
                    <button className="btn sm danger" onClick={() => actions.deleteBuilding(selectedBuilding.id)}>删除</button>
                  </div>
                  <div className="vuln-row">
                    <div className="vuln-row-text">
                      <span className="field-label" title="独居老人、行动不便等需优先配送的住户">重点住户</span>
                    </div>
                    <div className="stepper" role="group" aria-label="重点住户数">
                      <button className="stepper-btn" onClick={() => actions.updateBuilding(selectedBuilding.id, { vulnerable: Math.max(0, vulnOfSelected - 1) })} disabled={vulnOfSelected <= 0} aria-label="减少重点住户">−</button>
                      <span className={`stepper-value ${vulnOfSelected > 0 ? 'is-warm' : ''}`}>{vulnOfSelected}</span>
                      <button className="stepper-btn" onClick={() => actions.updateBuilding(selectedBuilding.id, { vulnerable: Math.min(200, vulnOfSelected + 1) })} disabled={vulnOfSelected >= 200} aria-label="增加重点住户">+</button>
                    </div>
                  </div>
                  <p className="field-hint">总高 {Math.round(selectedBuilding.floors * selectedBuilding.floorHeightM)} 米 · 占地 {selectedBuilding.widthM}×{selectedBuilding.depthM} 米</p>
                </div>
              ) : null}
              {model.buildings.length ? (
                <div className="sub-panel">
                  <div className="sub-panel-head"><span>楼栋列表</span><span className="badge muted">{model.buildings.length}</span></div>
                  <div className="rail-list editor-building-list" aria-label="楼栋列表">
                    {model.buildings.map((b) => (
                      <button
                        key={b.id}
                        className={`rail-list-row ${props.selectedBuilding?.id === b.id ? 'is-selected' : ''}`}
                        onClick={() => actions.selectBuilding(b.id)}
                        aria-pressed={selectedBuilding?.id === b.id}
                        title={`${b.name} · ${b.floors} 层 × ${b.floorHeightM} 米`}
                      >
                        <span>{b.name}</span>
                        <span className="rail-list-badges">
                          {(b.vulnerable ?? 0) > 0 ? <span className="badge warm">重点 {b.vulnerable}</span> : null}
                          <span>{b.floors} 层</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>

        {/* 4. 入口与路网 */}
        <section className={`rail-step ${openStep === 'network' ? 'is-open' : ''}`}>
          {stepHead(steps[3], 3)}
          {openStep === 'network' ? (
            <div id="editor-step-network" className="rail-step-body stack-sm" role="region" aria-labelledby="editor-heading-network">
              <div className="btn-group">
                <button className={`btn sm ${props.netMode === 'gate' ? 'is-active' : ''}`} aria-pressed={props.netMode === 'gate'} onClick={() => actions.setNetMode(props.netMode === 'gate' ? 'idle' : 'gate')}>标大门</button>
                <button className={`btn sm ${props.netMode === 'staging' ? 'is-active' : ''}`} aria-pressed={props.netMode === 'staging'} onClick={() => actions.setNetMode(props.netMode === 'staging' ? 'idle' : 'staging')}>标接驳点</button>
                <button className={`btn sm ${props.netMode === 'road' ? 'is-active' : ''}`} aria-pressed={props.netMode === 'road'} onClick={() => actions.setNetMode(props.netMode === 'road' ? 'idle' : 'road')}>画路段</button>
              </div>
              {props.netMode === 'gate' || props.netMode === 'staging' ? (
                <div className="row-between">
                  <span className="field-hint">{props.netMode === 'gate' ? '在地图上点选大门' : '在地图上点选接驳点'}</span>
                  <button className="btn sm" onClick={() => actions.setNetMode('idle')}>结束标记</button>
                </div>
              ) : null}
              {props.netMode === 'road' ? (
                <div className="stack-sm">
                  <div className="fence-live" data-testid="road-live" tabIndex={-1} role="group" aria-label="路段草稿">
                    <span><b>{props.roadDraftCount}</b> 个端点</span>
                    <span>{props.roadDraftCount >= 2 ? '可完成路段' : '继续点击添加端点'}</span>
                  </div>
                  <div className="row">
                    <button className="btn sm" onClick={actions.finishRoad} disabled={props.roadDraftCount < 2}>完成路段</button>
                    <button className="btn sm ghost" onClick={actions.undoRoadPoint} disabled={props.roadDraftCount === 0}>撤销端点</button>
                    <button className="btn sm ghost" onClick={actions.cancelRoad}>取消</button>
                  </div>
                </div>
              ) : null}
              <div className="row">
                <button className="btn sm" title={model.net.roads.length ? '替换现有路段，可撤销' : undefined} onClick={actions.suggestNetwork}>生成示例路网</button>
                <button className="btn sm primary" disabled={props.roadDraftCount > 0} onClick={actions.confirmRoads}>确认路网</button>
              </div>
              {props.netValidation.errors.length ? <div className="notice error">{props.netValidation.errors.join('；')}</div> : null}
              {props.netValidation.warnings.length ? <div className="notice warn">{props.netValidation.warnings.join('；')}</div> : null}
            </div>
          ) : null}
        </section>

        <details className="editor-details" data-testid="community-dashboard">
          <summary>社区数据</summary>
          <dl className="editor-facts">
            <div><dt>围栏面积</dt><dd>{fmtInt(fenceArea)} m²</dd></div>
            <div><dt>建筑面积</dt><dd>{fmtInt(totalFloorArea)} m²</dd></div>
            <div><dt>估算人口</dt><dd title="按每户 2.6 人估算">{fmtInt(population)} 人</dd></div>
            <div><dt>重点住户</dt><dd>{vulnerableTotal} 户 · {vulnerableBuildings} 栋</dd></div>
            <div><dt>大门 / 接驳点</dt><dd>{model.net.gates.length} / {model.net.staging.length}</dd></div>
            <div><dt>路段 / 楼栋入口</dt><dd>{model.net.roads.length} / {model.buildings.length}</dd></div>
          </dl>
          <div className="row-between">
            <span className="field-label">每层户数</span>
            <div className="stepper" role="group" aria-label="每层户数">
              <button className="stepper-btn" onClick={() => actions.setUnitsPerFloor(unitsPerFloor - 1)} disabled={unitsPerFloor <= 1} aria-label="减少每层户数">−</button>
              <span className="stepper-value">{unitsPerFloor}</span>
              <button className="stepper-btn" onClick={() => actions.setUnitsPerFloor(unitsPerFloor + 1)} disabled={unitsPerFloor >= 8} aria-label="增加每层户数">+</button>
            </div>
          </div>
        </details>
        <details className="editor-details">
          <summary>地图图层</summary>
          <div className="editor-layer-toggle row-between">
            <span>背景楼块</span>
            <button className={`switch ${props.basemapVisible ? 'is-on' : ''}`} role="switch" aria-label="背景楼块" aria-checked={props.basemapVisible} onClick={() => actions.toggleBasemap(!props.basemapVisible)}>{props.basemapVisible ? '显示' : '隐藏'}</button>
          </div>
          <ul className="editor-map-legend" aria-label="建模图例">
            <li><span className="legend-swatch fence" />社区围栏</li>
            <li><span className="legend-swatch solid" />已确认路段</li>
            <li><span className="legend-swatch dashed" />待确认路段</li>
          </ul>
          <p className="field-hint">{props.status.amap}</p>
        </details>
      </div>

      <footer className="rail-foot editor-actions" aria-label="社区保存与确认">
        <button className="btn primary block rail-cta" onClick={continueSetup} disabled={props.busy} data-testid="confirm-community" data-action={readiness.action} aria-label={readiness.ready ? '确认社区并进入指挥台' : readiness.label}>
          {readiness.label}
        </button>
        <div className="row-between">
          <button className="btn sm ghost" onClick={actions.exportJson}>导出社区</button>
          <span className="autosave" title={`保存在此浏览器 · ${savedTimeLabel(model.updatedAt)}`}>
            <span className="autosave-dot" aria-hidden />
            已保存
          </span>
        </div>
      </footer>
    </aside>
  )
}

