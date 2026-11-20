import type { ImpactEvent, ImpactTargetType } from '../disaster/types.ts'
import { analyzeResilience, type ResilienceOptions } from './analysis.ts'
import type { CommunityModel } from './model.ts'

const measures = {
  flood: {
    road: '复核积水低点、雨水口和汇流路径，评估排水扩容与独立绕行通道。',
    entrance: '核查入口标高，评估防倒灌和更高位置的备用出口。',
    staging: '在较高且保持可达的位置设置备用接驳点。',
    building: '复核首层进水路径，评估挡水和关键设备抬升。',
  },
  fire: {
    road: '复核排烟影响和消防通道净宽，保留绕开烟区的第二通道。',
    entrance: '核查防烟分隔与疏散出口，验证备用出口能独立通往室外。',
    staging: '增设可绕开烟区的备用消防集结点。',
    building: '复核报警、防火分隔、排烟与疏散条件。',
  },
  earthquake: {
    road: '核查路旁坠落和障碍物风险，评估独立绕行通道。',
    entrance: '核查入口坠落风险和疏散净宽，设置独立备用出口。',
    staging: '在远离坠物影响的位置设置备用集结点和接入通道。',
    building: '优先开展抗震鉴定，检查结构薄弱层及外墙和设备锚固。',
  },
}

export function assessPrevention(model: CommunityModel, events: ImpactEvent[]) {
  const targets = new Map<string, ImpactEvent>()
  for (const event of events) {
    const key = `${event.targetType}:${event.targetId}`
    const previous = targets.get(key)
    if (event.traffic === 'blocked' || (event.targetType === 'building' && event.traffic === 'restricted')) {
      if (!previous || event.traffic === 'blocked') targets.set(key, event)
    }
  }
  const blocked = [...targets.values()].filter((event) => event.traffic === 'blocked')
  function access(restored?: ImpactEvent) {
    const ids = (type: ImpactTargetType) => blocked.filter((event) => event !== restored && event.targetType === type).map((event) => event.targetId)
    const options: ResilienceOptions = {
      blockedRoadIds: ids('road'),
      blockedDoorIds: [...ids('entrance'), ...ids('building').map((id) => `entrance:${id}`)],
      blockedStagingIds: ids('staging'),
    }
    return analyzeResilience(model, options)
  }
  const baseline = analyzeResilience(model).summary
  const scenario = access().summary
  const actions = [...targets.values()].map((event) => {
    const restored = event.traffic === 'blocked' && event.targetType !== 'building' ? access(event).summary : null
    return {
      event,
      measure: measures[event.disaster][event.targetType],
      gateGain: restored ? restored.gateReachableCount - scenario.gateReachableCount : null,
      stagingGain: restored ? restored.stagingReachableCount - scenario.stagingReachableCount : null,
    }
  }).sort((a, b) => Math.max(b.gateGain ?? 0, b.stagingGain ?? 0) - Math.max(a.gateGain ?? 0, a.stagingGain ?? 0))
  return { baseline, scenario, actions }
}
