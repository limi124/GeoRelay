import type { LngLat } from '../domain/geo/types.ts'
import type { HazardSpec } from '../domain/disaster/types.ts'

/** 图层可见性（三个视图共享状态，只改变图层强调） */
export interface LayerVisibility {
  fence: boolean
  myBuildings: boolean
  basemapBuildings: boolean
  roads: boolean
  flood: boolean
  closures: boolean
  routes: boolean
  pendingRoutes: boolean
  agents: boolean
  tasks: boolean
  pharmacies: boolean
  externalRoutes: boolean
  labels: boolean
}

export type PlanLineStyle = 'approved' | 'pending' | 'rejected' | 'baseline' | 'evacuation' | 'response'
export type RoadLineStyle = 'open' | 'suggested' | 'closed'

export interface MarkerSpec {
  id: string
  lngLat: LngLat
  kind: 'gate' | 'staging' | 'entrance' | 'pharmacy' | 'agent-external' | 'agent-internal' | 'agent-firefighter' | 'agent-waiting' | 'origin' | 'vertex' | 'evacuation'
  label?: string
  /** 标记状态角标：待到达 / 待交接 / 已接力 */
  relayState?: 'pending_arrival' | 'pending_handover' | 'relayed' | 'delivered' | 'blocked' | null
  selected?: boolean
  draggable?: boolean
  tooltip?: string
  emphasis?: 'normal' | 'strong' | 'muted'
  rotationDeg?: number
  size?: 'sm' | 'md' | 'lg'
}

export interface BuildingSpec {
  id: string
  footprint: LngLat[]
  heightM: number
  floors: number
  selected?: boolean
  highlight?: 'none' | 'selected' | 'hover' | 'target' | 'related' | 'disabled'
  label?: string
  draggable?: boolean
  style?: 'residential' | 'public' | 'highrise' | 'default'
}

export interface PolygonSpec {
  id: string
  path: LngLat[]
  fill: string
  stroke: string
  opacity: number
  strokeWidth: number
  dashed?: boolean
  lineHeight?: number
}

export interface FenceEditorOptions {
  /** 'draw' 点击加点、双击结束；'edit' 拖动顶点；'off' 只显示 */
  mode: 'draw' | 'edit' | 'off'
  draft: LngLat[]
  hoverPoint: LngLat | null
  closed: boolean
  invalidPoint: number | null
  /** 自交的两条边（顶点索引对），画成红色警示 */
  invalidEdges?: Array<[number, number]>
  /** 光标悬停接近起点：起点画吸附光圈，提示“点这里闭合” */
  snapFirst?: boolean
  /** 矩形围栏模式的第一个角点；与 hoverPoint 一起画预览矩形 */
  rectAnchor?: LngLat | null
}

export interface MapEvents {
  collectingPoints?: boolean
  onClick?(lngLat: LngLat): void
  onDblClick?(lngLat: LngLat): void
  onMouseMove?(lngLat: LngLat | null): void
  onVertexDrag?(index: number, lngLat: LngLat): void
  onVertexDragEnd?(index: number, lngLat: LngLat): void
  /** 编辑模式：点击边中点插入新顶点（index 为边的起点索引） */
  onVertexInsert?(index: number, lngLat: LngLat): void
  /** 编辑模式：右键顶点删除 */
  onVertexDelete?(index: number): void
  onBuildingDrag?(id: string, lngLat: LngLat): void
  onBuildingDragEnd?(id: string, lngLat: LngLat): void
  onBuildingClick?(id: string): void
  onRoadClick?(id: string): void
  onMarkerClick?(id: string, kind: MarkerSpec['kind']): void
  onCameraChange?(center: LngLat, zoom: number): void
}

/**
 * 地图适配层：AMap 与示例地图各实现一套，编辑台/指挥台只依赖本接口。
 * 同一页面只创建一个实例；进入指挥台不清空实例（保留同一个地图容器与相机）。
 */
export interface MapAdapter {
  readonly kind: 'amap' | 'fallback'
  ready: boolean
  addFenceEditor(opts: FenceEditorOptions): void
  setBuildings(list: BuildingSpec[], visible: boolean): void
  setPolygons(list: PolygonSpec[]): void
  setRoads(list: Array<{ id: string; path: LngLat[]; style: RoadLineStyle }>): void
  setRoutes(list: Array<{ id: string; path: LngLat[]; style: PlanLineStyle; label?: string }>): void
  setMarkers(list: MarkerSpec[]): void
  setFlood(list: Array<{ id: string; path: LngLat[]; depthM: number }>): void
  /** 火灾烟雾 / 起火点 / 地震受损楼栋 / 断路等灾情几何 */
  setHazards(list: HazardSpec[]): void
  setBasemapBuildings(visible: boolean): void
  flyTo(center: LngLat, zoom: number, opts?: { durationMs?: number }): void
  fitBounds(points: LngLat[], padding?: number): void
  getCenter(): LngLat
  getZoom(): number
  /** 仅用于浏览器验收脚本：把经纬度换算成画布坐标（生产逻辑不依赖它） */
  debugProject?(lngLat: LngLat): [number, number]
  setEvents(ev: MapEvents): void
  destroy(): void
}

export interface MapInitResult {
  adapter: MapAdapter
  message?: string
}
