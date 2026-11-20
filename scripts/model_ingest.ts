/**
 * 把求解器输出归档 + 人工映射 + 演练通行规则，换算成 Web 可直接读取的模型回放数据。
 *
 * 输入：
 *   artifacts/model-runs/<runId>/manifest.json      求解器运行清单（引擎版本、输入、输出、状态）
 *   artifacts/model-runs/<runId>/devc-summary.json  FDS DEVC 采样时程（由运行脚本搬运）
 *   artifacts/model-runs/<runId>/damage-summary.json oQ 逐资产受损状态分布
 *   models/<kind>/mapping.json                     采样点/资产 → GeoRelay 对象
 *   models/<kind>/drill-rules.json                 指标 → 受阻/受损的演练判据
 *   models/<kind>/closures.json                    独立于模型的道路/接驳点关闭设定（地震用）
 * 输出：
 *   src/data/model-runs/<runId>.json               统一回放包（ModelDrillBundle）
 *   src/data/model-runs/index.json                 可用算例清单（Web 入口用）
 *
 * 原则：只做搬运、映射与规则换算；不重算、不插值、不生成求解器没给出的数值。
 * 算例没跑成功时，只在 index 里登记 status=failed 与失败原因，不生成事件。
 *
 * 运行：npm run model:ingest
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildPresetCommunity } from '../src/domain/community/demo.ts'
import type {
  DrillRule,
  ModelDrillBundle,
  ModelEvidence,
  ModelFamily,
  ModelManifest,
  ModelMapping,
  ProvenanceLevel,
} from '../src/domain/modelrun/types.ts'
import { PROVENANCE_LABEL } from '../src/domain/modelrun/types.ts'
import type { ImpactEvent, ImpactTargetType, TrafficChange } from '../src/domain/disaster/types.ts'
import type { LngLat } from '../src/domain/geo/types.ts'

const ROOT = process.cwd()
const RUNS_DIR = join(ROOT, 'artifacts', 'model-runs')
const OUT_DIR = join(ROOT, 'src', 'data', 'model-runs')
const MODEL_DIRS: Record<ModelFamily, string> = {
  fds: join(ROOT, 'models', 'fire_fds'),
  openquake: join(ROOT, 'models', 'quake_oq'),
}
const DISASTER_OF: Record<ModelFamily, 'fire' | 'earthquake'> = { fds: 'fire', openquake: 'earthquake' }
const LAT_M_PER_DEG = 110574

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as T
}

interface SampleSummary {
  samples: Array<{ sampleId: string; unit: string; quantity?: string; series: Array<{ t: number; value: number | null }> }>
  tEnd?: number
  dtS?: number
}

interface DamageSummary {
  assets: Array<{ assetId: string; taxonomy?: string; dmg: Array<{ state: string; prob: number }> }>
  units?: string
}

interface ClosuresFile {
  mode: 'manual' | 'rule'
  notes?: string[]
  closures: Array<{ targetType: 'road' | 'staging'; targetId: string; targetName: string; at: number; mode: 'manual' | 'rule'; note: string }>
}

function lngLatOf(community: ReturnType<typeof buildPresetCommunity>, targetType: ImpactTargetType, targetId: string): LngLat | null {
  if (targetType === 'entrance') {
    const bid = targetId.replace(/^entrance:/, '')
    const b = community.buildings.find((x) => x.id === bid)
    return b ? b.entrance.doorLngLat : null
  }
  if (targetType === 'road') {
    const r = community.net.roads.find((x) => x.id === targetId)
    if (!r || !r.points.length) return null
    const p = r.points[Math.floor(r.points.length / 2)]
    return Array.isArray(p) ? ([p[0], p[1]] as LngLat) : ([p.lng, p.lat] as LngLat)
  }
  if (targetType === 'staging') {
    const s = community.net.staging.find((x) => x.name === targetId || x.id === targetId)
    return s ? s.lngLat : null
  }
  return null
}

function footprintOf(community: ReturnType<typeof buildPresetCommunity>, buildingId: string): LngLat[] {
  const b = community.buildings.find((x) => x.id === buildingId)
  if (!b) return []
  const mxPerDegLng = 111320 * Math.cos((b.center[1] * Math.PI) / 180)
  return b.footprint.map((p) => [b.center[0] + (p.x - b.local.c.x) / mxPerDegLng, b.center[1] + (p.y - b.local.c.y) / LAT_M_PER_DEG] as LngLat)
}

function matchRule(rules: DrillRule[], metric: string, value: number): DrillRule | null {
  for (const r of rules) {
    if (r.metric !== metric) continue
    const hit =
      (r.comparator === 'lt' && value < r.threshold) ||
      (r.comparator === 'lte' && value <= r.threshold) ||
      (r.comparator === 'gt' && value > r.threshold) ||
      (r.comparator === 'gte' && value >= r.threshold)
    if (hit) return r
  }
  return null
}

function firstCrossing(series: Array<{ t: number; value: number | null }>, rule: DrillRule): { t: number; value: number } | null {
  for (const p of series) {
    if (p.value === null) continue
    const hit =
      (rule.comparator === 'lt' && p.value < rule.threshold) ||
      (rule.comparator === 'lte' && p.value <= rule.threshold) ||
      (rule.comparator === 'gt' && p.value > rule.threshold) ||
      (rule.comparator === 'gte' && p.value >= rule.threshold)
    // 保留精确采样时刻：事件触发时刻会取整到秒，但证据里要能和求解器输出一一对上
    if (hit) return { t: p.t, value: p.value }
  }
  return null
}

/** 火灾：采样时程 + 能见度规则 → 入口/路段受阻事件 */
function buildFireEvents(
  manifest: ModelManifest,
  mapping: ModelMapping,
  rules: DrillRule[],
  summary: SampleSummary,
  community: ReturnType<typeof buildPresetCommunity>,
): { events: Array<ImpactEvent & { evidence?: ModelEvidence }>; samples: ModelDrillBundle['samples'] } {
  const blockedRule = rules.find((r) => r.metric === 'visibility' && r.consequence === 'blocked')
  const restrictedRule = rules.find((r) => r.metric === 'visibility' && r.consequence === 'restricted')
  const events: Array<ImpactEvent & { evidence?: ModelEvidence }> = []
  const samples: ModelDrillBundle['samples'] = []

  for (const map of mapping.samples) {
    const found = summary.samples.find((s) => s.sampleId === map.sampleId)
    const center = lngLatOf(community, map.targetType, map.targetId)
    if (!found) {
      console.warn(`  ! 映射里的采样点 ${map.sampleId} 在求解器输出中不存在，跳过`)
      continue
    }
    samples.push({
      sampleId: map.sampleId,
      quantity: found.quantity ?? 'visibility',
      unit: found.unit,
      targetType: map.targetType,
      targetId: map.targetId,
      targetName: map.targetName,
      center: center ?? ([0, 0] as LngLat),
      influenceRadiusM: map.influenceRadiusM,
      series: found.series,
    })

    const hit = blockedRule ? firstCrossing(found.series, blockedRule) : null
    const soft = restrictedRule ? firstCrossing(found.series, restrictedRule) : null
    const useRule = hit ? blockedRule! : null
    const traffic: TrafficChange = hit ? 'blocked' : soft ? 'restricted' : 'open'
    const at = hit?.t ?? soft?.t
    const rule = useRule ?? (soft ? restrictedRule! : null)
    if (!rule || at === undefined) continue
    const value = hit?.value ?? soft!.value

    const evidence: ModelEvidence = {
      runId: manifest.runId,
      model: 'fds',
      engineVersion: manifest.engineVersion,
      caseId: manifest.caseId,
      sampleId: map.sampleId,
      metric: 'visibility',
      value: Number(value.toFixed(6)),
      unit: found.unit,
      comparator: rule.comparator,
      threshold: rule.threshold,
      ruleId: rule.id,
      ruleLabel: rule.label,
      atS: at,
      layers: {
        model: `FDS 采样点 ${map.sampleId} 在 t=${at}s 的能见度 ${value.toFixed(2)} ${found.unit}`,
        rule: `演练规则 ${rule.id}：${rule.label}（${rule.note}）`,
      },
    }
    events.push({
      id: `fds:${map.targetType}:${map.targetId}${hit ? '' : ':restricted'}`,
      disaster: DISASTER_LEVEL_FIRE,
      at: Math.round(at),
      targetType: map.targetType,
      targetId: map.targetId,
      targetName: map.targetName,
      traffic,
      level: hit ? '烟雾覆盖（能见度不足）' : '烟雾轻度影响',
      basis: [
        `FDS 输出：${map.sampleId} 能见度 ${value.toFixed(2)} ${found.unit}（t=${at}s）`,
        `演练规则：${rule.label}`,
        `算例 ${manifest.caseId}，引擎 ${manifest.engineVersion}`,
      ],
      reason: `${map.targetName} ${hit ? '因烟气能见度低于演练阈值而不可通行' : '能见度偏低但仍在通行阈值内'}`,
      metrics: { smokeDensity: Number((1 - Math.min(1, value / 30)).toFixed(3)) },
      geometry: center ? { kind: 'point', at: center } : undefined,
      evidence,
    })
  }
  return { events, samples }
}

const DISASTER_LEVEL_FIRE = 'fire' as const

/** 地震：逐资产受损状态分布 + 分级规则 → 楼栋受损事件（不推导道路中断） */
function buildQuakeEvents(
  manifest: ModelManifest,
  mapping: ModelMapping,
  rules: DrillRule[],
  summary: DamageSummary,
  community: ReturnType<typeof buildPresetCommunity>,
  atBase: number,
): { events: Array<ImpactEvent & { evidence?: ModelEvidence }>; assets: ModelDrillBundle['assets'] } {
  const events: Array<ImpactEvent & { evidence?: ModelEvidence }> = []
  const assets: ModelDrillBundle['assets'] = []
  const order: Array<{ level: string; metric: string; state: string }> = [
    { level: '倒塌', metric: 'damage_complete', state: 'complete' },
    { level: '严重', metric: 'damage_extensive_plus', state: 'extensive' },
    { level: '中等', metric: 'damage_moderate_plus', state: 'moderate' },
    { level: '轻微', metric: 'damage_slight_plus', state: 'slight' },
  ]

  for (const map of mapping.assets) {
    const found = summary.assets.find((a) => a.assetId === map.assetId)
    if (!found) {
      console.warn(`  ! 映射里的资产 ${map.assetId} 在 oQ 输出中不存在，跳过`)
      continue
    }
    const states = found.dmg.map((d) => d.state)
    const probs = found.dmg.map((d) => d.prob)
    const probOf = (state: string): number => probs[states.indexOf(state)] ?? 0
    const atLeast = (state: string): number => {
      const idx = states.indexOf(state)
      if (idx < 0) return 0
      return probs.slice(idx === 0 && states[0] === 'no_damage' ? 1 : idx).reduce((a, b) => a + b, 0)
    }
    const metrics: Record<string, number> = {
      damage_complete: probOf('complete'),
      damage_extensive_plus: atLeast('extensive'),
      damage_moderate_plus: atLeast('moderate'),
      damage_slight_plus: atLeast('slight'),
    }
    let level = '完好'
    let rule: DrillRule | null = null
    let metric = ''
    let value = 0
    for (const o of order) {
      const r = matchRule(rules, o.metric, metrics[o.metric] ?? 0)
      if (r) {
        level = o.level
        rule = r
        metric = o.metric
        value = metrics[o.metric]
        break
      }
    }
    assets.push({
      assetId: map.assetId,
      targetId: map.targetId,
      targetName: map.targetName,
      taxonomy: found.taxonomy,
      states,
      probs,
      level,
      footprint: footprintOf(community, map.targetId),
    })
    if (!rule) continue
    const evidence: ModelEvidence = {
      runId: manifest.runId,
      model: 'openquake',
      engineVersion: manifest.engineVersion,
      caseId: manifest.caseId,
      assetId: map.assetId,
      metric,
      value: Number(value.toFixed(6)),
      unit: 'probability',
      comparator: rule.comparator,
      threshold: rule.threshold,
      ruleId: rule.id,
      ruleLabel: rule.label,
      atS: atBase,
      layers: {
        model: `oQ 资产 ${map.assetId}：${states.map((s, i) => `${s}=${probs[i].toFixed(3)}`).join(' / ')}`,
        rule: `演练分级规则 ${rule.id}：${rule.label}（${rule.note}）`,
      },
    }
    events.push({
      id: `oq:building:${map.targetId}`,
      disaster: 'earthquake',
      at: atBase,
      targetType: 'building',
      targetId: map.targetId,
      targetName: map.targetName,
      traffic: 'restricted',
      level,
      basis: [
        `oQ 输出：${metric} = ${value.toFixed(3)}（${states.join('/')} 分布，${found.taxonomy ?? 'taxonomy 未知'}）`,
        `演练规则：${rule.label}`,
        `算例 ${manifest.caseId}，引擎 ${manifest.engineVersion}（震后静态结果，无时程）`,
      ],
      reason: `${map.targetName} 受损等级「${level}」（模型受损分布 + 演练分级规则）`,
      metrics: { damageRatio: Number(probOf('complete').toFixed(4)) },
      geometry: footprintOf(community, map.targetId).length ? { kind: 'point', at: community.buildings.find((b) => b.id === map.targetId)!.center } : undefined,
      evidence,
    })
  }
  return { events, assets }
}

function main(): void {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })
  if (!existsSync(RUNS_DIR)) {
    console.error(`没有找到 ${RUNS_DIR}：请先运行求解器（npm run model:run:fds / model:run:oq）`)
    process.exitCode = 1
    return
  }
  const runDirs = readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => join(RUNS_DIR, d.name))
    .filter((d) => existsSync(join(d, 'manifest.json')))

  const community = buildPresetCommunity()
  const index: Array<Record<string, unknown>> = []
  let okCount = 0
  let failCount = 0

  for (const dir of runDirs) {
    const manifest = readJson<ModelManifest>(join(dir, 'manifest.json'))
    const modelDir = MODEL_DIRS[manifest.model]
    const mapping = readJson<ModelMapping>(join(modelDir, 'mapping.json'))
    const rulesFile = readJson<{ rules: DrillRule[]; notes?: string[] }>(join(modelDir, 'drill-rules.json'))
    const catastrophe = DISASTER_OF[manifest.model]

    if (manifest.status !== 'ok') {
      failCount++
      index.push({
        runId: manifest.runId,
        model: manifest.model,
        disaster: catastrophe,
        caseId: manifest.caseId,
        engineVersion: manifest.engineVersion,
        status: 'failed',
        failure: manifest.failure ?? { stage: 'unknown', message: '求解器未成功运行' },
        available: false,
      })
      console.warn(`✗ ${manifest.runId}：求解器状态 ${manifest.status}（${manifest.failure?.message ?? '无详情'}），不生成回放数据`)
      continue
    }

    let events: Array<ImpactEvent & { evidence?: ModelEvidence }> = []
    let samples: ModelDrillBundle['samples'] = []
    let assets: ModelDrillBundle['assets'] = []
    let closures: ModelDrillBundle['closures'] = []

    if (manifest.model === 'fds') {
      const summaryPath = join(dir, 'devc-summary.json')
      if (!existsSync(summaryPath)) {
        failCount++
        index.push({ runId: manifest.runId, model: manifest.model, disaster: catastrophe, caseId: manifest.caseId, engineVersion: manifest.engineVersion, status: 'failed', failure: { stage: 'ingest', message: '缺少 devc-summary.json' }, available: false })
        continue
      }
      const built = buildFireEvents(manifest, mapping, rulesFile.rules, readJson<SampleSummary>(summaryPath), community)
      events = built.events
      samples = built.samples
    } else {
      const summaryPath = join(dir, 'damage-summary.json')
      if (!existsSync(summaryPath)) {
        failCount++
        index.push({ runId: manifest.runId, model: manifest.model, disaster: catastrophe, caseId: manifest.caseId, engineVersion: manifest.engineVersion, status: 'failed', failure: { stage: 'ingest', message: '缺少 damage-summary.json' }, available: false })
        continue
      }
      const built = buildQuakeEvents(manifest, mapping, rulesFile.rules, readJson<DamageSummary>(summaryPath), community, 60)
      events = built.events
      assets = built.assets

      // 道路/接驳点关闭：单独文件、单独标注，不来自楼栋受损
      const closuresPath = join(modelDir, 'closures.json')
      if (existsSync(closuresPath)) {
        const cf = readJson<ClosuresFile>(closuresPath)
        closures = cf.closures.map((c) => {
          const road = c.targetType === 'road' ? community.net.roads.find((r) => r.id === c.targetId) : undefined
          const path = road
            ? road.points.map((pt) => (Array.isArray(pt) ? ([pt[0], pt[1]] as LngLat) : ([pt.lng, pt.lat] as LngLat)))
            : undefined
          return { ...c, mode: c.mode ?? cf.mode, ...(path && path.length >= 2 ? { path } : {}) }
        })
        for (const c of closures) {
          const center = lngLatOf(community, c.targetType, c.targetId)
          events.push({
            id: `oq:${c.targetType}:${c.targetId}`,
            disaster: 'earthquake',
            at: c.at,
            targetType: c.targetType,
            targetId: c.targetId,
            targetName: c.targetName,
            traffic: 'blocked',
            level: c.mode === 'manual' ? '人工设定关闭' : '规则判定关闭',
            basis: [
              `来源：${c.mode === 'manual' ? '人工演练设定（models/quake_oq/closures.json）' : '独立于模型的关闭规则'}`,
              '说明：不由 oQ 楼栋受损分布推导',
            ],
            reason: `${c.targetName}：${c.note}`,
            geometry: c.targetType === 'road' && closures.find((x) => x.targetId === c.targetId)?.path
              ? { kind: 'road' as const, roadId: c.targetId }
              : center
                ? { kind: 'point' as const, at: center }
                : undefined,
          })
        }
      }
    }

    events.sort((a, b) => a.at - b.at)
    const provenance: ModelDrillBundle['provenance'] = {
      level: 'model' as ProvenanceLevel,
      label: PROVENANCE_LABEL.model,
      model: manifest.model,
      disaster: catastrophe,
      runId: manifest.runId,
      caseId: manifest.caseId,
      engineVersion: manifest.engineVersion,
      solverCommand: manifest.solverCommand,
      inputs: manifest.inputs,
      outputs: manifest.outputs,
      notes: [...(manifest.notes ?? []), ...(rulesFile.notes ?? [])],
      scope:
        manifest.model === 'fds'
          ? '适用范围：单个固定 FDS 小场景的烟气探针时程，用来演练“烟气影响入口/通道”的应急流程；不是本社区的性能化防火设计或安全评估。'
          : '适用范围：单个 Scene Damage 算例的逐资产受损状态分布，用来演练“按受损等级分级、单独设定道路关闭”的应急流程；不是本社区的地震安全评估。',
      ranAt: manifest.finishedAt ?? null,
    }

    const bundle: ModelDrillBundle = {
      provenance,
      rules: rulesFile.rules,
      samples,
      assets,
      events,
      closures,
      status: 'ok',
    }
    writeFileSync(join(OUT_DIR, `${manifest.runId}.json`), JSON.stringify(bundle, null, 2) + '\n', 'utf8')
    okCount++
    index.push({
      runId: manifest.runId,
      model: manifest.model,
      disaster: catastrophe,
      caseId: manifest.caseId,
      engineVersion: manifest.engineVersion,
      solverCommand: manifest.solverCommand,
      status: 'ok',
      level: provenance.level,
      label: provenance.label,
      ranAt: provenance.ranAt,
      title: catastrophe === 'fire' ? `火灾（FDS 算例）· ${manifest.caseId}` : `地震（OpenQuake 算例）· ${manifest.caseId}`,
      sampleCount: samples.length,
      assetCount: assets.length,
      eventCount: events.length,
      closureCount: closures.length,
      available: true,
    })
    console.log(`✓ ${manifest.runId}：${events.length} 条事件（采样点 ${samples.length} / 资产 ${assets.length} / 独立关闭 ${closures.length}）`)
  }

  writeFileSync(join(OUT_DIR, 'index.json'), JSON.stringify({ generatedFrom: 'artifacts/model-runs', runs: index }, null, 2) + '\n', 'utf8')
  console.log(`\n模型回放数据已写入 src/data/model-runs/：成功 ${okCount} 个算例，失败 ${failCount} 个`)
  if (okCount === 0) process.exitCode = 1
}

main()
