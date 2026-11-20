import { useEffect, useState } from 'react'
import type { BatchOptions, Building, CommunityModel, FenceValidation } from '../domain/community/model.ts'
import type { LngLat } from '../domain/geo/types.ts'
import { polygonPerimeterM } from '../domain/community/operations.ts'

/**
 * 建模台（A）的定位工具、社区概览和分步操作。
 *
 * 折叠规则：当前步骤展开，已完成的步骤收起并显示摘要；点击标题可手动展开/收起。
 * 只负责界面与输入校验提示；几何与规则判定都在 domain 层完成。
 */

export type FenceMode = 'off' | 'draw' | 'edit'
export type NetMode = 'idle' | 'gate' | 'staging' | 'road'

export interface EditorActions {
  startFence(): void
  undoVertex(): void
  finishFence(): void
  cancelFence(): void
  toggleRect(): void
  clearFence(): void
  editFence(): void
  saveFence(): void
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
  fenceMode: FenceMode
  fenceValidation: FenceValidation | null
  fenceDirty: boolean
  draft: LngLat[]
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

/** 每一步在地图上的操作提示：只描述怎么点，不改任何业务判断 */
const GUIDE_TEXT: Record<StepId, string> = {
  locate: '在地图上拖动/缩放找到社区位置；点地图任意处即可选中心，也可以用「定位到我」或地址搜索。',
  fence: '点「绘制」后在地图上逐点单击描边，双击或点回起点闭合；也可以用工具条的「矩形围栏」两点成框。闭合后可拖动顶点微调。',
  buildings: '围栏确认后点「批量生成楼栋」；点地图上的楼栋可选中，在左侧改层数、层高和重点住户，拖动楼栋可换位置。',
  network: '先用「标大门」点地图上的门位置，再「标接驳点」点空地，最后「画路段」依次点两个节点连成内部道路；画完点「确认路网」。',
}

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
  const { model, fenceValidation, selectedBuilding, actions } = props
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
  const fenceReady = !props.fenceDirty && model.fence.polygon.length >= 3 && Boolean(fenceValidation?.ok)
  const roadsConfirmed = model.net.roads.length > 0 && model.net.roads.every((r) => r.status === 'user')
  const networkReady = props.netValidation.ok && roadsConfirmed && model.net.staging.length > 0 && props.roadDraftCount === 0
  const steps: Array<{ id: StepId; title: string; done: boolean; summary: string }> = [
    { id: 'locate', title: '定位', done: Boolean(model.address) || model.fence.polygon.length > 0, summary: model.address || (model.fence.polygon.length ? '已选点' : '未定位') },
    { id: 'fence', title: '围栏', done: fenceReady, summary: props.fenceDirty ? `草稿 ${props.draftCount} 点 · 未确认` : fenceReady ? `${Math.round(fenceArea)} m²` : '未绘制' },
    { id: 'buildings', title: '楼栋', done: model.buildings.length > 0, summary: model.buildings.length ? `${model.buildings.length} 栋` : '未生成' },
    { id: 'network', title: '入口与路网', done: networkReady, summary: props.netMode === 'road' ? `草稿 ${props.roadDraftCount} 个端点` : `${model.net.gates.length} 门 · ${model.net.staging.length} 接驳点 · ${model.net.roads.length} 路段` },
  ]
  const firstOpen = steps.find((s) => !s.done)?.id ?? 'network'
  const [openStep, setOpenStep] = useState<StepId | null>(firstOpen)

  // ---- 常驻仪表盘：全部从当前社区模型实时推导 ----
  const unitsPerFloor = model.unitsPerFloor ?? 4
  const totalFloorArea = model.buildings.reduce((s, b) => s + b.widthM * b.depthM * b.floors, 0)
  const households = model.buildings.reduce((s, b) => s + b.floors * unitsPerFloor, 0)
  const population = Math.round(households * 2.6)
  const vulnerableTotal = model.buildings.reduce((s, b) => s + (b.vulnerable ?? 0), 0)
  const vulnerableBuildings = model.buildings.filter((b) => (b.vulnerable ?? 0) > 0).length
  const livePerimeter = props.fenceMode !== 'off'
    ? (props.draft.length >= 2 ? polygonPerimeterM(props.draft) : 0)
    : (model.fence.polygon.length >= 3 ? polygonPerimeterM(model.fence.polygon) : 0)

  const requiredDone = steps.filter((step) => step.done).length
  const requiredTotal = steps.length

  const doneSignature = steps.map((s) => `${s.id}:${s.done ? 1 : 0}`).join('|')

  // 完成一步后自动展开下一步（手动点开的那一步保持不变）
  useEffect(() => {
    setOpenStep((cur) => {
      if (props.netMode !== 'idle') return 'network'
      if (cur && !steps.find((s) => s.id === cur)?.done) return cur
      return steps.find((s) => !s.done)?.id ?? (cur === 'network' ? cur : null)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneSignature])

  useEffect(() => {
    if (props.fenceDirty) setOpenStep('fence')
    else if (props.netMode !== 'idle') setOpenStep('network')
  }, [props.fenceDirty, props.netMode])

  useEffect(() => {
    if (openStep) document.querySelector(`[data-testid="rail-step-${openStep}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [openStep])

  const toggle = (id: StepId): void => setOpenStep((cur) => (cur === id ? null : id))

  /** 引导提示跟随当前展开的步骤；全部完成时提示“入口与路网”可复核 */
  const guideStepId: StepId =
    openStep ??
    (props.fenceMode !== 'off' ? 'fence' : props.netMode !== 'idle' ? 'network' : firstOpen)

  const stepHead = (step: { id: StepId; title: string; done: boolean; summary: string }, index: number): React.ReactElement => (
    <button className="rail-step-head" onClick={() => toggle(step.id)} aria-expanded={openStep === step.id} data-testid={`rail-step-${step.id}`}>
      <span className={`rail-step-idx ${step.done ? 'is-done' : ''}`}>{step.done ? '✓' : index + 1}</span>
      <span className="rail-step-title">{step.title}</span>
      <span className="rail-step-summary">{step.summary}</span>
      <span className="rail-step-chev" aria-hidden>{openStep === step.id ? '▾' : '▸'}</span>
    </button>
  )

  const vulnOfSelected = selectedBuilding?.vulnerable ?? 0

  return (
    <>
      <div className="rail-locate" data-testid="rail-locate" role="group" aria-label="地图定位">
        <div className="input-group">
          <input
            className="input"
            placeholder="地址搜索，例如：某某小区"
            aria-label="社区地址搜索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !props.busy && query.trim()) actions.search(query) }}
          />
          <button className="btn sm" onClick={() => actions.search(query)} disabled={props.busy || !query.trim()}>搜索</button>
        </div>
        <button className="btn sm" onClick={actions.locate} disabled={props.busy}>定位到我</button>
        <button className="btn sm ghost" onClick={actions.loadSample} disabled={props.busy}>载入演示社区</button>
        <div className="dash-units">
          <span className="field-label" title="按户均 2.6 人估算人口">每层户数</span>
          <div className="stepper" role="group" aria-label="每层户数">
            <button className="stepper-btn" onClick={() => actions.setUnitsPerFloor(unitsPerFloor - 1)} disabled={unitsPerFloor <= 1} aria-label="减少每层户数">−</button>
            <span className="stepper-value">{unitsPerFloor}</span>
            <button className="stepper-btn" onClick={() => actions.setUnitsPerFloor(unitsPerFloor + 1)} disabled={unitsPerFloor >= 8} aria-label="增加每层户数">+</button>
          </div>
        </div>
      </div>

      <aside className="editor-map-panel" aria-labelledby="editor-map-heading">
        <header className="rail-head"><h2 id="editor-map-heading">地图图层</h2></header>
        <div className="rail-scroll">
          <div className="editor-layer-toggle row-between">
            <span>背景楼块</span>
            <button className={`switch ${props.basemapVisible ? 'is-on' : ''}`} aria-label="背景楼块" aria-pressed={props.basemapVisible} onClick={() => actions.toggleBasemap(!props.basemapVisible)}>{props.basemapVisible ? '显示' : '隐藏'}</button>
          </div>
          <ul className="editor-map-legend" aria-label="建模图例">
            <li><span className="legend-swatch fence" />社区围栏</li>
            <li><span className="legend-swatch solid" />已确认路段</li>
            <li><span className="legend-swatch dashed" />待确认路段</li>
          </ul>
          <section className="editor-network-status" aria-labelledby="editor-network-heading">
            <header className="row-between">
              <h3 id="editor-network-heading">路网状态</h3>
              <span className={`badge ${networkReady ? 'ok' : 'muted'}`}>{networkReady ? '已就绪' : model.net.roads.length ? '待确认' : '待建路网'}</span>
            </header>
            <dl>
              <div><dt>大门</dt><dd>{model.net.gates.length}</dd></div>
              <div><dt>接驳点</dt><dd>{model.net.staging.length}</dd></div>
              <div><dt>路段</dt><dd>{model.net.roads.length}</dd></div>
              <div><dt>楼栋入口</dt><dd>{model.buildings.length}</dd></div>
            </dl>
          </section>
        </div>
      </aside>

        <section className="rail-dash" data-testid="community-dashboard" aria-label="社区概览">
          <div className="dash-grid">
            <div className="dash-cell">
              <span className="dash-value">{fenceArea > 0 ? fmtInt(fenceArea) : '—'}</span>
              <span className="dash-label">围栏面积 m²{fenceArea > 0 ? ` · ${(fenceArea / 666.67).toFixed(1)} 亩` : ''}</span>
            </div>
            <div className="dash-cell">
              <span className="dash-value">{model.buildings.length}<small> 栋</small></span>
              <span className="dash-label">楼栋</span>
            </div>
            <div className="dash-cell">
              <span className="dash-value">{totalFloorArea > 0 ? fmtInt(totalFloorArea) : '—'}</span>
              <span className="dash-label">总建筑面积 m²</span>
            </div>
            <div className="dash-cell is-primary">
              <span className="dash-value">{fmtInt(population)}<small> 人</small></span>
              <span className="dash-label" title="按户均 2.6 人估算">估算人口</span>
            </div>
            <div className="dash-cell">
              <span className="dash-value">{model.net.gates.length} / {model.net.staging.length}</span>
              <span className="dash-label">大门 / 接驳点</span>
            </div>
            <div className={`dash-cell ${vulnerableTotal > 0 ? 'is-warm' : ''}`}>
              <span className="dash-value">{vulnerableTotal}<small> 户</small></span>
              <span className="dash-label">重点住户{vulnerableBuildings > 0 ? ` · ${vulnerableBuildings} 栋` : ''}</span>
            </div>
          </div>
        </section>

      <aside className="editor-rail" data-testid="editor-rail" aria-label="社区建模">
      <header className="rail-head">
        <h2>建模步骤</h2>
        <span className="rail-dash-progress" title={`必备项就绪 ${requiredDone}/${requiredTotal}`}>就绪 {requiredDone}/{requiredTotal}</span>
      </header>
      <div className="rail-guide" data-testid="rail-guide"><p>{GUIDE_TEXT[guideStepId]}</p></div>
      <div className="rail-scroll">
        {/* 1. 定位 */}
        <section className={`rail-step ${openStep === 'locate' ? 'is-open' : ''}`}>
          {stepHead(steps[0], 0)}
          {openStep === 'locate' ? (
            <div className="rail-step-body stack-sm">
              <button className="btn sm" onClick={() => { setOpenStep('fence'); actions.startFence() }}>下一步：绘制围栏</button>
              <p className="field-hint">也可以直接在地图上拖动/缩放后手动选址。定位失败会提示具体原因。</p>
              <p className="field-hint">{props.status.amap}</p>
            </div>
          ) : null}
        </section>

        {/* 2. 围栏 */}
        <section className={`rail-step ${openStep === 'fence' ? 'is-open' : ''}`}>
          {stepHead(steps[1], 1)}
          {openStep === 'fence' ? (
            <div className="rail-step-body stack-sm">
              <div className="btn-group">
                <button className={`btn sm ${props.fenceMode === 'draw' ? 'is-active' : ''}`} onClick={actions.startFence}>绘制</button>
                <button className={`btn sm ${props.fenceMode === 'edit' ? 'is-active' : ''}`} onClick={actions.editFence} disabled={!model.fence.polygon.length}>编辑顶点</button>
                <button className="btn sm ghost" onClick={actions.undoVertex} disabled={props.fenceMode !== 'draw' || props.draftCount === 0}>撤销</button>
                <button className="btn sm ghost" onClick={actions.clearFence}>重画</button>
              </div>
              {props.fenceMode !== 'off' ? (
                <div className="fence-live" data-testid="fence-live">
                  <span><b>{props.draftCount}</b> 顶点</span>
                  <span><b>{livePerimeter > 0 ? fmtInt(livePerimeter) : '—'}</b> m 周长</span>
                  <span><b>{fenceArea > 0 ? fmtInt(fenceArea) : '—'}</b> m² 面积</span>
                </div>
              ) : null}
              {props.fenceMode === 'draw' ? (
                <div className="notice info">
                  <span>已放置 {props.draftCount} 个顶点。继续点击加点，<b>双击</b>或<b>点回起点</b>结束绘制。</span>
                  <button className="btn sm" onClick={actions.finishFence} disabled={!fenceValidation?.ok}>完成围栏</button>
                </div>
              ) : null}
              {props.fenceMode === 'edit' ? (
                <div className="notice info">
                  拖动地图上的顶点调整形状。
                  <button className="btn sm" onClick={actions.saveFence}>保存围栏</button>
                </div>
              ) : null}
              {fenceValidation && !fenceValidation.ok ? <div className="notice error">{fenceValidation.errors.join('；')}</div> : null}
              {fenceValidation?.warnings.length ? <div className="notice warn">{fenceValidation.warnings.join('；')}</div> : null}
              <p className="field-hint">支持凹多边形；会校验面积与自交（自交边标红）。编辑时点边上的「+」插点、右键顶点删点；快捷键 Enter 完成 / Esc 退出 / 退格撤销。</p>
            </div>
          ) : null}
        </section>

        {/* 3. 楼栋 */}
        <section className={`rail-step ${openStep === 'buildings' ? 'is-open' : ''}`}>
          {stepHead(steps[2], 2)}
          {openStep === 'buildings' ? (
            <div className="rail-step-body stack-sm">
              <div className="grid-2">
                <label className="field"><span className="field-label">数量</span><input className="input" type="number" min={1} max={200} value={count} onChange={(e) => setCount(Number(e.target.value))} /></label>
                <label className="field"><span className="field-label">默认层数</span><input className="input" type="number" min={1} max={60} value={floors} onChange={(e) => setFloors(Number(e.target.value))} /></label>
                <label className="field"><span className="field-label">层高（米）</span><input className="input" type="number" min={2.2} max={6} step={0.1} value={floorHeight} onChange={(e) => setFloorHeight(Number(e.target.value))} /></label>
                <label className="field"><span className="field-label">宽 × 深</span><div className="row"><input className="input" type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} /><input className="input" type="number" value={depth} onChange={(e) => setDepth(Number(e.target.value))} /></div></label>
              </div>
              <label className="row"><input type="checkbox" checked={keepExisting} onChange={(e) => setKeepExisting(e.target.checked)} /><span className="field-label">保留已有楼栋（增量生成）</span></label>
              <button className="btn primary block" onClick={() => actions.generate({ count, floors, floorHeightM: floorHeight, widthM: width, depthM: depth, keepExisting, seed: 42 })} disabled={!fenceReady || props.busy}>
                批量生成楼栋
              </button>
              {selectedBuilding ? (
                <div className="sub-panel" data-testid="selected-building">
                  <div className="sub-panel-head"><span>{selectedBuilding.name}</span><span className="badge ok">已选中</span></div>
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
                      <span className="field-label">重点住户</span>
                      <span className="field-hint">独居老人、行动不便等需优先配送的住户；演练会自动生成最高优先级补给任务</span>
                    </div>
                    <div className="stepper" role="group" aria-label="重点住户数">
                      <button className="stepper-btn" onClick={() => actions.updateBuilding(selectedBuilding.id, { vulnerable: Math.max(0, vulnOfSelected - 1) })} disabled={vulnOfSelected <= 0} aria-label="减少重点住户">−</button>
                      <span className={`stepper-value ${vulnOfSelected > 0 ? 'is-warm' : ''}`}>{vulnOfSelected}</span>
                      <button className="stepper-btn" onClick={() => actions.updateBuilding(selectedBuilding.id, { vulnerable: Math.min(200, vulnOfSelected + 1) })} disabled={vulnOfSelected >= 200} aria-label="增加重点住户">+</button>
                    </div>
                  </div>
                  <p className="field-hint">总高 {Math.round(selectedBuilding.floors * selectedBuilding.floorHeightM)} 米 · 占地 {selectedBuilding.widthM}×{selectedBuilding.depthM} 米。拖动越界或重叠会被拒绝并提示。</p>
                </div>
              ) : (
                <p className="field-hint">点击地图上的楼栋可选中并修改层数/层高、标记重点住户，或从下方列表选择。</p>
              )}
              {model.buildings.length ? (
                <div className="sub-panel">
                  <div className="sub-panel-head"><span>楼栋列表</span><span className="badge muted">{model.buildings.length}</span></div>
                  <div className="rail-list" style={{ maxHeight: 200, overflowY: 'auto' }}>
                    {model.buildings.map((b) => (
                      <button
                        key={b.id}
                        className={`rail-list-row ${props.selectedBuilding?.id === b.id ? 'is-selected' : ''}`}
                        onClick={() => actions.selectBuilding(b.id)}
                        title={`${b.name} · ${b.floors} 层 × ${b.floorHeightM} 米`}
                      >
                        <span>{b.name}</span>
                        <span className="rail-list-badges">
                          {(b.vulnerable ?? 0) > 0 ? <span className="badge warm">重点 {b.vulnerable}</span> : null}
                          <span className="badge muted">{b.floors} 层 · {Math.round(b.floors * b.floorHeightM)} 米</span>
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
            <div className="rail-step-body stack-sm">
              <div className="btn-group">
                <button className={`btn sm ${props.netMode === 'gate' ? 'is-active' : ''}`} aria-pressed={props.netMode === 'gate'} onClick={() => actions.setNetMode(props.netMode === 'gate' ? 'idle' : 'gate')}>标大门</button>
                <button className={`btn sm ${props.netMode === 'staging' ? 'is-active' : ''}`} aria-pressed={props.netMode === 'staging'} onClick={() => actions.setNetMode(props.netMode === 'staging' ? 'idle' : 'staging')}>标接驳点</button>
                <button className={`btn sm ${props.netMode === 'road' ? 'is-active' : ''}`} aria-pressed={props.netMode === 'road'} onClick={() => actions.setNetMode(props.netMode === 'road' ? 'idle' : 'road')}>画路段</button>
              </div>
              {props.netMode === 'gate' || props.netMode === 'staging' ? (
                <div className="row-between">
                  <span className="field-hint">{props.netMode === 'gate' ? `标记大门中 · ${model.net.gates.length} 处` : `标记接驳点中 · ${model.net.staging.length} 处`}</span>
                  <button className="btn sm" onClick={() => actions.setNetMode('idle')}>结束标记</button>
                </div>
              ) : null}
              {props.netMode === 'road' ? (
                <div className="stack-sm">
                  <div className="fence-live" data-testid="road-live">
                    <span><b>{props.roadDraftCount}</b> 个端点</span>
                    <span>{props.roadDraftCount >= 2 ? '可完成路段' : '继续点击添加端点'}</span>
                  </div>
                  <div className="row">
                    <button className="btn sm" onClick={actions.finishRoad} disabled={props.roadDraftCount < 2}>完成路段</button>
                    <button className="btn sm ghost" onClick={actions.undoRoadPoint} disabled={props.roadDraftCount === 0}>取消点</button>
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
              <p className="field-hint">内部配送只走这里确认的路段，不使用高德导航替代；楼间空隙不会被当成道路。</p>
            </div>
          ) : null}
        </section>

      </div>
    </aside>

      <footer className="rail-foot editor-actions" aria-label="社区保存与确认">
        <button className="btn primary block rail-cta" onClick={actions.confirmCommunity} disabled={props.busy} data-testid="confirm-community">
          确认社区并进入指挥台
        </button>
        <div className="row-between">
          <button className="btn sm ghost" onClick={actions.exportJson}>导出社区 JSON</button>
          <span className="autosave" title="所有改动实时写入浏览器本地存储">
            <span className="autosave-dot" aria-hidden />
            已自动保存 {savedTimeLabel(model.updatedAt)}
          </span>
        </div>
      </footer>
    </>
  )
}

