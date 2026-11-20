import type { DisasterKind } from './types.ts'

/**
 * 三个一键演练示例（固定初始状态、固定种子、固定时长）。
 *
 * 只描述“怎么开一场演练 + 下一步该点哪里”，不碰社区模型持久化：
 * 用预置社区开场景时不会覆盖用户自己保存的社区模型。
 */

export interface DrillPreset {
  id: 'flood-detour' | 'fire-alt-door' | 'quake-relay'
  title: string
  disaster: DisasterKind
  seed: number
  durationS: number
  summary: string
  /** 开场提示 */
  intro: string
  /** 下一步操作提示（界面直接展示） */
  nextSteps: string[]
  /** 这次要观察的关键点（验收用） */
  focus: string[]
}

export const DRILL_PRESETS: DrillPreset[] = [
  {
    id: 'flood-detour',
    title: '内涝绕行',
    disaster: 'flood',
    seed: 42,
    durationS: 2400,
    summary: '主动脉积水达到阈值封路，改用未封闭大门与路段绕行。',
    intro: '预置内涝场景：固定种子 42，演练 40 分钟，封路点由规则在开局时确定。',
    nextSteps: [
      '点「开始演练」，用「+5 分钟」推进到第一条封路事件。',
      '在右侧「影响事件」点开被封闭路段，确认水深与阈值。',
      '在「改派候选」里比较绕行方案，确认后由志愿者 Agent 执行并送达。',
    ],
    focus: ['封路 → 候选 → 确认 → 送达', '无关任务的派单与版本保持不变'],
  },
  {
    id: 'fire-alt-door',
    title: '火灾换入口',
    disaster: 'fire',
    seed: 42,
    // 火灾案例的备用入口在楼栋另一侧，改派后内部配送约 30 分钟；
    // 40 分钟窗口会在「配送中」就被截断，演示看不到送达，所以这个案例给 60 分钟。
    durationS: 3600,
    summary: '目标楼栋正门被烟雾覆盖，改走同一栋楼的备用入口送达。',
    intro: '预置火灾场景：起火点与烟雾扩张速度固定，+150s 正门不可通行，窗口 60 分钟。',
    nextSteps: [
      '点「开始演练」并推进到入口不可通行事件。',
      '在「影响事件」查看烟雾前锋半径与判定依据（不是水深）。',
      '候选里选择「换入口」方案，确认后观察 Agent 改走备用入口送达。',
    ],
    focus: ['正门受阻 → 备用入口候选', '火灾文案不使用水深/降雨'],
  },
  {
    id: 'quake-relay',
    title: '地震换接驳点',
    disaster: 'earthquake',
    seed: 42,
    durationS: 2400,
    summary: '多点路段断裂、原接驳点失效，改用仍可达的接驳点完成内外交接。',
    intro: '预置地震场景：固定震级与断裂点，原接驳点在 +120s 失去交接条件。',
    nextSteps: [
      '点「开始演练」并推进到原接驳点不可用。',
      '选中受影响任务，在「接力看板」查看谁在等谁。',
      '确认「换接驳点」候选，等外部到达 → 交接 → 内部配送 → 送达。',
    ],
    focus: ['交接前内部 Agent 不开始配送', '使用新接驳点，受影响任务本身送达'],
  },
]

export function presetById(id: string): DrillPreset | undefined {
  return DRILL_PRESETS.find((p) => p.id === id)
}
