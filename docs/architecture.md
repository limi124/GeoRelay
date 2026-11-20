# 系统架构

GeoRelay 把「社区建模」「灾情推演」「调度求解」「Agent 执行」分开。Web 指挥台是唯一界面，志愿者由 Agent 在演练时钟上模拟。所有层共享同一份社区数据与稳定的对象 ID。

```mermaid
flowchart LR
    A["社区模型<br/>围栏/楼栋/入口/路网"] --> B["内涝引擎<br/>涨水 → 阈值 → 封路事件"]
    A --> D["规则规划器<br/>可达性/库存/运力/时限"]
    B --> C["结构化灾情事件"]
    C --> D
    D --> E["排序接口<br/>默认规则 / 可选 AI"]
    E --> F["Web 指挥台<br/>候选比较 + 人工确认"]
    F --> G["Agent 模拟器<br/>接单/移动/交接/送达"]
    G --> H["状态与轨迹回写"]
    H --> F
    H --> I["演练记录<br/>快照→候选→选中→结果"]
```

## 分层与职责

| 层 | 目录 | 职责 | 不做什么 |
| --- | --- | --- | --- |
| 几何 | `src/domain/geo/` | WGS-84 ⇄ GCJ-02、多边形/矩形/折线运算、距离与取点 | 不做业务判断 |
| 社区模型 | `src/domain/community/` | 围栏校验、楼栋生成与校验、路网编辑与完备性检查 | 不画图、不联网 |
| 路网 | `src/domain/routing/` | 内部路网 Dijkstra、备用入口图节点、外部段提供者、图构建 | 内部路网绝不调用高德导航 |
| 灾情 | `src/domain/disaster/` | 三灾种：内涝涨水、火灾烟雾扩散、地震受损/断路 → 统一结构化影响事件 | 不决定改派 |
| 模型算例 | `src/domain/modelrun/`、`src/domain/disaster/modelRun.ts` | 归档契约、回放包注册表、回放包 + 演练规则 → 统一 `DisasterPlan` / `ImpactEvent` | 不调用求解器、不改求解器数值、不做插值 |
| 演练 | `src/domain/sim/` | 状态机、规划器、排序接口、场景派生、记录 | 不依赖 React/DOM |
| 地图适配 | `src/map/` | 高德 2.0 与示例地图两套实现，同一 `MapAdapter` | 不持有业务状态 |
| 界面 | `src/App.tsx`、`src/ui/` | 编辑台与指挥台、地图联动、用户操作 | 不实现几何与规则 |
| 服务端 | `server/` | 高德代理、AI 代理、静态托管、健康检查 | 不落库、不记录密钥 |

关键约束：**`src/domain/**` 不 import React、不访问 DOM、不直接 fetch**。因此同一份模拟器既能跑在浏览器，也能跑在 `scripts/sim.ts` 的命令行里。

## 坐标系与 ID

- 内部统一 **WGS-84**；只有调用高德（地图渲染、Web 服务）时才在边界转换成 **GCJ-02**，避免 300–600 米偏移。
- 平面米制坐标以围栏第一个顶点为原点建立切平面（`src/domain/community/frame.ts`），用于楼栋几何、寻路与灾情判定。
- 对象 ID 稳定：楼栋 `bld-*`、大门 `gate-*`、接驳点 `stg-*`、路段 `road-*`。
- 无头批处理会设置 ID 命名空间（`setIdNamespace`），同一种子在不同进程里生成同一套 ID，便于复现与对照。

## 交接契约

| 交接点 | 数据 |
| --- | --- |
| 灾情 → 规划器 | `ImpactEvent`：灾种、事件 ID、演练时刻、受影响对象（路段/入口/接驳点/楼栋）、通行变化、影响等级、判定依据、可量化指标；路段部分同时写入 `RoadClosureEvidence` |
| 规划器 → 指挥台 | `Candidate[]`：关联事件、目标任务、外部段、内部段、ETA、时限余量、影响范围、逐条规则校验、改派理由、排序位次 |
| 指挥台 → 执行器 | `Plan`：方案版本、Agent、接力标记、药店、内外两段折线与耗时、确认时刻、风险 |
| 执行器 → 指挥台 | 阶段（取货/待交接/配送/送达/受阻）、进度、受阻路段、送达时刻、轨迹位置 |
| 全程 → 记录 | `snapshots`（状态快照）、`confirmations`（确认记录）、`results`（执行结果）、`inventory`（库存变化） |

## 关键设计决策

**1. 封路只屏蔽边，不屏蔽顶点。**
一条路的端点常常同时是其它路的交叉点。若按顶点封闭，封一条横向通道会顺带切断整条主动脉，所有候选都会变成「不可达」。因此 `DijkstraRouter.shortest(start, goals, blockedVerts, blockedRoads)` 区分两种封闭，`blockedSets()` 只把被淹的**大门/接驳点**放进顶点集合。

**2. 内部路线记录权威 `roadIds`。**
方案与候选的内部段保存 Dijkstra 返回的路段 ID 序列，而不是事后用几何折线反推。反推会把「经过同一条边的两次不同行程」误判成经过封闭路段，导致确认被错误拒绝。

**3. 先有派单，再定积水。**
`createEngine` 先按用户路网生成初始派单，再挑一条「既被在途派单经过、封掉后每栋楼仍能从某个大门到达」的路段作为封路目标。这样封路一定影响真实派单，改派才有意义，同时能演示「无关任务不变」。

**4. 示例路网必须真有回路。**
支线吸附到主轴线上的**真实采样点**（而不是算出来的垂足），并在不同深度生成横向通道。没有回路时，封掉任意一段主动脉都会把楼栋彻底隔离。

**5. 候选生成是异步的，因此推进也是异步的。**
`advance(engine, seconds)` 会等待本次推进产生的候选生成完成。否则「封路已发生但候选还没出现」的竞态会让演练无法复现。

**6. 规则校验与人工确认不可绕过。**
`confirmCandidate()` 会做最终校验：不可行候选直接拒绝；确认时刻若候选路线已压到新的封闭路段，也会拒绝并要求重新生成。AI 只能影响排序与解释。

## 三灾种统一模型

三种灾情都通过 `planDisaster()` 产出同一套 `DisasterPlan`：结构化影响事件 + 固定场景说明 + 每帧地图几何。

| 灾种 | 事件来源 | 判定依据 |
| --- | --- | --- |
| 内涝 | 每条路段切片一条涨水曲线，越过阈值即封路 | 水深 / 阈值 / 涨水历史 |
| 火灾 | 起火楼栋 + 烟雾前锋半径（时间线性扩张） | 烟雾半径、入口到起火点距离、烟雾浓度 |
| 地震 | 震级 + 震中距 + 楼层放大 + 固定种子扰动 → 受损等级；固定延迟发生多处断裂 | 震中距、衰减系数、受损指数、断裂点数 |

状态里只有三份“通行事实”：`closures`（路段）、`blockedDoors`（楼栋入口）、`blockedStaging`（接驳点）。可达性、候选生成、确认复核全部读这三份，因此**不需要为每个灾种另写调度器**。

**备用入口**（`src/domain/routing/doors.ts`）：给每栋楼在与正门相对的外立面上补一个第二疏散门节点，并用合成接入边（`access:<楼栋>:alt`）连到最近的内部路网顶点。这样“正门被封还能不能送到”是真的用 Dijkstra 算出来的；火灾 `no_alt` 变体会把备用入口一起封掉，于是规划器只能给出「当前无可行配送路线」及原因。

**规划器的入口回退**：`routeToTarget()` 先试正门，走不通再试备用入口。火灾是“入口被封”，地震是“入口没被封但唯一通路断了”——两种情况都在寻路层兜住，候选不会因为选错入口而全部不可行。

**地震场景的选点**：`chooseQuakeScenario()` 联合挑选「受灾任务 + 断裂路段 + 要作废的接驳点」，约束是每次断裂后都至少还有一个入口可达、最终正门不可达而备用入口可达，并优先切只被该任务使用的支线，避免误伤无关任务（验收要求无关任务派单与版本不变）。

## 专业模型算例的数据流（FDS / OpenQuake）

首版接入两个外部求解器算例。数据流是单向的，链路上每一段都有文件可查：

```text
求解器（fds.exe / OpenQuake）
  → artifacts/model-runs/<runId>/       原始输出 + manifest.json（输入/输出 sha256、版本、命令、状态）
  → scripts/model_ingest.ts             归档 + models/<kind>/mapping.json + drill-rules.json + 摘要
  → src/data/model-runs/index.json      + <runId>.json（回放包 ModelDrillBundle）
  → src/domain/modelrun/registry.ts     import.meta.glob 静态读入（前端不求解、不插值）
  → createEngine({ modelRun })          engine.ts 的 modelRun 分支
  → planModelDisaster(bundle)           回放包 + 规则 → DisasterPlan（事件 + hazardsAt(t)）
  → ImpactEvent                         统一结构，带 evidence（模型层 / 判据层）
  → 现有规划器 / UI / AI                可达性、候选、确认、Agent、复盘、aiContext 全部复用
```

| 环节 | 谁写 | 关键约束 |
| --- | --- | --- |
| 求解器 → 归档 | `scripts/model_run_fds.ts` / `model_run_oq.ts` | 只有退出码 0 且输出齐全才写 `status: 'ok'`；失败写 `status: 'failed'` 且不覆盖已有 ok 归档 |
| 归档 → 摘要 | 同上 | 数值**原样搬运**：`devc-summary.json` 只取时间列与 4 个 VISIBILITY 列、缺测写 `null`；`damage-summary.json` 只做列名映射，不归一化、不重排状态 |
| 归档 + 映射 + 规则 → 回放包 | `scripts/model_ingest.ts` | 采样点/资产 → 社区对象来自 `mapping.json`（人工标注）；「受阻/受损」判据来自 `drill-rules.json`；地震的道路关闭来自 `closures.json`。失败算例只进索引（`available: false`），不生成回放包 |
| 回放包 → 灾情计划 | `src/domain/disaster/modelRun.ts` | 灾害种类由 `bundle.provenance.disaster` 决定；`hazardsAt(t)` 在 t 时刻从采样时程取值（火灾）或按事件时刻显示（地震）；事件仍是统一 `ImpactEvent` |
| 回放包 → AI | `src/domain/sim/aiContext.ts` | 只读 `plan.modelEvents[].evidence` 的原始值搬运成 `modelEvidence`，AI 引用的 `evidenceId` 必须存在于当前 payload，否则 `validateAiRefs()` 拦下 |

**为什么模型算例跳过「场景自检自动收缩」。** `createEngine()` 在 `src/domain/sim/engine.ts` 里有一段兜底：简化演示场景若到演练结束时目标入口仍不可达，会主动收缩灾情范围（火灾先去掉路段封闭、地震逐个减少断路点），以保证默认场景有可行改派可演示。这段逻辑**只在 `!opts.modelRun` 时执行**：

```ts
// src/domain/sim/engine.ts（注释原文）
// 专业模型算例例外：灾情是求解器输出 + 独立演练规则的固定结果，不能为了“凑出可行方案”
// 去改它（那就不是模型回放了）。若确实没有可行候选，就如实呈现“无可行方案”。
```

原因很直接：收缩灾情等于**改物理结果去迁就调度器**，那样归档里的数值与界面上发生的事就对不上了，「模型回放」这个来源标注也就失效了。因此模型算例即使出现「无可行方案」，也照实显示，不改事件、不改阈值、不改关闭列表。

## 本轮新增共享模块与数据流

本轮新增的四个模块都只做「读状态 / 产出派生数据」，不引入第二份真相；Web 与命令行脚本复用同一份域层代码。

| 模块 | 输入 | 输出 | 是否写状态 |
| --- | --- | --- | --- |
| `src/domain/sim/presets.ts` | 无（常量表 `DRILL_PRESETS`） | 场景 ID / 灾种 / 种子 / 时长 / 下一步 / 关注点 | 否 |
| `src/domain/sim/replay.ts` | 引擎当场记录（`impacts`、`planSets`、`record.results`、`events`） | 按演练时刻排序的复盘条目 | 否 |
| `src/domain/sim/aiContext.ts` | 当前演练状态 `DrillState` | AI payload、引用校验结果、可建议候选集 | 否 |
| `src/data/compare-sample.json` | `scripts/compare.ts` 的无头对照输出 | 只读面板数据（实验信息 / 指标口径 / 每种子结果） | 否（面板只读） |

### presets → 预置社区副本 → 引擎

`DRILL_PRESETS` 只描述「开一场什么演练、下一步点什么」，不持有社区模型。载入流程（`src/App.tsx` 的 `loadPreset()`）：

1. `buildPresetCommunity()`（`src/domain/community/demo.ts`）现造一份独立社区副本：凹形围栏 + 12 栋楼 + 两个大门 + 两个接驳点；构建期间 `setIdNamespace('preset')` + `resetIdCounter()`，函数结束前复位 `setIdNamespace('')`；
2. 用 `preset.seed` 造示例药店库存与示例外部路线提供者，再 `createEngine({ community: 副本, seed, durationS, disaster })` 开新引擎；
3. `presetMode = true` 期间持久化 effect 直接 return，因此副本不写回 `localStorage`；用户开始自己编辑（`leavePresetMode()`）后恢复写回——这一步之后保存会把当前（预置）社区写回，是已知边界而不是隔离机制。

因为副本 ID 固定，三个场景的 `roadId` / `buildingId` 与封路序列在重启后仍一致；无头题库脚本 `scripts/ai_bank.ts` 用同一套 `DRILL_PRESETS` 复现同样的快照。

### replay 只读派生

`buildReplay(state)` 是纯函数：遍历 `state.impacts`、`state.planSets`（含 `confirmedCandidateId`）、`state.record.results` 与 `state.events`（`agent_relay` / `agent_blocked`），返回 `ReplayEntry[]`，按 `at` 升序、同刻按 id 排序，标题前缀加演练时钟。它不写回任何字段，因此复盘与当场看到的内容必然一致。

界面点击只改本地选中态并在地图上定位（`fitBounds` 到路段 / 飞到楼栋 / 切到候选集）。选中候选集时，`App.tsx` 会把被 `supersededBy` 标记的旧方案以 `baseline` 线型补画（标签「原路线」），与新方案的 `approved` 实线成对出现。

### compare JSON → 只读面板

数据流是单向的：`scripts/compare.ts`（无头、两策略同输入）→ `npm run compare -- --out=src/data/compare-sample.json` → `src/ui/ComparePanel.tsx` 直接 `import` JSON。面板只渲染 `experiment` / `metricDefinitions` / `pairs`，**不重算统计**，避免 Web 与命令行两套算法；JSON 里的 `experiment.command` 是脚本拼的命令文本（不含 `--out=`），实际生成命令以 README 为准。当前样例（种子 42/7/99、步长 5s、时长 2400s）已用修复后的代码重新生成。

### aiContext：Web 与题库共用 payload 与校验

`src/domain/sim/aiContext.ts` 是 AI 相关逻辑的唯一入口：

- `buildAiPayload()` 把 `DrillState` 压成事件、受影响任务、候选（含可行性与逐项校验）、队伍、库存与 `expiredCandidateIds`；
- `relevantPlanSets()` 只保留**尚未确认**的候选集，作为改派建议来源；
- `validateAiRefs()` 校验模型返回的引用：未知任务 / 事件、未知候选、不可行候选、已确认候选集里的过期候选一律 `rejected` 并给原因。

Web 的「AI 调度分析」与 `scripts/ai_bank.ts` 的 10 道验收题走同一个 payload、同一套校验，因此题库里的通过 / 不通过结论等于界面上会得到的行为。

### 接力候选的可达判定（本轮修复）

修复前所有 `staging_relay`（换接驳点）候选恒判不可行，候选卡「接驳点可达」永远失败。根因与改法（`src/domain/sim/planner.ts` 的候选 B：围栏临时接驳点接力段）：

1. `relay.key` 实际是**顶点 ID**（`relayOptionsFor()` 用 `v.id` 生成），旧代码却按**节点键**查 `router.verts.byNode.get(relay.key)`，查不到 `relayV`；现改为 `router.verts.byId.get(relay.key) ?? router.verts.byNode.get(relay.key)`，两种 key 都能命中。
2. 内部 Agent 到接驳点这一步此前没有真实寻路——起终点是空的，`shortest()` 直接返回空路径，`canReachRelay` 恒为 false。现起点取 `startPool`：内部 Agent 自己驻守的接驳点 + 所有**当前未被封**的接驳点，去重后交给 `router.router.shortest(startIds, [relayV.id], blocked.verts, blocked.roads)` 做真实 Dijkstra。
3. 步行到接驳点的耗时与折线并入内部段（`durationS` / `distanceM` / `roadIds` / `path` 都加上这段路），ETA 不再漏算。
4. 允许「从可用接驳点前置出发」：内部 Agent 驻守的接驳点被灾情作废时，把仍可用的接驳点作为起点（演练里视为指挥员提前部署），校验说明里区分「从驻守的接驳点」与「已前置到可用接驳点」，不假装人凭空出现。
5. 同一条 `routeToTarget()` 同时负责「正门走不通就退回备用入口」（外部段候选、接力内部段、换组候选都走它），因此换入口与换接驳点共用一套可达判定与原因文案。

已知边界：`relayOptionsFor()` 会枚举围栏临时接驳点（`edgegate:*`），但过滤用的是 `reachable([g.id])`，这些 id 不在路网图顶点里（可达集合为空），所以这类选项当前不会出现在候选里——只有用户标记的接驳点会成为接力候选。

## AI 调度分析

`POST /api/ai/analyze` 三种入口（`situation` / `affected` / `compare`），请求只带当前演练的结构化状态，不带任何密钥到前端。

- 有凭据：调用 OpenAI 兼容接口，严格 JSON 输出；服务端只做结构校验（items 必须是数组），不做业务放行。
- 无凭据：规则模式，由结构化状态直接生成分析文本，标注「未联通真实模型」。
- `AI_MOCK=1`：模拟 AI，用于在没有凭据时验证流程；`?ai=bad-id|expired|timeout|bad-format` 可复现异常分支。
- 前端 `validateAiRefs()` 负责业务校验：未知任务/事件/候选、未通过规则校验的候选、已确认候选集里的过期候选全部拦下并给出原因。**AI 不修改任何状态**，改派仍由指挥员确认并经规则复核。

## 可替换的排序接口

```ts
// src/domain/sim/ranker.ts
export interface CandidateRanker {
  readonly id: string
  readonly mode: 'rules' | 'ai'
  rank(input: { task: Task | null; candidates: Candidate[]; now: number }): Promise<RankingResult>
}
```

默认实现 `RuleRanker`：可行性 → 时限余量 → 可靠性（外部取货/交接次数）→ 改动量。后续接入 AI 调度 Agent 时让它查询状态、调用规划器、实现本接口提交排序与解释；也可以用同一个模拟器（`scripts/sim.ts --json` 输出候选与结果）训练强化学习排序策略。**换排序器不改变规则校验与确认流程。**

## 安全

- 高德 Web Key 由服务端 `/api/amap/config` 下发；安全密钥由 `/api/amap/security` 同源下发并映射到 `window._AMapSecurityConfig`，不写入页面源码。
- `AMAP_REST_KEY`、`AI_API_KEY` 只在 Node 进程内使用，浏览器只访问同源 `/api/*`。
- 服务端日志只记录错误码与消息，**不记录含 Key 的 URL**；健康检查只返回脱敏后的 Key。
- 已用脚本核查 `dist/`：不含真实密钥；`sk-` 形式的高熵串为 0。

## 扩展点

| 扩展 | 做法 |
| --- | --- |
| 火灾 / 地震 | 复用 `SimEvent` + `RoadClosureEvidence` 结构，替换灾种与判定函数，规划器与界面无需改动 |
| 真实导航 | 实现 `ExternalLegProvider`（已有 `AmapExternalProvider`），内部段仍走 Dijkstra |
| AI 调度 Agent | 实现 `CandidateRanker`，并可调用 `/api/ai/explain` 做解释 |
| 对照实验 / RL 训练 | 用 `scripts/sim.ts --json` 固定 seed 批量产出「快照 → 候选 → 选中 → 结果」 |
| 更多灾情图层 | 在 `MapAdapter` 增加 setter，两套实现同步，界面不改 |
