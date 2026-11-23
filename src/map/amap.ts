import type { HazardSpec } from '../domain/disaster/types.ts'
import { MAP_COLORS } from './palette.ts'
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
 * 高德地图 JS API 2.0 适配器。
 *
 * 关键限制（必须让用户知道）：
 *   高德 JS API 2.0 **没有**按多边形局部隐藏底图楼块的稳定接口，
 *   只能整体开关白模（setStatus({isBuildingBlock})）。
 *   因此围栏内的原始楼块无法单独去掉；用户楼栋画在独立的 3D 图层上，
 *   与底图白模可能视觉重叠。界面里必须提供“背景楼块开关”并说明这个限制。
 *
 * 密钥约束：Web Key 由服务端 /api/amap/config 下发（前端 JS API 必需），
 * 安全密钥 securityJsCode 走 /api/amap/security 同源代理，都不写进源码或日志。
 */

type LngLat = [number, number]

const GCJ_A = 6378245.0
const GCJ_EE = 0.00669342162296594323

function outOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(x: number, y: number): number {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3
  ret += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3
  ret += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3
  return ret
}

function transformLon(x: number, y: number): number {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3
  ret += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3
  ret += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3
  return ret
}

/** WGS-84 → GCJ-02（内部统一 WGS-84，只有地图出入口转换） */
export function wgs84ToGcj02(p: LngLat): LngLat {
  const [lng, lat] = p
  if (outOfChina(lng, lat)) return [lng, lat]
  let dLat = transformLat(lng - 105, lat - 35)
  let dLon = transformLon(lng - 105, lat - 35)
  const radLat = (lat / 180) * Math.PI
  let magic = Math.sin(radLat)
  magic = 1 - GCJ_EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI)
  dLon = (dLon * 180) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI)
  return [lng + dLon, lat + dLat]
}

export function gcj02ToWgs84(p: LngLat): LngLat {
  const [lng, lat] = p
  if (outOfChina(lng, lat)) return [lng, lat]
  const [glng, glat] = wgs84ToGcj02(p)
  return [lng * 2 - glng, lat * 2 - glat]
}

declare global {
  interface Window {
    AMap?: any
    _AMapSecurityConfig?: { securityJsCode?: string }
  }
}

export interface AmapCreateResult {
  adapter: MapAdapter | null
  error?: string
  /** 楼栋渲染模式：3D 体块 / 降级为底面多边形 */
  buildingMode?: '3d' | 'flat'
}

interface AmapConfigResponse {
  ok: boolean
  jsVersion: string
  webKey: string | null
  securityCodeConfigured: boolean
  securityCodePath: string
  allowSample: boolean
  message: string
}

async function fetchConfig(): Promise<AmapConfigResponse | null> {
  try {
    const res = await fetch('/api/amap/config', { headers: { accept: 'application/json' } })
    if (!res.ok) return null
    return (await res.json()) as AmapConfigResponse
  } catch {
    return null
  }
}

let scriptLoad: Promise<void> | undefined

function loadScript(key: string, version: string): Promise<void> {
  if (window.AMap) return Promise.resolve()
  scriptLoad ??= new Promise<void>((resolve, reject) => {
    const src = `https://webapi.amap.com/maps?v=${encodeURIComponent(version)}&key=${encodeURIComponent(key)}&plugin=AMap.Scale,AMap.ToolBar`
    const script = document.createElement('script')
    script.src = src
    script.async = true
    function fail(message: string): void {
      window.clearTimeout(timer)
      script.remove()
      reject(new Error(message))
    }
    const timer = window.setTimeout(() => fail('脚本加载超时（10 秒）'), 10000)
    script.onload = () => {
      window.clearTimeout(timer)
      if (window.AMap) resolve()
      else fail('脚本已加载但 window.AMap 不存在')
    }
    script.onerror = () => fail('脚本请求失败（网络或 Key 被拒绝）')
    document.head.appendChild(script)
  }).catch((error) => {
    scriptLoad = undefined
    throw error
  })
  return scriptLoad
}

const ROAD_STYLE: Record<RoadLineStyle, { color: string; dashed: boolean; width: number }> = {
  open: { color: '#8FBF4E', dashed: false, width: 5 },
  suggested: { color: '#FFAE84', dashed: true, width: 3 },
  closed: { color: MAP_COLORS.blocked, dashed: true, width: 5 },
}

const ROUTE_STYLE: Record<PlanLineStyle, { color: string; dashed: boolean }> = {
  approved: { color: MAP_COLORS.active, dashed: false },
  pending: { color: MAP_COLORS.pending, dashed: true },
  rejected: { color: MAP_COLORS.blocked, dashed: true },
  baseline: { color: MAP_COLORS.original, dashed: true },
  evacuation: { color: MAP_COLORS.evacuation, dashed: true },
  response: { color: MAP_COLORS.firefighter, dashed: true },
}

const RELAY_TEXT: Record<string, string> = {
  pending_arrival: '待到达',
  pending_handover: '待交接',
  relayed: '已接力',
  delivered: '已送达',
  blocked: '受阻',
}

export async function createAmapAdapter(container: HTMLDivElement, opts: { center?: LngLat; zoom?: number; intro?: boolean; signal?: AbortSignal } = {}): Promise<AmapCreateResult> {
  const cfg = await fetchConfig()
  if (opts.signal?.aborted) return { adapter: null }
  if (!cfg) {
    return { adapter: null, error: '无法连接本地服务 /api/amap/config：请确认 npm run dev 已启动 API 服务' }
  }
  if (!cfg.ok || !cfg.webKey) {
    return { adapter: null, error: `未配置高德 Web Key：${cfg.message || '请在 .env 中设置 AMAP_WEB_KEY'}` }
  }
  if (cfg.securityCodeConfigured) {
    try {
      const res = await fetch(cfg.securityCodePath || '/api/amap/security')
      const data = (await res.json()) as { securityJsCode: string | null }
      if (data.securityJsCode) window._AMapSecurityConfig = { securityJsCode: data.securityJsCode }
    } catch {
      // 安全密钥取不到时仍尝试加载，让高德自己报错，界面能看到真实原因
    }
  }
  try {
    await loadScript(cfg.webKey, cfg.jsVersion || '2.0')
  } catch (err) {
    return { adapter: null, error: `高德地图 JS API 加载失败：${(err as Error).message}` }
  }
  if (opts.signal?.aborted) return { adapter: null }
  const AMap = window.AMap
  if (!AMap) return { adapter: null, error: '高德地图 JS API 加载失败：window.AMap 未定义' }

  const gcj = (p: LngLat): [number, number] => {
    const g = wgs84ToGcj02(p)
    return [g[0], g[1]]
  }
  const wgs = (p: { lng: number; lat: number } | [number, number]): LngLat =>
    Array.isArray(p) ? gcj02ToWgs84([p[0], p[1]]) : gcj02ToWgs84([p.lng, p.lat])

  const finalZoom = opts.zoom ?? 16
  const finalPitch = 54
  const playIntro = opts.intro && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const startZoom = finalZoom - 3
  const startPitch = 12
  const map = new AMap.Map(container, {
    viewMode: '3D',
    pitch: playIntro ? startPitch : finalPitch,
    rotateEnable: true,
    showBuildingBlock: true,
    showLabel: true,
    mapStyle: 'amap://styles/light',
    center: gcj(opts.center ?? [121.4737, 31.2304]),
    zoom: playIntro ? startZoom : finalZoom,
    resizeEnable: true,
    // 双击要用来收尾围栏，不能让高德拿去做缩放动画
    doubleClickZoom: false,
  })
  // 兜底：构造参数在个别版本不生效，软更新只改这一项，不动其它地图状态（白模/俯仰保持原样）
  map.setStatus({ doubleClickZoom: false }, true)

  const introInput = new AbortController()
  let introWait = 0
  let introFrame = 0
  function stopIntro(): void {
    introInput.abort()
    window.clearTimeout(introWait)
    cancelAnimationFrame(introFrame)
    if (playIntro) map.off('complete', startIntro)
  }
  function startIntro(): void {
    if (introInput.signal.aborted || introFrame) return
    window.clearTimeout(introWait)
    const start = performance.now()
    const move = (now: number): void => {
      const progress = Math.min(1, (now - start) / 1050)
      const ease = 1 - (1 - progress) ** 3
      map.setZoom(startZoom + (finalZoom - startZoom) * ease, true)
      map.setPitch(startPitch + (finalPitch - startPitch) * ease, true)
      if (progress < 1) introFrame = requestAnimationFrame(move)
      else stopIntro()
    }
    introFrame = requestAnimationFrame(move)
  }
  if (playIntro) {
    const inputOptions = { capture: true, passive: true, signal: introInput.signal }
    window.addEventListener('pointerdown', stopIntro, inputOptions)
    window.addEventListener('wheel', stopIntro, inputOptions)
    window.addEventListener('keydown', stopIntro, inputOptions)
    introWait = window.setTimeout(startIntro, 1200)
    map.on('complete', startIntro)
  }

  let events: MapEvents = {}
  let buildingsVisible = true
  let buildingMode: '3d' | 'flat' = 'flat'
  let object3dLayer: any = null
  const layerOverlays: Record<'buildings' | 'polygons' | 'roads' | 'routes' | 'markers' | 'flood', any[]> = {
    buildings: [], polygons: [], roads: [], routes: [], markers: [], flood: [],
  }
  let hazardOverlays: any[] = []
  let editorOverlays: any[] = []

  function clearLayer(layer: keyof typeof layerOverlays): any[] {
    if (layerOverlays[layer].length) map.remove(layerOverlays[layer])
    layerOverlays[layer] = []
    return layerOverlays[layer]
  }
  function clearEditor(): void {
    if (editorOverlays.length) map.remove(editorOverlays)
    editorOverlays = []
  }

  // 3D 楼栋图层：优先 Object3DLayer，失败则降级为多边形
  try {
    if (AMap.Object3DLayer && AMap.Object3D && AMap.Object3D.Prism) {
      object3dLayer = new AMap.Object3DLayer({ zIndex: 130 })
      map.add(object3dLayer)
      buildingMode = '3d'
    }
  } catch {
    buildingMode = 'flat'
  }

  map.on('click', (e: any) => {
    if (!events.collectingPoints && e?.lnglat) events.onClick?.(wgs(e.lnglat))
  })
  let pointerStart: { id: number; x: number; y: number } | null = null
  function onPointerDown(e: PointerEvent): void {
    if (!e.isPrimary || e.button !== 0) return
    pointerStart = null
    if (!events.collectingPoints) return
    if (e.target instanceof Element && e.target.closest('.amap-controls, .amap-logo, .amap-copyright')) return
    pointerStart = { id: e.pointerId, x: e.clientX, y: e.clientY }
  }
  function onPointerMove(e: PointerEvent): void {
    if (pointerStart?.id === e.pointerId && Math.hypot(e.clientX - pointerStart.x, e.clientY - pointerStart.y) > 5) pointerStart = null
  }
  function pointFromMouse(e: MouseEvent): LngLat {
    const rect = container.getBoundingClientRect()
    const p = map.containerToLngLat(new AMap.Pixel(e.clientX - rect.left, e.clientY - rect.top))
    return wgs([p.getLng(), p.getLat()])
  }
  // 采点使用原生指针释放，避免依赖 SDK 点击或被重绘图层吞掉的 click。
  function onPointerUp(e: PointerEvent): void {
    onPointerMove(e)
    if (pointerStart?.id !== e.pointerId) return
    pointerStart = null
    if (events.collectingPoints) events.onClick?.(pointFromMouse(e))
  }
  function onPointerCancel(e: PointerEvent): void {
    if (pointerStart?.id === e.pointerId) pointerStart = null
  }
  function onContainerDblClick(e: MouseEvent): void {
    e.preventDefault()
    e.stopPropagation()
    events.onDblClick?.(pointFromMouse(e))
  }
  container.addEventListener('pointerdown', onPointerDown, true)
  container.addEventListener('pointermove', onPointerMove, true)
  container.addEventListener('pointerup', onPointerUp, true)
  container.addEventListener('pointercancel', onPointerCancel, true)
  container.addEventListener('dblclick', onContainerDblClick, true)
  map.on('mousemove', (e: any) => {
    events.onMouseMove?.(e?.lnglat ? wgs(e.lnglat) : null)
  })
  map.on('zoomend', () => events.onCameraChange?.(wgs(map.getCenter()), map.getZoom()))
  map.on('moveend', () => events.onCameraChange?.(wgs(map.getCenter()), map.getZoom()))

  const adapter: MapAdapter = {
    kind: 'amap',
    ready: true,
    addFenceEditor(o: FenceEditorOptions) {
      clearEditor()
      if (o.mode === 'off') return
      const path = o.draft.map(gcj)
      const n = path.length
      const ring = o.closed && n > 2
      if (n >= 2) {
        const full = ring ? [...path, path[0]] : path
        // 先铺一层低透明度粗线做“发光底”，再叠细亮线：白模地图上也能一眼看见勾画轨迹
        editorOverlays.push(
          new AMap.Polyline({
            path: full,
            strokeColor: '#EAFF9E',
            strokeOpacity: 0.24,
            strokeWeight: 24,
            lineJoin: 'round',
            lineCap: 'round',
          }),
        )
        // 深色描边“衬底”：压过底图上的 POI 文字，勾画线始终可读
        editorOverlays.push(
          new AMap.Polyline({
            path: full,
            strokeColor: '#0B1A1B',
            strokeOpacity: 0.45,
            strokeWeight: 11,
            lineJoin: 'round',
            lineCap: 'round',
          }),
        )
        editorOverlays.push(
          new AMap.Polyline({
            path: full,
            strokeColor: '#EAFF9E',
            strokeOpacity: 1,
            strokeWeight: 6,
            strokeStyle: 'dashed',
            lineJoin: 'round',
            lineCap: 'round',
            zIndex: 130,
          }),
        )
      }
      // 矩形围栏预览：第一个角点 + 光标位置实时画出矩形
      if (o.mode === 'draw' && o.rectAnchor && o.hoverPoint) {
        const a = gcj(o.rectAnchor)
        const b = gcj(o.hoverPoint)
        const rect: Array<[number, number]> = [a, [b[0], a[1]], b, [a[0], b[1]]]
        editorOverlays.push(new AMap.Polygon({ path: rect, fillColor: '#C3F477', fillOpacity: 0.08, strokeWeight: 0, zIndex: 100 }))
        editorOverlays.push(new AMap.Polyline({ path: [...rect, a], strokeColor: '#D9FF9A', strokeOpacity: 0.9, strokeWeight: 4, strokeStyle: 'dashed', zIndex: 131 }))
      }
      if (o.hoverPoint && n) {
        editorOverlays.push(new AMap.Polyline({ path: [path[n - 1], gcj(o.hoverPoint)], strokeColor: '#D9FF9A', strokeOpacity: 0.7, strokeWeight: 3.5, strokeStyle: 'dashed' }))
        // 闭合预览：光标 → 起点，让用户提前看到围合后的形状
        if (!o.closed && n >= 3) {
          editorOverlays.push(new AMap.Polyline({ path: [gcj(o.hoverPoint), path[0]], strokeColor: '#D9FF9A', strokeOpacity: 0.35, strokeWeight: 2.5, strokeStyle: 'dashed' }))
        }
      }
      // 自交边标红：只画真实存在的边（未闭合时没有首尾相连那条）
      for (const [ia, ib] of o.invalidEdges ?? []) {
        for (const idx of [ia, ib]) {
          if (idx < 0 || idx >= n) continue
          if (!ring && idx + 1 >= n) continue
          editorOverlays.push(new AMap.Polyline({ path: [path[idx], path[(idx + 1) % n]], strokeColor: '#FF6B6B', strokeOpacity: 0.95, strokeWeight: 7, lineCap: 'round', zIndex: 132 }))
        }
      }
      if (o.mode === 'draw') {
        o.draft.forEach((p, i) => {
          const snap = i === 0 && Boolean(o.snapFirst)
          const size = snap ? 22 : 12
          editorOverlays.push(
            new AMap.Marker({
              position: gcj(p),
              bubble: true,
              content: `<div class="fence-vertex${snap ? ' is-snap' : ''}" style="width:${size}px;height:${size}px"></div>`,
              offset: new AMap.Pixel(-size / 2, -size / 2),
              zIndex: 140,
            }),
          )
        })
      }
      if (o.mode === 'edit') {
        o.draft.forEach((p, i) => {
          const marker = new AMap.Marker({
            position: gcj(p),
            draggable: true,
            content: `<div style="width:16px;height:16px;background:${o.invalidPoint === i ? '#FF6B6B' : '#102724'};border:3px solid ${o.invalidPoint === i ? '#FFD3BA' : '#D9FF9A'};border-radius:3px;box-shadow:0 0 0 3px rgba(195,244,119,0.25)"></div>`,
            offset: new AMap.Pixel(-8, -8),
            zIndex: 140,
          })
          marker.on('dragging', (e: any) => events.onVertexDrag?.(i, wgs(e.lnglat)))
          marker.on('dragend', (e: any) => events.onVertexDragEnd?.(i, wgs(e.lnglat)))
          marker.on('rightclick', () => events.onVertexDelete?.(i))
          editorOverlays.push(marker)
        })
        // 边中点「＋」手柄：点击在该边插入新顶点
        for (let i = 0; i < n; i++) {
          if (!ring && i + 1 >= n) continue
          const a = o.draft[i]
          const b = o.draft[(i + 1) % n]
          const mid: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
          const handle = new AMap.Marker({
            position: gcj(mid),
            content: '<div class="fence-midpoint">+</div>',
            offset: new AMap.Pixel(-9, -9),
            zIndex: 139,
          })
          handle.on('click', () => events.onVertexInsert?.(i, mid))
          editorOverlays.push(handle)
        }
      }
      if (editorOverlays.length) map.add(editorOverlays)
    },
    setBuildings(list: BuildingSpec[], visible: boolean) {
      buildingsVisible = visible
      const overlays = clearLayer('buildings')
      if (!visible) {
        if (object3dLayer) object3dLayer.clear()
        return
      }
      if (object3dLayer) object3dLayer.clear()
      for (const b of list) {
        const path = b.footprint.map(gcj)
        const selected = b.highlight === 'selected' || b.selected
        const color = b.highlight === 'target' ? '#B0705A' : selected ? '#5F9A6E' : '#3E6B58'
        if (buildingMode === '3d' && object3dLayer) {
          try {
            const prism = new AMap.Object3D.Prism({
              path,
              height: b.heightM,
              color,
            })
            prism.transparent = false
            object3dLayer.add(prism)
          } catch {
            buildingMode = 'flat'
          }
        }
        // 真实高德下 Prism/Polygon 不能拖动：给可拖动楼栋挂一个透明手柄 Marker，
        // 拖动时把经纬度回传给上层做越界/重叠校验（与示例地图行为一致）。
        if (b.draggable && (events.onBuildingDrag || events.onBuildingDragEnd)) {
          const centerLngLat = b.footprint.reduce<[number, number]>(
            (acc, p) => [acc[0] + p[0] / b.footprint.length, acc[1] + p[1] / b.footprint.length],
            [0, 0],
          )
          const handle = new AMap.Marker({
            position: gcj(centerLngLat as [number, number]),
            draggable: true,
            cursor: 'move',
            zIndex: 150,
            content: `<div class="bld-handle" data-bld="${escapeHtml(b.id)}"></div>`,
            offset: new AMap.Pixel(-9, -9),
          })
          handle.on('dragging', (e: any) => events.onBuildingDrag?.(b.id, wgs(e.lnglat)))
          handle.on('dragend', (e: any) => events.onBuildingDragEnd?.(b.id, wgs(e.lnglat)))
          overlays.push(handle)
        }
        if (buildingMode === 'flat') {
          overlays.push(
            new AMap.Polygon({
              path,
              fillColor: color,
              fillOpacity: 0.82,
              strokeColor: selected ? '#C3F477' : b.highlight === 'target' ? '#FFAE84' : '#6E8F80',
              strokeWeight: selected ? 2.5 : 1,
              zIndex: 120,
            }),
          )
          if (b.label) overlays.push(new AMap.Text({ text: b.label, position: gcj(b.footprint[0]), style: { color: '#F4F8EF', fontSize: '11px', background: 'rgba(16,39,36,0.7)', border: 'none' }, offset: new AMap.Pixel(0, -6) }))
        }
      }
      if (overlays.length) map.add(overlays)
    },
    setPolygons(list: PolygonSpec[]) {
      const overlays = clearLayer('polygons')
      for (const poly of list) {
        if (poly.path.length < 3) continue
        overlays.push(
          new AMap.Polygon({
            path: poly.path.map(gcj),
            fillColor: poly.fill,
            fillOpacity: poly.opacity,
            strokeColor: poly.stroke,
            strokeWeight: poly.strokeWidth,
            strokeStyle: poly.dashed ? 'dashed' : 'solid',
            zIndex: 100,
          }),
        )
      }
      if (overlays.length) map.add(overlays)
    },
    setRoads(list) {
      const overlays = clearLayer('roads')
      for (const road of list) {
        if (road.path.length < 2) continue
        const s = ROAD_STYLE[road.style]
        overlays.push(
          new AMap.Polyline({
            path: road.path.map(gcj),
            strokeColor: s.color,
            strokeWeight: s.width,
            strokeStyle: s.dashed ? 'dashed' : 'solid',
            lineJoin: 'round',
            zIndex: 110,
          }),
        )
      }
      if (overlays.length) map.add(overlays)
    },
    setRoutes(list) {
      const overlays = clearLayer('routes')
      for (const r of list) {
        if (r.path.length < 2) continue
        const s = ROUTE_STYLE[r.style]
        overlays.push(
          new AMap.Polyline({
            path: r.path.map(gcj),
            strokeColor: s.color,
            strokeWeight: r.style === 'approved' ? 6 : 4,
            strokeStyle: s.dashed ? 'dashed' : 'solid',
            lineJoin: 'round',
            zIndex: 140,
          }),
        )
        if (r.label) {
          overlays.push(
            new AMap.Text({
              text: r.label,
              position: gcj(r.path[Math.floor(r.path.length / 2)]),
              style: { color: s.color, fontSize: '11px', background: 'rgba(16,39,36,0.8)', border: 'none', padding: '2px 6px' },
              offset: new AMap.Pixel(0, -10),
            }),
          )
        }
      }
      if (overlays.length) map.add(overlays)
    },
    setMarkers(list: MarkerSpec[]) {
      const overlays = clearLayer('markers')
      for (const mk of list) {
        const relay = mk.relayState ? `<div class="relay-state ${mk.relayState}">${RELAY_TEXT[mk.relayState] ?? ''}</div>` : ''
        const label = mk.label ? `<div class="marker-label">${escapeHtml(mk.label)}</div>` : ''
        const color = mk.kind === 'agent-internal' ? MAP_COLORS.internal
          : mk.kind === 'agent-external' ? MAP_COLORS.external
            : mk.kind === 'agent-firefighter' ? MAP_COLORS.firefighter
              : mk.kind === 'evacuation' ? MAP_COLORS.evacuation
                : mk.kind === 'agent-waiting' ? MAP_COLORS.pending : null
        const marker = new AMap.Marker({
          position: gcj(mk.lngLat),
          draggable: Boolean(mk.draggable),
          content: `<div class="map-marker ${mk.kind} ${mk.size ?? 'md'}${mk.selected ? ' is-selected' : ''}"${color ? ` style="--rescue-color:${color}"` : ''}>${relay}<div class="marker-dot"${color ? ` style="background-color:${color}"` : ''}></div>${label}</div>`,
          offset: new AMap.Pixel(mk.kind.startsWith('agent-') ? -14 : -11, mk.kind.startsWith('agent-') ? -14 : -11),
          zIndex: mk.kind.startsWith('agent') ? 160 : 150,
        })
        marker.on('click', () => events.onMarkerClick?.(mk.id, mk.kind))
        overlays.push(marker)
      }
      if (overlays.length) map.add(overlays)
    },
    setHazards(list: HazardSpec[]) {
      if (hazardOverlays.length) map.remove(hazardOverlays)
      hazardOverlays = []
      for (const h of list) {
        let overlay: any = null
        if (h.kind === 'risk' || h.kind === 'urgency') {
          const focused = h.kind === 'risk' && h.focused
          const color = focused ? '#FFE680' : h.color ?? '#E76E47'
          const style = { strokeColor: color, strokeWeight: focused ? 3 : 2, fillColor: color, fillOpacity: h.kind === 'urgency' ? 0.52 : 0.23, zIndex: h.kind === 'urgency' ? 126 : 125 }
          overlay = h.path ? new AMap.Polygon({ ...style, path: h.path.map(gcj) }) : new AMap.Circle({ ...style, center: gcj(h.center), radius: h.kind === 'risk' ? h.radiusM : 0 })
          if (h.label) {
            const label = new AMap.Text({ text: h.label, position: gcj(h.center), offset: new AMap.Pixel(0, -25), style: { color, fontSize: '12px', background: '#192325', border: 'none', padding: '3px 6px' }, zIndex: 155 })
            label.setMap(map)
            hazardOverlays.push(label)
          }
        } else if (h.kind === 'smoke') {
          overlay = new AMap.Circle({
            center: gcj(h.center),
            radius: h.radiusM,
            strokeColor: '#FFAE84',
            strokeWeight: 2,
            strokeStyle: 'dashed',
            fillColor: '#FFAE84',
            fillOpacity: 0.24,
            zIndex: 60,
          })
        } else if (h.kind === 'fire-origin') {
          overlay = new AMap.Circle({ center: gcj(h.center), radius: 10, strokeColor: '#F4F8EF', strokeWeight: 2, fillColor: '#FF7840', fillOpacity: 0.95, zIndex: 70 })
        } else if (h.kind === 'damage') {
          overlay = new AMap.Polygon({
            path: h.path.map(gcj),
            strokeColor: h.level === '倒塌' || h.level === '严重' ? '#FF7840' : '#FFAE84',
            strokeWeight: 2,
            fillColor: '#FFAE84',
            fillOpacity: h.level === '倒塌' ? 0.5 : h.level === '严重' ? 0.4 : 0.22,
            zIndex: 65,
          })
        } else if (h.kind === 'rupture') {
          overlay = new AMap.Polyline({ path: h.path.map(gcj), strokeColor: '#FF7840', strokeWeight: 5, strokeStyle: 'dashed', zIndex: 66 })
        }
        if (overlay) {
          overlay.setMap(map)
          hazardOverlays.push(overlay)
        }
      }
    },
    setFlood(list) {
      const overlays = clearLayer('flood')
      for (const f of list) {
        if (f.path.length < 2) continue
        overlays.push(
          new AMap.Polyline({
            path: f.path.map(gcj),
            strokeColor: '#5AA0DC',
            strokeOpacity: 0.55,
            strokeWeight: Math.min(28, 6 + f.depthM * 40),
            lineJoin: 'round',
            zIndex: 105,
          }),
        )
      }
      if (overlays.length) map.add(overlays)
    },
    setBasemapBuildings(visible: boolean) {
      basemapVisible = visible
      try {
        // 只能整体开关白模：不支持按围栏局部隐藏（限制已写在文件头注释与界面说明里）
        if (typeof map.setStatus === 'function') map.setStatus({ isBuildingBlock: visible })
        else map.setFeatures(visible ? ['bg', 'road', 'building', 'point'] : ['bg', 'road', 'point'])
      } catch {
        // 忽略：不同小版本 API 差异，界面已有说明
      }
    },
    flyTo(center: LngLat, zoom: number, o) {
      stopIntro()
      map.setZoomAndCenter(zoom, gcj(center), false, o?.durationMs ?? 600)
    },
    fitBounds(points: LngLat[], padding = 48) {
      if (!points.length) return
      stopIntro()
      const overlaysTmp = points.map((p) => new AMap.Marker({ position: gcj(p), visible: false }))
      map.add(overlaysTmp)
      map.setFitView(overlaysTmp, false, [padding, padding, padding, padding], 18)
      map.remove(overlaysTmp)
    },
    getCenter: () => wgs(map.getCenter()),
    getZoom: () => map.getZoom(),
    debugProject: (p: LngLat) => {
      const px = map.lngLatToContainer(gcj(p))
      return [px.getX(), px.getY()]
    },
    setEvents(ev: MapEvents) {
      events = ev
    },
    destroy() {
      stopIntro()
      container.removeEventListener('pointerdown', onPointerDown, true)
      container.removeEventListener('pointermove', onPointerMove, true)
      container.removeEventListener('pointerup', onPointerUp, true)
      container.removeEventListener('pointercancel', onPointerCancel, true)
      container.removeEventListener('dblclick', onContainerDblClick, true)
      for (const layer of Object.values(layerOverlays)) if (layer.length) map.remove(layer)
      clearEditor()
      map.destroy()
    },
  }

  let basemapVisible = true
  void buildingsVisible
  void basemapVisible
  return { adapter, buildingMode }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}
