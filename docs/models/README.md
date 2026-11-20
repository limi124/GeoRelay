# 专业模型算例（FDS / OpenQuake）

本目录说明 GeoRelay 首版接入的两个**外部求解器算例**：火灾用 [FDS](fire-fds.md)，地震用 [OpenQuake](quake-openquake.md)。

一句话定位：**求解器负责算出物理量（能见度时程、逐资产受损状态概率），GeoRelay 负责把这些数值按单独配置的演练规则换算成「受阻 / 受损」事件，再交给现有规划器与界面。** 两边分开存放、分开展示，不把工程判据说成模型结论。

两个算例都是**在本机真实跑过求解器**的：

| 算例 | 求解器（本机实测版本） | 归档目录 | 主输出 |
| --- | --- | --- | --- |
| `fire_entrance_smoke_v1` | FDS 6.11.2（SMV 6.11.3，Intel MPI 2021.16） | `artifacts/model-runs/fds-fire-entrance-20261118/` | 4 个探针的能见度时程 |
| `quake_scenario_damage_v1` | OpenQuake 3.26.2 | `artifacts/model-runs/oq-quake-damage-20261118/` | 12 个资产的受损状态概率 |

两个归档都在 `.gitignore` 里（`artifacts/` 与 `.tools/`、`.venv-oq/` 不入库）。换机器复跑要先自己装求解器，见两篇算例文档的「安装」与「如何复跑」。

---

## 1. 三层来源

界面上每条带模型背景的灾情都必须标出数据来源层级，定义在 `src/domain/modelrun/types.ts` 的 `ProvenanceLevel`：

| 层级值 | 界面徽标 | 定义 | 当前实际状态 |
| --- | --- | --- | --- |
| `model` | 模型计算结果回放 | 本次**真的在本机跑了求解器**，数值直接来自求解器输出文件 | **两个算例都是这一层**（`manifest.status = ok`） |
| `imported` | 官方算例导入 | 直接用官方发布的算例或结果，**未在本机重跑** | 类型与徽标文案已定义，**目前没有任何算例属于这一层** |
| `simplified` | 简化演示 | GeoRelay 自带的公式演示（固定速度烟雾、震中距 × 楼层放大），**不是求解器输出** | 未载入模型算例时的默认状态，界面照常标注 |

要点：

- 三层不是「质量等级」，是「数值从哪来」。`imported` 只是留了位置，别把没跑过的算例写成 `model`。
- 来源徽标随模式切换同步变化：`src/ui/DisasterBar.tsx` 依据 `provenance.level` 渲染，切到简化演示时同一灾种重建引擎（`src/App.tsx` 的 `switchProvenanceMode()`），灾情事件回到内置公式。
- 反向切换（简化演示 → 模型回放）要求该灾种**存在 `status = ok` 且 `available = true` 的归档**（`modelRunsFor()`），否则不切。

---

## 2. 两层证据

同一个「入口不可通行」事件里有两类事实，界面上必须分开显示（`src/ui/ModelEvidencePanel.tsx`，字段 `ModelEvidence.layers.model` / `layers.rule`）：

| 层 | 回答什么 | 数据来源 | 举例（火灾算例） |
| --- | --- | --- | --- |
| 模型层 | 求解器算出了什么数值 | 求解器输出文件 → `devc-summary.json` / `damage-summary.json` | `S1_ENTRANCE` 在 t=20.02 s 的能见度 3.304 m |
| 判据层 | GeoRelay 按哪条演练规则判定 | `models/<kind>/drill-rules.json` | `fire-vis-blocked`：能见度 < 10 m 判为不可通行 |

对应代码约定（`src/domain/modelrun/types.ts`）：

- `ModelEvidence` 里 `value` / `unit` 来自模型，`ruleId` / `ruleLabel` / `comparator` / `threshold` 来自演练规则；
- 事件的 `basis` 同时写模型输出与规则原文，`metrics` 只放模型数值；
- 规则与模型分开存文件，改阈值只改 `drill-rules.json` 再 `npm run model:ingest`，**不需要重跑求解器**。

一句话：**模型说「能见度 3.3 m」，规则说「< 10 m 就算不可通行」，GeoRelay 不替任何一方下结论。**

---

## 3. 目录结构

| 位置 | 内容 | 谁写 | 是否入库 |
| --- | --- | --- | --- |
| `models/fire_fds/` | FDS 输入 `.fds`、`mapping.json`（探针 → 对象）、`drill-rules.json`（阈值规则）、求解器原始输出 | 人工维护 | 是 |
| `models/quake_oq/` | `job.ini`、`exposure*.{csv,xml}`、`fragility.xml`、`site_model.csv`、`rupture_model.xml`、`mapping.json`、`drill-rules.json`、`closures.json` | 人工维护 | 是 |
| `artifacts/model-runs/<runId>/` | 求解器原始输出副本 + `manifest.json` + 规范化摘要（`devc-summary.json` / `damage-summary.json`）+ `run.log` | `npm run model:run:fds` / `model:run:oq` | 否（`artifacts/` 被忽略） |
| `src/data/model-runs/index.json` | 算例索引（runId、灾种、引擎版本、事件数、`available`、失败原因） | `npm run model:ingest` | 是（Web 只读缓存） |
| `src/data/model-runs/<runId>.json` | 回放包 `ModelDrillBundle`：来源声明 + 规则 + 采样时程 + 资产分布 + 事件（含证据）+ 关闭列表 | `npm run model:ingest` | 是 |
| `src/domain/modelrun/types.ts` | 归档契约（Manifest / SampleSeries / DamageAsset / DrillRule / ModelMapping / ModelEvidence / ModelDrillBundle） | 手写 | 是 |
| `src/domain/modelrun/registry.ts` | 读取索引与回放包（`import.meta.glob`，离线可用） | 手写 | 是 |
| `src/domain/disaster/modelRun.ts` | `planModelDisaster()`：回放包 → 统一 `DisasterPlan` / `ImpactEvent` | 手写 | 是 |
| `scripts/model_run_fds.ts` / `model_run_oq.ts` | 调求解器 + 生成归档与 `manifest.json` | 脚本 | 是 |
| `scripts/model_ingest.ts` | 归档 + 映射 + 规则 → `src/data/model-runs/*.json` | 脚本 | 是 |
| `scripts/model_verify.ts` | 只读校验：数值可追溯、规则可复算、事件进规划器、闭环送达 | 脚本 | 是 |

`.tools/`（FDS 解包目录）与 `.venv-oq/`（OpenQuake 虚拟环境）都不入库，属于本机环境。

---

## 4. 复跑顺序

前置条件：本机已装好求解器（FDS → `docs/models/fire-fds.md`；OpenQuake → `docs/models/quake-openquake.md`）。

```bash
# 1) 求解器 → artifacts/model-runs/<runId>/
npm run model:run:fds        # 已存在 status=ok 归档时直接复用，不重跑
npm run model:run:oq

# 2) 归档 + 映射 + 规则 → src/data/model-runs/*.json
npm run model:ingest

# 3) 只读校验（可追溯 / 可复算 / 进规划器 / 闭环送达）
npm run model:verify
```

补充约定：

- 两个 `model:run:*` 都支持 `--dry-run`（只自检、不求解）、`--force`（忽略已有 ok 归档重跑）、`--archive-only`（不求解，用已有输出重建归档）。
- 求解器路径可用环境变量覆盖：`FDS_EXE`、`OQ_PYTHON`。
- 求解失败时脚本会写一份 `status: 'failed'` 的 manifest 并以退出码 1 结束；`model:ingest` 会把失败算例写进索引（`available: false`）但**不生成回放包**，`model:verify` 会跳过并说明原因。
- 顺序不能反：`model:ingest` 只读 `artifacts/model-runs/`，`model:verify` 只读 `src/data/model-runs/`。两者都不调用求解器。
- 本机实测耗时：FDS 一次求解约 8.7 分钟（`manifest.wallClockS = 520.2`）；OpenQuake 这份归档的 `manifest.startedAt` / `wallClockS` 为 `null`（未记录），因此此处不给出耗时数字。

---

## 5. 本轮实测结果

| 项目 | 火灾（FDS） | 地震（OpenQuake） |
| --- | --- | --- |
| 求解器版本 | FDS 6.11.2（SMV 6.11.3） | OpenQuake 3.26.2 |
| runId | `fds-fire-entrance-20261118` | `oq-quake-damage-20261118` |
| 求解命令 | `fds fire_entrance_smoke_v1.fds`（cwd=`models/fire_fds`） | 引擎 API 驱动脚本，等价于 `oq engine --run job.ini` |
| 模型原始事件 | 4 条（4 个探针各一次能见度越限） | 12 条（12 个资产各一条受损分级） |
| 独立关闭设定 | 无 | 2 条（人工设定，非模型输出） |
| 事件总数 | 4 | 14 |
| 受影响任务（校验时） | 6 个 | 6 个 |
| 闭环结果 | 存在可行候选 → 确认 → 送达 | 存在可行候选 → 确认 → 送达 |

`npm run model:verify` 本机实测：**通过 58 · 失败 0**（火灾 21 项、地震 37 项；含逐点数值追溯、规则复算、事件进规划器、确认与送达）。

---

## 6. 明确限制（两个算例共有）

- **演示算例，不是工程评估**：单室火灾场景、单场景地震；不是本社区的性能化防火设计、也不是地震安全评估。
- **映射是人工标注**：`mapping.json` 只对预置演练社区有效；FDS 探针是局部米制坐标，与社区没有物理对应关系。
- **影响圈半径是示意**：`influenceRadiusM` 是地图显示用的固定值，不是求解器算出的烟气扩散范围。
- **未做敏感性分析**：两个算例都是单次确定性计算，没有参数扫描，也没有网格无关性验证（FDS）。
- **归档不入库**：`artifacts/`、`.tools/`、`.venv-oq/` 被 `.gitignore` 忽略，别人拿到仓库后必须自己装求解器才能复跑；`src/data/model-runs/*.json` 已入库，因此**不装求解器也能看回放**。
- **失败路径未实跑**：「求解器未安装时报错退出」目前只核对过脚本代码路径，没有在真正缺求解器的机器上跑过（见 `docs/mvp.md` 验收表）。

---

## 7. 相关文档

- [火灾 FDS 算例](fire-fds.md)
- [地震 OpenQuake 算例](quake-openquake.md)
- 仓库 README 的「专业模型算例（首版）」一节（命令表与验收数字）
- 首版验收清单 `docs/mvp.md`（模型相关验收行）
- 系统架构 `docs/architecture.md`（模型数据流）
- 求解器输入说明：`models/fire_fds/README.md`（FDS 算例几何/假设，求解器侧维护）
