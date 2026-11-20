import type { DisasterPlan, HazardSpec, ImpactEvent } from './types.ts'
import type { ModelDrillBundle, ModelEvidence } from '../modelrun/types.ts'
import type { SimTime } from '../sim/types.ts'
import type { LngLat } from '../geo/types.ts'

/**
 * 用归档的专业模型算例驱动灾情。
 *
 * 与简化演示的区别只在「事件从哪来」：这里的事件由求解器输出 + 单独配置的演练通行规则换算而来，
 * 事件本身仍是统一的 `ImpactEvent`，后面的可达性、规划、改派、AI 分析完全复用。
 *
 * 两类证据分开写进事件：
 *  - `basis` / `metrics`：模型算出了什么（能见度、受损状态概率）
 *  - `evidence.rule*`：GeoRelay 按哪条演练规则判成受阻（阈值、比较方向、规则 ID）
 */

function sortedUnique(ts: number[]): number[] {
  return [...new Set(ts.map((t) => Math.round(t)))].sort((a, b) => a - b)
}

/** 线性读取采样序列在 t 时刻的值；超出末点取末值，起点之前取首值，缺测返回 null */
export function sampleValueAt(series: Array<{ t: number; value: number | null }>, t: number): number | null {
  if (!series.length) return null
  const pts = series.filter((p) => p.value !== null) as Array<{ t: number; value: number }>
  if (!pts.length) return null
  if (t <= pts[0].t) return pts[0].value
  const last = pts[pts.length - 1]
  if (t >= last.t) return last.value
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].t >= t) {
      const a = pts[i - 1]
      const b = pts[i]
      const k = (t - a.t) / Math.max(1e-9, b.t - a.t)
      return a.value + (b.value - a.value) * k
    }
  }
  return last.value
}

/** 能见度→烟雾浓度的展示映射（仅用于地图着色，不是模型输出，标注在 label 里） */
function densityOfVisibility(v: number): number {
  return Math.max(0, Math.min(1, 1 - v / 30))
}

const DAMAGE_HAZARD_LEVEL: Record<string, '轻微' | '中等' | '严重' | '倒塌'> = {
  slight: '轻微',
  moderate: '中等',
  extensive: '严重',
  complete: '倒塌',
}

export function planModelDisaster(bundle: ModelDrillBundle): DisasterPlan {
  const events = bundle.events
  const smokeSamples = bundle.samples.filter((s) => s.targetType !== 'staging')

  const hazardsAt = (t: SimTime): HazardSpec[] => {
    const out: HazardSpec[] = []
    if (bundle.provenance.disaster === 'fire') {
      for (const s of smokeSamples) {
        const v = sampleValueAt(s.series, t)
        if (v === null) continue
        // 只有已经触发（或已经超过阈值）的采样点才画，避免把“未来时刻”提前画到地图上
        const firstHit = events.find((e) => (e.evidence?.sampleId ?? '') === s.sampleId)
        if (firstHit && t < firstHit.at) continue
        out.push({
          id: `smoke:${s.sampleId}`,
          kind: 'smoke',
          center: s.center,
          radiusM: s.influenceRadiusM,
          density: densityOfVisibility(v),
          // 标签写清：数值来自模型，范围是示意图层
          label: `${s.targetName} 能见度 ${v.toFixed(1)} ${s.unit}（模型）· 影响圈半径 ${s.influenceRadiusM}m（示意）`,
        })
      }
    } else {
      for (const a of bundle.assets) {
        const ev = events.find((e) => e.targetId === a.targetId)
        if (ev && t >= ev.at) {
          out.push({
            id: `damage:${a.assetId}`,
            kind: 'damage',
            path: a.footprint,
            level: (DAMAGE_HAZARD_LEVEL[a.level] ?? '中等') as '轻微' | '中等' | '严重' | '倒塌',
            label: `${a.targetName} ${a.level}（模型受损分布）`,
          })
        }
      }
      for (const c of bundle.closures) {
        if (c.targetType !== 'road') continue
        const path = c.path ?? roadPathOf(bundle, c.targetId)
        // 地图要求至少两个点才画线；只有单点时退化为一个标记点，不硬画零长度线段
        out.push({
          id: `rupture:${c.targetId}`,
          kind: 'rupture',
          path: path.length >= 2 ? path : [],
          label: `${c.targetName} 关闭（${c.mode === 'manual' ? '人工设定' : '规则判定'}，非模型结论）`,
        })
      }
    }
    return out
  }

  return {
    kind: bundle.provenance.disaster,
    events,
    scenario: {
      id: `model:${bundle.provenance.runId}`,
      title: `${bundle.provenance.disaster === 'fire' ? '火灾（FDS 算例）' : '地震（OpenQuake 算例）'} · ${bundle.provenance.caseId}`,
      summary: `${bundle.provenance.label}：${bundle.provenance.caseId}，引擎 ${bundle.provenance.engineVersion}。${bundle.provenance.scope}`,
      fixedInputs: [
        `算例 ID：${bundle.provenance.caseId}`,
        `引擎版本：${bundle.provenance.engineVersion}`,
        `运行命令：${bundle.provenance.solverCommand}`,
        ...bundle.provenance.inputs.map((i) => `输入：${i.path}${i.note ? `（${i.note}）` : ''}`),
        ...bundle.rules.map((r) => `演练规则 ${r.id}：${r.label}${r.note ? `（${r.note}）` : ''}`),
      ],
    },
    hazardsAt,
    provenance: bundle.provenance,
    modelEvents: events,
  } as DisasterPlan & { provenance: ModelDrillBundle['provenance']; modelEvents: ModelEventLike[] }
}

type ModelEventLike = ImpactEvent & { evidence?: ModelEvidence }

function roadPathOf(bundle: ModelDrillBundle, roadId: string): LngLat[] {
  const ev = bundle.events.find((e) => e.targetId === roadId)
  const g = ev?.geometry
  if (g && g.kind === 'point') return [g.at, g.at]
  return []
}

/** 采样时刻集合：用于在界面上说明“模型在哪些时刻有输出” */
export function modelTimelineOf(bundle: ModelDrillBundle): SimTime[] {
  const times: number[] = []
  for (const s of bundle.samples) for (const p of s.series) times.push(p.t)
  for (const e of bundle.events) times.push(e.at)
  return sortedUnique(times)
}
