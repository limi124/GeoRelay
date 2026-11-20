import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CommunityModel } from '../domain/community/model.ts'
import type { Engine } from '../domain/sim/engine.ts'
import type { PlanSet } from '../domain/sim/types.ts'
import type { ResilienceReport } from '../domain/community/analysis.ts'
import { localFrameFromFence } from '../domain/community/frame.ts'
import { buildScene, projectArrival, SANDBOX_THEME, type CommunityArrival, type SandboxLayer, type Scene, type SceneNode, type SceneTone } from '../sandbox/scene.ts'

/**
 * 指挥台（C）沙盘：固定视角的等轴测 2.5D，用 SVG 画。
 *
 * 只做「看」和「缩放/平移/复位」：楼栋、地台、路网、路线、受阻点、Agent 位置
 * 全部由 `buildScene()` 从社区模型与演练状态算出，不在这里改任何状态。
 */

export interface SandboxViewProps {
  layer: SandboxLayer
  arrivals: CommunityArrival[]
  model: CommunityModel
  engine: Engine
  selectedTaskId: string | null
  selectedCandidateId: string | null
  planSet: PlanSet | null
  showHazards: boolean
  resilience: ResilienceReport | null
  focusedBuildingId: string | null
  selectedImpactId: string | null
}

const PAD = 70
const startArrivalMotion = (animation: SVGAnimateMotionElement | null): void => {
  animation?.beginElement()
}

function labelTone(tone: SceneTone): string {
  if (tone === 'external') return SANDBOX_THEME.agentExternal
  if (tone === 'firefighter') return SANDBOX_THEME.agentFirefighter
  if (tone === 'evacuation') return SANDBOX_THEME.evacuation
  if (tone === 'mint') return SANDBOX_THEME.routeActive
  if (tone === 'warn') return SANDBOX_THEME.blocked
  if (tone === 'muted') return SANDBOX_THEME.labelMuted
  return SANDBOX_THEME.labelText
}

function nodeToSvg(node: SceneNode, i: number, u: number, buildingLabels: Array<{ x: number; y: number; w: number }>): React.ReactElement | null {
  if (node.type === 'poly') {
    return (
      <polygon
        key={i}
        data-layer={node.layer}
        className={node.layer === 'urgency' ? 'sandbox-urgency-face' : undefined}
        points={node.points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')}
        fill={node.fill}
        stroke={node.stroke ?? 'none'}
        strokeWidth={node.strokeWidth ?? 0}
        opacity={node.opacity ?? 1}
        strokeLinejoin="round"
      />
    )
  }
  if (node.type === 'line') {
    return (
      <polyline
        key={i}
        data-layer={node.layer}
        className={node.flow ? 'sandbox-route-flow' : undefined}
        points={node.points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')}
        fill="none"
        stroke={node.stroke}
        strokeWidth={node.width}
        vectorEffect={node.layer === 'closure' || node.layer === 'evacuation' || node.layer === 'dispatch' ? 'non-scaling-stroke' : undefined}
        strokeDasharray={node.dash}
        strokeLinecap={node.cap ?? 'butt'}
        opacity={node.opacity ?? 1}
      />
    )
  }
  if (node.type === 'circle') {
    return <circle key={i} data-layer={node.layer} cx={node.at.x} cy={node.at.y} r={node.r * u * 1.25} fill={node.fill} stroke={node.stroke ?? 'none'} strokeWidth={(node.strokeWidth ?? 0) * u} />
  }
  const text = node.text
  // u = 一个屏幕像素对应的用户单位 → 标签在任何缩放/视口下都是 11px 左右
  const fs = (node.layer === 'occupancy' ? 10 : 11) * u
  const padX = 6 * u
  const w = Array.from(text).reduce((width, character) => width + (character.charCodeAt(0) < 128 ? 0.58 : 1), 0) * fs + padX * 2
  const h = (node.layer === 'occupancy' ? 15 : 18) * u
  const x = node.anchor === 'start' ? node.at.x : node.anchor === 'end' ? node.at.x - w : node.at.x - w / 2
  let y = node.at.y
  if (node.layer === 'occupancy' || node.layer === 'dispatch') {
    while (buildingLabels.some((label) => x < label.x + label.w + 3 * u && x + w + 3 * u > label.x && Math.abs(y - label.y) < h + u)) y -= h + 2 * u
    buildingLabels.push({ x, y, w })
  }
  return (
    <g key={i} data-layer={node.layer}>
      {node.hint ? <title>{node.hint}</title> : null}
      {y !== node.at.y ? <line x1={node.at.x} x2={node.at.x} y1={y} y2={node.at.y} stroke="#b0b9b7" strokeWidth={u} opacity={0.55} /> : null}
      <rect x={x} y={y - h + 3 * u} width={w} height={h} rx={3 * u} fill="rgba(18,20,23,0.88)" stroke="rgba(255,255,255,0.10)" strokeWidth={1 * u} />
      <text x={x + w / 2} y={y} textAnchor="middle" fontSize={fs} fill={labelTone(node.tone)} fontFamily="var(--gr-font, system-ui)" fontWeight={500}>
        {text}
      </text>
    </g>
  )
}

export function SandboxView(props: SandboxViewProps): React.ReactElement {
  const { model, engine, selectedTaskId, selectedCandidateId, planSet, showHazards, resilience, focusedBuildingId, selectedImpactId, layer } = props
  const svgRef = useRef<SVGSVGElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const [px, setPx] = useState({ w: 1200, h: 800 })

  useEffect(() => {
    const el = hostRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setPx({ w: el.clientWidth || 1200, h: el.clientHeight || 800 }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const [k, setK] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)

  const scene: Scene = useMemo(
    () => buildScene({ model, engine, selectedTaskId, selectedCandidateId, planSet, showHazards, resilience, focusedBuildingId, selectedImpactId, layer }),
    [model, engine, engine.state.clock.t, engine.state.evacuation.length, selectedTaskId, selectedCandidateId, planSet, showHazards, resilience, focusedBuildingId, selectedImpactId, layer],
  )

  const bounds = scene.bounds
  const cx = (bounds.minX + bounds.maxX) / 2
  const cy = (bounds.minY + bounds.maxY) / 2
  const vbW = Math.max(200, bounds.maxX - bounds.minX + PAD * 2)
  const vbH = Math.max(160, bounds.maxY - bounds.minY + PAD * 2)

  const reset = useCallback(() => {
    setK(1)
    setTx(0)
    setTy(0)
  }, [])

  // 社区版本或灾种切换后回到默认视角，避免停在上一份社区的空处
  useEffect(() => {
    reset()
  }, [model.updatedAt, engine.state.disaster, reset])

  const toScene = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const svg = svgRef.current
    if (!svg) return null
    const pt = svg.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return null
    const p = pt.matrixTransform(ctm.inverse())
    return { x: p.x, y: p.y }
  }, [])

  const onWheel = (e: React.WheelEvent<SVGSVGElement>): void => {
    e.preventDefault()
    const p = toScene(e.clientX, e.clientY)
    if (!p) return
    const next = Math.min(4, Math.max(0.5, k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)))
    // 以指针为锚点缩放
    const sx = cx + (p.x - cx - tx) / k
    const sy = cy + (p.y - cy - ty) / k
    setK(next)
    setTx(p.x - cx - next * (sx - cx))
    setTy(p.y - cy - next * (sy - cy))
  }

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    dragRef.current = { x: e.clientX, y: e.clientY, tx, ty }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    const d = dragRef.current
    if (!d) return
    const p0 = toScene(d.x, d.y)
    const p1 = toScene(e.clientX, e.clientY)
    if (!p0 || !p1) return
    setTx(d.tx + (p1.x - p0.x))
    setTy(d.ty + (p1.y - p0.y))
  }
  const onPointerUp = (): void => {
    dragRef.current = null
  }

  const gTransform = `translate(${(cx * (1 - k) + tx).toFixed(2)} ${(cy * (1 - k) + ty).toFixed(2)}) scale(${k.toFixed(3)})`
  // 标签用屏幕像素定尺寸：viewBox → 画布像素的比例（preserveAspectRatio=meet 取较大者）× 缩放
  const unit = Math.max(vbW / Math.max(1, px.w), vbH / Math.max(1, px.h)) / k
  const buildingLabels: Array<{ x: number; y: number; w: number }> = []
  const arrivalFrame = props.arrivals.length ? localFrameFromFence(model.fence.polygon).frame : null

  return (
    <div className="sandbox" data-testid="sandbox" ref={hostRef} data-buildings={scene.buildingCount} data-roads={scene.roadCount} data-max-height={Math.max(0, ...scene.buildingHeights).toFixed(1)} data-min-height={Math.min(...(scene.buildingHeights.length ? scene.buildingHeights : [0])).toFixed(1)}>
      <svg
        ref={svgRef}
        className="sandbox-svg"
        viewBox={`${bounds.minX - PAD} ${bounds.minY - PAD + 12} ${vbW} ${vbH}`}
        preserveAspectRatio="xMidYMid meet"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        role="img"
        aria-label="社区白模沙盘"
      >
        <defs>
          <radialGradient id="sb-ground" cx="50%" cy="42%" r="70%">
            <stop offset="0%" stopColor="#22252A" />
            <stop offset="100%" stopColor={SANDBOX_THEME.bg} />
          </radialGradient>
        </defs>
        <rect x={bounds.minX - PAD * 4} y={bounds.minY - PAD * 4} width={vbW + PAD * 8} height={vbH + PAD * 8} fill="url(#sb-ground)" />
        <g transform={gTransform}>
          {scene.items.map((it, i) => nodeToSvg(it.node, i, unit, buildingLabels))}
          {arrivalFrame ? props.arrivals.map((arrival, index) => {
            const points = projectArrival(arrivalFrame, arrival.path)
            const end = points.at(-1)!
            const color = arrival.kind === 'firefighter' ? '#FF9478' : '#7CE6FF'
            const path = points.map(({ x, y }, pointIndex) => `${pointIndex ? 'L' : 'M'}${x},${y}`).join(' ')
            return <g key={arrival.id} className="sandbox-arrival" data-arrival={arrival.kind} pointerEvents="none">
              <path d={path} fill="none" stroke={color} strokeWidth={3} strokeDasharray="6 5" vectorEffect="non-scaling-stroke" opacity={0.75} />
              <circle className="sandbox-arrival-mover" r={6 * unit} fill={color} stroke="#172226" strokeWidth={2 * unit}>
                <animateMotion ref={startArrivalMotion} begin="indefinite" path={path} dur="0.85s" fill="freeze" />
              </circle>
              <g transform={`translate(${end.x} ${end.y})`}>
                <circle className="sandbox-arrival-ring" r={12 * unit} fill="none" stroke={color} strokeWidth={2 * unit} />
              </g>
              <text x={end.x} y={end.y - (22 + index * 22) * unit} textAnchor="middle" fill={color} fontSize={13 * unit} fontWeight={700} stroke="#172226" strokeWidth={5 * unit} paintOrder="stroke">{arrival.label}</text>
            </g>
          }) : null}
        </g>
      </svg>

      <div className="sandbox-tools">
        <button className="sb-btn" onClick={() => setK((v) => Math.min(4, v * 1.2))} title="放大" aria-label="放大">＋</button>
        <button className="sb-btn" onClick={() => setK((v) => Math.max(0.5, v / 1.2))} title="缩小" aria-label="缩小">－</button>
        <button className="sb-btn" onClick={reset} title="复位视角" aria-label="复位视角">⤾</button>
      </div>
      <div className="sandbox-meta" data-testid="sandbox-meta">
        <span>{scene.buildingCount} 栋白模</span>
        <span>{scene.roadCount} 段路网</span>
        {scene.damagedBuildingIds.length ? <span className="is-warn">{scene.damagedBuildingIds.length} 栋受损</span> : null}
      </div>
    </div>
  )
}
