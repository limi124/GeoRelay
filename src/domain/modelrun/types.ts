import type { LngLat } from '../geo/types.ts'
import type { ImpactEvent, ImpactTargetType } from '../disaster/types.ts'

/**
 * 专业灾情模型算例的归档契约（FDS / OpenQuake）。
 *
 * 设计要点：
 *  1. 一个算例 = 一个 `artifacts/model-runs/<runId>/` 目录，里面有求解器原始输出 + `manifest.json`。
 *  2. 采样点/资产到 GeoRelay 对象（路段、入口、接驳点、楼栋）的映射单独放在 `models/<kind>/mapping.json`，
 *     不写进求解器输入，避免把业务 ID 混进物理模型。
 *  3. 指标 → 受阻事件的换算由**单独配置的演练通行规则**（`models/<kind>/drill-rules.json`）完成，
 *     规则和模型结果分开存放、分开展示，避免把工程判据说成模型结论。
 *  4. Web 只读缓存产物（`src/data/model-runs/<runId>.json`），不要求在线求解。
 */

/** 模型族：首版只接这两种 */
export type ModelFamily = 'fds' | 'openquake'

/**
 * 数据来源分层（界面必须显示，切换时同步变化）：
 *  - model      ：模型计算结果回放（本次真的跑了求解器，数值来自求解器输出文件）
 *  - imported   ：官方算例导入（直接用官方发布的算例/结果，未在本机重跑）
 *  - simplified ：简化演示（GeoRelay 自带的公式演示，不是求解器输出）
 */
export type ProvenanceLevel = 'model' | 'imported' | 'simplified'

export const PROVENANCE_LABEL: Record<ProvenanceLevel, string> = {
  model: '模型计算结果回放',
  imported: '官方算例导入',
  simplified: '简化演示',
}

export interface ModelInputRef {
  path: string
  sha256?: string
  note?: string
}

export interface ModelManifest {
  runId: string
  model: ModelFamily
  caseId: string
  engineVersion: string
  solverCommand: string
  status: 'ok' | 'failed'
  startedAt?: string
  finishedAt?: string
  wallClockS?: number
  inputs: ModelInputRef[]
  outputs: Array<ModelInputRef & { unit?: string; columns?: string[] }>
  samples?: Array<{ sampleId: string; quantity: string; unit: string }>
  assets?: Array<{ assetId: string; taxonomy?: string }>
  notes?: string[]
  failure?: { stage: string; log?: string; message: string }
}

/** 求解器原始输出的规范化摘要（由 `scripts/model_ingest.ts` 生成） */

export interface SampleSeries {
  sampleId: string
  quantity: string
  unit: string
  /** 采样序列；缺测为 null，不做插值 */
  series: Array<{ t: number; value: number | null }>
}

export interface DamageAsset {
  assetId: string
  taxonomy?: string
  /** 受损状态分布（顺序与 states 对应） */
  states: string[]
  /** 各状态概率，和为 1（来自求解器输出，不做归一化改写） */
  probs: number[]
}

/** 演练通行规则：把模型指标换算成受阻/受损的判据（不属于模型结论） */
export interface DrillRule {
  id: string
  label: string
  /** 规则作用的指标名，如 visibility / damage_complete */
  metric: string
  comparator: 'lt' | 'lte' | 'gt' | 'gte'
  threshold: number
  unit: string
  /** 判定结果：不可通行 / 受限 / 建筑受损等级 */
  consequence: 'blocked' | 'restricted'
  appliesTo: ImpactTargetType[]
  /** 人为设定的说明（阈值来自哪里、为什么这样定） */
  note: string
}

/** 采样点/资产 → GeoRelay 对象的映射（人工标注） */
export interface ModelMapping {
  model: ModelFamily
  caseId: string
  /** 采样点 → 入口 / 路段 / 接驳点 */
  samples: Array<{
    sampleId: string
    targetType: Extract<ImpactTargetType, 'entrance' | 'road' | 'staging'>
    targetId: string
    targetName: string
    /** 该采样点的“影响圈”半径，仅用于地图示意，不代表模型输出的烟气范围 */
    influenceRadiusM: number
  }>
  /** 资产 → 楼栋 */
  assets: Array<{ assetId: string; targetType: 'building'; targetId: string; targetName: string }>
  notes?: string[]
}

/** 模型证据：一条受阻事件能追溯到哪个算例、哪个采样点、哪个数值、哪条规则 */
export interface ModelEvidence {
  runId: string
  model: ModelFamily
  engineVersion: string
  caseId: string
  sampleId?: string
  assetId?: string
  metric: string
  value: number | null
  unit: string
  comparator: DrillRule['comparator']
  threshold: number
  ruleId: string
  ruleLabel: string
  atS: number
  /** 客观说明：这一条里哪部分是模型输出、哪部分是演练判据 */
  layers: { model: string; rule: string }
}

/** 归档算例 + 映射 + 规则 → 界面与引擎可直接消费的包 */
export interface ModelDrillBundle {
  provenance: {
    level: ProvenanceLevel
    label: string
    model: ModelFamily
    disaster: 'fire' | 'earthquake'
    runId: string
    caseId: string
    engineVersion: string
    solverCommand: string
    inputs: ModelInputRef[]
    outputs: ModelInputRef[]
    notes: string[]
    /** 算例的适用范围声明 */
    scope: string
    ranAt: string | null
  }
  rules: DrillRule[]
  /** 采样点（带位置），用于地图随时间显示 */
  samples: Array<{
    sampleId: string
    quantity: string
    unit: string
    targetType: ImpactTargetType
    targetId: string
    targetName: string
    center: LngLat
    influenceRadiusM: number
    series: Array<{ t: number; value: number | null }>
  }>
  /** 资产受损（楼栋），只作建筑受损展示，不参与道路判定 */
  assets: Array<{
    assetId: string
    targetId: string
    targetName: string
    taxonomy?: string
    states: string[]
    probs: number[]
    /** 由演练规则换算出的展示等级（如 严重/倒塌） */
    level: string
    footprint: LngLat[]
  }>
  /** 由模型 + 规则换算出的影响事件（统一 ImpactEvent，进现有规划器） */
  events: Array<ImpactEvent & { evidence?: ModelEvidence }>
  /** 与模型分开标注的道路/接驳点关闭决定（人工或独立规则） */
  closures: Array<{
    targetType: 'road' | 'staging'
    targetId: string
    targetName: string
    at: number
    mode: 'manual' | 'rule'
    note: string
    /** 路段折线（WGS-84）；接驳点为单点则不填。地图据此画断裂线，而不是退化成一个点 */
    path?: LngLat[]
  }>
  status: 'ok' | 'failed'
  failure?: { stage: string; message: string; log?: string }
}

export function isProvenanceLevel(v: string): v is ProvenanceLevel {
  return v === 'model' || v === 'imported' || v === 'simplified'
}
