import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CommunityModel } from '../domain/community/model.ts'
import type { Engine } from '../domain/sim/engine.ts'
import type { PlanSet } from '../domain/sim/types.ts'
import type { ResilienceReport } from '../domain/community/analysis.ts'
import { localFrameFromFence } from '../domain/community/frame.ts'
import { buildScene, projectArrival, SANDBOX_THEME, type CommunityArrival, type Pt, type SandboxLayer, type SceneNode, type SceneTone } from '../sandbox/scene.ts'
import { layoutLabels, type LabelRect, type SceneLabel } from '../sandbox/labels.ts'
import { MapObjects } from './MapObjects.tsx'
import { mapLabelColor } from '../map/palette.ts'

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
  onFocusBuilding(id: string | null): void
  selectedImpactId: string | null
}

const startArrivalMotion = (animation: SVGAnimateMotionElement | null): void => { animation?.beginElement() }
function labelTone(tone: SceneTone): string {
  if (tone === 'external') return SANDBOX_THEME.agentExternal
  if (tone === 'firefighter') return SANDBOX_THEME.agentFirefighter
  if (tone === 'evacuation') return SANDBOX_THEME.evacuation
  if (tone === 'mint') return SANDBOX_THEME.routeActive
  if (tone === 'warn') return SANDBOX_THEME.blocked
  if (tone === 'muted') return SANDBOX_THEME.labelMuted
  return SANDBOX_THEME.labelText
}

function nodeToSvg(node: SceneNode, index: number, unit: number, focusedBuildingId: string | null, running: boolean): React.ReactElement | null {
  if (node.type === 'poly') return <polygon
    key={index} data-layer={node.layer} data-building-id={node.buildingId}
    data-focused={node.buildingId ? node.buildingId === focusedBuildingId : undefined}
    className={node.layer === 'urgency' ? 'sandbox-urgency-face' : undefined}
    points={node.points.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')}
    fill={node.fill} stroke={node.buildingId === focusedBuildingId ? SANDBOX_THEME.labelText : node.stroke ?? 'none'}
    strokeWidth={node.buildingId === focusedBuildingId ? 2 * unit : node.strokeWidth ?? 0}
    opacity={node.opacity ?? 1} strokeLinejoin="round"
    pointerEvents={node.buildingId ? 'visiblePainted' : 'none'}
  />
  if (node.type === 'line') return <polyline
    key={index} data-layer={node.layer} data-route-state={node.routeState} className={node.flow ? 'sandbox-route-flow' : undefined} data-flow={node.flow || undefined} data-motion-state={node.flow ? running ? 'moving' : 'paused' : undefined}
    points={node.points.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')}
    fill="none" stroke={node.stroke} strokeWidth={node.width}
    vectorEffect={node.layer === 'closure' || node.layer === 'evacuation' || node.layer === 'dispatch' ? 'non-scaling-stroke' : undefined}
    strokeDasharray={node.dash} strokeDashoffset={node.dashOffset} strokeLinecap={node.cap ?? 'butt'} opacity={node.opacity ?? 1} pointerEvents="none"
  />
  if (node.type === 'actor') {
    const heading = node.direction && Math.hypot(node.direction.x, node.direction.y) > .001
      ? Math.atan2(node.direction.y, node.direction.x) * 180 / Math.PI : -90
    const size = node.size * unit
    return <g key={node.actorId} data-layer={node.layer} data-actor-id={node.actorId} data-shape="arrow" data-motion-state={node.motionState} data-position={`${node.at.x.toFixed(3)},${node.at.y.toFixed(3)}`} pointerEvents="none">
      <polygon points={`${-size},${-.65 * size} ${size},0 ${-size},${.65 * size} ${-.45 * size},0`} transform={`translate(${node.at.x} ${node.at.y}) rotate(${heading})`} fill={node.fill} stroke="#fffefd" strokeWidth={.85 * unit} strokeLinejoin="round" />
    </g>
  }
  if (node.type === 'circle') return <circle key={index} data-layer={node.layer} cx={node.at.x} cy={node.at.y} r={node.r * unit * 1.25} fill={node.fill} stroke={node.stroke ?? 'none'} strokeWidth={(node.strokeWidth ?? 0) * unit} pointerEvents="none" />
  return null
}

/** Camera and label placement are presentation state; selection belongs to App. */
export function SandboxView(props: SandboxViewProps): React.ReactElement {
  const { model, engine, selectedTaskId, selectedCandidateId, planSet, showHazards, resilience, focusedBuildingId, selectedImpactId, layer } = props
  const svgRef = useRef<SVGSVGElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const [px, setPx] = useState({ w: 1200, h: 800 })
  const [k, setK] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)
  const [obstacles, setObstacles] = useState<LabelRect[]>([])
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean; buildingId: string | null } | null>(null)
  const running = engine.state.clock.running && engine.state.status === 'running'

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = (): void => {
      if (running && !reducedMotion.matches) svg.unpauseAnimations()
      else svg.pauseAnimations()
    }
    sync()
    reducedMotion.addEventListener('change', sync)
    return () => reducedMotion.removeEventListener('change', sync)
  }, [running])

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setPx(previous => {
      const next = { w: el.clientWidth || 1200, h: el.clientHeight || 800 }
      return previous.w === next.w && previous.h === next.h ? previous : next
    }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const scene = useMemo(
    () => buildScene({ model, engine, selectedTaskId, selectedCandidateId, planSet, showHazards, resilience, focusedBuildingId, selectedImpactId, layer }),
    [model, engine, engine.state.clock.t, engine.state.clock.running, engine.state.evacuation.length, selectedTaskId, selectedCandidateId, planSet, showHazards, resilience, focusedBuildingId, selectedImpactId, layer],
  )
  const { bounds } = scene
  const cx = (bounds.minX + bounds.maxX) / 2
  const cy = (bounds.minY + bounds.maxY) / 2
  const inset = { left: 18, right: 48, top: px.w < 600 ? 96 : 58, bottom: 76 }
  const usableW = Math.max(140, px.w - inset.left - inset.right)
  const usableH = Math.max(120, px.h - inset.top - inset.bottom)
  const baseScale = Math.min(usableW / Math.max(200, bounds.maxX - bounds.minX + 45), usableH / Math.max(160, bounds.maxY - bounds.minY + 45))
  const scale = baseScale * k
  const centerX = inset.left + usableW / 2
  const centerY = inset.top + usableH / 2
  const offsetX = centerX - cx * scale + tx
  const offsetY = centerY - cy * scale + ty
  const unit = 1 / scale

  const reset = useCallback(() => { setK(1); setTx(0); setTy(0) }, [])
  useEffect(() => { reset() }, [model.updatedAt, engine.state.disaster, reset])

  const centerAt = (at: Pt): void => {
    const zoom = Math.max(1.35, k)
    setK(zoom)
    setTx((cx - at.x) * baseScale * zoom)
    setTy((cy - at.y) * baseScale * zoom)
  }
  const centerBuilding = (id: string): void => {
    const building = scene.buildings.find(item => item.id === id)
    if (building) centerAt(building.at)
  }
  // Center external focus requests, but do not reset a user's pan on each clock tick.
  useEffect(() => {
    if (focusedBuildingId) centerBuilding(focusedBuildingId)
  }, [focusedBuildingId, model.updatedAt, px.w, px.h])

  const focusBuilding = (id: string | null): void => {
    props.onFocusBuilding(id)
    if (id) centerBuilding(id)
  }

  const collectObstacles = useCallback(() => {
    const host = hostRef.current
    if (!host) return
    const rect = host.getBoundingClientRect()
    const workspace = host.closest('.workspace')
    const next = Array.from(workspace?.querySelectorAll('.console-map-switch, .console-focus-switch, .console-map-key, .workspace-feedback, .sandbox-tools, .map-object-browser, .sandbox-meta') ?? [])
      .filter(element => element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }))
      .map(element => element.getBoundingClientRect())
      .filter(item => item.right > rect.left && item.left < rect.right && item.bottom > rect.top && item.top < rect.bottom)
      .map(item => ({ x: item.left - rect.left - 5, y: item.top - rect.top - 5, width: item.width + 10, height: item.height + 10 }))
    setObstacles(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
  }, [])
  useLayoutEffect(() => { collectObstacles() }, [collectObstacles, scene, px, k, tx, ty])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const wheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = svg.getBoundingClientRect()
      const x = (event.clientX - rect.left) * px.w / rect.width
      const y = (event.clientY - rect.top) * px.h / rect.height
      const next = Math.min(4, Math.max(.5, k * (event.deltaY < 0 ? 1.12 : 1 / 1.12)))
      setK(next)
      setTx(x - centerX - (x - centerX - tx) * next / k)
      setTy(y - centerY - (y - centerY - ty) * next / k)
    }
    svg.addEventListener('wheel', wheel, { passive: false })
    return () => svg.removeEventListener('wheel', wheel)
  }, [k, tx, ty, px, centerX, centerY])

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return
    dragRef.current = { x: event.clientX, y: event.clientY, tx, ty, moved: false, buildingId: (event.target as Element).closest('[data-building-id]')?.getAttribute('data-building-id') ?? null }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y
    drag.moved ||= Math.hypot(dx, dy) >= 5
    if (drag.moved) { setTx(drag.tx + dx); setTy(drag.ty + dy) }
  }
  const onPointerUp = (event: React.PointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (drag && !drag.moved && drag.buildingId) focusBuilding(drag.buildingId)
  }

  const arrivalFrame = props.arrivals.length ? localFrameFromFence(model.fence.polygon).frame : null
  const arrivals = arrivalFrame ? props.arrivals.map(arrival => ({ ...arrival, points: projectArrival(arrivalFrame, arrival.path) })) : []
  const fireArrival = arrivals.some(arrival => arrival.kind === 'firefighter')
  const labels: Array<{ key: string; node: SceneLabel }> = scene.items.flatMap(({ node }, index) => node.type === 'label' && !(fireArrival && node.text === '消防已到场') ? [{ key: `scene-${index}`, node }] : [])
  for (const arrival of arrivals) {
    const end = arrival.points.at(-1)
    if (end) labels.push({ key: arrival.id, node: { type: 'label', at: end, text: arrival.label, tone: arrival.kind === 'firefighter' ? 'firefighter' : 'external', priority: 95 } })
  }
  // Keep labels clear of the actual position marks at every zoom.
  const actorObstacles = scene.items.flatMap(({ node }) => {
    if (node.type !== 'actor') return []
    const radius = node.size * 1.2 + 3
    return [{ x: node.at.x * scale + offsetX - radius, y: node.at.y * scale + offsetY - radius, width: radius * 2, height: radius * 2 }]
  })
  const placedLabels = layoutLabels(labels, { width: px.w, height: px.h, scale, offsetX, offsetY, zoom: k }, [...obstacles, ...actorObstacles])

  return <div className="sandbox" data-testid="sandbox" ref={hostRef} data-running={running} data-buildings={scene.buildingCount} data-roads={scene.roadCount} data-focused-building={focusedBuildingId ?? ''} data-max-height={Math.max(0, ...scene.buildingHeights).toFixed(1)} data-min-height={Math.min(...(scene.buildingHeights.length ? scene.buildingHeights : [0])).toFixed(1)}>
    <svg ref={svgRef} className="sandbox-svg" viewBox={`0 0 ${px.w} ${px.h}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { dragRef.current = null }} role="img" aria-label="社区沙盘，可通过楼栋列表定位">
      <rect width={px.w} height={px.h} fill={SANDBOX_THEME.bg} />
      <g transform={`translate(${offsetX.toFixed(2)} ${offsetY.toFixed(2)}) scale(${scale.toFixed(5)})`} data-testid="sandbox-camera">
        {scene.items.map(({ node }, index) => nodeToSvg(node, index, unit, focusedBuildingId, running))}
        {arrivals.map(arrival => {
          const end = arrival.points.at(-1)
          if (!end) return null
          const color = arrival.kind === 'firefighter' ? SANDBOX_THEME.agentFirefighter : SANDBOX_THEME.agentExternal
          const path = arrival.points.map(({ x, y }, index) => `${index ? 'L' : 'M'}${x},${y}`).join(' ')
          return <g key={arrival.id} className="sandbox-arrival" data-arrival={arrival.kind} pointerEvents="none">
            <path d={path} fill="none" stroke={color} strokeWidth={3} strokeDasharray="6 5" vectorEffect="non-scaling-stroke" opacity={.75} />
            <circle className="sandbox-arrival-mover" r={6 * unit} fill={color} stroke={SANDBOX_THEME.ground2d} strokeWidth={2 * unit}>
              <animateMotion ref={startArrivalMotion} begin="indefinite" path={path} dur=".85s" fill="freeze" />
            </circle>
            <circle className="sandbox-arrival-ring" cx={end.x} cy={end.y} r={12 * unit} fill="none" stroke={color} strokeWidth={2 * unit} />
          </g>
        })}
      </g>
      <g data-testid="sandbox-labels">
        {placedLabels.map(label => <g key={label.key} data-building-id={label.node.buildingId} data-layer={label.node.layer} pointerEvents={label.node.buildingId ? 'visiblePainted' : 'none'}>
          <title>{label.node.hint ?? label.node.text}</title>
          <line x1={label.anchorX} y1={label.anchorY} x2={Math.max(label.x, Math.min(label.x + label.width, label.anchorX))} y2={label.y + label.height} stroke="#b0b9b7" strokeWidth={1} opacity={.6} pointerEvents="none" />
          <rect x={label.x} y={label.y} width={label.width} height={label.height} rx={3} fill="rgba(255,255,253,.96)" stroke="rgba(75,81,71,.14)" />
          <text x={label.x + label.width / 2} y={label.y + label.height / 2} dominantBaseline="central" textAnchor="middle" fontSize={11} fontFamily="var(--gr-font, system-ui)" fontWeight={500} fill={mapLabelColor(labelTone(label.node.tone))}>{label.text}</text>
        </g>)}
      </g>
    </svg>
    <div className="sandbox-tools">
      <button className="sb-btn" onClick={() => setK(value => Math.min(4, value * 1.2))} title="放大" aria-label="放大">＋</button>
      <button className="sb-btn" onClick={() => setK(value => Math.max(.5, value / 1.2))} title="缩小" aria-label="缩小">－</button>
      <button className="sb-btn" onClick={() => { reset(); props.onFocusBuilding(null) }} title="复位视角" aria-label="复位视角">⤾</button>
    </div>
    <MapObjects buildings={scene.buildings} notes={labels.filter(({ node }) => !node.buildingId).map(({ node }) => ({ text: node.text, hint: node.hint, at: node.at }))} focusedBuildingId={focusedBuildingId} onFocusBuilding={focusBuilding} onLocateNote={centerAt} onToggle={collectObstacles} />
    <div className="sandbox-meta" data-testid="sandbox-meta"><span>{scene.buildingCount} 栋白模</span><span>{scene.roadCount} 段路网</span>{scene.damagedBuildingIds.length ? <span className="is-warn">{scene.damagedBuildingIds.length} 栋受损</span> : null}</div>
  </div>
}
