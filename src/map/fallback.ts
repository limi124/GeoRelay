import type { HazardSpec } from '../domain/disaster/types.ts'
import { MAP_COLORS, mapLabelColor } from './palette.ts'
import type {
  BuildingSpec,
  FenceEditorOptions,
  MapAdapter,
  MapEvents,
  MarkerSpec,
  PlanLineStyle,
  PolygonSpec,
  RoadLineStyle,
} from './types.ts'

/**
 * 示例地图适配器（纯 Canvas 2D）。
 *
 * 存在意义：没有高德凭据时，编辑与演练链路仍然必须能完整走通。
 * 因此这里画一张**明确标注为示例**的示意图：浅色街区 + 道路网格 + 楼块，
 * 几何关系（距离、方位、包含）与真实经纬度一致，但不是真实地理数据。
 *
 * 刻意不做的事：不模拟真实路网、不联网、不做瓦片加载。
 */

type LngLat = [number, number]

const COLORS = {
  bg: '#F4F3EF',
  block: '#E9E7E1',
  blockEdge: '#DDDAD2',
  road: '#D6D3CA',
  fenceFill: `${MAP_COLORS.fence}1A`,
  fenceStroke: MAP_COLORS.fence,
  approved: MAP_COLORS.active,
  pending: MAP_COLORS.pending,
  closed: MAP_COLORS.blocked,
  water: 'rgba(90,160,220,0.38)',
  text: '#343936',
  text2: '#71746E',
}

const M_PER_DEG_LAT = 110574.0
const M_PER_DEG_LNG = 111319.49

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface View {
  center: LngLat
  zoom: number
}

interface CanvasLabel {
  key: string
  text: string
  compact?: string
  x: number
  y: number
  priority: number
  color: string
}

interface LabelBox { x: number; y: number; width: number; height: number }

export function createFallbackAdapter(container: HTMLDivElement, opts: { center?: LngLat; zoom?: number } = {}): MapAdapter {
  const view: View = { center: opts.center ?? [121.4737, 31.2304], zoom: opts.zoom ?? 16 }
  const lat0 = view.center[1]

  let events: MapEvents = {}
  let buildings: BuildingSpec[] = []
  let buildingsVisible = true
  let polygons: PolygonSpec[] = []
  let roads: Array<{ id: string; path: LngLat[]; style: RoadLineStyle }> = []
  let routes: Array<{ id: string; path: LngLat[]; style: PlanLineStyle; label?: string }> = []
  let markers: MarkerSpec[] = []
  let flood: Array<{ id: string; path: LngLat[]; depthM: number }> = []
  let hazards: HazardSpec[] = []
  let fence: FenceEditorOptions = { mode: 'off', draft: [], hoverPoint: null, closed: false, invalidPoint: null }
  let basemapVisible = true
  let labels: CanvasLabel[] = []

  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab'
  container.appendChild(canvas)
  const ctx = canvas.getContext('2d')!

  let w = container.clientWidth || 800
  let h = container.clientHeight || 600
  let dpr = Math.min(2.5, window.devicePixelRatio || 1)

  function resize(): void {
    w = container.clientWidth || w
    h = container.clientHeight || h
    dpr = Math.min(2.5, window.devicePixelRatio || 1)
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    draw()
  }

  const ro = new ResizeObserver(() => resize())
  ro.observe(container)

  function mpp(): number {
    return (156543.03392 * Math.cos((lat0 * Math.PI) / 180)) / Math.pow(2, view.zoom)
  }

  function project(p: LngLat): [number, number] {
    const m = mpp()
    const x = ((p[0] - view.center[0]) * M_PER_DEG_LNG * Math.cos((lat0 * Math.PI) / 180)) / m + w / 2
    const y = h / 2 - ((p[1] - view.center[1]) * M_PER_DEG_LAT) / m
    return [x, y]
  }

  function unproject(x: number, y: number): LngLat {
    const m = mpp()
    const lng = view.center[0] + ((x - w / 2) * m) / (M_PER_DEG_LNG * Math.cos((lat0 * Math.PI) / 180))
    const lat = view.center[1] - ((y - h / 2) * m) / M_PER_DEG_LAT
    return [lng, lat]
  }

  // ---------------- 示例街区（固定种子，稳定不抖动） ----------------

  interface Block {
    p: LngLat
    wM: number
    hM: number
    rot: number
  }
  let blockCache: Block[] | null = null
  let blockCacheKey = ''

  function basemapBlocks(): Block[] {
    const key = `${view.center[0].toFixed(3)},${view.center[1].toFixed(3)}`
    if (blockCache && blockCacheKey === key) return blockCache
    const rnd = mulberry32(20261118)
    const out: Block[] = []
    const spanM = 1400
    for (let i = 0; i < 130; i++) {
      const dx = (rnd() - 0.5) * spanM * 2
      const dy = (rnd() - 0.5) * spanM * 2
      // 留出主干道网格：距离格线太近就跳过
      const gx = Math.abs(((dx % 220) + 220) % 220 - 110)
      const gy = Math.abs(((dy % 220) + 220) % 220 - 110)
      if (gx < 26 || gy < 26) continue
      out.push({
        p: [view.center[0] + dx / (M_PER_DEG_LNG * Math.cos((lat0 * Math.PI) / 180)), view.center[1] + dy / M_PER_DEG_LAT],
        wM: 26 + rnd() * 46,
        hM: 18 + rnd() * 38,
        rot: (Math.floor(rnd() * 4) * Math.PI) / 2,
      })
    }
    blockCache = out
    blockCacheKey = key
    return out
  }

  function drawBasemap(): void {
    const m = mpp()
    ctx.save()
    // 道路网格
    ctx.strokeStyle = COLORS.road
    ctx.lineWidth = Math.max(1.5, 9 / m)
    ctx.globalAlpha = 0.75
    const gridM = 220
    const originScreen = project(view.center)
    const startX = originScreen[0] % (gridM / m)
    const startY = originScreen[1] % (gridM / m)
    for (let x = startX; x < w; x += gridM / m) {
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
    }
    for (let y = startY; y < h; y += gridM / m) {
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    if (basemapVisible) {
      for (const b of basemapBlocks()) {
        const [bx, by] = project(b.p)
        const bw = b.wM / m
        const bh = b.hM / m
        if (bx < -80 || by < -80 || bx > w + 80 || by > h + 80) continue
        ctx.save()
        ctx.translate(bx, by)
        ctx.rotate(b.rot)
        ctx.fillStyle = COLORS.block
        ctx.strokeStyle = COLORS.blockEdge
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.rect(-bw / 2, -bh / 2, bw, bh)
        ctx.fill()
        ctx.stroke()
        // 轻微“高度”提示：顶部左上角高光
        ctx.fillStyle = 'rgba(255,255,255,0.05)'
        ctx.fillRect(-bw / 2, -bh / 2, bw, Math.max(2, bh * 0.18))
        ctx.restore()
      }
    }
    ctx.restore()
  }

  // ---------------- 各图层 ----------------

  function pathOf(points: LngLat[]): Array<[number, number]> {
    return points.map(project)
  }

  function drawPolygons(): void {
    for (const poly of polygons) {
      const pts = pathOf(poly.path)
      if (pts.length < 2) continue
      ctx.beginPath()
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
      ctx.closePath()
      if (poly.lineHeight && poly.lineHeight > 0) {
        // 围栏高度：先填一个“墙”的侧面，制造立体感
        // 围栏“墙体”只做很薄的一点立体感：太高会糊成一条宽色带，像围栏带而不是边界
        const lift = Math.min(6, poly.lineHeight / mpp())
        ctx.save()
        ctx.globalAlpha = poly.opacity * 0.35
        ctx.fillStyle = poly.stroke
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i]
          const b = pts[(i + 1) % pts.length]
          ctx.beginPath()
          ctx.moveTo(a[0], a[1])
          ctx.lineTo(b[0], b[1])
          ctx.lineTo(b[0], b[1] - lift)
          ctx.lineTo(a[0], a[1] - lift)
          ctx.closePath()
          ctx.fill()
        }
        ctx.restore()
        ctx.save()
        ctx.translate(0, -lift)
      }
      ctx.globalAlpha = poly.opacity
      ctx.fillStyle = poly.fill
      ctx.fill()
      ctx.globalAlpha = 1
      ctx.strokeStyle = poly.stroke
      // 围栏这类大面积多边形用细线：粗描边会糊成一条宽色带，看不清边界
      ctx.lineWidth = Math.min(3, poly.strokeWidth)
      if (poly.dashed) ctx.setLineDash([8, 6])
      ctx.stroke()
      ctx.setLineDash([])
      ctx.restore()
    }
  }

  function drawRoads(): void {
    for (const road of roads) {
      if (road.path.length < 2) continue
      const pts = pathOf(road.path)
      ctx.beginPath()
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
      if (road.style === 'closed') {
        ctx.strokeStyle = COLORS.closed
        ctx.setLineDash([6, 5])
        ctx.lineWidth = 4
      } else if (road.style === 'suggested') {
        ctx.strokeStyle = COLORS.pending
        ctx.setLineDash([8, 6])
        ctx.lineWidth = 2.5
      } else {
        ctx.strokeStyle = COLORS.road
        ctx.setLineDash([])
        ctx.lineWidth = 5
      }
      ctx.globalAlpha = road.style === 'open' ? 1 : 0.95
      ctx.lineCap = 'round'
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.setLineDash([])
    }
  }

  function drawFlood(): void {
    for (const f of flood) {
      if (f.path.length < 2) continue
      const pts = pathOf(f.path)
      ctx.beginPath()
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
      ctx.strokeStyle = COLORS.water
      ctx.lineWidth = Math.min(30, 6 + f.depthM * 40)
      ctx.globalAlpha = Math.min(0.62, 0.28 + f.depthM * 0.5)
      ctx.lineCap = 'round'
      ctx.stroke()
      ctx.globalAlpha = 1
    }
  }

  /** 灾情图层：烟雾圆、起火点、受损楼栋、断路 */
  function drawHazards(): void {
    for (const h of hazards) {
      if (h.kind === 'risk' || h.kind === 'urgency') {
        const [x, y] = project(h.center)
        const focused = h.kind === 'risk' && h.focused
        const color = focused ? '#FFE680' : h.color ?? '#E76E47'
        ctx.beginPath()
        if (h.path) {
          pathOf(h.path).forEach(([px, py], index) => index ? ctx.lineTo(px, py) : ctx.moveTo(px, py))
          ctx.closePath()
        } else if (h.kind === 'risk') ctx.arc(x, y, h.radiusM / mpp(), 0, Math.PI * 2)
        ctx.fillStyle = `${color}${h.kind === 'urgency' ? '85' : '42'}`
        ctx.fill()
        ctx.strokeStyle = color
        ctx.lineWidth = focused ? 3 : 2
        ctx.stroke()
        const building = buildings.find(building => building.id === h.id)
        const selected = building?.selected || h.kind === 'urgency' && building?.label !== h.label
        labels.push({ key: `hazard-${h.id}`, text: h.label, x, y: y - 12, priority: focused || selected ? 110 : h.kind === 'risk' ? 95 : 35, color: h.kind === 'risk' ? COLORS.closed : COLORS.text })
      } else if (h.kind === 'smoke') {
        const [x, y] = project(h.center)
        const r = h.radiusM / mpp()
        const g = ctx.createRadialGradient(x, y, Math.max(2, r * 0.15), x, y, Math.max(3, r))
        g.addColorStop(0, 'rgba(255,140,90,0.55)')
        g.addColorStop(0.55, 'rgba(255,174,132,0.30)')
        g.addColorStop(1, 'rgba(255,174,132,0.02)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(x, y, Math.max(3, r), 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = 'rgba(255,174,132,0.85)'
        ctx.lineWidth = 1.5
        ctx.setLineDash([7, 5])
        ctx.stroke()
        ctx.setLineDash([])
      } else if (h.kind === 'fire-origin') {
        const [x, y] = project(h.center)
        ctx.fillStyle = 'rgba(255,120,60,0.95)'
        ctx.beginPath()
        ctx.arc(x, y, 7, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = '#343936'
        ctx.lineWidth = 2
        ctx.stroke()
      } else if (h.kind === 'damage') {
        if (h.path.length < 3) continue
        const pts = pathOf(h.path)
        const tone = h.level === '倒塌' ? 'rgba(255,120,60,0.55)' : h.level === '严重' ? 'rgba(255,174,132,0.45)' : h.level === '中等' ? 'rgba(255,211,186,0.32)' : 'rgba(255,211,186,0.18)'
        ctx.beginPath()
        pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
        ctx.closePath()
        ctx.fillStyle = tone
        ctx.fill()
        ctx.strokeStyle = h.level === '倒塌' || h.level === '严重' ? 'rgba(255,120,60,0.95)' : 'rgba(255,174,132,0.8)'
        ctx.lineWidth = 1.6
        ctx.stroke()
      } else if (h.kind === 'rupture') {
        if (h.path.length < 2) continue
        const pts = pathOf(h.path)
        ctx.beginPath()
        pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
        ctx.strokeStyle = 'rgba(255,120,60,0.95)'
        ctx.lineWidth = 5
        ctx.setLineDash([4, 6])
        ctx.stroke()
        ctx.setLineDash([])
      }
    }
  }

  function drawRoutes(): void {
    for (const r of routes) {
      if (r.path.length < 2) continue
      const pts = pathOf(r.path)
      ctx.beginPath()
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
      const styleColor =
        r.style === 'evacuation' ? MAP_COLORS.evacuation : r.style === 'response' ? MAP_COLORS.firefighter : r.style === 'approved' ? COLORS.approved : r.style === 'rejected' ? COLORS.closed : r.style === 'baseline' ? MAP_COLORS.original : COLORS.pending
      // 深色描边提升在浅色街区上的可读性
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'
      ctx.lineWidth = 7
      ctx.setLineDash(r.style === 'approved' ? [] : [9, 7])
      ctx.stroke()
      ctx.strokeStyle = styleColor
      ctx.lineWidth = 3.5
      ctx.stroke()
      ctx.setLineDash([])
      if (r.label) {
        const mid = pts[Math.floor(pts.length / 2)]
        labels.push({ key: `route-${r.id}`, text: r.label, x: mid[0], y: mid[1], priority: r.style === 'rejected' ? 95 : r.style === 'pending' ? 75 : 45, color: styleColor })
      }
    }
  }

  function drawBuildings(): void {
    if (!buildingsVisible) return
    const m = mpp()
    for (const b of buildings) {
      if (b.footprint.length < 3) continue
      const pts = pathOf(b.footprint)
      const lift = Math.min(120, b.heightM / m)
      const target = b.highlight === 'target'
      const selected = b.highlight === 'selected' || b.selected
      const muted = b.highlight === 'disabled'
      // 白模观感：顶面近白、侧面略暗，选中/目标楼栋用淡绿/暖色顶面区分
      const topColor = target ? '#F3D9C6' : selected ? '#E6F8EA' : '#E9E7E0'
      const sideColor = target ? '#C79A83' : selected ? '#B9CFBE' : '#A9AAA4'
      ctx.save()
      ctx.globalAlpha = muted ? 0.45 : 1
      // 侧面（只画下方两条边，形成伪 3D）
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]
        const b2 = pts[(i + 1) % pts.length]
        const midY = (a[1] + b2[1]) / 2
        if (midY < pts.reduce((s, p) => s + p[1], 0) / pts.length) continue
        ctx.beginPath()
        ctx.moveTo(a[0], a[1])
        ctx.lineTo(b2[0], b2[1])
        ctx.lineTo(b2[0], b2[1] - lift)
        ctx.lineTo(a[0], a[1] - lift)
        ctx.closePath()
        ctx.fillStyle = sideColor
        ctx.fill()
      }
      // 顶面
      ctx.beginPath()
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y - lift) : ctx.lineTo(x, y - lift)))
      ctx.closePath()
      ctx.fillStyle = topColor
      ctx.fill()
      ctx.strokeStyle = selected ? COLORS.fenceStroke : target ? COLORS.pending : 'rgba(70,74,67,0.4)'
      ctx.lineWidth = selected ? 2.2 : 1
      ctx.stroke()
      ctx.restore()
      if (b.label && !hazards.some(hazard => hazard.kind === 'urgency' && hazard.id === b.id && hazard.label)) {
        const c = project(b.footprint.reduce((acc, p) => [acc[0] + p[0] / b.footprint.length, acc[1] + p[1] / b.footprint.length] as LngLat, [0, 0] as LngLat))
        labels.push({ key: `building-${b.id}`, text: b.label, x: c[0], y: c[1] - lift, priority: selected ? 110 : target ? 85 : 30, color: selected ? COLORS.fenceStroke : COLORS.text })
      }
    }
  }

  const RELAY_TEXT: Record<string, string> = {
    pending_arrival: '待到达',
    pending_handover: '待交接',
    relayed: '已接力',
    delivered: '已送达',
    blocked: '受阻',
  }

  function drawMarkers(): void {
    for (const mk of markers) {
      const [x, y] = project(mk.lngLat)
      const size = mk.size === 'lg' ? 26 : mk.size === 'sm' ? 14 : 20
      const roleColor =
        mk.kind === 'agent-external' ? MAP_COLORS.external : mk.kind === 'agent-internal' ? MAP_COLORS.internal : mk.kind === 'agent-firefighter' ? MAP_COLORS.firefighter : mk.kind === 'evacuation' ? MAP_COLORS.evacuation : null
      const color = roleColor ?? (
        mk.kind === 'pharmacy'
          ? '#8FD4F4'
          : mk.kind === 'agent-waiting'
            ? COLORS.pending
            : mk.kind === 'origin'
              ? COLORS.text2
              : COLORS.text
      )
      ctx.save()
      ctx.shadowColor = 'rgba(40,40,36,0.12)'
      ctx.shadowBlur = 6
      ctx.fillStyle = roleColor ?? (mk.selected ? COLORS.fenceStroke : color)
      ctx.strokeStyle = mk.selected && roleColor ? COLORS.text : '#102724'
      ctx.lineWidth = mk.selected && roleColor ? 3 : 2
      ctx.beginPath()
      if (mk.kind === 'gate') {
        ctx.rect(x - size / 2, y - size / 2, size, size)
      } else if (mk.kind === 'staging') {
        ctx.moveTo(x, y - size / 2)
        ctx.lineTo(x + size / 2, y)
        ctx.lineTo(x, y + size / 2)
        ctx.lineTo(x - size / 2, y)
        ctx.closePath()
      } else {
        ctx.arc(x, y, size / 2, 0, Math.PI * 2)
      }
      ctx.fill()
      ctx.stroke()
      ctx.restore()
      if (mk.label || mk.relayState) {
        const state = mk.relayState ? RELAY_TEXT[mk.relayState] ?? '' : ''
        const parts = (mk.label ?? '').split(' · ')
        const compact = parts.slice(0, 2).join(' · ')
        const withState = (text: string): string => state && !text.includes(state) ? `${text}${text ? ' · ' : ''}${state}` : text
        const blocked = mk.relayState === 'blocked'
        labels.push({
          key: `marker-${mk.id}`, text: withState(mk.selected ? mk.label ?? '' : compact), compact: withState(compact), x, y,
          priority: mk.selected ? 120 : blocked ? 100 : mk.kind === 'agent-firefighter' ? 90 : mk.relayState === 'pending_handover' ? 80 : mk.kind === 'evacuation' ? 70 : mk.label?.includes('待命') ? 15 : 50,
          color: blocked ? COLORS.closed : roleColor ?? COLORS.text,
        })
      }
    }
  }

  /** All geographic labels share one screen-space pass, including status badges.
   * Geometry and hit targets remain available when a low-priority label cannot fit. */
  function drawLabels(): void {
    const canvasRect = canvas.getBoundingClientRect()
    const workspace = container.closest('.workspace') ?? container
    const occupied: LabelBox[] = Array.from(workspace.querySelectorAll('.console-map-switch, .console-focus-switch, .console-map-key, .map-controls, .map-attribution, .map-object-browser, .map-overlay-top, .fence-toolbar, .workspace-feedback'))
      .filter(element => element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }))
      .map(element => element.getBoundingClientRect())
      .filter(rect => rect.right > canvasRect.left && rect.left < canvasRect.right && rect.bottom > canvasRect.top && rect.top < canvasRect.bottom)
      .map(rect => ({ x: rect.left - canvasRect.left, y: rect.top - canvasRect.top, width: rect.width, height: rect.height }))
    const overlaps = (a: LabelBox, b: LabelBox): boolean => a.x < b.x + b.width + 4 && a.x + a.width + 4 > b.x && a.y < b.y + b.height + 4 && a.y + a.height + 4 > b.y
    const seen = new Set<string>()
    ctx.save()
    ctx.font = "11px 'Segoe UI', 'Microsoft YaHei', sans-serif"
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    for (const label of [...labels].sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key))) {
      if (!label.text || seen.has(label.text) || label.x < -16 || label.x > w + 16 || label.y < -16 || label.y > h + 16) continue
      let placed: { box: LabelBox; text: string } | undefined
      for (const text of label.compact && label.compact !== label.text ? [label.text, label.compact] : [label.text]) {
        const width = Math.ceil(ctx.measureText(text).width) + 12
        if (width > w - 20) continue
        // Keep labels near their object; critical labels get extra rows before
        // lower-priority names are considered. Every candidate stays on screen.
        const offsets = [[12, -10], [-width - 12, -10], [-width / 2, -32], [-width / 2, 12], [-width / 2, -56], [-width / 2, 36], [-width - 12, -56], [12, 36]]
        if (label.priority >= 80) offsets.push([-width / 2, -80], [-width / 2, 60], [-width / 2, -104], [-width / 2, 84])
        for (const [dx, dy] of offsets) {
          const box = { x: Math.max(10, Math.min(w - width - 10, label.x + dx)), y: Math.max(10, Math.min(h - 30, label.y + dy)), width, height: 20 }
          if (occupied.some(other => overlaps(box, other))) continue
          placed = { box, text }
          break
        }
        if (placed) break
      }
      if (!placed) continue
      const { box, text } = placed
      occupied.push(box)
      seen.add(label.text)
      ctx.strokeStyle = 'rgba(75,81,71,0.35)'
      ctx.lineWidth = 1
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.moveTo(label.x, label.y)
      ctx.lineTo(Math.max(box.x, Math.min(box.x + box.width, label.x)), Math.max(box.y, Math.min(box.y + box.height, label.y)))
      ctx.stroke()
      ctx.fillStyle = 'rgba(255,255,253,0.96)'
      ctx.beginPath()
      ctx.roundRect(box.x, box.y, box.width, box.height, 3)
      ctx.fill()
      ctx.fillStyle = mapLabelColor(label.color)
      ctx.fillText(text, box.x + 6, box.y + 10)
    }
    ctx.restore()
  }

  function drawFenceEditor(): void {
    if (fence.mode === 'off') return
    const draft = fence.draft
    const n = draft.length
    const ring = fence.closed && n > 2
    // 矩形围栏预览
    if (fence.mode === 'draw' && fence.rectAnchor && fence.hoverPoint) {
      const a = project(fence.rectAnchor)
      const b = project(fence.hoverPoint)
      ctx.save()
      ctx.fillStyle = 'rgba(84,133,107,0.08)'
      ctx.strokeStyle = 'rgba(84,133,107,0.9)'
      ctx.lineWidth = 2.5
      ctx.setLineDash([7, 5])
      ctx.beginPath()
      ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))
      ctx.fill()
      ctx.stroke()
      ctx.restore()
    }
    if (n) {
      const pts = pathOf(draft)
      ctx.save()
      // 发光底 + 深色衬底 + 主虚线：与高德适配器同一套视觉
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      const trace = (): void => {
        ctx.beginPath()
        pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
        if (ring) ctx.closePath()
      }
      if (n >= 2) {
        trace()
        ctx.strokeStyle = 'rgba(84,133,107,0.22)'
        ctx.lineWidth = 14
        ctx.stroke()
        trace()
        ctx.strokeStyle = 'rgba(11,26,27,0.5)'
        ctx.lineWidth = 7
        ctx.stroke()
      }
      trace()
      ctx.strokeStyle = '#49775E'
      ctx.lineWidth = 3
      ctx.setLineDash([6, 4])
      ctx.stroke()
      ctx.setLineDash([])
      if (fence.hoverPoint && !fence.closed && n) {
        const last = pts[n - 1]
        const [hx, hy] = project(fence.hoverPoint)
        ctx.strokeStyle = 'rgba(84,133,107,0.55)'
        ctx.lineWidth = 2
        ctx.setLineDash([5, 4])
        ctx.beginPath()
        ctx.moveTo(last[0], last[1])
        ctx.lineTo(hx, hy)
        ctx.stroke()
        if (n >= 3) {
          ctx.strokeStyle = 'rgba(84,133,107,0.28)'
          ctx.beginPath()
          ctx.moveTo(hx, hy)
          ctx.lineTo(pts[0][0], pts[0][1])
          ctx.stroke()
        }
        ctx.setLineDash([])
      }
      // 自交边标红
      for (const [ia, ib] of fence.invalidEdges ?? []) {
        for (const idx of [ia, ib]) {
          if (idx < 0 || idx >= n) continue
          if (!ring && idx + 1 >= n) continue
          const a = pts[idx]
          const b = pts[(idx + 1) % n]
          ctx.strokeStyle = 'rgba(255,107,107,0.95)'
          ctx.lineWidth = 5
          ctx.beginPath()
          ctx.moveTo(a[0], a[1])
          ctx.lineTo(b[0], b[1])
          ctx.stroke()
        }
      }
      // 编辑模式：边中点「＋」手柄
      if (fence.mode === 'edit') {
        for (let i = 0; i < n; i++) {
          if (!ring && i + 1 >= n) continue
          const a = pts[i]
          const b = pts[(i + 1) % n]
          const mx = (a[0] + b[0]) / 2
          const my = (a[1] + b[1]) / 2
          ctx.fillStyle = 'rgba(255,255,255,0.85)'
          ctx.strokeStyle = 'rgba(84,133,107,0.75)'
          ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.arc(mx, my, 8, 0, Math.PI * 2)
          ctx.fill()
          ctx.stroke()
          ctx.strokeStyle = '#49775E'
          ctx.beginPath()
          ctx.moveTo(mx - 3.5, my)
          ctx.lineTo(mx + 3.5, my)
          ctx.moveTo(mx, my - 3.5)
          ctx.lineTo(mx, my + 3.5)
          ctx.stroke()
        }
      }
      pts.forEach(([x, y], i) => {
        const bad = fence.invalidPoint === i
        const snap = i === 0 && fence.mode === 'draw' && Boolean(fence.snapFirst)
        if (snap) {
          ctx.strokeStyle = 'rgba(84,133,107,0.55)'
          ctx.lineWidth = 3
          ctx.beginPath()
          ctx.arc(x, y, 14, 0, Math.PI * 2)
          ctx.stroke()
        }
        const r = snap ? 7 : 4
        ctx.fillStyle = bad ? COLORS.closed : '#FFFFFF'
        ctx.strokeStyle = bad ? '#FFD3BA' : COLORS.fenceStroke
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.rect(x - r, y - r, r * 2, r * 2)
        ctx.fill()
        ctx.stroke()
      })
      ctx.restore()
    }
  }

  function draw(): void {
    labels = []
    ctx.save()
    ctx.fillStyle = COLORS.bg
    ctx.fillRect(0, 0, w, h)
    ctx.restore()
    drawBasemap()
    drawPolygons()
    drawFlood()
    drawRoads()
    drawRoutes()
    drawBuildings()
    // 灾情图层放在楼栋之后：地震受损的 hazard.path 就是楼栋轮廓，
    // 早画会被楼栋填充完全盖住（火灾烟雾半径大，顺序影响不明显，但同理）。
    drawHazards()
    drawMarkers()
    drawLabels()
    drawFenceEditor()
  }

  // ---------------- 交互 ----------------

  interface DragState {
    mode: 'pan' | 'vertex' | 'building' | 'none'
    startX: number
    startY: number
    lastX: number
    lastY: number
    moved: boolean
    vertexIndex?: number
    buildingId?: string
  }
  let drag: DragState = { mode: 'none', startX: 0, startY: 0, lastX: 0, lastY: 0, moved: false }

  function localXY(e: MouseEvent): [number, number] {
    const r = canvas.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }

  function hitVertex(x: number, y: number): number | null {
    if (fence.mode !== 'edit') return null
    for (let i = 0; i < fence.draft.length; i++) {
      const [vx, vy] = project(fence.draft[i])
      if (Math.hypot(vx - x, vy - y) <= 9) return i
    }
    return null
  }

  function hitMidpoint(x: number, y: number): { index: number; lngLat: LngLat } | null {
    if (fence.mode !== 'edit') return null
    const n = fence.draft.length
    const ring = fence.closed && n > 2
    for (let i = 0; i < n; i++) {
      if (!ring && i + 1 >= n) continue
      const a = fence.draft[i]
      const b = fence.draft[(i + 1) % n]
      const mid: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
      const [mx, my] = project(mid)
      if (Math.hypot(mx - x, my - y) <= 9) return { index: i, lngLat: mid }
    }
    return null
  }

  function pointInPoly(x: number, y: number, poly: Array<[number, number]>): boolean {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]
      const b = poly[j]
      if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
    }
    return inside
  }

  function hitBuilding(x: number, y: number): string | null {
    for (let i = buildings.length - 1; i >= 0; i--) {
      const b = buildings[i]
      if (!b.draggable) continue
      if (pointInPoly(x, y, pathOf(b.footprint))) return b.id
    }
    return null
  }

  function hitMarker(x: number, y: number): MarkerSpec | null {
    for (let i = markers.length - 1; i >= 0; i--) {
      const [mx, my] = project(markers[i].lngLat)
      if (Math.hypot(mx - x, my - y) <= 13) return markers[i]
    }
    return null
  }

  function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    if (len2 === 0) return Math.hypot(px - ax, py - ay)
    let t = ((px - ax) * dx + (py - ay) * dy) / len2
    t = Math.max(0, Math.min(1, t))
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
  }

  function hitRoad(x: number, y: number): string | null {
    for (const road of roads) {
      const pts = pathOf(road.path)
      for (let i = 0; i < pts.length - 1; i++) {
        if (distToSeg(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]) <= 8) return road.id
      }
    }
    return null
  }

  function onPointerDown(e: MouseEvent): void {
    if (e.button !== 0) return
    const [x, y] = localXY(e)
    const v = events.collectingPoints ? null : hitVertex(x, y)
    if (v !== null) {
      drag = { mode: 'vertex', startX: x, startY: y, lastX: x, lastY: y, moved: false, vertexIndex: v }
      canvas.style.cursor = 'grabbing'
      return
    }
    const b = events.collectingPoints ? null : hitBuilding(x, y)
    if (b) {
      drag = { mode: 'building', startX: x, startY: y, lastX: x, lastY: y, moved: false, buildingId: b }
      canvas.style.cursor = 'grabbing'
      return
    }
    drag = { mode: 'pan', startX: x, startY: y, lastX: x, lastY: y, moved: false }
    canvas.style.cursor = 'grabbing'
  }

  function onPointerMove(e: MouseEvent): void {
    const [x, y] = localXY(e)
    if (drag.mode === 'none') {
      events.onMouseMove?.(unproject(x, y))
      return
    }
    const dx = x - drag.lastX
    const dy = y - drag.lastY
    if (Math.abs(x - drag.startX) > 3 || Math.abs(y - drag.startY) > 3) drag.moved = true
    if (drag.mode === 'pan') {
      const m = mpp()
      view.center = [
        view.center[0] - (dx * m) / (M_PER_DEG_LNG * Math.cos((lat0 * Math.PI) / 180)),
        view.center[1] + (dy * m) / M_PER_DEG_LAT,
      ]
      drag.lastX = x
      drag.lastY = y
      draw()
      return
    }
    if (drag.mode === 'vertex' && drag.vertexIndex !== undefined) {
      events.onVertexDrag?.(drag.vertexIndex, unproject(x, y))
      drag.lastX = x
      drag.lastY = y
      return
    }
    if (drag.mode === 'building' && drag.buildingId) {
      events.onBuildingDrag?.(drag.buildingId, unproject(x, y))
      drag.lastX = x
      drag.lastY = y
    }
  }

  function onPointerUp(e: MouseEvent): void {
    const [x, y] = localXY(e)
    const wasPan = drag.mode === 'pan'
    const moved = drag.moved
    if (drag.mode === 'vertex' && drag.vertexIndex !== undefined && moved) {
      events.onVertexDragEnd?.(drag.vertexIndex, unproject(x, y))
    } else if (drag.mode === 'building' && drag.buildingId) {
      if (moved) events.onBuildingDragEnd?.(drag.buildingId, unproject(x, y))
      else events.onBuildingClick?.(drag.buildingId)
    } else if (wasPan && !moved && events.collectingPoints) {
      events.onClick?.(unproject(x, y))
    } else if (wasPan && !moved) {
      // 单击：优先命中围栏边中点（插点）/ 标记 / 路段 / 空白
      const mid = hitMidpoint(x, y)
      if (mid) events.onVertexInsert?.(mid.index, mid.lngLat)
      else {
        const mk = hitMarker(x, y)
        if (mk) events.onMarkerClick?.(mk.id, mk.kind)
        else {
          const road = hitRoad(x, y)
          if (road) events.onRoadClick?.(road)
          else events.onClick?.(unproject(x, y))
        }
      }
    }
    if (wasPan || moved) events.onCameraChange?.(view.center, view.zoom)
    drag = { mode: 'none', startX: 0, startY: 0, lastX: 0, lastY: 0, moved: false }
    canvas.style.cursor = fence.mode === 'draw' ? 'crosshair' : 'grab'
  }

  function onContextMenu(e: MouseEvent): void {
    if (fence.mode !== 'edit') return
    const [x, y] = localXY(e)
    const v = hitVertex(x, y)
    if (v !== null) {
      e.preventDefault()
      events.onVertexDelete?.(v)
    }
  }

  function onDblClick(e: MouseEvent): void {
    // 双击只做围栏收尾：挡掉默认手势（选中文本 / 缩放），页面不会因此重载
    e.preventDefault()
    e.stopPropagation()
    const [x, y] = localXY(e)
    events.onDblClick?.(unproject(x, y))
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault()
    const [x, y] = localXY(e)
    const before = unproject(x, y)
    const next = Math.max(12, Math.min(20, view.zoom - Math.sign(e.deltaY) * 0.35))
    if (next === view.zoom) return
    view.zoom = next
    const after = unproject(x, y)
    view.center = [view.center[0] + (before[0] - after[0]), view.center[1] + (before[1] - after[1])]
    draw()
    events.onCameraChange?.(view.center, view.zoom)
  }

  const controls = document.createElement('div')
  controls.className = 'map-controls'
  controls.setAttribute('role', 'group')
  controls.setAttribute('aria-label', '地图视角')
  const viewActions = [
    { label: '地图放大', text: '+', run: () => { view.zoom = Math.min(20, view.zoom + 0.5) } },
    { label: '地图缩小', text: '−', run: () => { view.zoom = Math.max(12, view.zoom - 0.5) } },
    { label: '地图复位', text: '↺', run: () => { view.zoom = opts.zoom ?? 16; view.center = opts.center ?? view.center } },
  ]
  for (const action of viewActions) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'sb-btn'
    button.textContent = action.text
    button.title = action.label
    button.setAttribute('aria-label', action.label)
    button.addEventListener('click', () => {
      action.run()
      draw()
      events.onCameraChange?.(view.center, view.zoom)
    })
    controls.appendChild(button)
  }
  const attribution = document.createElement('span')
  attribution.className = 'map-attribution'
  attribution.textContent = '示例地图 · 非真实地理数据'
  canvas.setAttribute('aria-label', '社区地图')
  container.append(controls, attribution)

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('dblclick', onDblClick)
  canvas.addEventListener('contextmenu', onContextMenu)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  const workspace = container.closest('.workspace') ?? container
  workspace.addEventListener('toggle', draw, true)

  resize()

  const adapter: MapAdapter = {
    kind: 'fallback',
    ready: true,
    addFenceEditor(o: FenceEditorOptions) {
      fence = o
      canvas.style.cursor = o.mode === 'draw' ? 'crosshair' : 'grab'
      draw()
    },
    setBuildings(list: BuildingSpec[], visible: boolean) {
      buildings = list.map((b) => ({ ...b, footprint: b.footprint.map((p) => [p[0], p[1]] as LngLat) }))
      buildingsVisible = visible
      draw()
    },
    setPolygons(list: PolygonSpec[]) {
      polygons = list
      draw()
    },
    setRoads(list) {
      roads = list
      draw()
    },
    setRoutes(list) {
      routes = list
      draw()
    },
    setMarkers(list: MarkerSpec[]) {
      markers = list
      draw()
    },
    setFlood(list) {
      flood = list
      draw()
    },
    setHazards(list: HazardSpec[]) {
      hazards = list
      draw()
    },
    setBasemapBuildings(visible: boolean) {
      basemapVisible = visible
      draw()
    },
    flyTo(center: LngLat, zoom: number, o) {
      const from = { center: view.center, zoom: view.zoom }
      const dur = Math.max(120, o?.durationMs ?? 600)
      const t0 = performance.now()
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / dur)
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
        view.center = [from.center[0] + (center[0] - from.center[0]) * e, from.center[1] + (center[1] - from.center[1]) * e]
        view.zoom = from.zoom + (zoom - from.zoom) * e
        draw()
        if (k < 1) requestAnimationFrame(step)
        else events.onCameraChange?.(view.center, view.zoom)
      }
      requestAnimationFrame(step)
    },
    fitBounds(points: LngLat[], padding = 48) {
      if (!points.length) return
      const xs = points.map((p) => p[0])
      const ys = points.map((p) => p[1])
      const minX = Math.min(...xs)
      const maxX = Math.max(...xs)
      const minY = Math.min(...ys)
      const maxY = Math.max(...ys)
      const cx = (minX + maxX) / 2
      const cy = (minY + maxY) / 2
      const spanX = Math.max(1e-6, (maxX - minX) * M_PER_DEG_LNG * Math.cos((lat0 * Math.PI) / 180))
      const spanY = Math.max(1e-6, (maxY - minY) * M_PER_DEG_LAT)
      const usableW = Math.max(80, w - padding * 2)
      const usableH = Math.max(80, h - padding * 2)
      const zoomX = Math.log2((156543.03392 * Math.cos((lat0 * Math.PI) / 180) * usableW) / spanX)
      const zoomY = Math.log2((156543.03392 * Math.cos((lat0 * Math.PI) / 180) * usableH) / spanY)
      adapter.flyTo([cx, cy], Math.max(12, Math.min(19.5, Math.min(zoomX, zoomY))), { durationMs: 520 })
    },
    getCenter: () => view.center,
    getZoom: () => view.zoom,
    debugProject: (p: LngLat) => project(p),
    setEvents(ev: MapEvents) {
      events = ev
    },
    destroy() {
      workspace.removeEventListener('toggle', draw, true)
      ro.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('dblclick', onDblClick)
      canvas.removeEventListener('contextmenu', onContextMenu)
      canvas.removeEventListener('wheel', onWheel)
      canvas.remove()
      controls.remove()
      attribution.remove()
    },
  }
  return adapter
}
