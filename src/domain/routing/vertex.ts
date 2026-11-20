import type { Vec2 } from '../geo/types.ts'

/**
 * 路网类型定义。
 * 内部路网的顶点来自社区模型（大门 / 楼栋入口 / 接驳点 / 路段折点），ID 稳定。
 */

export type LocalFrame = {
  origin: [number, number]
  mxPerDegLng: number
  myPerDegLat: number
}

/** 路网顶点：pos 为局部米制坐标 */
export interface NetVertex {
  id: string
  pos: Vec2
  kind: 'gate' | 'entrance' | 'staging' | 'junction'
  /** 演练水深（米），由灾情引擎写入，仅用于显示 */
  depthM?: number
}

export interface RouteResult {
  pathVertices: string[]
  roadIds: string[]
  distance: number
  cost: number
  bends: number
}

export interface NetVerts {
  byId: Map<string, NetVertex>
  /** 节点键 → 图中顶点（gate:<id> / entrance:<bid> / staging:<id> / x:<lng>,<lat>） */
  byNode: Map<string, NetVertex>
  /** 路段折线（局部米制），用于绘制与封路判定 */
  segments: Array<{ roadId: string; points: Vec2[] }>
  /** 逐段边（相邻顶点对），用于「路线是否经过某路段/封闭段」的精确判断 */
  edges: Array<{ roadId: string; a: Vec2; b: Vec2 }>
  /** 图中边 */
  links: Array<{ a: string; b: string; roadId: string }>
  frame: LocalFrame
  frameLocal: Vec2[]
  centroidLocal: Vec2
}
