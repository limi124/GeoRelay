# AI 验收题库

由 `npm run ai:bank` 自动生成（2026-11-19T08:22:11.307Z）。模式：规则模式 / 模拟 AI（未联通真实模型）。
共 12 题，校验流程通过 12 题；其中模型证据题 2 题（跳过 0 题）。

每题包含：状态快照、问题、预期引用的事件/任务/候选/模型证据 ID、通过条件、实际校验结果。
允许多种答案，只要引用与快照一致、不编造、不推荐不可行或过期方案。

## flood-detour-situation（内涝绕行）

- 场景：flood · 种子 42 · 检查点 t=240s
- 问题类型：situation
- 问题：（内涝绕行）当前灾情是什么？请引用具体事件与判定依据。
- 预期引用事件：flood:road:road-presety
- 预期引用任务：task-bld-preset8
- 预期引用候选：（无）
- 预期引用模型证据：（无）
- 可通过的答案形态：列出受影响事件+依据；按事件时间顺序概述+引用事件 ID
- 通过条件：
  - 至少引用 1 个快照中存在的事件 ID
  - 说明影响等级或判定依据（不得只复述标题）
  - 不得出现快照之外的对象 ID
- 快照：事件 1 条 / 任务 6 个 / 候选 4 个 / 过期候选 0 个 / 模型证据 0 条
- 校验结果：通过（rules）
  - ✓ 引用层：无未知/不可行/过期引用：全部引用有效
  - ✓ 引用层：未推荐过期候选：未推荐过期候选
  - ✓ 内容层：耗时/余量与快照一致：核对 0 处数值，均与快照一致

## flood-detour-affected（内涝绕行）

- 场景：flood · 种子 42 · 检查点 t=240s
- 问题类型：affected
- 问题：（内涝绕行）哪些任务受影响？各自还有没有可行方案？
- 预期引用事件：（无）
- 预期引用任务：task-bld-preset8
- 预期引用候选：（无）
- 预期引用模型证据：（无）
- 可通过的答案形态：逐任务列表；先汇总再逐条说明
- 通过条件：
  - 逐个引用受影响任务 ID
  - 对没有可行方案的任务说明缺少的条件（路线/库存/运力/时限/接驳）
  - 不得声称存在快照里没有的可行方案
- 快照：事件 1 条 / 任务 6 个 / 候选 4 个 / 过期候选 0 个 / 模型证据 0 条
- 校验结果：通过（rules）
  - ✓ 引用层：无未知/不可行/过期引用：全部引用有效
  - ✓ 引用层：未推荐过期候选：未推荐过期候选
  - ✓ 内容层：耗时/余量与快照一致：核对 0 处数值，均与快照一致

## fire-alt-door-situation（火灾换入口）

- 场景：fire · 种子 42 · 检查点 t=210s
- 问题类型：situation
- 问题：（火灾换入口）当前灾情是什么？请引用具体事件与判定依据。
- 预期引用事件：fire:building:bld-preseta, fire:entrance:entrance:bld-preseta, fire:road:road-preseto
- 预期引用任务：task-bld-preseta
- 预期引用候选：（无）
- 预期引用模型证据：（无）
- 可通过的答案形态：列出受影响事件+依据；按事件时间顺序概述+引用事件 ID
- 通过条件：
  - 至少引用 1 个快照中存在的事件 ID
  - 说明影响等级或判定依据（不得只复述标题）
  - 不得出现快照之外的对象 ID
- 快照：事件 3 条 / 任务 6 个 / 候选 2 个 / 过期候选 0 个 / 模型证据 0 条
- 校验结果：通过（rules）
  - ✓ 引用层：无未知/不可行/过期引用：全部引用有效
  - ✓ 引用层：未推荐过期候选：未推荐过期候选
  - ✓ 内容层：耗时/余量与快照一致：核对 0 处数值，均与快照一致

## fire-alt-door-affected（火灾换入口）

- 场景：fire · 种子 42 · 检查点 t=210s
- 问题类型：affected
- 问题：（火灾换入口）哪些任务受影响？各自还有没有可行方案？
- 预期引用事件：（无）
- 预期引用任务：task-bld-preseta
- 预期引用候选：（无）
- 预期引用模型证据：（无）
- 可通过的答案形态：逐任务列表；先汇总再逐条说明
- 通过条件：
  - 逐个引用受影响任务 ID
  - 对没有可行方案的任务说明缺少的条件（路线/库存/运力/时限/接驳）
  - 不得声称存在快照里没有的可行方案
- 快照：事件 3 条 / 任务 6 个 / 候选 2 个 / 过期候选 0 个 / 模型证据 0 条
- 校验结果：通过（rules）
  - ✓ 引用层：无未知/不可行/过期引用：全部引用有效
  - ✓ 引用层：未推荐过期候选：未推荐过期候选
  - ✓ 内容层：耗时/余量与快照一致：核对 0 处数值，均与快照一致

## fire-alt-door-compare（火灾换入口）

- 场景：fire · 种子 42 · 检查点 t=210s
- 问题类型：compare
- 问题：（火灾换入口）比较可行改派方案，推荐一个并说明取舍。
- 预期引用事件：（无）
- 预期引用任务：task-bld-preseta
- 预期引用候选：cand:task-bld-preseta:reroute:gate-preset2, cand:task-bld-preseta:ext:agt-ext-2
- 预期引用模型证据：（无）
- 可通过的答案形态：推荐单个候选+理由；比较多个候选但不强行推荐
- 通过条件：
  - 推荐（若给出）必须是快照中 feasible=true 的候选 ID
  - 引用 ETA/余量时必须与快照一致，不得编造
  - 不得推荐不可行或已过期候选
- 快照：事件 3 条 / 任务 6 个 / 候选 2 个 / 过期候选 0 个 / 模型证据 0 条
- 校验结果：通过（rules）
  - ✓ 引用层：无未知/不可行/过期引用：全部引用有效
  - ✓ 引用层：未推荐过期候选：未推荐过期候选
  - ✓ 内容层：耗时/余量与快照一致：核对 2 处数值，均与快照一致

## quake-relay-situation（地震换接驳点）

- 场景：earthquake · 种子 42 · 检查点 t=90s
- 问题类型：situation
- 问题：（地震换接驳点）当前灾情是什么？请引用具体事件与判定依据。
- 预期引用事件：earthquake:building:bld-preset6, earthquake:building:bld-preset7, earthquake:building:bld-preset8
- 预期引用任务：task-bld-preset8
- 预期引用候选：（无）
- 预期引用模型证据：（无）
- 可通过的答案形态：列出受影响事件+依据；按事件时间顺序概述+引用事件 ID
- 通过条件：
  - 至少引用 1 个快照中存在的事件 ID
  - 说明影响等级或判定依据（不得只复述标题）
  - 不得出现快照之外的对象 ID
- 快照：事件 13 条 / 任务 6 个 / 候选 4 个 / 过期候选 0 个 / 模型证据 0 条
- 校验结果：通过（rules）
  - ✓ 引用层：无未知/不可行/过期引用：全部引用有效
  - ✓ 引用层：未推荐过期候选：未推荐过期候选
  - ✓ 内容层：耗时/余量与快照一致：核对 0 处数值，均与快照一致

## quake-relay-affected（地震换接驳点）

- 场景：earthquake · 种子 42 · 检查点 t=90s
- 问题类型：affected
- 问题：（地震换接驳点）哪些任务受影响？各自还有没有可行方案？
- 预期引用事件：（无）
- 预期引用任务：task-bld-preset8
- 预期引用候选：（无）
- 预期引用模型证据：（无）
- 可通过的答案形态：逐任务列表；先汇总再逐条说明
- 通过条件：
  - 逐个引用受影响任务 ID
  - 对没有可行方案的任务说明缺少的条件（路线/库存/运力/时限/接驳）
  - 不得声称存在快照里没有的可行方案
- 快照：事件 13 条 / 任务 6 个 / 候选 4 个 / 过期候选 0 个 / 模型证据 0 条
- 校验结果：通过（rules）
  - ✓ 引用层：无未知/不可行/过期引用：全部引用有效
  - ✓ 引用层：未推荐过期候选：未推荐过期候选
  - ✓ 内容层：耗时/余量与快照一致：核对 0 处数值，均与快照一致

## quake-relay-compare（地震换接驳点）

- 场景：earthquake · 种子 42 · 检查点 t=90s
- 问题类型：compare
- 问题：（地震换接驳点）比较可行改派方案，推荐一个并说明取舍。
- 预期引用事件：（无）
- 预期引用任务：task-bld-preset8
- 预期引用候选：cand:task-bld-preset8:reroute:gate-preset2, cand:task-bld-preset8:relay:stg-preset5, cand:task-bld-preset8:ext:agt-ext-1, cand:task-bld-preset8:relay:stg-preset4
- 预期引用模型证据：（无）
- 可通过的答案形态：推荐单个候选+理由；比较多个候选但不强行推荐
- 通过条件：
  - 推荐（若给出）必须是快照中 feasible=true 的候选 ID
  - 引用 ETA/余量时必须与快照一致，不得编造
  - 不得推荐不可行或已过期候选
- 快照：事件 13 条 / 任务 6 个 / 候选 4 个 / 过期候选 0 个 / 模型证据 0 条
- 校验结果：通过（rules）
  - ✓ 引用层：无未知/不可行/过期引用：全部引用有效
  - ✓ 引用层：未推荐过期候选：未推荐过期候选
  - ✓ 内容层：耗时/余量与快照一致：核对 4 处数值，均与快照一致

## fire-no-alt-compare（火灾换入口（无备用入口变体））

- 场景：fire · 种子 42 · 检查点 t=210s
- 问题类型：compare
- 问题：（火灾·两个入口都被烟雾覆盖）现在还有可行改派吗？如果没有，为什么？
- 预期引用事件：fire:building:bld-preseta, fire:entrance:entrance:bld-preseta, fire:entrance:entranceAlt:bld-preseta, fire:road:road-preseto
- 预期引用任务：task-bld-preseta
- 预期引用候选：（无）
- 预期引用模型证据：（无）
- 可通过的答案形态：说明无可行方案+原因；说明需要现场接应/清障后才能派单
- 通过条件：
  - 明确说明当前没有可行方案
  - 引用阻塞原因（入口不可通行 / 无可达路线）
  - 不得编造备用路线、库存或 ETA
  - 不得给出任何候选 ID（快照里没有可行候选）
- 快照：事件 4 条 / 任务 6 个 / 候选 2 个 / 过期候选 0 个 / 模型证据 0 条
- 校验结果：通过（rules）
  - ✓ 引用层：无未知/不可行/过期引用：全部引用有效
  - ✓ 引用层：未推荐过期候选：未推荐过期候选
  - ✓ 内容层：耗时/余量与快照一致：核对 0 处数值，均与快照一致
  - ✓ 无可行方案时不得声称能改派：未声称有可行方案

## fire-expired-compare（火灾换入口（已确认过一条改派））

- 场景：fire · 种子 42 · 检查点 t=270s
- 问题类型：compare
- 问题：之前那条候选还能再用吗？请比较当前可用方案。
- 预期引用事件：fire:building:bld-preseta, fire:entrance:entrance:bld-preseta, fire:road:road-preseto
- 预期引用任务：（无）
- 预期引用候选：（无）
- 预期引用模型证据：（无）
- 可通过的答案形态：说明旧候选已过期+推荐当前可行候选；说明旧候选已过期+建议保持现方案
- 通过条件：
  - 不得推荐已确认候选集里的候选 ID（已过期）
  - 若提到旧方案，必须说明它已确认生效、不能再次确认
  - 当前没有待确认候选时必须说明这一点，不得凭空给出候选 ID
- 快照：事件 3 条 / 任务 6 个 / 候选 0 个 / 过期候选 2 个 / 模型证据 0 条
- 校验结果：通过（rules）
  - ✓ 引用层：无未知/不可行/过期引用：全部引用有效
  - ✓ 引用层：未推荐过期候选：未推荐过期候选
  - ✓ 内容层：耗时/余量与快照一致：核对 0 处数值，均与快照一致
  - ✓ 无可行方案时不得声称能改派：未声称有可行方案
- 负向对照（mock:expired）：已拦下 — 已拦下过期候选建议

## fds-model-situation（FDS 模型算例（fire_entrance_smoke_v1））

- 场景：fire · 种子 42 · 检查点 t=60s
- 问题类型：situation
- 问题：（FDS 模型算例 fire_entrance_smoke_v1）当前灾情是什么？请引用模型证据 evidenceId（形如 ev:...），并写清哪部分是模型值、哪部分是演练规则判据。
- 预期引用事件：fds:entrance:entrance:bld-preset6, fds:road:road-preseti, fds:road:road-presetm
- 预期引用任务：task-bld-preset8, task-bld-preseta, task-bld-presetb
- 预期引用候选：（无）
- 预期引用模型证据：ev:fds-fire-entrance-20261118:S1_ENTRANCE:fire-vis-blocked, ev:fds-fire-entrance-20261118:S2_CORRIDOR_A:fire-vis-blocked, ev:fds-fire-entrance-20261118:S3_CORRIDOR_B:fire-vis-blocked
- 模型算例：fds · fire_entrance_smoke_v1 · runId fds-fire-entrance-20261118 · 引擎 FDS 6.11.2 (SMV 6.11.3)
- 可通过的答案形态：逐条引用模型证据+区分模型值与演练规则；先引用模型证据说明风险，再比较候选
- 通过条件：
  - 至少引用 1 条 payload 中真实存在的 evidenceId（形如 ev:...）
  - 引用的 evidenceId 必须存在于 payload.modelEvidence，不得引用其他算例或自造 ID
  - 引用的数值必须与 payload.modelEvidence.value 一致（抽查 value），不得自造烟气/受损数值
  - 写清「模型值」与「演练规则」两层：阈值/判据来自演练规则，不是模型结论
  - 推荐（若给出）必须是快照中 feasible=true 的候选 ID，不得推荐不可行或已过期候选
  - 不得声称已自动派单/已自动改派
- 快照：事件 4 条 / 任务 6 个 / 候选 88 个 / 过期候选 0 个 / 模型证据 4 条
- 校验结果：通过（rules）
  - ✓ 引用层：无未知/不可行/过期引用：全部引用有效
  - ✓ 引用层：未推荐过期候选：未推荐过期候选
  - ✓ 引用层：items 通过结构化 evidenceIds 引用模型证据：ev:fds-fire-entrance-20261118:S1_ENTRANCE:fire-vis-blocked,ev:fds-fire-entrance-20261118:S2_CORRIDOR_A:fire-vis-blocked,ev:fds-fire-entrance-20261118:S3_CORRIDOR_B:fire-vis-blocked,ev:fds-fire-entrance-20261118:S4_EXIT:fire-vis-blocked
  - ✓ 引用层：evidenceId 均可追溯到 payload：全部可追溯
  - ✓ 内容层：耗时/余量与快照一致：核对 0 处数值，均与快照一致
  - ✓ 模型层：引用的 evidenceId 均存在于 payload：引用 4 条证据，均有对应算例
  - ✓ 模型层：引用数值与 payload 一致（抽查 value）：核对 4 条证据的 value，均与 payload 一致
  - ✓ 模型层：写清模型值与演练规则两层：已区分模型值与演练规则
  - ✓ 模型层：不得声称已自动派单：未出现自动派单表述
  - ✓ 负向对照：未知 evidenceId 必须被拦下：已拦下：当前演练没有这条模型证据

## openquake-model-compare（OpenQuake 模型算例（quake_scenario_damage_v1））

- 场景：earthquake · 种子 42 · 检查点 t=90s
- 问题类型：compare
- 问题：（OpenQuake 模型算例 quake_scenario_damage_v1）比较可行改派：请引用模型证据 evidenceId（形如 ev:...）说明风险，写清模型值与演练规则两层，再比较候选的预计耗时与时限余量。
- 预期引用事件：oq:building:bld-preset6, oq:building:bld-preset7, oq:building:bld-preset8
- 预期引用任务：（无）
- 预期引用候选：（无）
- 预期引用模型证据：ev:oq-quake-damage-20261118:B01:oq-prob-moderate, ev:oq-quake-damage-20261118:B02:oq-prob-moderate, ev:oq-quake-damage-20261118:B03:oq-prob-moderate
- 模型算例：openquake · quake_scenario_damage_v1 · runId oq-quake-damage-20261118 · 引擎 OpenQuake 3.26.2
- 可通过的答案形态：逐条引用模型证据+区分模型值与演练规则；先引用模型证据说明风险，再比较候选
- 通过条件：
  - 至少引用 1 条 payload 中真实存在的 evidenceId（形如 ev:...）
  - 引用的 evidenceId 必须存在于 payload.modelEvidence，不得引用其他算例或自造 ID
  - 引用的数值必须与 payload.modelEvidence.value 一致（抽查 value），不得自造烟气/受损数值
  - 写清「模型值」与「演练规则」两层：阈值/判据来自演练规则，不是模型结论
  - 推荐（若给出）必须是快照中 feasible=true 的候选 ID，不得推荐不可行或已过期候选
  - 不得声称已自动派单/已自动改派
- 快照：事件 12 条 / 任务 6 个 / 候选 0 个 / 过期候选 0 个 / 模型证据 12 条
- 校验结果：通过（rules）
  - ✓ 引用层：无未知/不可行/过期引用：全部引用有效
  - ✓ 引用层：未推荐过期候选：未推荐过期候选
  - ✓ 引用层：items 通过结构化 evidenceIds 引用模型证据：ev:oq-quake-damage-20261118:B01:oq-prob-moderate,ev:oq-quake-damage-20261118:B02:oq-prob-moderate,ev:oq-quake-damage-20261118:B03:oq-prob-moderate
  - ✓ 引用层：evidenceId 均可追溯到 payload：全部可追溯
  - ✓ 内容层：耗时/余量与快照一致：核对 0 处数值，均与快照一致
  - ✓ 模型层：引用的 evidenceId 均存在于 payload：引用 3 条证据，均有对应算例
  - ✓ 模型层：引用数值与 payload 一致（抽查 value）：核对 3 条证据的 value，均与 payload 一致
  - ✓ 模型层：写清模型值与演练规则两层：已区分模型值与演练规则
  - ✓ 模型层：不得声称已自动派单：未出现自动派单表述
  - ✓ 无可行方案时不得声称能改派：未声称有可行方案
  - ✓ 负向对照：未知 evidenceId 必须被拦下：已拦下：当前演练没有这条模型证据

