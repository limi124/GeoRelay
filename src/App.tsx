import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import brandIcon from '../assets/brand/icon.svg'
import type { CommunityModel, BatchOptions } from './domain/community/model.ts'
import {
  addGate,
  addRoad,
  addStaging,
  confirmRoads,
  createEmptyModel,
  generateBuildings,
  makeFence,
  moveBuilding,
  removeBuilding,
  rotateBuilding,
  suggestNetwork,
  touch,
  updateBuilding,
  validateFence,
  validateNetwork,
  makeRectFence,
  fenceCenter,
  polygonPerimeterM,
} from './domain/community/operations.ts'
import type { LngLat } from './domain/geo/types.ts'
import { offsetMeters } from './domain/geo/wgs84.ts'
import type { MapAdapter, BuildingSpec, MarkerSpec, PolygonSpec, PlanLineStyle } from './map/types.ts'
import { createFallbackAdapter } from './map/fallback.ts'
import { createAmapAdapter } from './map/amap.ts'
import { EditorSidebar } from './ui/EditorSidebar.tsx'
import { FenceToolbar } from './ui/FenceToolbar.tsx'
import { ConsoleSidebar } from './ui/ConsoleSidebar.tsx'
import { ViewPanel } from './ui/ViewPanel.tsx'
import { engineLabel } from './ui/modelRunLabel.ts'
import type { ConsoleUiState } from './ui/ConsoleSidebar.tsx'
import type { AiQuestion } from './services/lbsClient.ts'
import { requestAiAnalysis } from './services/lbsClient.ts'
import type { AiUiState } from './ui/AiPanel.tsx'
import type { DisasterKind } from './domain/sim/types.ts'
import type { ImpactEvent } from './domain/disaster/types.ts'
import { DRILL_PRESETS, presetById } from './domain/sim/presets.ts'
import { modelBundleOf, modelRunsFor } from './domain/modelrun/registry.ts'
import './index.css'
import { buildAiPayload, relevantPlanSets, validateAiRefs } from './domain/sim/aiContext.ts'
import { buildPresetCommunity } from './domain/community/demo.ts'
import type { ReplayEntry } from './domain/sim/replay.ts'
import { relayViewOf } from './domain/sim/relay.ts'
import {
  advance,
  agentPosition,
  confirmCandidate,
  createEngine,
  floodedAt,
  orderEvacuation,
  planRoads,
  proposeCandidates,
  rankPlanSet,
  resetEngine,
  type Engine,
} from './domain/sim/engine.ts'
import { RuleRanker } from './domain/sim/ranker.ts'
import { LearningRanker } from './domain/sim/learningRanker.ts'
import { DISPATCH_REWARDS } from './domain/sim/dispatchRewards.ts'
import { SampleExternalProvider, AmapExternalProvider } from './domain/routing/external.ts'
import { demoInventory } from './domain/sim/scenario.ts'
import { fetchServerStatus, RemoteLbsClient, requestAiExplanation } from './services/lbsClient.ts'
import { SampleLbsClient } from './domain/lbs/sample.ts'
import { fromLocal } from './domain/community/frame.ts'
import type { InventoryPoint, PlanSet } from './domain/sim/types.ts'
import type { Pharmacy } from './domain/lbs/types.ts'
import { formatSimTime } from './domain/sim/clock.ts'
import { SandboxView } from './ui/SandboxView.tsx'
import { SandboxHud } from './ui/SandboxHud.tsx'
import { ResiliencePanel } from './ui/ResiliencePanel.tsx'
import { PreventionPanel } from './ui/PreventionPanel.tsx'
import { assessPrevention } from './domain/community/prevention.ts'
import { EvacuationPanel } from './ui/EvacuationPanel.tsx'
import { analyzeResilience } from './domain/community/analysis.ts'
import { buildingUrgency, pickCandidate, type CommunityArrival, type SandboxLayer } from './sandbox/scene.ts'
import { estimatedResidents, rescueQueue } from './domain/sim/evacuation.ts'

const STORAGE_KEY = 'georelay.community.v2'
const DEFAULT_CENTER: LngLat = [121.4737, 31.2304]
/** 双击的第二下之前会先派发一次 click：顶点先挂在这个定时器上，收到 dblclick 就撤掉 */
const CLICK_COMMIT_MS = 260

function replaceCommunityFence(model: CommunityModel, fence: CommunityModel['fence']): CommunityModel {
  return touch({ ...model, fence, buildings: [], net: { gates: [], staging: [], roads: [] } })
}

function isAgentPlanning(engine: Engine): boolean {
  const phase = engine.planning?.stage
  return phase === 'impact' || phase === 'routes' || phase === 'rank'
}

type Mode = 'edit' | 'console'
type FenceMode = 'off' | 'draw' | 'edit'
type NetMode = 'idle' | 'gate' | 'staging' | 'road'
export type ViewMode = 'global' | 'internal' | 'external'

interface Notice {
  kind: 'info' | 'warn' | 'error' | 'ok'
  text: string
  /** 可选操作按钮（如删除后的「撤销」） */
  action?: { label: string; run: () => void }
}

function cloneCommunity(m: CommunityModel): CommunityModel {
  // 社区模型是纯数据（坐标/楼栋/路网），深拷贝一份作为「我的社区」副本，
  // 预置演练只玩这份副本，绝不写回用户自己的存储。
  return JSON.parse(JSON.stringify(m)) as CommunityModel
}

function loadStored(): CommunityModel | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CommunityModel
    if (!parsed || parsed.version !== 2 || !Array.isArray(parsed.fence?.polygon)) return null
    return parsed
  } catch {
    return null
  }
}

export default function App(): React.ReactElement {
  const mapHostRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapAdapter | null>(null)
  const engineRef = useRef<Engine | null>(null)
  /** 进入预置/算例演练前，用户自己那份社区的快照；「返回我的社区」用它恢复 */
  const userCommunityRef = useRef<CommunityModel | null>(null)
  /** 上一场演练所用社区版本：回到建模改过社区再确认时，用来提示「将开始新演练」 */
  const lastDrillVersionRef = useRef<string | null>(null)
  const lastTickRef = useRef<number>(0)
  const rafRef = useRef<number>(0)
  /** 画围栏时挂起的「单击加点」定时器：双击会把它撤掉，避免双击多出顶点 */
  const pendingVertexRef = useRef<number | null>(null)
  const pendingPointRef = useRef<LngLat | null>(null)
  useEffect(() => () => {
    if (pendingVertexRef.current !== null) window.clearTimeout(pendingVertexRef.current)
  }, [])

  const [mapKind, setMapKind] = useState<'amap' | 'fallback'>('fallback')
  const [mapError, setMapError] = useState<string | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const [mode, setMode] = useState<Mode>('edit')
  const [model, setModel] = useState<CommunityModel>(() => loadStored() ?? createEmptyModel(DEFAULT_CENTER, '我的社区'))
  const [fenceMode, setFenceMode] = useState<FenceMode>('off')
  const [draft, setDraft] = useState<LngLat[]>([])
  const [hover, setHover] = useState<LngLat | null>(null)
  /** 矩形围栏模式：第一次点击定角点，第二次点击成矩形 */
  const [rectMode, setRectMode] = useState(false)
  const [rectAnchor, setRectAnchor] = useState<LngLat | null>(null)
  const [netMode, setNetMode] = useState<NetMode>('idle')
  const [roadDraft, setRoadDraft] = useState<LngLat[]>([])
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | null>(null)
  const [selectedRoadId, setSelectedRoadId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [basemapVisible, setBasemapVisible] = useState(true)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const [view, setView] = useState<ViewMode>('global')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedPlanSetId, setSelectedPlanSetId] = useState<string | null>(null)
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null)
  const [inventory, setInventory] = useState<InventoryPoint[]>([])
  const [aiText, setAiText] = useState<string | null>(null)
  const [aiMode, setAiMode] = useState<'rules' | 'ai'>('rules')
  const dispatchRanker = useRef<RuleRanker | LearningRanker>(new RuleRanker())
  const [lbsMode, setLbsMode] = useState<'amap' | 'sample'>('sample')
  const [status, setStatus] = useState<{ amap: string; ai: string }>({ amap: '检测中…', ai: '检测中…' })
  const [disasterKind, setDisasterKind] = useState<DisasterKind>('flood')
  const [selectedImpactId, setSelectedImpactId] = useState<string | null>(null)
  const [preventionOpen, setPreventionOpen] = useState(false)
  const [activePresetId, setActivePresetId] = useState<string | null>(null)
  /** 预置场景模式：不把预置社区写回用户保存的模型 */
  const [presetMode, setPresetMode] = useState(false)
  const [replaySelectedId, setReplaySelectedId] = useState<string | null>(null)
  const [ai, setAi] = useState<AiUiState>({ busy: false, question: null, analysis: null, rejected: [], error: null })

  const engine = engineRef.current
  const selectedBuilding = model.buildings.find((b) => b.id === selectedBuildingId) ?? null
  const fenceValidation = useMemo(() => validateFence(fenceMode === 'off' ? model.fence.polygon : draft), [fenceMode, draft, model.fence.polygon])
  const fenceDirty = fenceMode === 'draw' || (fenceMode === 'edit' && JSON.stringify(draft) !== JSON.stringify(model.fence.polygon))
  const netValidation = useMemo(() => validateNetwork(model), [model])

  // ---------------- 持久化 ----------------
  useEffect(() => {
    // 预置场景用的是社区副本，不覆盖用户自己保存的社区模型
    if (presetMode) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(model))
    } catch {
      // 存储不可用（隐私模式）时不影响演练
    }
  }, [model, presetMode])

  // ---------------- 服务能力探测 ----------------
  useEffect(() => {
    void (async () => {
      const s = await fetchServerStatus()
      if (!s) {
        setStatus({ amap: '本地服务未启动（使用示例地图与示例路线）', ai: '规则模式' })
        setLbsMode('sample')
        return
      }
      setStatus({
        amap: s.amap.webKeyConfigured ? (s.amap.securityCodeConfigured ? '高德 JS API 已配置（含安全密钥代理）' : '高德 Key 已配置，但缺少 AMAP_SECURITY_JS_CODE') : '未配置高德 Key → 示例地图',
        ai: s.ai.enabled ? `AI 接口已配置（${s.ai.model ?? ''}）` : '规则模式（未配置 AI 接口）',
      })
      setAiMode(s.ai.enabled ? 'ai' : 'rules')
      setLbsMode(s.amap.webKeyConfigured ? 'amap' : 'sample')
    })()
  }, [])

  // ---------------- 地图初始化（只创建一次） ----------------
  useEffect(() => {
    const controller = new AbortController()
    const host = mapHostRef.current
    if (!host) return
    void (async () => {
      const center = model.center
      const amap = await createAmapAdapter(host, { center, zoom: 18.3, intro: true, signal: controller.signal })
      if (controller.signal.aborted) {
        amap.adapter?.destroy()
        return
      }
      let adapter = amap.adapter
      if (!adapter) {
        setMapError(amap.error ?? null)
        adapter = createFallbackAdapter(host, { center, zoom: 16 })
      }
      mapRef.current = adapter
      if (import.meta.env.DEV) (window as unknown as { __geoMap?: MapAdapter }).__geoMap = adapter
      setMapKind(adapter.kind)
      setMapReady(true)
    })()
    return () => {
      controller.abort()
      mapRef.current?.destroy()
      mapRef.current = null
    }
    // 地图实例整个会话只创建一次：进入指挥台不重建，只改图层与相机
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------- 地图事件 ----------------
  useEffect(() => {
    const adapter = mapRef.current
    if (!adapter) return
    adapter.setEvents({
      collectingPoints: mode === 'edit' && (fenceMode === 'draw' || netMode !== 'idle'),
      onClick: (p) => {
        if (fenceMode === 'draw') {
          // 矩形围栏：两次点击直接成矩形，不走逐点草稿
          if (rectMode) {
            if (!rectAnchor) {
              setRectAnchor(p)
              setNotice({ kind: 'info', text: '已定矩形第一个角点，再点一次对角位置完成围栏' })
            } else {
              const a = rectAnchor
              const corners: LngLat[] = [[a[0], a[1]], [p[0], a[1]], [p[0], p[1]], [a[0], p[1]]]
              setRectAnchor(null)
              setRectMode(false)
              setDraft(corners)
              finishFence(corners)
            }
            return
          }
          // 点回起点吸附闭合：屏幕上足够接近第一个顶点就直接收尾
          if (draft.length >= 3 && nearFirstVertex(p)) {
            cancelPendingVertex()
            finishFence()
            return
          }
          commitVertexLater(p)
        } else handleMapClick(p)
      },
      onDblClick: () => {
        // 双击的两下不算顶点：撤掉挂起的加点，直接结束并保存围栏
        cancelPendingVertex()
        if (fenceMode === 'draw') finishFence()
      },
      onMouseMove: (p) => {
        if (fenceMode === 'draw') setHover(p)
      },
      onVertexDragEnd: (index, p) => {
        setDraft((prev) => prev.map((v, i) => (i === index ? p : v)))
      },
      onVertexInsert: (index, p) => {
        setDraft((prev) => [...prev.slice(0, index + 1), p, ...prev.slice(index + 1)])
        setNotice({ kind: 'ok', text: '已在边上插入新顶点，可拖动调整' })
      },
      onVertexDelete: (index) => {
        if (draft.length <= 3) {
          setNotice({ kind: 'warn', text: '围栏至少需要 3 个顶点，不能再删' })
          return
        }
        setDraft((prev) => prev.filter((_, j) => j !== index))
      },
      onBuildingDragEnd: (id, p) => {
        const r = moveBuilding(model, id, p)
        if (r.errors.length) setNotice({ kind: 'error', text: `不能移动：${r.errors.join('；')}` })
        else {
          setModel(r.model)
          setNotice(null)
        }
      },
      onBuildingClick: (id) => setSelectedBuildingId(id),
      onRoadClick: (id) => {
        setSelectedRoadId(id)
        if (mode === 'console') setView((v) => v)
      },
      onMarkerClick: (id, kind) => {
        if (kind === 'gate' || kind === 'staging') setNotice({ kind: 'info', text: `已选中${kind === 'gate' ? '大门' : '接驳点'} ${id}` })
      },
      onCameraChange: () => undefined,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, fenceMode, draft, model, mode, netMode, rectMode, rectAnchor])

  // ---------------- 围栏快捷键 ----------------
  useEffect(() => {
    if (mode !== 'edit' || (fenceMode === 'off' && netMode === 'idle')) return
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (netMode !== 'idle') {
        if (e.key === 'Escape') {
          e.preventDefault()
          setNetMode('idle')
          setRoadDraft([])
        }
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        finishFence()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        cancelFence()
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && fenceMode === 'draw') {
        e.preventDefault()
        undoVertex()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, fenceMode, draft, model, netMode])

  // ---------------- 时钟循环 ----------------
  const pendingAdvance = useRef<Engine['state'] | null>(null)
  const pendingAi = useRef<Engine['state'] | null>(null)
  const rescueAnalysisBusy = useRef<Engine['state'] | null>(null)

  async function advanceDrill(eng: Engine, seconds: number): Promise<void> {
    const state = eng.state
    if (pendingAdvance.current === state || pendingAi.current === state || rescueAnalysisBusy.current === state || isAgentPlanning(eng)) return
    pendingAdvance.current = state
    const refresh = (): void => {
      if (engineRef.current === eng) setTick((t) => t + 1)
    }
    try {
      await advance(eng, seconds, refresh)
    } catch (error) {
      if (engineRef.current === eng && eng.state === state) setNotice({ kind: 'warn', text: `候选生成中断：${(error as Error).message}` })
    } finally {
      if (pendingAdvance.current === state) pendingAdvance.current = null
      refresh()
    }
  }

  useEffect(() => {
    if (mode !== 'console' || !engine) return
    engine.onPlanning = async (active) => {
      setTick((value) => value + 1)
      if (active) await new Promise<void>((resolve) => window.setTimeout(resolve, 360))
    }
    lastTickRef.current = performance.now()
    const loop = () => {
      const now = performance.now()
      const dtReal = Math.min(0.5, (now - lastTickRef.current) / 1000)
      lastTickRef.current = now
      const eng = engineRef.current
      if (eng && eng.state.clock.running && eng.state.status === 'running') {
        void advanceDrill(eng, dtReal * eng.state.clock.speed)
      }
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => {
      engine.onPlanning = undefined
      cancelAnimationFrame(rafRef.current)
    }
  }, [mode, engine])

  // ---------------- 图层同步 ----------------
  useEffect(() => {
    const adapter = mapRef.current
    if (!adapter || !mapReady) return
    const fencePath = fenceMode === 'off' ? model.fence.polygon : draft
    const si = fenceMode !== 'off' && fenceValidation?.selfIntersection
    const adapterForSnap = fenceMode === 'draw' && hover && draft.length >= 3 && mapRef.current?.debugProject ? mapRef.current : null
    let snapFirst = false
    if (adapterForSnap?.debugProject) {
      const a = adapterForSnap.debugProject(hover as LngLat)
      const b = adapterForSnap.debugProject(draft[0])
      snapFirst = Math.hypot(a[0] - b[0], a[1] - b[1]) <= 14
    }
    adapter.addFenceEditor({
      mode: fenceMode === 'draw' ? 'draw' : fenceMode === 'edit' ? 'edit' : 'off',
      draft: fencePath,
      hoverPoint: hover,
      closed: fenceMode !== 'draw',
      invalidPoint: null,
      invalidEdges: si ? [[si.indexA, si.indexB]] : undefined,
      snapFirst,
      rectAnchor: fenceMode === 'draw' ? rectAnchor : null,
    })
  }, [mapReady, fenceMode, draft, hover, model.fence.polygon, fenceValidation, rectAnchor])

  useEffect(() => {
    const adapter = mapRef.current
    if (!adapter || !mapReady) return
    const specs: BuildingSpec[] = model.buildings.map((b) => ({
      id: b.id,
      footprint: b.footprint.map((p) => fromLocal({ origin: model.fence.polygon[0] ?? DEFAULT_CENTER, mxPerDegLng: lngMeters(model.center[1]), myPerDegLat: 110574 }, p)),
      heightM: b.floors * b.floorHeightM,
      floors: b.floors,
      selected: b.id === selectedBuildingId,
      highlight: b.id === selectedBuildingId ? 'selected' : 'none',
      label: b.name,
      draggable: mode === 'edit',
      style: b.style,
    }))
    adapter.setBuildings(specs, true)
    adapter.setBasemapBuildings(mode === 'console' || basemapVisible)
  }, [mapReady, model.buildings, model.fence.polygon, model.center, selectedBuildingId, mode, basemapVisible])

  useEffect(() => {
    const adapter = mapRef.current
    if (!adapter || !mapReady) return
    const polygons: PolygonSpec[] = []
    if (model.fence.polygon.length >= 3) {
      polygons.push({ id: 'fence', path: model.fence.polygon, fill: '#C3F477', stroke: '#C3F477', opacity: 0.10, strokeWidth: 2.5, dashed: false, lineHeight: 26 })
    }
    adapter.setPolygons(polygons)
  }, [mapReady, model.fence.polygon])

  useEffect(() => {
    const adapter = mapRef.current
    if (!adapter || !mapReady) return
    const eng = engineRef.current
    const closed = mode === 'console' && eng ? new Set(Object.keys(eng.state.closures)) : new Set<string>()
    const roads = model.net.roads.map((r) => ({
      id: r.id,
      path: r.points.map((p) => (Array.isArray(p) ? p : ([p.lng, p.lat] as LngLat))),
      style: closed.has(r.id) ? ('closed' as const) : r.status === 'suggested' ? ('suggested' as const) : ('open' as const),
    }))
    if (roadDraft.length >= 2) roads.push({ id: 'draft-road', path: roadDraft, style: 'suggested' })
    adapter.setRoads(roads)
  }, [mapReady, model.net.roads, roadDraft, tick, mode])

  useEffect(() => {
    const adapter = mapRef.current
    if (!adapter || !mapReady) return
    const markers: MarkerSpec[] = []
    const frame = { origin: model.fence.polygon[0] ?? DEFAULT_CENTER, mxPerDegLng: lngMeters(model.center[1]), myPerDegLat: 110574 }
    for (const g of model.net.gates) markers.push({ id: g.id, lngLat: g.lngLat, kind: 'gate', label: g.name, size: 'md' })
    for (const s of model.net.staging) markers.push({ id: s.id, lngLat: s.lngLat, kind: 'staging', label: s.name, size: 'md' })
    if (mode === 'console') {
      for (const b of model.buildings) {
        markers.push({ id: `ent-${b.id}`, lngLat: fromLocal(frame, b.entrance.doorPoint), kind: 'entrance', label: undefined, size: 'sm' })
      }
      for (const ph of inventory) markers.push({ id: ph.id, lngLat: ph.lngLat, kind: 'pharmacy', label: `${ph.name}（演练库存）`, size: 'md' })
      const eng = engineRef.current
      if (eng) {
        const shownAgents = new Set<string>()
        const activeAssignments = Object.entries(eng.state.assignments).sort(([a, ap], [b, bp]) => {
          const aFinished = eng.state.plans[ap]?.phase === 'delivered'
          const bFinished = eng.state.plans[bp]?.phase === 'delivered'
          return Number(aFinished) - Number(bFinished) || Number(b === selectedTaskId) - Number(a === selectedTaskId)
        })
        for (const [taskId, planId] of activeAssignments) {
          const plan = eng.state.plans[planId]
          if (!plan) continue
          const pos = plan.phase === 'internal_ready' && plan.legs.internal?.path[0]
            ? { lngLat: plan.legs.internal.path[0], leg: 'internal' as const }
            : plan.phase === 'external_arrived' && plan.legs.external?.path.at(-1)
              ? { lngLat: plan.legs.external.path.at(-1)!, leg: 'external' as const }
              : agentPosition(eng, plan)
          const task = eng.state.tasks.find((t) => t.id === taskId)
          const relayState =
            plan.phase === 'blocked'
              ? ('blocked' as const)
              : plan.phase === 'external_enroute'
                ? ('pending_arrival' as const)
                : plan.phase === 'handover_wait' || plan.phase === 'pickup_wait'
                  ? ('pending_handover' as const)
                  : plan.phase === 'delivered'
                    ? ('delivered' as const)
                    : ('relayed' as const)
          const rv = relayViewOf(plan, eng.state.tasks, eng.state.agents)
          const relayCarrier = eng.state.agents.find((a) => a.id === plan.carryAgentId)
          if (rv?.isRelay && relayCarrier?.role === 'internal' && relayCarrier.id !== plan.agentId && !rv.internalStarted && pos.leg === 'external' && !shownAgents.has(plan.carryAgentId)) {
            shownAgents.add(plan.carryAgentId)
            const staging = eng.view.model.net.staging.find((x) => x.name === rv.stagingLabel)
            const internalPos = staging?.lngLat ?? pos.lngLat
            markers.push({
              id: `agent-wait-${plan.id}`,
              lngLat: internalPos,
              kind: 'agent-internal',
              label: `${relayCarrier.name} · 等待交接`,
              relayState: 'pending_handover',
              selected: selectedTaskId === taskId,
              size: 'sm',
            })
          }
          const carrierId = pos.leg === 'external' ? plan.agentId : plan.carryAgentId
          const carrier = eng.state.agents.find((a) => a.id === carrierId)
          if (carrier && !shownAgents.has(carrierId)) {
            shownAgents.add(carrierId)
            const statusLabel = plan.phase === 'blocked' ? '受阻待援' : plan.phase === 'delivered' ? '已送达' : plan.phase === 'external_arrived' ? '已到入口' : plan.phase === 'pickup_wait' ? '取货中' : pos.leg === 'external' ? '前往社区' : plan.phase === 'handover_wait' || plan.phase === 'internal_ready' ? '交接中' : '配送中'
            markers.push({
              id: `agent-${carrierId}`,
              lngLat: pos.lngLat,
              kind: carrier.role === 'external' ? 'agent-external' : 'agent-internal',
              label: `${carrier.name} · ${statusLabel}${task ? ` · ${task.code}` : ''}`,
              relayState,
              selected: selectedTaskId === taskId,
              size: 'lg',
            })
          }
        }
        for (const agent of eng.state.agents) {
          if (shownAgents.has(agent.id)) continue
          const staging = eng.view.model.net.staging.find((s) => `staging:${s.id}` === agent.stagingNodeKey)
          markers.push({ id: agent.id, lngLat: agent.restingAt ?? staging?.lngLat ?? agent.origin ?? eng.view.model.center, kind: agent.role === 'external' ? 'agent-external' : 'agent-internal', label: `${agent.name} · 待命`, size: 'sm' })
        }
        for (const responder of eng.state.responders) {
          markers.push({ id: responder.id, lngLat: responder.position, kind: 'agent-firefighter', label: `${responder.name} · ${responder.status === 'arrived' ? '已到集结点' : '出警中 · 80 km/h（假设）'}`, size: 'lg' })
        }
        const arrivedGroups = new Map<string, { lngLat: LngLat; residents: number }>()
        const gateQueues = new Map<string, { lngLat: LngLat; residents: number }>()
        for (const group of eng.state.evacuation) {
          if (group.status === 'queued' || (!group.departed && group.status !== 'rescuing' && group.gateQueuedAt === undefined)) continue
          if (group.gateQueuedAt !== undefined) {
            const key = group.vertices[0]
            gateQueues.set(key, { lngLat: group.position, residents: (gateQueues.get(key)?.residents ?? 0) + group.residents })
            continue
          }
          if (group.status === 'arrived') {
            const key = group.position.join(',')
            const residents = (arrivedGroups.get(key)?.residents ?? 0) + group.residents
            arrivedGroups.set(key, { lngLat: group.position, residents })
            continue
          }
          const status = group.status === 'blocked' ? '待援' : group.status === 'rescuing' ? '专业转运' : group.departed ? '撤离在途' : '待出楼'
          markers.push({ id: `evac-${group.id}`, lngLat: group.position, kind: 'evacuation', label: `${group.residents} 人 · ${status}` })
        }
        for (const [key, group] of gateQueues) markers.push({ id: `gate-queue-${key}`, lngLat: group.lngLat, kind: 'evacuation', label: `排队 ${group.residents} 人` })
        for (const [key, group] of arrivedGroups) {
          markers.push({ id: `assembly-${key}`, lngLat: group.lngLat, kind: 'evacuation', label: `${group.residents} 人 · 已到集结点` })
        }
      }
    }
    adapter.setMarkers(markers)
  }, [mapReady, model.net.gates, model.net.staging, model.buildings, mode, inventory, tick, selectedTaskId, model.center, model.fence.polygon])

  // 路线与积水（指挥台）
  useEffect(() => {
    const adapter = mapRef.current
    if (!adapter || !mapReady) return
    const eng = engineRef.current
    if (!eng || mode !== 'console') {
      adapter.setRoutes([])
      adapter.setFlood([])
      return
    }
    const routes: Array<{ id: string; path: LngLat[]; style: PlanLineStyle; label?: string }> = []
    for (const [taskId, planId] of Object.entries(eng.state.assignments)) {
      const plan = eng.state.plans[planId]
      if (!plan) continue
      const task = eng.state.tasks.find((t) => t.id === taskId)
      const style = plan.phase === 'blocked' ? 'rejected' : plan.phase === 'delivered' ? 'baseline' : 'approved'
      if (plan.legs.internal) routes.push({ id: `${plan.id}-int`, path: plan.legs.internal.path, style, label: taskId === selectedTaskId ? `${task?.code ?? ''} 内部路线` : undefined })
      if (plan.legs.external && view !== 'internal') routes.push({ id: `${plan.id}-ext`, path: plan.legs.external.path, style, label: taskId === selectedTaskId ? `${task?.code ?? ''} 外部路线` : undefined })
    }
    // 选中改派时补画“原路线”：被替换掉的旧方案用 baseline 线型，与新方案（approved）成对出现
    if (selectedPlanSetId) {
      const targetTaskIds = new Set(
        Object.values(eng.state.planSets[selectedPlanSetId]?.candidates ?? []).map((c) => c.taskId),
      )
      for (const plan of Object.values(eng.state.plans)) {
        if (!plan.supersededBy || !targetTaskIds.has(plan.taskId)) continue
        const task = eng.state.tasks.find((x) => x.id === plan.taskId)
        if (plan.legs.internal) routes.push({ id: `old-${plan.id}-int`, path: plan.legs.internal.path, style: 'baseline', label: `${task?.code ?? ''} 原路线` })
        if (plan.legs.external && view !== 'internal') routes.push({ id: `old-${plan.id}-ext`, path: plan.legs.external.path, style: 'baseline', label: `${task?.code ?? ''} 原路线` })
      }
    }
    const planSet = selectedPlanSetId ? eng.state.planSets[selectedPlanSetId] : null
    if (planSet) {
      for (const c of planSet.candidates) {
        if (c.id !== selectedCandidateId || planSet.confirmedCandidateId) continue
        if (c.internal?.path.length) routes.push({ id: `${c.id}-int`, path: c.internal.path, style: 'pending', label: `${c.feasible ? '候选' : '不可行'}` })
        if (c.external?.path.length && view !== 'internal') routes.push({ id: `${c.id}-ext`, path: c.external.path, style: c.feasible ? 'pending' : 'rejected' })
      }
    }
    for (const responder of eng.state.responders) {
      if (responder.status !== 'arrived' || view === 'external') routes.push({ id: `response-${responder.id}`, path: responder.path, style: 'response', label: '消防出警模拟路线' })
    }
    for (const group of eng.state.evacuation) {
      if (group.status !== 'moving' || !group.departed || group.gateQueuedAt !== undefined) continue
      const path = [group.position]
      for (const id of group.vertices.slice(1)) {
        const node = eng.view.router.verts.byId.get(id)
        if (node) path.push(fromLocal(eng.view.router.verts.frame, node.pos))
      }
      if (group.assembly) path.push(group.assembly)
      routes.push({ id: `evac-${group.id}`, path, style: 'evacuation' })
    }
    adapter.setRoutes(routes)
    const flood = floodedAt(eng).map((f, i) => ({
      id: `${f.roadId}-${i}`,
      path: [fromLocal(eng.view.router.verts.frame, f.a), fromLocal(eng.view.router.verts.frame, f.b)],
      depthM: f.depthM,
    }))
    adapter.setFlood(flood)
  }, [mapReady, tick, mode, view, selectedPlanSetId, selectedCandidateId, selectedTaskId, engine])

  // ---------------- 编辑动作 ----------------
  /** 屏幕上是否足够接近起点（≤14px）：用于“点回起点闭合”的吸附判定 */
  function nearFirstVertex(p: LngLat): boolean {
    const adapter = mapRef.current
    if (!adapter?.debugProject || !draft.length) return false
    const a = adapter.debugProject(p)
    const b = adapter.debugProject(draft[0])
    return Math.hypot(a[0] - b[0], a[1] - b[1]) <= 14
  }

  function commitVertexLater(p: LngLat): void {
    const previous = pendingPointRef.current
    if (previous && mapRef.current?.debugProject) {
      const a = mapRef.current.debugProject(previous)
      const b = mapRef.current.debugProject(p)
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 14) setDraft((prev) => [...prev, previous])
    }
    cancelPendingVertex()
    pendingPointRef.current = p
    pendingVertexRef.current = window.setTimeout(() => {
      pendingVertexRef.current = null
      pendingPointRef.current = null
      setDraft((prev) => [...prev, p])
    }, CLICK_COMMIT_MS)
  }

  function cancelPendingVertex(): void {
    if (pendingVertexRef.current !== null) {
      window.clearTimeout(pendingVertexRef.current)
      pendingVertexRef.current = null
    }
    pendingPointRef.current = null
  }

  function undoVertex(): void {
    if (pendingPointRef.current) {
      cancelPendingVertex()
      return
    }
    setDraft((prev) => prev.slice(0, -1))
  }

  function startFence(): void {
    cancelPendingVertex()
    setNetMode('idle')
    setRoadDraft([])
    setFenceMode('draw')
    setDraft([])
    setRectMode(false)
    setRectAnchor(null)
    setNotice({ kind: 'info', text: '在地图上依次点击顶点，双击或点回起点结束绘制' })
  }

  function selectLocation(p: LngLat, label: string): void {
    if (!model.fence.polygon.length) setModel((m) => touch({ ...m, center: p, address: label }))
  }

  const handleMapClick = useCallback(
    (p: LngLat) => {
      if (mode === 'console') return
      if (fenceMode === 'draw') {
        setDraft((prev) => [...prev, p])
        return
      }
      if (netMode === 'gate') {
        setModel((m) => addGate(m, p))
        return
      }
      if (netMode === 'staging') {
        setModel((m) => addStaging(m, p))
        return
      }
      if (netMode === 'road') {
        setRoadDraft((prev) => [...prev, p])
        return
      }
      setSelectedBuildingId(null)
      if (!model.fence.polygon.length && fenceMode === 'off') {
        setModel((m) => touch({ ...m, center: p, address: '地图手动选址' }))
        setNotice({ kind: 'ok', text: '已选择社区位置，可开始绘制围栏' })
      }
    },
    [mode, fenceMode, netMode, model.fence.polygon.length],
  )

  /** 把当前社区存成「我的社区」快照：只在还没进入预置模式时记录，避免用预置副本覆盖快照 */
  function snapshotUserCommunity(): void {
    if (presetMode && userCommunityRef.current) return
    const mine = loadStored() ?? model
    userCommunityRef.current = cloneCommunity(mine)
  }

  /** 退出预置模式：把用户自己的社区原样放回来（不能把预置副本留在 state 里被持久化） */
  function leavePresetMode(): void {
    if (!presetMode) return
    const mine = userCommunityRef.current ?? loadStored()
    setPresetMode(false)
    setActivePresetId(null)
    if (mine) {
      setModel(cloneCommunity(mine))
      setDraft([])
      setFenceMode('off')
      setNetMode('idle')
      const adapter = mapRef.current
      if (adapter && mine.fence.polygon.length >= 3) adapter.fitBounds(mine.fence.polygon, 80)
    }
  }

  /** 「返回我的社区」：结束预置演练，回到用户自己建好的社区继续编辑（不丢、不覆盖） */
  function returnToMyCommunity(): void {
    const mine = userCommunityRef.current ?? loadStored()
    if (!mine) {
      setPresetMode(false)
      setActivePresetId(null)
      setMode('edit')
      setNotice({ kind: 'warn', text: '还没有保存过自己的社区：先在建模页载入/绘制一个社区' })
      return
    }
    setPresetMode(false)
    setActivePresetId(null)
    engineRef.current = null
    setMode('edit')
    setConsoleView('sandbox')
    setDrawer(null)
    setModel(cloneCommunity(mine))
    setDraft([])
    setFenceMode('off')
    setNetMode('idle')
    setSelectedBuildingId(null)
    setSelectedTaskId(null)
    setSelectedPlanSetId(null)
    setSelectedCandidateId(null)
    setSelectedImpactId(null)
    setReplaySelectedId(null)
    setTick((v) => v + 1)
    const adapter = mapRef.current
    if (adapter && mine.fence.polygon.length >= 3) adapter.fitBounds(mine.fence.polygon, 80)
    setNotice({ kind: 'ok', text: `已回到「${mine.name}」：${mine.buildings.length} 栋楼 / ${mine.net.roads.length} 段路网，预置演练数据没有写回` })
  }

  /** 明确把当前预置社区「复制为我的社区」：需要二次确认覆盖 */
  function adoptPresetCommunity(): void {
    const mine = userCommunityRef.current ?? loadStored()
    const ok = window.confirm(
      mine && mine.buildings.length
        ? `这会用当前预置社区「${model.name}」替换你保存的「${mine.name}」（${mine.buildings.length} 栋楼）。替换后不可撤销，继续？`
        : '这会用当前预置社区替换你的社区存储，继续？',
    )
    if (!ok) return
    userCommunityRef.current = null
    setPresetMode(false)
    setActivePresetId(null)
    setMode('edit')
    setDraft([])
    setFenceMode('off')
    setNetMode('idle')
    setModel((m) => touch({ ...cloneCommunity(m), name: m.name }))
    setNotice({ kind: 'ok', text: '已把当前预置社区复制为你的社区（可继续编辑并保存）' })
  }

  function finishFence(points?: LngLat[]): void {
    const pending = pendingPointRef.current
    cancelPendingVertex()
    const path = points ?? (pending ? [...draft, pending] : draft)
    if (!points && pending) setDraft(path)
    // 校验不通过只报错：draft 与绘制模式都保持原样，页面不重置
    if (path.length < 3) {
      setNotice({ kind: 'error', text: '围栏至少需要 3 个顶点' })
      return
    }
    const v = validateFence(path)
    if (!v.ok) {
      setNotice({ kind: 'error', text: `围栏不可用：${v.errors.join('；')}` })
      return
    }
    leavePresetMode()
    setRectMode(false)
    setRectAnchor(null)
    const fence = makeFence(path)
    setDraft(fence.polygon)
    if (fenceMode === 'draw') {
      setSelectedBuildingId(null)
      setSelectedRoadId(null)
    }
    setModel((m) => {
      const center = fenceCenter(fence)
      const next = { ...m, center }
      if (fenceMode === 'draw') {
        if (m.fence.polygon.length) next.address = ''
        return replaceCommunityFence(next, fence)
      }
      return touch({ ...next, fence })
    })
    setFenceMode('edit')
    setNotice({ kind: 'ok', text: `围栏已确认：面积 ${Math.round(v.areaM2)} m²（顶点 ${path.length} 个），可拖动顶点微调` })
    const adapter = mapRef.current
    if (adapter) adapter.fitBounds(path, 80)
  }

  /** Esc / 工具条「退出」：放弃本次草稿；已保存过围栏就回到查看态，否则留在绘制态 */
  function cancelFence(): void {
    cancelPendingVertex()
    setRectMode(false)
    setRectAnchor(null)
    if (model.fence.polygon.length >= 3) {
      setFenceMode('off')
      setDraft([])
      setNotice({ kind: 'info', text: '已退出围栏编辑，保存的形状没有改动' })
    } else {
      setDraft([])
      setNotice({ kind: 'info', text: '已清空草稿顶点，可重新点击绘制' })
    }
  }

  function loadSampleCommunity(): void {
    cancelPendingVertex()
    setNetMode('idle')
    setRoadDraft([])
    leavePresetMode()
    const center = DEFAULT_CENTER
    const ring = makeRectFence(center, 150, 8)
    // 凹形：把东侧中间一个顶点向内推，形成 L 形缺口，用于演示凹多边形支持
    const concave = ring.map((p, i) => (i === 2 ? offsetMeters(center, -30, 40) : p))
    let next: CommunityModel = touch({ ...createEmptyModel(center, '演示社区'), fence: makeFence(concave), center })
    next = addGate(next, offsetMeters(center, -140, -20), '西门')
    next = addGate(next, offsetMeters(center, 70, 130), '北门')
    next = addStaging(next, offsetMeters(center, -20, 10), '中央接驳点')
    next = addStaging(next, offsetMeters(center, 40, 70), '北侧接驳点')
    const gen = generateBuildings(next, { count: 12, floors: 8, floorHeightM: 2.9, widthM: 22, depthM: 15, keepExisting: false, seed: 42 })
    if (!gen.ok) {
      setNotice({ kind: 'error', text: gen.message })
      return
    }
    next = suggestNetwork(gen.model)
    next = confirmRoads(next)
    setModel(next)
    setDraft([])
    setFenceMode('off')
    const adapter = mapRef.current
    if (adapter) adapter.fitBounds(concave, 80)
    setNotice({ kind: 'ok', text: '已载入演示社区（凹形围栏 + 12 栋楼 + 示例路网）' })
  }

  async function searchPlace(query: string): Promise<void> {
    if (!query.trim()) return
    setBusy(true)
    try {
      const sample = new SampleLbsClient(DEFAULT_CENTER, 42)
      const client = new RemoteLbsClient(sample, lbsMode === 'amap')
      const hit = await client.geocode(query)
      if (!hit) {
        setNotice({ kind: 'warn', text: `没有找到「${query}」。可以改用地图手动选址，或用「定位到我」。` })
        return
      }
      const adapter = mapRef.current
      adapter?.flyTo(hit.lngLat, 16.5, { durationMs: 600 })
      selectLocation(hit.lngLat, `${hit.formatted ?? query}${lbsMode === 'sample' ? '（示例定位）' : ''}`)
      setNotice({ kind: 'info', text: `已定位到：${hit.formatted ?? query}（${lbsMode === 'amap' ? '高德地理编码' : '示例定位，非真实搜索结果'}）${model.fence.polygon.length ? '；仅移动视角，已建社区未改变' : ''}` })
    } catch (err) {
      setNotice({ kind: 'error', text: `搜索失败：${(err as Error).message}。可重试或手动选址。` })
    } finally {
      setBusy(false)
    }
  }

  function locateMe(): void {
    if (!navigator.geolocation) {
      setNotice({ kind: 'error', text: '当前浏览器不支持定位。请用地址搜索或在地图上手动选址。' })
      return
    }
    setBusy(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setBusy(false)
        const p: LngLat = [pos.coords.longitude, pos.coords.latitude]
        mapRef.current?.flyTo(p, 17, { durationMs: 700 })
        selectLocation(p, '浏览器定位')
        setNotice({ kind: 'ok', text: `定位成功（精度约 ${Math.round(pos.coords.accuracy)} 米）${model.fence.polygon.length ? '；仅移动视角，已建社区未改变' : '，可在地图上继续画围栏'}` })
      },
      (err) => {
        setBusy(false)
        const reason =
          err.code === err.PERMISSION_DENIED
            ? '定位权限被拒绝：请在浏览器地址栏的权限设置里允许定位'
            : err.code === err.POSITION_UNAVAILABLE
              ? '定位信息不可用（系统定位服务关闭或无信号）'
              : '定位超时'
        setNotice({ kind: 'error', text: `${reason}。仍可用地址搜索或手动选址继续。` })
      },
      { enableHighAccuracy: true, timeout: 8000 },
    )
  }

  async function confirmCommunity(kind: DisasterKind = disasterKind): Promise<void> {
    if (fenceDirty || roadDraft.length) {
      setNotice({ kind: 'warn', text: '请先完成或取消当前围栏/路段草稿，再进入指挥台' })
      return
    }
    if (model.fence.polygon.length < 3) {
      setNotice({ kind: 'error', text: '还没有确认的围栏：请先绘制并确认电子围栏' })
      return
    }
    if (!model.buildings.length) {
      setNotice({ kind: 'error', text: '还没有楼栋：请先批量生成楼栋' })
      return
    }
    if (!netValidation.ok) {
      setNotice({ kind: 'error', text: `路网还不能确认：${netValidation.errors.join('；')}` })
      return
    }
    // 从指挥台返回建模后改了社区（楼栋/路网/围栏版本变了）再确认：上一场演练的记录与时钟不能复用，
    // 必须明确告诉用户「将开始新演练」，不能悄悄把两场演练混在一起。
    const lastVersion = lastDrillVersionRef.current
    if (lastVersion && lastVersion !== model.updatedAt) {
      const ok = window.confirm(
        '社区模型已修改（楼栋/路网版本已变化）。重新进入指挥台会开始一场新演练：演练时钟归零，上一场的确认与送达记录不会套用到新方案。继续？',
      )
      if (!ok) return
    }
    setBusy(true)
    try {
      const sample = new SampleLbsClient(model.center, 42)
      const client = new RemoteLbsClient(sample, lbsMode === 'amap')
      let list: Pharmacy[] = []
      try {
        list = await client.aroundSearch(model.center, 3000, '药店')
      } catch (err) {
        setNotice({ kind: 'warn', text: `周边搜索失败：${(err as Error).message}。改用示例药店继续演练（不是真实数据）。` })
        list = await sample.aroundSearch(model.center, 3000, '药店')
      }
      const inv = Object.values(demoInventory(list, 42))
      setInventory(inv)
      const provider = lbsMode === 'amap' && list.some((p) => p.source === 'amap')
        ? new AmapExternalProvider(client, (id) => list.find((p) => p.id === id)?.name ?? id)
        : new SampleExternalProvider((id) => inv.find((p) => p.id === id)?.name ?? id)
      const engineNew = createEngine({
        untilAllEvacuated: true,
        continueAfterEvacuation: true,
        community: model,
        seed: 42,
        pharmacies: inv,
        provider,
        ranker: dispatchRanker.current,
        startLabel: '08:00',
        disaster: kind,
      })
      engineRef.current = engineNew
      lastDrillVersionRef.current = model.updatedAt
      setDisasterKind(kind)
      communityViewRef.current = 'sandbox'
      setConsoleView('sandbox')
      setEntering(true)
      window.setTimeout(() => setEntering(false), 900)
      setMode('console')
      setView('global')
      setSelectedTaskId(engineNew.state.tasks[0]?.id ?? null)
      setSelectedPlanSetId(null)
      setSelectedCandidateId(null)
      setSelectedImpactId(null)
      setAi({ busy: false, question: null, analysis: null, rejected: [], error: null })
      const adapter = mapRef.current
      if (adapter) {
        const pts = [...model.fence.polygon, ...inv.map((p) => p.lngLat)]
        adapter.fitBounds(pts, 60)
      }
      setNotice({ kind: 'ok', text: `已进入指挥台：社区「${model.name}」版本已锁定（${model.buildings.length} 栋楼，${model.net.roads.length} 条路段）` })
    } finally {
      setBusy(false)
    }
  }

  /** 一键载入预置演练：固定社区副本 + 固定种子 + 固定灾种；不写回用户保存的社区模型 */
  async function loadPreset(id: string): Promise<void> {
    const preset = presetById(id)
    if (!preset) return
    const ok = window.confirm(`载入「${preset.title}」会开启新演练（固定种子 ${preset.seed}）。你保存的社区模型不会被覆盖。继续？`)
    if (!ok) return
    setBusy(true)
    try {
      snapshotUserCommunity()
      const community = buildPresetCommunity()
      setPresetMode(true)
      lastDrillVersionRef.current = community.updatedAt
      setModel(community)
      setActivePresetId(id)
      setDraft([])
      setFenceMode('off')
      setNetMode('idle')
      const sample = new SampleLbsClient(community.center, preset.seed)
      const list = await sample.aroundSearch(community.center, 3000, '药店')
      const inv = Object.values(demoInventory(list, preset.seed))
      setInventory(inv)
      const provider = new SampleExternalProvider((pid) => inv.find((p) => p.id === pid)?.name ?? pid)
      const engineNew = createEngine({
        untilAllEvacuated: true,
        continueAfterEvacuation: true,
        community,
        seed: preset.seed,
        pharmacies: inv,
        provider,
        ranker: dispatchRanker.current,
        startLabel: '08:00',
        durationS: preset.durationS,
        disaster: preset.disaster,
      })
      engineRef.current = engineNew
      setDisasterKind(preset.disaster)
      setMode('console')
      setView('global')
      setSelectedTaskId(engineNew.state.tasks[0]?.id ?? null)
      setSelectedPlanSetId(null)
      setSelectedCandidateId(null)
      setSelectedImpactId(null)
      setReplaySelectedId(null)
      setAi({ busy: false, question: null, analysis: null, rejected: [], error: null })
      const adapter = mapRef.current
      if (adapter) adapter.fitBounds([...community.fence.polygon, ...inv.map((p) => p.lngLat)], 60)
      setNotice({ kind: 'ok', text: `已载入预置演练「${preset.title}」` })
    } finally {
      setBusy(false)
    }
  }

  /**
   * 载入专业模型算例（FDS / OpenQuake 的缓存回放包）。
   *
   * 与「一键演练」同样的做法：用预置演练社区副本 + 固定种子开新演练，不写回用户保存的模型。
   * 区别只在灾情来源：`modelRun` 传给引擎后，事件由求解器输出 + 独立演练通行规则换算而来，
   * 后续可达性、候选生成、确认与送达完全复用既有流程（不写新的调度逻辑）。
   */
  async function startModelRun(runId: string): Promise<void> {
    const bundle = modelBundleOf(runId)
    if (!bundle) {
      setNotice({ kind: 'warn', text: `算例「${runId}」还没有回放包：先运行 npm run model:run:fds / npm run model:run:oq，再运行 npm run model:ingest` })
      return
    }
    if (bundle.status !== 'ok') {
      setNotice({ kind: 'error', text: `算例「${runId}」求解器未成功运行：${bundle.failure?.message ?? '无详情'}（不生成回放数据）` })
      return
    }
    setBusy(true)
    try {
      snapshotUserCommunity()
      const community = buildPresetCommunity()
      setPresetMode(true)
      lastDrillVersionRef.current = community.updatedAt
      setModel(community)
      setActivePresetId(null)
      setDraft([])
      setFenceMode('off')
      setNetMode('idle')
      const seed = 42
      const sample = new SampleLbsClient(community.center, seed)
      const list = await sample.aroundSearch(community.center, 3000, '药店')
      const inv = Object.values(demoInventory(list, seed))
      setInventory(inv)
      const provider = new SampleExternalProvider((id) => inv.find((p) => p.id === id)?.name ?? id)
      const engineNew = createEngine({
        untilAllEvacuated: true,
        continueAfterEvacuation: true,
        community,
        seed,
        pharmacies: inv,
        provider,
        ranker: dispatchRanker.current,
        startLabel: '08:00',
        disaster: bundle.provenance.disaster,
        modelRun: bundle,
      })
      engineRef.current = engineNew
      setDisasterKind(bundle.provenance.disaster)
      setMode('console')
      setView('global')
      setSelectedTaskId(engineNew.state.tasks[0]?.id ?? null)
      setSelectedPlanSetId(null)
      setSelectedCandidateId(null)
      setSelectedImpactId(null)
      setReplaySelectedId(null)
      setAi({ busy: false, question: null, analysis: null, rejected: [], error: null })
      const adapter = mapRef.current
      if (adapter) adapter.fitBounds([...community.fence.polygon, ...inv.map((p) => p.lngLat)], 60)
      setTick((t) => t + 1)
      const engineText = engineLabel(bundle.provenance.model, bundle.provenance.engineVersion)
      setNotice({
        kind: 'ok',
        text: `已载入${bundle.provenance.label}「${bundle.provenance.caseId}」：${engineText}，模型事件 ${bundle.events.length} 条（是否受阻由演练通行规则判定）`,
      })
    } finally {
      setBusy(false)
    }
  }

  /**
   * 数据来源切换：模型回放 ↔ 简化演示。
   *
   * 简化演示用**同一个灾种**重建引擎（不带 modelRun），所以灾情事件回到内置公式，
   * 来源徽标与两层证据面板同步切换；反向必须有可用的归档算例才能切。
   */
  async function switchProvenanceMode(level: 'model' | 'simplified'): Promise<void> {
    const eng = engineRef.current
    if (!eng) return
    const kind = eng.state.disaster
    if (level === 'model') {
      const runs = kind === 'fire' || kind === 'earthquake' ? modelRunsFor(kind) : []
      const first = runs.find((r) => modelBundleOf(r.runId)) ?? null
      if (!first) {
        setNotice({ kind: 'warn', text: '当前灾种没有可用的专业模型算例：先运行 npm run model:run:fds / npm run model:run:oq' })
        return
      }
      await startModelRun(first.runId)
      return
    }
    setBusy(true)
    try {
      const community = eng.view.model
      const inventory = Object.values(eng.state.inventory)
      const engineNew = createEngine({
        untilAllEvacuated: true,
        continueAfterEvacuation: true,
        community,
        seed: eng.seed,
        pharmacies: inventory,
        provider: eng.provider,
        ranker: dispatchRanker.current,
        startLabel: eng.state.config.startLabel,
        durationS: eng.state.config.durationS,
        disaster: kind,
      })
      engineRef.current = engineNew
      setDisasterKind(kind)
      setMode('console')
      setView('global')
      setSelectedTaskId(engineNew.state.tasks[0]?.id ?? null)
      setSelectedPlanSetId(null)
      setSelectedCandidateId(null)
      setSelectedImpactId(null)
      setReplaySelectedId(null)
      setAi({ busy: false, question: null, analysis: null, rejected: [], error: null })
      setTick((t) => t + 1)
      const kindLabel = kind === 'fire' ? '火灾' : kind === 'earthquake' ? '地震' : '内涝'
      setNotice({ kind: 'ok', text: `已切回简化演示：灾种「${kindLabel}」按 GeoRelay 内置公式重新开始（非求解器输出）` })
    } finally {
      setBusy(false)
    }
  }

  /**
   * 点击模型证据：定位地图对象并选中对应任务 / 候选集。
   * 火灾定位采样点（入口/路段），地震定位受损楼栋；不改派单。
   */
  function focusModelEvidence(ev: ImpactEvent): void {
    const eng = engineRef.current
    if (!eng) return
    const adapter = mapRef.current
    const model = eng.view.model
    const rawId = ev.targetId.replace(/^entranceAlt:/, '').replace(/^entrance:/, '')
    const building = model.buildings.find((b) => b.id === rawId) ?? null
    let focus: LngLat | null = null
    if (ev.disaster === 'fire') {
      const sample = eng.modelRun?.samples.find((s) => s.sampleId === ev.evidence?.sampleId) ?? null
      focus = sample?.center ?? building?.center ?? null
      if (!focus && ev.geometry?.kind === 'point') focus = ev.geometry.at
    } else if (building) {
      focus = building.center
    } else if (ev.geometry?.kind === 'circle') {
      focus = ev.geometry.center
    } else if (ev.geometry?.kind === 'point') {
      focus = ev.geometry.at
    }
    if (adapter && focus) {
      adapter.flyTo(focus, ev.disaster === 'fire' ? 18 : 17, { durationMs: 600 })
    } else if (adapter && ev.geometry?.kind === 'road') {
      const road = model.net.roads.find((r) => r.id === ev.targetId)
      const path = road?.points.map((p) => (Array.isArray(p) ? (p as LngLat) : ([p.lng, p.lat] as LngLat)))
      if (path?.length) adapter.fitBounds(path, 120)
    }

    if (building) {
      const task = eng.state.tasks.find((t) => t.targetBuildingId === building.id)
      if (task) setSelectedTaskId(task.id)
    }
    // 候选集 ID 形如 `ps:<refId>#<at>`：refId 就是受影响对象（路段 / 入口 / 接驳点）的 ID
    const direct = Object.values(eng.state.planSets).find((ps) => ps.id.startsWith(`ps:${ev.targetId}#`)) ?? null
    const targetTask = building ? eng.state.tasks.find((t) => t.targetBuildingId === building.id) ?? null : null
    const related = direct ?? (targetTask ? Object.values(eng.state.planSets).find((ps) => ps.candidates.some((c) => c.taskId === targetTask.id)) ?? null : null)
    if (related) {
      setSelectedPlanSetId(related.id)
      const candidate = related.candidates.find((c) => c.feasible) ?? related.candidates[0] ?? null
      if (candidate) {
        setSelectedCandidateId(candidate.id)
        setSelectedTaskId(candidate.taskId)
      }
    }
    setTick((t) => t + 1)
  }

  /** 切换灾种：开一场新演练，清空上一场的封路/候选/派单/AI 分析，保留社区模型与地图实例 */
  async function switchDisaster(kind: DisasterKind): Promise<void> {
    if (kind === disasterKind) return
    const label = kind === 'flood' ? '内涝' : kind === 'fire' ? '火灾' : '地震'
    const ok = window.confirm(`切换为「${label}」将开启新演练：上一场的封路、候选、派单和 AI 分析都会清空（社区模型保留）。继续？`)
    if (!ok) return
    await confirmCommunity(kind)
    setNotice({ kind: 'ok', text: `已切换到「${label}」演练：灾情事件按固定场景重新开始` })
  }

  /** AI 调度分析：读取当前演练的结构化状态，交给服务端 AI 参考；结果只做建议 */
  async function askAiAnalysis(question: AiQuestion): Promise<void> {
    const eng = engineRef.current
    if (!eng || pendingAi.current === eng.state || isAgentPlanning(eng)) return
    const activeState = eng.state
    pendingAi.current = activeState
    setAi((prev) => ({ ...prev, busy: true, error: null, question }))
    try {
      const payload = buildAiPayload(eng, question, { mockScenario: new URLSearchParams(window.location.search).get('ai') ?? undefined })
      const res = await requestAiAnalysis(payload)
      if (engineRef.current !== eng || eng.state !== activeState) return
      const state = eng.state
      const relevant = relevantPlanSets(state)
      // 校验 AI 引用的任务/候选：未知、不可行、已过期的一律拦下
      const checked = validateAiRefs(res, state, relevant)
      setAi({ busy: false, question, analysis: res, rejected: checked.rejected, error: null })
      if (checked.rejected.length) setNotice({ kind: 'warn', text: `AI 建议中 ${checked.rejected.length} 条引用不可用，已拦截（详见 AI 面板）` })
    } catch (err) {
      if (engineRef.current !== eng || eng.state !== activeState) return
      setAi({ busy: false, question, analysis: null, rejected: [], error: (err as Error).message })
      setNotice({ kind: 'warn', text: `AI 分析失败：${(err as Error).message}（规则候选仍然可用）` })
    } finally {
      if (pendingAi.current === activeState) pendingAi.current = null
      setTick((value) => value + 1)
    }
  }

  async function askAi(planSet: PlanSet): Promise<void> {
    const eng = engineRef.current
    if (!eng || pendingAi.current === eng.state || isAgentPlanning(eng)) return
    const activeState = eng.state
    pendingAi.current = activeState
    setBusy(true)
    try {
      const res = await requestAiExplanation({
        event: { roadId: planSet.eventId },
        now: engine?.state.clock.t ?? 0,
        task: engine?.state.tasks.find((t) => t.id === planSet.taskId) ?? null,
        candidates: planSet.candidates.map((c) => ({
          id: c.id,
          title: c.title,
          feasible: c.feasible,
          checks: c.checks,
          eta: c.eta,
          slackS: c.slackS,
          isRelay: c.isRelay,
          external: c.external ? { pharmacy: c.external.pharmacy, durationS: c.external.durationS, routeSource: c.external.routeSource } : null,
          internal: c.internal ? { distanceM: c.internal.distanceM, durationS: c.internal.durationS } : null,
          reason: c.reason,
        })),
      })
      if (engineRef.current !== eng || eng.state !== activeState) return
      if (res.ok && res.mode === 'ai') {
        setAiMode('ai')
        setAiText(`${res.summary ?? ''}\n${Object.entries(res.explanations ?? {}).map(([k, v]) => `· ${k}：${v}`).join('\n')}`)
      } else {
        setAiMode('rules')
        setAiText(`规则模式：${res.error ? `AI 接口不可用（${res.error}），` : ''}以下结论由规则规划器生成。`)
      }
    } finally {
      if (pendingAi.current === activeState) pendingAi.current = null
      setBusy(false)
    }
  }

  /** 推进一步后，把选择对齐到当前任务最新的预案集（否则界面停在旧候选上，指挥员会错过新中断） */
  function followLatestPlanSet(): void {
    const eng = engineRef.current
    if (!eng) return
    const taskId = selectedTaskId ?? eng.state.tasks[0]?.id ?? null
    if (!taskId) return
    const sets = Object.values(eng.state.planSets)
      .filter((s) => s.taskId === taskId)
      .sort((a, b) => b.at - a.at)
    // 优先挑「还没确认」的最新一组：已经确认过的候选集不该再占用确认按钮
    const newest = sets.find((s) => !s.confirmedCandidateId) ?? sets[0]
    if (!newest) return
    // 演练重点是「原接驳点失效 → 换接驳点接力」，有接力候选时优先给指挥员看这条
    const feasible = newest.candidates
      .filter((c) => c.feasible)
      .sort((a, b) => (eng.ranker.mode === 'rl' ? 0 : (a.kind === 'staging_relay' ? 0 : 1) - (b.kind === 'staging_relay' ? 0 : 1)) || a.rank - b.rank)[0]
    setSelectedCandidateId(feasible?.id ?? newest.candidates[0]?.id ?? null)
    setSelectedPlanSetId(newest.id)
  }

  const planSet = useMemo(() => {
    if (!engine) return null
    const sets = Object.values(engine.state.planSets).filter((set) => !selectedTaskId || set.candidates.some((candidate) => candidate.taskId === selectedTaskId))
    const selected = sets.find((set) => set.id === selectedPlanSetId)
    return selected ?? sets.at(-1) ?? null
  }, [engine, selectedPlanSetId, selectedTaskId, tick])

  // 调试钩子：仅用于浏览器验收脚本读取演练状态（不参与业务逻辑）
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    ;(window as unknown as { __gr?: unknown }).__gr = engine
      ? {
          engine,
          planSet: planSet ?? null,
          disasterEvents: engine.disaster.plan.events.map((e) => `${e.at}:${e.targetType}:${e.targetName}:${e.traffic}`),
          planSets: Object.keys(engine.state.planSets).length,
          plans: Object.values(engine.state.plans).map((p) => `${p.taskId}:${p.phase}:${p.relay}:${p.legs.internal?.enterGate ?? '—'}`),
          stagings: engine.view.model.net.staging.map((s) => `${s.id}:${s.name}`),
        }
      : null
  }

  // ---------------- 指挥台（C）：沙盘 / 外部地图 与 HUD 数据 ----------------
  const [consoleView, setConsoleView] = useState<'sandbox' | 'amap' | 'external'>('sandbox')
  const communityViewRef = useRef<'sandbox' | 'amap'>('sandbox')
  const [sandboxLayer, setSandboxLayer] = useState<SandboxLayer>('overview')
  useEffect(() => { setSandboxLayer('overview') }, [engine?.state.id])
  const [drawer, setDrawer] = useState<'judgement' | 'evacuation' | null>(null)
  const [riskFocus, setRiskFocus] = useState<string | null>(null)
  /** 从 A 切入 C 的一次性转场（镜头先聚焦围栏再进沙盘） */
  const [entering, setEntering] = useState(false)
  const [followingResponder, setFollowingResponder] = useState(false)
  const dispatchedViewRef = useRef<string | null>(null)
  const arrivedViewRef = useRef<string | null>(null)
  const cameraUpdatedRef = useRef(0)
  const responder = engine?.state.responders[0] ?? null
  const [arrivals, setArrivals] = useState<CommunityArrival[]>([])
  const arrivalCursor = useRef({ drillId: '', index: 0 })
  useEffect(() => {
    if (mode !== 'console' || !engine) return
    const { id, events, plans, responders } = engine.state
    const cursor = arrivalCursor.current
    const sameDrill = cursor.drillId === id
    const fresh = events.slice(sameDrill ? cursor.index : 0).flatMap((event): CommunityArrival[] => {
      if (event.kind === 'supply_arrived') {
        const path = plans[event.refs?.planId ?? '']?.legs.external?.path
        return path && path.length >= 2 ? [{ id: event.id, kind: 'supply', path, label: event.message }] : []
      }
      if (event.kind === 'responder_arrived') {
        const unit = responders.find((item) => item.id === event.refs?.responderIds?.[0])
        return unit && unit.path.length >= 2 ? [{ id: event.id, kind: 'firefighter', path: unit.path, label: '消防到场' }] : []
      }
      return []
    })
    arrivalCursor.current = { drillId: id, index: events.length }
    if (fresh.length || !sameDrill) setArrivals((current) => [...(sameDrill ? current : []), ...fresh].slice(-3))
  }, [engine, mode, tick])
  useEffect(() => {
    if (!arrivals.length) return
    const timer = window.setTimeout(() => setArrivals([]), 2400)
    return () => window.clearTimeout(timer)
  }, [arrivals])
  const closureSignature = engine ? JSON.stringify([engine.state.id, Object.keys(engine.state.closures), Object.keys(engine.state.blockedDoors), Object.keys(engine.state.blockedStaging)]) : ''
  const liveResilience = useMemo(() => engine ? analyzeResilience(engine.view.model, {
    blockedRoadIds: Object.keys(engine.state.closures),
    blockedDoorIds: Object.keys(engine.state.blockedDoors),
    blockedStagingIds: Object.keys(engine.state.blockedStaging),
  }) : null, [engine, closureSignature])
  const urgency = useMemo(() => engine && mode === 'console' ? buildingUrgency(engine, liveResilience, riskFocus) : [], [engine, mode, liveResilience, riskFocus, tick])
  const disasterPlan = engine?.disaster.plan
  const prevention = useMemo(() => mode === 'console' && preventionOpen && engine && disasterPlan
    ? assessPrevention(engine.view.model, disasterPlan.events)
    : null, [mode, preventionOpen, engine, disasterPlan])
  useEffect(() => {
    if (!mapReady) return
    const adapter = mapRef.current
    if (!adapter) return
    if (!engine || mode !== 'console' || consoleView === 'sandbox') {
      adapter.setHazards([])
      return
    }
    const hazards = [...engine.disaster.plan.hazardsAt(engine.state.clock.t)]
    for (const [index, item] of urgency.entries()) {
      const building = engine.view.model.buildings[index]
      hazards.push({
        kind: 'urgency', id: item.id, center: building.center, color: item.color,
        path: building.footprint.map((point) => fromLocal(engine.view.router.verts.frame, point)),
        label: sandboxLayer === 'overview' ? item.zone?.label ?? `${item.name} · ${item.score} 分` : sandboxLayer === 'evacuation' ? `${item.name} · 楼内 ${item.inside} 人` : sandboxLayer === 'supply' ? engine.state.tasks.filter((task) => task.targetBuildingId === item.id).map((task) => {
          const phase = engine.state.plans[engine.state.assignments[task.id]]?.phase
          return `${task.code} ${phase === 'delivered' ? '已送达' : phase === 'blocked' ? '受阻' : phase ? '调度中' : '待派单'}`
        }).join(' · ') : '',
      })
      if (item.zone) hazards.push({ ...item.zone, label: sandboxLayer === 'hazards' || item.zone.focused ? item.zone.label : '' })
    }
    const selected = preventionOpen ? engine.disaster.plan.events.find((event) => event.id === selectedImpactId) : undefined
    if (selected?.targetType === 'road') {
      const road = engine.view.model.net.roads.find((item) => item.id === selected.targetId)
      if (road) hazards.push({ id: `prevention-${road.id}`, kind: 'rupture', path: road.points.map((point) => Array.isArray(point) ? point : [point.lng, point.lat]), label: selected.targetName })
    } else if (selected?.targetType === 'staging') {
      const staging = engine.view.model.net.staging.find((item) => item.id === selected.targetId)
      if (staging) hazards.push({ id: `prevention-${staging.id}`, kind: 'risk', center: staging.lngLat, radiusM: 15, priority: true, focused: true, label: staging.name })
    }
    adapter.setHazards(hazards)
  }, [mapReady, engine, mode, consoleView, tick, urgency, sandboxLayer, preventionOpen, selectedImpactId])
  const [rescueRequest, setRescueRequest] = useState<{ engine: Engine; report: NonNullable<typeof liveResilience> } | null>(null)
  const [rescueAnalysis, setRescueAnalysis] = useState<{ stage: 'screening' | 'reviewing' | 'done'; source: string; summary?: string } | null>(null)
  const [showRescueProgress, setShowRescueProgress] = useState(false)
  const currentRescueAnalysis = rescueRequest?.engine === engine && rescueRequest.report === liveResilience ? rescueAnalysis : null

  useEffect(() => {
    if (mode !== 'console' || !engine || !liveResilience || rescueRequest?.engine !== engine || rescueRequest.report !== liveResilience) return
    const state = engine.state
    const controller = new AbortController()
    rescueAnalysisBusy.current = state
    setRescueAnalysis({ stage: 'screening', source: '规则筛查' })
    setShowRescueProgress(true)
    let hide: number | undefined
    const start = window.setTimeout(async () => {
      const priorities = new Map<string, Set<string>>()
      for (const issue of liveResilience.issues) {
        if (issue.level === 'low') continue
        const targets = priorities.get(issue.suggestion) ?? new Set<string>()
        if (issue.targetName) targets.add(issue.targetName)
        priorities.set(issue.suggestion, targets)
      }
      setRescueAnalysis({ stage: 'reviewing', source: 'AI 救援分析' })
      let result: { source: string; summary?: string } = { source: '规则建议已就绪' }
      try {
        const reply = await requestAiAnalysis({ ...buildAiPayload(engine, 'resilience'), resilience: {
          summary: liveResilience.summary,
          priorities: Array.from(priorities, ([action, targets]) => ({ action, targets: [...targets] })).slice(0, 12),
        } }, AbortSignal.any([controller.signal, AbortSignal.timeout(23000)]))
        if (reply.mode === 'ai' || reply.mode === 'mock') result = { source: reply.mode === 'ai' ? 'AI 建议' : '模拟 AI 建议', summary: reply.summary.trim() || undefined }
      } catch {
        result = { source: 'AI 暂不可用，请查看规则建议' }
      }
      if (controller.signal.aborted) return
      setRescueAnalysis({ stage: 'done', ...result })
      rescueAnalysisBusy.current = null
      hide = window.setTimeout(() => setShowRescueProgress(false), 3500)
    }, 480)
    return () => {
      controller.abort()
      window.clearTimeout(start)
      window.clearTimeout(hide)
      if (rescueAnalysisBusy.current === state) rescueAnalysisBusy.current = null
    }
  }, [mode, engine, liveResilience, rescueRequest])

  function viewResponder(follow = false): void {
    if (!responder) return
    setConsoleView('external')
    setView('external')
    setFollowingResponder(follow)
    if (follow) mapRef.current?.flyTo(responder.position, 16, { durationMs: 500 })
    else requestAnimationFrame(() => mapRef.current?.fitBounds(responder.path, 180))
  }

  function toggleExternalView(): void {
    if (consoleView === 'external') {
      showCommunityMap(communityViewRef.current)
      return
    }
    setFollowingResponder(false)
    setConsoleView('external')
    setView('external')
    const path = hudPlan?.legs.external?.path
    if (path?.length) requestAnimationFrame(() => mapRef.current?.fitBounds(path, 95))
  }

  function showCommunityMap(next: 'sandbox' | 'amap'): void {
    setFollowingResponder(false)
    communityViewRef.current = next
    setConsoleView(next)
    setView(next === 'amap' ? 'internal' : 'global')
    if (next === 'amap' && engine && consoleView !== 'amap') requestAnimationFrame(() => mapRef.current?.fitBounds(engine.view.model.fence.polygon, 90))
  }

  useEffect(() => {
    if (mode !== 'console' || !engine) return
    const first = engine.state.responders[0]
    if (!first) {
      if (dispatchedViewRef.current && consoleView === 'external') showCommunityMap(communityViewRef.current)
      dispatchedViewRef.current = null
      arrivedViewRef.current = null
      setFollowingResponder(false)
      return
    }
    const key = `${engine.state.id}:${first.id}`
    if (first.status === 'arrived' && arrivedViewRef.current !== key) {
      arrivedViewRef.current = key
      dispatchedViewRef.current = key
      setFollowingResponder(false)
      if (consoleView === 'external') showCommunityMap(communityViewRef.current)
      return
    }
    if (dispatchedViewRef.current !== key) {
      dispatchedViewRef.current = key
      setConsoleView('external')
      setView('external')
      setFollowingResponder(false)
      requestAnimationFrame(() => {
        if (first.status !== 'arrived') mapRef.current?.fitBounds(first.path, 180)
      })
    }
    if (followingResponder && consoleView === 'external' && performance.now() - cameraUpdatedRef.current > 700) {
      cameraUpdatedRef.current = performance.now()
      mapRef.current?.flyTo(first.position, 16, { durationMs: 600 })
    }
  }, [mode, engine, tick, followingResponder, consoleView])

  const hudTask = engine && selectedTaskId ? engine.state.tasks.find((t) => t.id === selectedTaskId) ?? null : null
  const hudPlan = engine && selectedTaskId ? engine.state.plans[engine.state.assignments[selectedTaskId] ?? ''] ?? null : null
  const taskPlanSet = planSet && hudTask ? { ...planSet, candidates: planSet.candidates.filter((candidate) => candidate.taskId === hudTask.id) } : planSet
  const hudCandidate = pickCandidate(taskPlanSet, planSet?.confirmedCandidateId ?? selectedCandidateId)
  // 受阻原因：优先用本次演练最新的「不可通行/不可用」事件（路段断裂、接驳点失效等），
  // 不再依赖候选预案是否已经生成 —— 外部 Agent 还在路上时指挥员也要能看到风险。
  const hudImpactList = engine ? Object.values(engine.state.impacts) : []
  const hudBlocking =
    hudImpactList
      .filter((e) => e.traffic === 'blocked')
      .sort((a, b) => b.at - a.at)
      .find((e) => (hudTask ? e.targetId !== hudTask.targetBuildingId : true)) ?? null
  const hudEvent = engine && planSet ? engine.state.impacts[planSet.eventId] ?? null : null
  const blockedSource = hudEvent && hudEvent.traffic !== 'open' ? hudEvent : hudBlocking
  const hudBlocked = blockedSource
    ? {
        title: `${blockedSource.targetName}${blockedSource.traffic === 'blocked' ? ' 不可通行' : ' 受限'}`,
        detail: blockedSource.reason,
      }
    : hudPlan && hudPlan.phase === 'blocked'
      ? { title: '当前方案受阻', detail: hudPlan.rationale }
      : null
  const relayViaName = ((): string => {
    const key = hudCandidate?.internal?.enterGate ?? hudPlan?.legs.internal?.enterGate ?? ''
    const bare = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key
    const live = engine?.view.model ?? model
    const staging = live.net.staging.find((s) => s.id === bare)
    if (staging) return staging.name
    const gate = live.net.gates.find((g) => g.id === bare)
    if (gate) return gate.name
    return key ? '社区接驳点' : '未确定'
  })()
  const relayPharmacy = hudCandidate?.external?.pharmacy.name ?? hudPlan?.legs.external?.pharmacy.name ?? '（演练药店）'
  const canConfirm = Boolean(planSet && hudCandidate && hudCandidate.feasible && !planSet.confirmedCandidateId && engine?.state.status === 'running' && !isAgentPlanning(engine))
  /** 演练时钟是否已走到本场窗口末尾（到点后引擎不再推进，看起来像“卡住”） */
  const drillEnded = engine?.state.status === 'finished'
  const thinking = Boolean(engine && (isAgentPlanning(engine) || pendingAi.current === engine.state || rescueAnalysisBusy.current === engine.state))
  const totalResidents = engine?.view.model.buildings.reduce((total, b) => total + estimatedResidents(b.floors, engine.view.model.unitsPerFloor), 0) ?? 0
  const evacuatedResidents = engine?.state.evacuation.reduce((total, group) => total + (group.status === 'arrived' ? group.residents : 0), 0) ?? 0
  const confirmNote = planSet?.confirmedCandidateId
    ? '该候选已确认，等待 Agent 执行'
    : canConfirm
      ? `预计 ${formatSimTime(hudCandidate!.latestEta, engine!.state.config.startLabel)} 送达`
      : '当前没有可确认的候选方案'

  const consoleUi: ConsoleUiState = {
    view,
    selectedTaskId,
    selectedRoadId,
    selectedPlanSetId: planSet?.id ?? null,
    selectedCandidateId,
    aiText,
    aiMode,
    lbsMode,
    notice,
    busy,
  }

  const showSandbox = mode === 'console' && consoleView === 'sandbox'
  const disasterOptions: Array<{ kind: DisasterKind; label: string }> = [
    { kind: 'flood', label: '内涝' },
    { kind: 'fire', label: '火灾' },
    { kind: 'earthquake', label: '地震' },
  ]
  const disasterTitle = engine
    ? engine.state.disaster === 'flood'
      ? '内涝演练'
      : engine.state.disaster === 'fire'
        ? '火灾演练'
        : '地震演练'
    : '演练'
  const mapSourceLabel = mapKind === 'amap' ? '高德 3D 白模' : '示例地图（非真实地理数据）'

  return (
    <div className={`app-shell mode-${mode}`}>
      <header className="topbar">
        <div className="topbar-brand">
          <img src={brandIcon} alt="" width={26} height={26} />
          <strong>GeoRelay</strong>
          <span className="topbar-sep" aria-hidden />
          <span className="topbar-scene">{mode === 'edit' ? '社区建模' : disasterTitle}</span>
          {mode === 'edit' ? (
            <span className={`badge ${mapKind === 'amap' ? 'muted' : 'warn'}`} data-testid="map-source-badge">{mapSourceLabel}</span>
          ) : (
            <span className="badge muted">{presetMode ? '预置演练（独立副本）' : '演练演示'}</span>
          )}
        </div>

        <div className="topbar-center">
          {mode === 'console' && engine ? (
            <div className="seg" role="tablist" aria-label="灾种">
              {disasterOptions.map((d) => (
                <button
                  key={d.kind}
                  className={`seg-btn ${engine.state.disaster === d.kind ? 'is-active' : ''}`}
                  role="tab"
                  aria-selected={engine.state.disaster === d.kind}
                  onClick={() => void switchDisaster(d.kind)}
                  disabled={busy}
                  data-testid={`disaster-${d.kind}`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          ) : (
            <span className="badge muted">{lbsMode === 'amap' ? '高德周边/路线' : '示例路线'}</span>
          )}
        </div>

        <div className="topbar-actions">
          {mode === 'console' ? (
            <>
              <button className="btn ghost sm" onClick={toggleExternalView} data-testid="toggle-external">
                {consoleView !== 'external' ? '外部支援地图' : communityViewRef.current === 'amap' ? '回到高德白模' : '回到白模沙盘'}
              </button>
              {presetMode ? (
                <>
                  <button className="btn ghost sm" onClick={returnToMyCommunity} data-testid="back-to-my-community">返回我的社区</button>
                  <button className="btn ghost sm" onClick={adoptPresetCommunity} data-testid="adopt-preset-community">复制为我的社区</button>
                </>
              ) : (
                <button className="btn ghost sm" onClick={() => { setMode('edit'); setDrawer(null) }} data-testid="back-to-edit">返回编辑</button>
              )}
            </>
          ) : null}
          <button
            className="btn ghost sm"
            onClick={() => { if (engine) { resetEngine(engine); setTick((v) => v + 1); setNotice({ kind: 'ok', text: '演练已重置到 t=0（种子固定）' }) } }}
            disabled={!engine}
          >
            重置演练
          </button>
        </div>
      </header>

      <div className={`workspace ${mode === 'edit' ? 'is-edit' : 'is-console'}`}>
        <div className={`stage ${showSandbox ? 'is-behind' : ''} ${mode === 'edit' && fenceMode !== 'off' ? 'is-fencing' : ''}`} aria-hidden={showSandbox || undefined}>
          <div className="map-host" ref={mapHostRef} />
          {mode === 'edit' || !showSandbox ? (
            <div className="map-overlay-top">
              <div className="map-notice-stack">
                {mapError && mode === 'console' ? <div className="notice warn">高德未启用（{mapError}），当前为<b>示例地图</b>：几何关系正确，非真实地理数据。</div> : null}
                {!mapReady ? <div className="notice info">地图加载中…</div> : null}
                {consoleView === 'external' && mode === 'console' ? (
                  <div className="notice info">
                    <span><b>外部支援地图</b>：白模沙盘只画围栏内社区；候选药店与完整外部路线在这里看。底图来源：{mapSourceLabel}。</span>
                  </div>
                ) : null}
                {notice ? (
                  <div className={`notice ${notice.kind === 'error' ? 'error' : notice.kind === 'warn' ? 'warn' : 'info'}`}>
                    <span>{notice.text}</span>
                    {notice.action ? (
                      <button className="btn sm notice-action" onClick={() => { const a = notice.action; setNotice(null); a?.run() }}>{notice.action.label}</button>
                    ) : null}
                    <button className="btn sm ghost" onClick={() => setNotice(null)}>关闭</button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
          {mode === 'edit' && fenceMode !== 'off' ? (
            <FenceToolbar
              fenceMode={fenceMode}
              draftCount={draft.length}
              areaM2={fenceValidation?.areaM2 ?? 0}
              perimeterM={draft.length >= 2 ? polygonPerimeterM(draft) : 0}
              invalid={Boolean(fenceValidation && !fenceValidation.ok)}
              selfIntersect={Boolean(fenceValidation?.selfIntersection)}
              rectMode={rectMode}
              onFinish={() => finishFence()}
              onUndo={undoVertex}
              onCancel={cancelFence}
              onToggleRect={() => {
                setRectMode((v) => {
                  const next = !v
                  setRectAnchor(null)
                  setNotice({ kind: 'info', text: next ? '矩形围栏：点击两个对角点，自动成围栏' : '已切回逐点绘制' })
                  return next
                })
              }}
            />
          ) : null}
          {mode === 'console' ? <div className="map-overlay-bottom">
            <div className="legend">
              <span className="legend-item"><span className="legend-swatch solid" />已生效路线</span>
              <span className="legend-item"><span className="legend-swatch dashed" />待确认候选</span>
              <span className="legend-item"><span className="legend-swatch dotted" />封闭/受阻路段</span>
              <span className="legend-item"><span className="data-flag">演练数据</span></span>
            </div>
          </div> : null}
        </div>

        {mode === 'edit' ? (
          <EditorSidebar
            model={model}
            fenceMode={fenceMode}
            fenceValidation={fenceValidation}
            fenceDirty={fenceDirty}
            draft={draft}
            draftCount={draft.length}
            selectedBuilding={selectedBuilding}
            netMode={netMode}
            roadDraftCount={roadDraft.length}
            basemapVisible={basemapVisible}
            busy={busy}
            netValidation={netValidation}
            status={status}
            actions={{
              startFence,
              undoVertex,
              finishFence: () => finishFence(),
              cancelFence,
              toggleRect: () => {
                setRectMode((v) => {
                  const next = !v
                  setRectAnchor(null)
                  setNotice({ kind: 'info', text: next ? '矩形围栏：点击两个对角点，自动成围栏' : '已切回逐点绘制' })
                  return next
                })
              },
              clearFence: () => {
                const previous = model
                startFence()
                setSelectedBuildingId(null)
                setSelectedRoadId(null)
                setModel((m) => replaceCommunityFence({ ...m, address: '' }, makeFence([])))
                setNotice({
                  kind: 'info',
                  text: '已清空围栏、楼栋和路网，可重新标记小区',
                  action: previous.fence.polygon.length || previous.buildings.length || previous.net.gates.length || previous.net.staging.length || previous.net.roads.length ? {
                    label: '撤销',
                    run: () => {
                      cancelPendingVertex()
                      setModel(previous)
                      setDraft([])
                      setFenceMode('off')
                      setNotice({ kind: 'ok', text: '已恢复原来的社区' })
                    },
                  } : undefined,
                })
              },
              editFence: () => { cancelPendingVertex(); setNetMode('idle'); setRoadDraft([]); setFenceMode('edit'); setDraft(model.fence.polygon); setNotice({ kind: 'info', text: '拖动顶点调整围栏，完成后点「保存围栏」' }) },
              saveFence: () => finishFence(),
              generate: (opts: BatchOptions) => {
                const r = generateBuildings(model, opts)
                if (!r.ok) {
                  setNotice({ kind: 'error', text: r.message })
                  return
                }
                setModel(r.model)
                setNotice({ kind: 'ok', text: `已生成 ${r.placed} 栋楼${r.warning ? `（${r.warning}）` : ''}` })
              },
              selectBuilding: (id: string | null) => setSelectedBuildingId(id),
              updateBuilding: (id, patch) => {
                const r = updateBuilding(model, id, patch)
                if (r.errors.length) setNotice({ kind: 'error', text: r.errors.join('；') })
                else { setModel(r.model); setNotice({ kind: 'ok', text: '已更新楼栋' }) }
              },
              deleteBuilding: (id) => {
                const idx = model.buildings.findIndex((b) => b.id === id)
                const removed = model.buildings[idx]
                setModel(removeBuilding(model, id))
                setSelectedBuildingId(null)
                setNotice({
                  kind: 'ok',
                  text: `已删除「${removed?.name ?? '楼栋'}」`,
                  action: removed ? {
                    label: '撤销',
                    run: () => {
                      setModel((m) => {
                        const buildings = [...m.buildings]
                        buildings.splice(Math.min(idx, buildings.length), 0, removed)
                        return touch({ ...m, buildings })
                      })
                      setNotice({ kind: 'ok', text: `已恢复「${removed.name}」` })
                    },
                  } : undefined,
                })
              },
              setUnitsPerFloor: (n: number) => {
                const v = Math.max(1, Math.min(8, Math.round(n)))
                setModel((m) => touch({ ...m, unitsPerFloor: v }))
              },
              rotateBuilding: (id, delta) => {
                const r = rotateBuilding(model, id, delta)
                if (r.errors.length) setNotice({ kind: 'error', text: r.errors.join('；') })
                else setModel(r.model)
              },
              setNetMode: (next) => {
                if (fenceDirty) { setNotice({ kind: 'warn', text: '请先保存或退出围栏编辑，再标记路网' }); return }
                cancelPendingVertex()
                setFenceMode('off')
                setDraft([])
                if (next !== 'road') setRoadDraft([])
                setNetMode(next)
              },
              undoRoadPoint: () => {
                if (roadDraft.length === 0) return
                setRoadDraft((prev) => prev.slice(0, -1))
                setNotice({ kind: 'info', text: `已撤销上一个端点，还剩 ${roadDraft.length - 1} 个端点` })
              },
              finishRoad: () => {
                if (roadDraft.length < 2) { setNotice({ kind: 'error', text: '路段至少需要两个端点' }); return }
                setModel(addRoad(model, roadDraft, `路段 ${model.net.roads.length + 1}`))
                setRoadDraft([])
                setNetMode('idle')
                setNotice({ kind: 'ok', text: '已添加路段' })
              },
              cancelRoad: () => { setRoadDraft([]); setNetMode('idle') },
              suggestNetwork: () => {
                if (fenceDirty || model.fence.polygon.length < 3) { setNotice({ kind: 'warn', text: '请先确认围栏' }); return }
                if (!model.net.gates.length) { setNotice({ kind: 'error', text: '请先标记至少一个大门' }); return }
                const next = suggestNetwork(model)
                const previousRoads = model.net.roads
                setModel(next)
                setNetMode('idle')
                setRoadDraft([])
                setSelectedRoadId(null)
                setNotice({
                  kind: 'info',
                  text: `已生成 ${next.net.roads.length} 段示例道路，替换 ${previousRoads.length} 段旧道路`,
                  action: previousRoads.length ? {
                    label: '撤销替换',
                    run: () => {
                      setModel((current) => current.net.roads === next.net.roads
                        ? touch({ ...current, net: { ...current.net, roads: previousRoads } })
                        : current)
                    },
                  } : undefined,
                })
              },
              confirmRoads: () => {
                setNetMode('idle')
                setRoadDraft([])
                const r = confirmRoads(model)
                setModel(r)
                const v = validateNetwork(r)
                setNotice(v.ok ? { kind: 'ok', text: '路网已确认，可作为内部配送道路' } : { kind: 'warn', text: `路网已确认，但仍有问题：${v.errors.join('；')}` })
              },
              confirmCommunity: () => void confirmCommunity(),
              toggleBasemap: setBasemapVisible,
              loadSample: loadSampleCommunity,
              locate: locateMe,
              search: (q: string) => void searchPlace(q),
              exportJson: () => {
                const blob = new Blob([JSON.stringify(model, null, 2)], { type: 'application/json' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `georelay-${model.name}.json`
                a.click()
                URL.revokeObjectURL(url)
              },
            }}
          />
        ) : null}

        {showSandbox && engine ? (
          <SandboxView
            layer={sandboxLayer}
            arrivals={arrivals}
            model={engine.view.model}
            engine={engine}
            selectedTaskId={selectedTaskId}
            selectedCandidateId={selectedCandidateId}
            planSet={taskPlanSet}
            showHazards
            resilience={liveResilience}
            focusedBuildingId={riskFocus}
            selectedImpactId={selectedImpactId ?? blockedSource?.id ?? null}
          />
        ) : null}

        {mode === 'console' ? (
          <div className="sandbox-layers console-map-switch" role="group" aria-label="指挥地图底图">
            <button type="button" aria-pressed={consoleView === 'sandbox'} onClick={() => showCommunityMap('sandbox')}>白模沙盘</button>
            <button type="button" aria-pressed={consoleView === 'amap'} onClick={() => showCommunityMap('amap')}>{mapKind === 'amap' ? '高德白模' : '地理示意图'}</button>
          </div>
        ) : null}

        {mode === 'console' && engine ? <>
          <div className="sandbox-layers console-focus-switch" role="group" aria-label="沙盘视图">
            {([['overview', '态势'], ['supply', '物资'], ['evacuation', '撤离'], ['hazards', '灾情']] as const).map(([id, label]) =>
              <button key={id} type="button" aria-pressed={sandboxLayer === id} onClick={() => setSandboxLayer(id)}>{label}</button>)}
          </div>
          <div className="console-map-key" aria-label="地图图例">
            <span title="灾害暴露 45，通达性 30，楼内人数 15，重点住户 10">低 <i className="map-key-urgency" /> 高 · 紧急度 0–100</span>
            <span><i className="map-key-supply" />物资</span>
            <span><i className="map-key-evac" />撤离</span>
            <span><i className="map-key-prevention" />重点预防区</span>
          </div>
        </> : null}

        {mode === 'console' && engine ? (
          <SandboxHud
            clockControls={<>
              <span className="drill-clock" title="全员撤离进度">
                <span className="clock" data-testid="console-clock">{formatSimTime(engine.state.clock.t, engine.state.config.startLabel)}</span>
                <progress max={Math.max(totalResidents, 1)} value={evacuatedResidents} aria-label="全员撤离进度" />
              </span>
              <button
                className="btn sm"
                disabled={drillEnded}
                onClick={() => { engine.state.clock.running = !engine.state.clock.running; setTick((v) => v + 1) }}
              >
                {thinking ? (engine.state.clock.running ? '规划中 · 暂停自动恢复' : '规划中 · 时钟已暂停') : drillEnded ? '全员已撤离' : engine.state.clock.running ? '暂停' : '开始演练'}
              </button>
              <button className="btn sm ghost" disabled={drillEnded || thinking} onClick={() => { void advanceDrill(engine, 60).then(followLatestPlanSet) }} data-testid="step-1min">+1 分钟</button>
              <button className="btn sm ghost" disabled={drillEnded || thinking} onClick={() => { void advanceDrill(engine, 300).then(followLatestPlanSet) }} data-testid="step-5min">+5 分钟</button>
              <select className="input input-compact" disabled={thinking || drillEnded} value={engine.state.clock.speed} onChange={(e) => { engine.state.clock.speed = Number(e.target.value); setTick((v) => v + 1) }} aria-label="演练速度">
                {[1, 2, 4, 8, 16, 60].map((s) => <option key={s} value={s}>{s}×</option>)}
              </select>
            </>}
            tasks={engine.state.tasks.map((task) => ({ task, plan: engine.state.plans[engine.state.assignments[task.id]] }))}
            activeTaskId={selectedTaskId}
            onSelectTask={(id) => { setSelectedTaskId(id); setSelectedCandidateId(null); setSelectedPlanSetId(null); setSandboxLayer('supply') }}
            candidate={hudCandidate}
            rankingMode={planSet?.rankingMode}
            rankingPreference={dispatchRanker.current.mode}
            rankingNote={planSet?.rankingNote}
            rankingDisabled={busy || thinking}
            onRankingPreference={async (preference) => {
              const ranker = preference === 'rl' ? new LearningRanker(DISPATCH_REWARDS) : new RuleRanker()
              dispatchRanker.current = ranker
              engine.ranker = ranker
              setTick((value) => value + 1)
              const state = engine.state
              await Promise.all(Object.values(state.planSets).filter((set) => !set.confirmedCandidateId)
                .map((set) => rankPlanSet(engine, set.id, ranker)))
              if (engineRef.current !== engine || engine.state !== state || engine.ranker !== ranker) return
              if (planSet && !planSet.confirmedCandidateId) {
                const candidates = planSet.candidates.filter((item) => !selectedTaskId || item.taskId === selectedTaskId)
                setSelectedCandidateId(candidates.find((item) => item.feasible)?.id ?? candidates[0]?.id ?? null)
              }
              setTick((value) => value + 1)
            }}
            confirmed={Boolean(planSet?.confirmedCandidateId === hudCandidate?.id && hudCandidate)}
            onPreviewCandidate={() => {
              if (consoleView === 'external') showCommunityMap(communityViewRef.current)
              if (hudCandidate && planSet) {
                setSelectedPlanSetId(planSet.id)
                setSelectedCandidateId(hudCandidate.id)
              }
              setSandboxLayer('supply')
            }}
            activity={engine.state.events.filter((event) => ['plan_confirmed', 'agent_assigned', 'agent_pickup', 'agent_relay', 'agent_delivered', 'agent_blocked', 'responder_dispatched', 'responder_arrived', 'rescue_assigned'].includes(event.kind) || (event.kind === 'note' && 'message' in event.payload && event.payload.message === '全员集结')).slice(-12).reverse().map((event) => {
              const taskId = event.refs?.taskIds?.[0]
              return {
                id: event.id, time: formatSimTime(event.at, engine.state.config.startLabel), message: event.message,
                onFocus: taskId ? () => {
                  setSelectedTaskId(taskId)
                  setSelectedCandidateId(null)
                  setSelectedPlanSetId(null)
                  setSandboxLayer('supply')
                  if (consoleView !== 'sandbox') {
                    const plan = engine.state.plans[engine.state.assignments[taskId]]
                    if (plan) mapRef.current?.flyTo(agentPosition(engine, plan).lngLat, 17)
                  }
                } : event.refs?.buildingId ? () => {
                  const building = engine.view.model.buildings.find((item) => item.id === event.refs?.buildingId)
                  if (!building) return
                  if (consoleView === 'external') showCommunityMap(communityViewRef.current)
                  setSandboxLayer('evacuation')
                  setRiskFocus(building.id)
                  if (consoleView === 'amap') mapRef.current?.flyTo(building.center, 18)
                } : event.refs?.responderIds?.length ? () => viewResponder() : undefined,
              }
            })}
            taskCode={hudTask?.code ?? null}
            taskTitle={hudTask?.title ?? null}
            taskNeed={hudTask ? `${hudTask.need.item} × ${hudTask.need.qty}` : null}
            taskWindow={hudTask ? hudTask.deadlineLabel : null}
            targetName={hudTask?.targetName ?? null}
            blocked={hudBlocked}
            awaitingApproval={canConfirm}
            relay={{ pharmacy: relayPharmacy, via: relayViaName, target: hudTask?.targetName ?? '—' }}
            canConfirm={canConfirm}
            confirmNote={confirmNote}
            candidateCount={taskPlanSet?.candidates.length ?? 0}
            feasibleCount={taskPlanSet?.candidates.filter((c) => c.feasible).length ?? 0}
            externalView={consoleView === 'external'}
            onToggleExternal={toggleExternalView}
            responder={responder}
            followingResponder={followingResponder}
            onViewResponder={() => viewResponder()}
            onFollowResponder={() => viewResponder(!followingResponder)}
            onOpenAnalysis={() => {
              if (!liveResilience) return
              setRescueAnalysis(null)
              setRescueRequest({ engine, report: liveResilience })
            }}
            analyzing={Boolean(currentRescueAnalysis && currentRescueAnalysis.stage !== 'done')}
            preventionOpen={preventionOpen}
            onTogglePrevention={() => {
              setPreventionOpen((value) => !value)
              setSelectedImpactId(null)
              setRiskFocus(null)
            }}
            preventionPanel={prevention ? <PreventionPanel report={prevention} onLocate={(event) => {
              const model = engine.view.model
              const buildingId = event.targetId.replace(/^entrance(?:Alt)?:/, '')
              const building = model.buildings.find((item) => item.id === buildingId)
              const nextView = consoleView === 'external' ? communityViewRef.current : consoleView
              if (consoleView === 'external') showCommunityMap(nextView)
              setSandboxLayer('hazards')
              setSelectedImpactId(event.id)
              setRiskFocus(building?.id ?? null)
              if (nextView === 'amap') requestAnimationFrame(() => {
                const road = event.targetType === 'road' ? model.net.roads.find((item) => item.id === event.targetId) : undefined
                if (road) mapRef.current?.fitBounds(road.points.map((point) => Array.isArray(point) ? point : [point.lng, point.lat]), 100)
                else {
                  const point = event.geometry?.kind === 'point' ? event.geometry.at : building?.center ?? model.net.staging.find((item) => item.id === event.targetId)?.lngLat
                  if (point) mapRef.current?.flyTo(point, 18)
                }
              })
            }} /> : null}
            analysisPanel={liveResilience ? <ResiliencePanel report={liveResilience} analysis={currentRescueAnalysis} focusedId={riskFocus} onFocus={(id) => {
              if (consoleView === 'external') showCommunityMap(communityViewRef.current)
              setRiskFocus((previous) => previous === id ? null : id)
              const building = engine.view.model.buildings.find((item) => item.id === id)
              if (consoleView === 'amap' && building && riskFocus !== id) mapRef.current?.flyTo(building.center, 18)
            }} /> : null}
            onShowClosure={blockedSource ? () => {
              if (consoleView === 'external') showCommunityMap(communityViewRef.current)
              setSandboxLayer('hazards')
              setSelectedImpactId(blockedSource.id)
              if (consoleView === 'amap') {
                const road = engine.view.model.net.roads.find((item) => item.id === blockedSource.targetId)
                if (road) mapRef.current?.fitBounds(road.points.map((point) => Array.isArray(point) ? point : [point.lng, point.lat]), 100)
                else if (blockedSource.geometry?.kind === 'point') mapRef.current?.flyTo(blockedSource.geometry.at, 18)
              }
            } : undefined}
            onOpenEvacuation={() => { setDrawer('evacuation'); setRiskFocus(null) }}
            evacuation={engine.state.evacuation}
            rescuePriority={engine.state.rescuePriority ?? 'efficiency'}
            onRescuePriority={(priority) => { engine.state.rescuePriority = priority; setTick((value) => value + 1) }}
            rescueTeams={engine.state.rescueTeams ?? 1}
            respondersDispatched={engine.state.responders.length}
            respondersArrived={engine.state.responders.filter((unit) => unit.status === 'arrived').length}
            onRescueTeams={(teams) => { engine.state.rescueTeams = teams; setTick((value) => value + 1) }}
            rescueQueue={rescueQueue(engine.view.router, engine.state.evacuation, engine.state.rescuePriority ?? 'efficiency').slice(0, 3).map((group) => engine.view.model.buildings.find((item) => item.id === group.buildingId)?.name ?? group.buildingId)}
            activeRescueBuildings={engine.state.evacuation.filter((group) => group.status === 'rescuing').map((group) => engine.view.model.buildings.find((building) => building.id === group.buildingId)?.name ?? group.buildingId)}
            disaster={engine.state.disaster}
            externalLeg={hudPlan?.legs.external ?? null}
            totalResidents={totalResidents}
            planning={engine.planning}
            aiPlanning={pendingAi.current === engine.state}
            onOrderAll={() => { orderEvacuation(engine, engine.view.model.buildings.map((b) => b.id)); if (consoleView === 'external') showCommunityMap(communityViewRef.current); setSandboxLayer('evacuation'); setTick((v) => v + 1) }}
            onFocusTask={() => { if (hudTask) setSelectedTaskId(hudTask.id); if (planSet) setSelectedPlanSetId(planSet.id) }}
            dataPlanSets={Object.keys(engine.state.planSets).length}
            dataImpacts={Object.keys(engine.state.impacts).length}
            dataPlanPhase={hudPlan?.phase ?? 'none'}
            drillEnded={drillEnded}
            evacuationComplete={engine.state.evacuationCompletedAt !== undefined}
            onOpenJudgement={() => setDrawer('judgement')}
            onOpenCandidates={() => setDrawer('judgement')}
            onConfirm={() => {
              if (!engine || !planSet || !hudCandidate) return
              const r = confirmCandidate(engine, planSet.id, hudCandidate.id, '指挥员')
              setNotice({ kind: r.ok ? 'ok' : 'error', text: r.message })
              setTick((v) => v + 1)
              if (r.ok) {
                setSelectedPlanSetId(planSet.id)
                setSelectedCandidateId(hudCandidate.id)
              }
            }}
          />
        ) : null}

        {mode === 'console' && currentRescueAnalysis && showRescueProgress ? (
          <section className={`rescue-analysis-progress${currentRescueAnalysis.stage === 'done' ? ' is-done' : ''}`} role="status" data-testid="rescue-analysis-progress">
            <strong>{currentRescueAnalysis.stage === 'done' ? '救援研判完成' : '救援研判进行中 · 演练时钟暂停'}</strong>
            <ol>
              <li data-state={currentRescueAnalysis.stage === 'screening' ? 'active' : 'done'}>核对封路与入口</li>
              <li data-state={currentRescueAnalysis.stage === 'screening' ? 'pending' : 'done'}>筛查楼栋可达性</li>
              <li data-state={currentRescueAnalysis.stage === 'done' ? 'done' : currentRescueAnalysis.stage === 'reviewing' ? 'active' : 'pending'}>{currentRescueAnalysis.stage === 'done' ? currentRescueAnalysis.source : 'AI 归纳救援建议'}</li>
            </ol>
          </section>
        ) : null}
        {mode === 'console' && drawer && engine ? (
          <aside className="console-drawer" data-testid="console-drawer">
            <header className="drawer-head">
              <span>{drawer === 'evacuation' ? '住户撤离' : '判据 · 候选 · 复盘'}</span>
              <button className="btn sm ghost" onClick={() => { setDrawer(null); setRiskFocus(null) }} data-testid="close-drawer">关闭</button>
            </header>
            <div className="drawer-body">
              {drawer === 'evacuation' ? <EvacuationPanel key={engine.state.id} engine={engine} onOrder={(ids) => {
                orderEvacuation(engine, ids)
                setSandboxLayer('evacuation')
                setDrawer(null)
                setTick((v) => v + 1)
              }} /> : null}
              {drawer === 'judgement' ? <>
              {consoleView === 'external' ? <ViewPanel engine={engine} model={model} view={view} selectedTaskId={selectedTaskId} /> : null}
              <ConsoleSidebar
                engine={engine}
                disaster={{
                  kind: engine.state.disaster,
                  scenarioTitle: engine.disaster.plan.scenario.title,
                  scenarioSummary: engine.disaster.plan.scenario.summary,
                  fixedInputs: engine.disaster.plan.scenario.fixedInputs,
                  impacts: Object.values(engine.state.impacts).sort((x, y) => x.at - y.at),
                  selectedImpactId,
                  upcoming: engine.disaster.plan.events.filter((e) => e.at > engine.state.clock.t).slice(0, 6),
                  running: engine.state.clock.running,
                }}
                disasterBusy={busy || thinking}
                onSwitchDisaster={(k) => void switchDisaster(k)}
                onSelectImpact={setSelectedImpactId}
                onStartModelRun={(runId) => void startModelRun(runId)}
                onSwitchProvenance={(level) => void switchProvenanceMode(level)}
                onFocusModelEvidence={focusModelEvidence}
                ai={ai}
                aiModeLabel={status.ai}
                onAskAi={(q) => void askAiAnalysis(q)}
                onJumpToTask={(taskId) => { setSelectedTaskId(taskId); const ps = relevantPlanSets(engine.state).find((p) => p.candidates.some((c) => c.taskId === taskId)); if (ps) { setSelectedPlanSetId(ps.id); const c = ps.candidates.find((x) => x.taskId === taskId && x.feasible); if (c) setSelectedCandidateId(c.id) } }}
                presets={DRILL_PRESETS}
                activePresetId={activePresetId}
                presetMode={presetMode}
                onLoadPreset={(id) => void loadPreset(id)}
                replaySelectedId={replaySelectedId}
                onSelectReplay={(entry: ReplayEntry) => {
                  setReplaySelectedId(entry.id)
                  const taskId = entry.refs.taskIds?.[0]
                  if (taskId) setSelectedTaskId(taskId)
                  const ps = entry.refs.candidateId
                    ? Object.values(engine.state.planSets).find((x) => x.candidates.some((c) => c.id === entry.refs.candidateId))
                    : null
                  if (ps) setSelectedPlanSetId(ps.id)
                  const adapter = mapRef.current
                  const roadId = entry.refs.roadIds?.[0]
                  if (adapter && roadId) {
                    const road = engine.view.model.net.roads.find((r) => r.id === roadId)
                    if (road && road.points.length) {
                      const frame = { origin: engine.view.model.fence.polygon[0] ?? engine.view.model.center, mxPerDegLng: lngMeters(engine.view.model.center[1]), myPerDegLat: 110574 }
                      const pts = road.points.map((p) => fromLocal(frame, Array.isArray(p) ? { x: p[0], y: p[1] } : (p as unknown as { x: number; y: number })))
                      void pts
                      const path = road.points.map((p) => (Array.isArray(p) ? ([p[0], p[1]] as LngLat) : ([p.lng, p.lat] as LngLat)))
                      adapter.fitBounds(path, 120)
                    }
                  }
                  if (adapter && entry.refs.taskIds?.length && !roadId) {
                    const t2 = engine.state.tasks.find((x) => x.id === entry.refs.taskIds?.[0])
                    const b = engine.view.model.buildings.find((x) => x.id === t2?.targetBuildingId)
                    if (b) adapter.flyTo(b.center, 17, { durationMs: 500 })
                  }
                }}
                onJumpToCandidate={(candidateId) => { for (const ps of relevantPlanSets(engine.state)) { const c = ps.candidates.find((x) => x.id === candidateId); if (c) { setSelectedPlanSetId(ps.id); setSelectedCandidateId(c.id); setSelectedTaskId(c.taskId); break } } }}
                model={model}
                ui={consoleUi}
                planSet={planSet}
                inventory={inventory}
                actions={{
                  setView,
                  selectTask: (id) => { setSelectedTaskId(id); setSelectedRoadId(null) },
                  selectCandidate: (id) => setSelectedCandidateId(id),
                  selectPlanSet: (id) => { setSelectedPlanSetId(id); setSelectedCandidateId(null) },
                  toggleClock: () => { engine.state.clock.running = !engine.state.clock.running; setTick((v) => v + 1) },
                  stepSeconds: (s: number) => { void advanceDrill(engine, s).then(followLatestPlanSet) },
                  regenerate: async () => {
                    const r = await proposeCandidates(engine)
                    setNotice({ kind: r.ok ? 'ok' : 'warn', text: r.message })
                    setTick((v) => v + 1)
                  },
                  confirm: (planSetId: string, candidateId: string) => {
                    const r = confirmCandidate(engine, planSetId, candidateId, '指挥员')
                    setNotice({ kind: r.ok ? 'ok' : 'error', text: r.message })
                    setTick((v) => v + 1)
                  },
                  askAi: () => { if (planSet) void askAi(planSet) },
                  reset: () => { resetEngine(engine); setTick((v) => v + 1); setSelectedPlanSetId(null); setSelectedCandidateId(null) },
                  backToEdit: () => setMode('edit'),
                  selectRoad: (id) => setSelectedRoadId(id),
                  setInventory: (next: InventoryPoint[]) => { setInventory(next); engine.state.inventory = Object.fromEntries(next.map((p) => [p.id, p])); setTick((v) => v + 1) },
                  exportRecord: () => {
                    const blob = new Blob([JSON.stringify(engine.state.record, null, 2)], { type: 'application/json' })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = url
                    a.download = `georelay-record-${engine.seed}.json`
                    a.click()
                    URL.revokeObjectURL(url)
                  },
                }}
              />
              </> : null}
            </div>
          </aside>
        ) : null}

        {entering ? (
          <div className="scene-transition" aria-hidden>
            <div className="scene-transition-inner">锁定社区版本 · 切入白模沙盘</div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** 每度经度对应的米数（用于把局部米制坐标换回经纬度） */
function lngMeters(lat: number): number {
  return (Math.cos((lat * Math.PI) / 180) * 2 * Math.PI * 6378137) / 360
}

export { planRoads }
