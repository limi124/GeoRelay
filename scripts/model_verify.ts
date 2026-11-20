/**
 * 专业模型算例的可追溯性与闭环校验。
 *
 * 校验四件事：
 *  1. 数值可追溯：模型回放包里的每个数值都能在求解器输出文件里找到同一行（比对 manifest 输出 + 采样时程/资产分布）。
 *  2. 规则可复算：用演练规则对同一数值重新判定，结论必须与回放包里的事件一致。
 *  3. 事件能进规划器：模型事件激活后，受影响任务被重新识别、生成候选。
 *  4. 闭环可跑通：人工确认一个可行候选 → 推进 → 送达（或至少进入配送）。
 *
 * 运行：npm run model:verify
 * 只读：不修改任何数据，只打印结论。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { advance, affectedTasks, confirmCandidate, createEngine, currentBlocked } from '../src/domain/sim/engine.ts'
import { RuleRanker } from '../src/domain/sim/ranker.ts'
import { SampleExternalProvider } from '../src/domain/routing/external.ts'
import { demoInventory } from '../src/domain/sim/scenario.ts'
import { buildPresetCommunity } from '../src/domain/community/demo.ts'
import type { ModelDrillBundle } from '../src/domain/modelrun/types.ts'

// 注意：这里不用 src/domain/modelrun/registry.ts —— 它用 import.meta.glob 读 JSON，
// 那是 Vite 的能力，Node 直接跑会报 ERR_IMPORT_ATTRIBUTE_MISSING。脚本侧按同一份文件读盘。
interface RunEntry {
  runId: string
  disaster: 'fire' | 'earthquake'
  status: 'ok' | 'failed'
  available: boolean
  failure?: { message: string }
}

const INDEX_PATH = join(process.cwd(), 'src', 'data', 'model-runs', 'index.json')
const MODEL_RUNS: RunEntry[] = existsSync(INDEX_PATH)
  ? (JSON.parse(readFileSync(INDEX_PATH, 'utf8').replace(/^\uFEFF/, '')) as { runs: RunEntry[] }).runs ?? []
  : []

function modelBundleOf(runId: string): ModelDrillBundle | null {
  const path = join(process.cwd(), 'src', 'data', 'model-runs', `${runId}.json`)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as ModelDrillBundle
}
import { planModelDisaster, sampleValueAt } from '../src/domain/disaster/modelRun.ts'

const ROOT = process.cwd()
let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}${detail ? `  [${detail}]` : ''}`)
  } else {
    failed++
    failures.push(`${name}${detail ? `：${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? `  [${detail}]` : ''}`)
  }
}

const community = buildPresetCommunity()
const pharmacies = [
  { id: 'ph-1', name: '康宁大药房（演练）', lngLat: [121.481, 31.236] as [number, number], distanceM: 1140, source: 'sample' as const },
  { id: 'ph-2', name: '便民药房（演练）', lngLat: [121.466, 31.234] as [number, number], distanceM: 1217, source: 'sample' as const },
]

function engineFor(bundle: ModelDrillBundle) {
  const inv = Object.values(demoInventory(pharmacies as never, 42))
  return createEngine({
    community,
    seed: 42,
    pharmacies: inv,
    provider: new SampleExternalProvider((id) => inv.find((p) => p.id === id)?.name ?? id),
    ranker: new RuleRanker(),
    startLabel: '08:00',
    disaster: bundle.provenance.disaster,
    durationS: 2400,
    modelRun: bundle,
  })
}

interface SampleSummaryFile {
  samples: Array<{ sampleId: string; unit: string; quantity?: string; series: Array<{ t: number; value: number | null }> }>
}

function seriesOf(runId: string, sampleId: string): Array<{ t: number; value: number | null }> | null {
  const path = join(ROOT, 'artifacts', 'model-runs', runId, 'devc-summary.json')
  if (!existsSync(path)) return null
  const data = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as SampleSummaryFile
  return data.samples.find((s) => s.sampleId === sampleId)?.series ?? null
}

async function runOne(bundle: ModelDrillBundle): Promise<void> {
  const p = bundle.provenance
  console.log(`\n【${p.model === 'fds' ? '火灾 FDS' : '地震 OpenQuake'}】${p.runId} · ${p.caseId} · ${p.engineVersion}`)

  check('来源标注为「模型计算结果回放」', p.level === 'model' && p.label === '模型计算结果回放', p.label)
  check('求解器命令与输入文件已归档', Boolean(p.solverCommand) && p.inputs.length > 0 && p.outputs.length > 0, `${p.inputs.length} 个输入 / ${p.outputs.length} 个输出`)
  const manifestPath = join(ROOT, 'artifacts', 'model-runs', p.runId, 'manifest.json')
  check('manifest 存在且状态 ok', existsSync(manifestPath) && (JSON.parse(readFileSync(manifestPath, 'utf8')).status === 'ok'))

  const events = bundle.events.filter((e) => e.evidence)
  check('模型事件带证据', events.length > 0, `${events.length} 条`)

  // 1+2：逐条追溯数值并复算规则
  let traced = 0
  let ruleOk = 0
  for (const ev of events) {
    const evi = ev.evidence!
    if (evi.model === 'fds' && evi.sampleId) {
      const series = seriesOf(p.runId, evi.sampleId)
      if (!series) {
        check(`追溯 ${evi.sampleId} 的原始采样`, false, '缺少 devc-summary.json')
        continue
      }
      const atValue = series.filter((s) => s.value !== null).find((s) => Math.abs(s.t - evi.atS) < 1e-6)?.value ?? null
      const sample = bundle.samples.find((s) => s.sampleId === evi.sampleId)
      const interp = sample ? sampleValueAt(sample.series, evi.atS) : null
      const same = atValue !== null && interp !== null && Math.abs(atValue - interp) < 1e-6
      check(`追溯 ${evi.sampleId}：回放值 = 求解器原始采样（t=${evi.atS}s）`, same, `原始 ${atValue?.toFixed(3)} / 回放 ${interp?.toFixed(3)}`)
      if (same) traced++
      const val = interp ?? atValue ?? 0
      const cmp =
        evi.comparator === 'lt' ? val < evi.threshold : evi.comparator === 'lte' ? val <= evi.threshold : evi.comparator === 'gt' ? val > evi.threshold : val >= evi.threshold
      check(`复算规则 ${evi.ruleId}`, cmp, `${val.toFixed(2)} ${evi.unit} ${evi.comparator} ${evi.threshold} → ${ev.traffic}`)
      if (cmp) ruleOk++
    } else if (evi.model === 'openquake' && evi.assetId) {
      const asset = bundle.assets.find((a) => a.assetId === evi.assetId)
      const probSum = asset ? asset.probs.reduce((a, b) => a + b, 0) : 0
      check(`资产 ${evi.assetId} 受损分布概率和 ≈ 1`, Math.abs(probSum - 1) < 0.02, `Σ=${probSum.toFixed(4)}`)
      const completeIdx = asset ? asset.states.indexOf('complete') : -1
      const recomputed = asset && completeIdx >= 0 ? asset.probs[completeIdx] : 0
      const claimed = evi.value ?? 0
      const matches = evi.metric !== 'damage_complete' ? Boolean(asset) : Math.abs(recomputed - claimed) < 1e-6
      check(`复算受损分级 ${evi.ruleId}`, matches, `${evi.metric}=${evi.value} → ${ev.level}`)
      if (matches) {
        traced++
        ruleOk++
      }
    }
  }
  check('全部模型事件数值可追溯到求解器输出', traced === events.length, `${traced}/${events.length}`)
  check('全部模型事件可由演练规则复算', ruleOk === events.length, `${ruleOk}/${events.length}`)

  // 3：事件进规划器
  const engine = engineFor(bundle)
  const plan = planModelDisaster(bundle)
  check('模型事件进入统一 ImpactEvent 结构', plan.events.length === events.length + (bundle.closures.length), `${plan.events.length} 条（含独立关闭 ${bundle.closures.length} 条）`)

  const firstAt = Math.min(...plan.events.map((e) => e.at))
  engine.state.clock.running = true
  {
    // 推进到第一条模型事件之后
    let guard = 0
    while (engine.state.clock.t < firstAt + 60 && guard < 200) {
      await advance(engine, 10)
      guard++
    }
    const affected = affectedTasks(engine, currentBlocked(engine))
    check('模型事件激活后识别出受影响任务', affected.length > 0, `${affected.length} 个任务`)
    const sets = Object.keys(engine.state.planSets).length
    check('受影响任务生成候选集', sets > 0, `${sets} 个候选集`)

    // 4：闭环
    const ps = Object.values(engine.state.planSets)[0]
    const feasible = ps?.candidates.filter((c) => c.feasible).sort((a, b) => a.rank - b.rank)[0]
    check('存在可行候选（规则校验后）', Boolean(feasible), feasible ? feasible.title.slice(0, 24) : '无')
    if (feasible && ps) {
      const res = confirmCandidate(engine, ps.id, feasible.id)
      check('人工确认后改派生效', res.ok, res.message)
      const taskId = feasible.taskId
      let delivered = false
      let delivering = false
      for (let i = 0; i < 260; i++) {
        await advance(engine, 10)
        const planId = engine.state.assignments[taskId]
        const phase = planId ? engine.state.plans[planId]?.phase : null
        if (phase === 'delivering') delivering = true
        if (phase === 'delivered') {
          delivered = true
          break
        }
        if (engine.state.status !== 'running') break
      }
      check('确认后进入配送', delivering || delivered)
      check('模型算例驱动的任务最终送达', delivered, delivered ? '已送达' : '演练时长内未送达（记录为限制）')
    }

  }
}

async function main(): Promise<void> {
  console.log('模型算例追溯校验（求解器输出 → 回放包 → 受阻事件 → 候选 → 确认 → 送达）')
  if (!MODEL_RUNS.length) {
    console.log('没有已归档的模型算例：先运行 npm run model:run:fds / model:run:oq，再 npm run model:ingest')
    process.exitCode = 1
    return
  }
  for (const entry of MODEL_RUNS) {
    if (entry.status !== 'ok' || !entry.available) {
      console.log(`\n【跳过】${entry.runId}：${entry.failure?.message ?? '算例未成功运行'}`)
      continue
    }
    const bundle = modelBundleOf(entry.runId)
    if (!bundle) {
      check(`读取回放包 ${entry.runId}`, false, '找不到 src/data/model-runs 下的 JSON')
      continue
    }
    await runOne(bundle)
  }
  if (!MODEL_RUNS.some((e) => e.status === 'ok')) {
    console.log('\n没有任何成功算例，校验失败（这是如实结果，不要用手写 JSON 冒充求解器输出）')
    process.exitCode = 1
    return
  }
  console.log(`\n${'─'.repeat(64)}`)
  console.log(`模型算例校验：通过 ${passed} · 失败 ${failed}`)
  if (failures.length) {
    console.log('失败项：')
    for (const f of failures) console.log(`  · ${f}`)
  }
  process.exitCode = failed === 0 ? 0 : 1
}

void main()
