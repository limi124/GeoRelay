# 地震算例：OpenQuake `quake_scenario_damage_v1`

本页说明 GeoRelay 地震演练接入的 OpenQuake 算例：它算什么、本机怎么跑通的、输出怎么映射到社区楼栋、受损等级由哪条规则换算、为什么**不能**把楼栋受损当成道路中断、以及明确做不到的地方。

- 求解器：**OpenQuake 3.26.2**（`.venv-oq`，Python 3.11.4）
- 算例输入：`models/quake_oq/`（`job.ini` 为 `scenario_damage`）
- 归档：`artifacts/model-runs/oq-quake-damage-20261118/`
- 来源层级：`model`（模型计算结果回放，本机真实跑过求解器）

---

## 1. 算例概览

| 项目 | 取值 | 出处 |
| --- | --- | --- |
| 计算模式 | `scenario_damage`（单场景地震动 → 逐资产受损状态分布） | `job.ini` |
| 随机种子 | `random_seed = 42` | `job.ini` |
| 破裂 | 简单断层，**M6.2**，走滑（rake 0.0），倾角 90°，0–15 km 深度 | `rupture_model.xml` |
| 震源 | 震中 (121.4737, 31.2650)，深 8.0 km；断层迹线沿 121.4400–121.5300、纬度 31.2650 | `rupture_model.xml` |
| 地震动模型 | `gsim = BooreAtkinson2008`，`truncation_level = 3.0` | `job.ini` |
| 地震动场 | `number_of_ground_motion_fields = 10`，`intensity_measure_types = PGA` | `job.ini` |
| 资产 | 12 个（`B01`–`B12`）：`RC_8` × 9、`URM_5` × 3 | `exposure.csv` |
| 暴露价值 | `RC_8` 每栋 structural 3,600,000；`URM_5` 每栋 1,200,000（演练数值，非真实造价） | `exposure.csv` |
| 脆弱性 | 5 个状态：`no_damage` / `slight` / `moderate` / `extensive` / `complete`，连续对数正态，PGA 0.02–2.00 g | `fragility.xml` |
| 场地 | `site_model.csv`：12 个点，`vs30` 250–400 m/s（`vs30measured=false`） | `site_model.csv` |
| 资产间最大距离 | `asset_hazard_distance = 5.0`（km） | `job.ini` |

脆弱性中位数为文献量级值（HAZUS-MH MR5、Lagomarsino & Giovinazzi 2006、Silva et al. 2014 的范围核对），**未针对任何真实建筑校准**，这一点写在其文件注释里。

---

## 2. 算例假设与适用范围

**适用**：把一份 OpenQuake 官方式 `scenario_damage` 输出（逐资产受损状态概率）接到演练流程里，验证「受损等级分级展示 → 楼栋受损事件 → 规划器 → 界面」这条链路。

**关键假设**：

1. **单场景、确定性**：一条破裂、一个 GMPE、10 个地震动场，无逻辑树、无不确定性传播、无事件集；
2. **断层是虚构的**：几何为演练编造，不是实测断层，也不是复发模型；
3. **资产是演练资产**：12 个点的经纬度与造价都是演练数据，不是真实建筑清单；
4. **脆弱性未校准**：中位数取文献量级，不代表这几栋楼的真实抗震能力；
5. **静态结果**：`scenario_damage` 输出震后受损状态分布，**没有时程**——GeoRelay 把它当作 t=60 s 已发生的灾情导入；
6. 没有余震、没有液化 / 滑坡、没有次生火灾。

**不属于本算例结论的事**：本社区的地震安全性评价、损失评估、人员伤亡估计。

---

## 3. 安装 OpenQuake

本机用虚拟环境 `.venv-oq`（Python 3.11.4），OpenQuake 装在 `E:\GeoRelay\.venv-oq\Lib\site-packages`。脚本检测不到环境时会给出提示：

```powershell
# 本机已有的环境（按脚本提示的方式安装）
.venv-oq\Scripts\python.exe -m pip install openquake.engine
# 验证
.venv-oq\Scripts\oq.exe --version          # 3.26.2
.venv-oq\Scripts\python.exe -m openquake.commands --version   # 3.26.2
```

`.venv-oq/` 被 `.gitignore` 忽略，不入库。装了 GDAL 依赖的机器上可能需要额外 wheel（本机安装日志见 `artifacts/model-runs/_install/`）。

---

## 4. 为什么用驱动脚本跑，而不是 `oq engine --run`

这是本算例最需要说清楚的一点。

**现象**：直接 `oq engine --run job.ini` 或 `python -m openquake.commands run job.ini`，进程不报错，但**每隔 5 s 只打一条日志、计算永不开始**。

**原因**：两个 CLI 入口都会先经过 `openquake.engine.engine.run_calc()` 的硬门限：

```python
while True:
    if psutil.virtual_memory().percent < 80:
        break
    logging.info('Memory occupation %d%%, the user should free some memory')
    time.sleep(5)
```

本机系统内存占用长期 **82–94%**，永远进不去这个循环的出口。另外，OpenQuake 3.26.2 的两个 CLI 入口都**没有 `--output-dir` 选项**（导出目录是 `job.ini` 的 `export_dir`）。

**做法**：用引擎自己的 API 驱动（`artifacts/model-runs/oq-quake-damage-20261118/_driver/run_via_engine_api.py`，由 `scripts/model_run_oq.ts` 首次运行时落盘，可逐字复核）：

```powershell
.venv-oq\Scripts\python.exe `
  artifacts\model-runs\oq-quake-damage-20261118\_driver\run_via_engine_api.py `
  job.ini <out 目录>
```

它调用的是 `readinput.get_params()` / `logs.init()` / `base.calculators(log.get_oqparam(), calc_id)` / `calc.run(exports='csv')`——也就是 `openquake.commands.run._run()` 用的同一套对象。

**等价性边界（照实说明）**：

- 相同：同一份校验过的 `job.ini`、同一 GMPE（`BooreAtkinson2008`）、同一脆弱性曲线、同一 `random_seed = 42`、同一组官方导出（`exports='csv'`）；
- 不同：**跳过了 CLI 里的 psutil 内存门限**，并把 `export_dir` 通过 `readinput.get_params()` 覆盖为归档目录（等价于 CLI 的 `job.ini + export_dir` 组合）；
- 未改动：没有任何 OpenQuake 代码、GMPE、曲线、种子或导出内容被修改。

也就是说：**计算内容与 CLI 一致，只是绕过了「内存不足就等待」这个与本算例数值无关的前置检查**。这一条是如实记录的限制，不是「CLI 也能跑」的替代说法。

---

## 5. 如何复跑

```bash
# 只自检：定位 python、打印引擎版本、校验输入与计划，不启动引擎
npm run model:run:oq -- --dry-run

# 正式复跑
npm run model:run:oq

# 已存在 status=ok 的归档时默认「复用、不重跑」；要重跑：
npm run model:run:oq -- --force

# 不求解，用 output/ 下已有 CSV 重建归档
npm run model:run:oq -- --archive-only
```

可用环境变量 `OQ_PYTHON` 指定别的解释器（优先于 `.venv-oq`）。脚本流程（`scripts/model_run_oq.ts`）：

1. 定位 python（`OQ_PYTHON` > `.venv-oq`）并读引擎版本（`oq.exe --version`，退回 `python -m openquake.commands --version`）；
2. 校验 6 个输入文件齐全（`job.ini` / `exposure.csv` / `exposure_model.xml` / `fragility.xml` / `site_model.csv` / `rupture_model.xml`）；
3. 运行驱动脚本，控制台输出写入归档 `run.log`；
4. 找到 `output/avg_damages-rlz-000_<calcId>.csv`，解析 `structural-*` 状态列，**原样搬运**成 `damage-summary.json`（不归一化、不重排状态）；
5. 任一步失败写 `status: 'failed'` 的 manifest 并以退出码 1 结束；若已有 ok 归档则**不覆盖**为 failed（避免把成功结果写坏）。

---

## 6. 输出：`damages-rlzs` 与 `dmg_by_asset` 的差异

本算例实际产出 10 个官方 CSV 导出（均在归档 `output/` 下）：

| 文件 | 内容 |
| --- | --- |
| `avg_damages-rlz-000_5.csv` | **主输出**：逐资产各受损状态的概率（`damages-rlzs` 导出） |
| `avg_gmf_5.csv` | 各站点 PGA（g），12 个资产点位实测范围 0.211–0.306 g |
| `site_model_5.csv` | 所用场地参数 |
| `realizations_5.csv` | GMPE 实现（本算例 1 条） |
| `aggrisk-_5.csv` | 聚合风险（各状态的**期望栋数**） |
| `risk_by_event_5.csv` | 按事件的风险 |
| `sigma_epsilon_5.csv` | 离散度 |
| `events_5.csv` | 事件清单 |
| `gmf-data_5.csv` | 逐站地震动（每个地震动场） |
| `sitemesh_5.csv` | 场地网格 |

**关于导出键名，容易踩错**：OpenQuake 3.26.2 的导出键是 **`damages-rlzs` / `damages-stats`**，**没有** `dmg_by_asset` 这个键（那是某些老版本 / 老文档里的叫法）。本算例用的是 `damages-rlzs` 的 CSV 导出，落盘文件名是 `avg_damages-rlz-000_5.csv`。

另外两点需要照实说明：

- 归档目录里**没有** `scripts/model_run_oq.ts` 代码里提到的 `dmg_by_asset.csv` 副本——这份归档由更早版本的脚本产出，`manifest.outputs[]` 记录的是 `output/avg_damages-rlz-000_5.csv`（sha256 `e153de5d…8725a0`）。用当前脚本重跑时会额外复制一份 `dmg_by_asset.csv`，属正常差异。
- `avg_damages-rlz-000_5.csv` 的**数值未被改写**：`damage-summary.json` 是它的逐行搬运，只做列名映射（`asset_id→assetId`、`structural-<state>→dmg[].state`）。

CSV 真实表头（3.26.2）：`asset_id,taxonomy,lon,lat,structural-no_damage,structural-slight,structural-moderate,structural-extensive,structural-complete`，解析按 `structural-` 前缀取状态列，不写死列名顺序。

---

## 7. 资产映射与受损分级

### 资产 → 楼栋

映射在 `models/quake_oq/mapping.json`（人工标注，**仅对预置演练社区有效**）：`B01`–`B12` 依次映射到 `bld-preset6`…`bld-preseth`（1–12 号楼）。它只用于把受损状态分布显示到楼栋上，**不代表这些楼栋的真实抗震能力**。

### 分级规则（判据层，不是模型结论）

规则在 `models/quake_oq/drill-rules.json`，按「最严重优先」逐条试：

| 规则 ID | 指标 | 判据 | 展示等级 |
| --- | --- | --- | --- |
| `oq-prob-complete` | `damage_complete`（complete 概率） | ≥ 0.5 | 倒塌 |
| `oq-prob-extensive` | `damage_extensive_plus`（extensive + complete） | ≥ 0.5 | 严重 |
| `oq-prob-moderate` | `damage_moderate_plus`（moderate 及以上） | ≥ 0.5 | 中等 |
| `oq-prob-slight` | `damage_slight_plus`（slight 及以上） | ≥ 0.5 | 轻微 |

阈值 0.5、累计概率口径都是**演练分级假设**，只影响界面分级与事件文案，不影响道路通行（见下一节）。

### 本机实测分级（`npm run model:verify` 输出）

| 资产 | taxonomy | 命中的规则 | 指标值 | 等级 |
| --- | --- | --- | --- | --- |
| B01–B09 | RC_8 | `oq-prob-moderate` | 0.6904 / 0.6736 / 0.6681 / 0.6408 / 0.6672 / 0.6069 / 0.6459 / 0.6265 / 0.5883 | 中等（9 栋） |
| B10 | URM_5 | `oq-prob-extensive` | 0.6693 | 严重 |
| B11 | URM_5 | `oq-prob-complete` | 0.5470 | 倒塌 |
| B12 | URM_5 | `oq-prob-complete` | 0.5060 | 倒塌 |

12 个资产的分级结果：**9 栋「中等」（B01–B09）、1 栋「严重」（B10）、2 栋「倒塌」（B11、B12）**，共 **12 条模型事件**。每个资产 5 个状态概率之和为 1（校验实测 Σ = 1.0000，容差 0.02）。

> 与 `aggrisk-_5.csv` 的差异要讲清楚：聚合风险给的**期望栋数**是 no_damage 1.95 / slight 1.71 / moderate 2.75 / extensive 2.69 / complete 2.89。分级规则取的是「单资产某个累计概率 ≥ 0.5」这条演练判据，不是在算期望栋数——两者口径不同，不能互相换算、也不该混着引用。

---

## 8. 为什么不能把楼栋受损当道路中断

这是本算例最容易被误读的地方：

- `scenario_damage` 只输出**资产（楼栋）**的受损状态分布，**不输出道路、桥梁、管网的破坏**，也没有路网拓扑；
- 从「某栋楼倒塌概率 0.55」推不出「旁边这条路中断」，那是另一套模型（道路脆弱性 + 连通性分析），本算例没有做；
- 因此 GeoRelay 把「道路 / 接驳点是否关闭」放在**独立文件** `models/quake_oq/closures.json` 里，`mode` 标为 `manual`，界面上单独标注来源。

本机设置（`closures.json`）：

| 目标 | 时刻 | 来源 | 说明 |
| --- | --- | --- | --- |
| `road-preseti`（西门主动脉） | 120 s | `manual` | 演练设定：巡查判定路面开裂关闭（人工判定，非 oQ 输出） |
| `中央接驳点`（staging） | 180 s | `manual` | 演练设定：接驳点暂停使用（人工判定，非 oQ 输出） |

改这两条不需要重跑求解器：改 `closures.json` 后 `npm run model:ingest` 即可。

---

## 9. 归档字段

`artifacts/model-runs/oq-quake-damage-20261118/`：

| 文件 | 说明 |
| --- | --- |
| `manifest.json` | `ModelManifest`，`model: 'openquake'` |
| `damage-summary.json` | 逐资产受损状态概率 `{assets:[{assetId,taxonomy,dmg:[{state,prob}]}], units:'probability'}`（主输出搬运） |
| `run.log` | 引擎控制台日志（`calc_id`、输入校验和、导出文件清单） |
| `output/*.csv` | 10 个官方导出（见第 6 节） |
| `_driver/run_via_engine_api.py` | 引擎 API 驱动脚本 |
| `_oqdata/` | 引擎数据存储目录（本地缓存，非交付物） |

`manifest.json` 关键字段：

| 字段 | 本算例取值 |
| --- | --- |
| `runId` / `model` / `caseId` | `oq-quake-damage-20261118` / `openquake` / `quake_scenario_damage_v1` |
| `engineVersion` | `OpenQuake 3.26.2` |
| `solverCommand` | 引擎 API 驱动脚本命令（含未用 CLI 的原因说明） |
| `status` | `ok` |
| `startedAt` / `finishedAt` / `wallClockS` | 均为 `null`（该归档未记录耗时，**不要引用耗时数字**） |
| `inputs[]` | 6 个输入文件，各带 sha256（`job.ini` = `85022579…6c2b3a`） |
| `outputs[]` | 10 个输出 CSV，各带 sha256 |
| `assets[]` | `B01`–`B12` 及其 taxonomy（`B01`–`B09` = `RC_8`，`B10`–`B12` = `URM_5`） |
| `notes[]` | 驱动原因、oQ 为静态结果、映射与关闭列表位置等声明 |

运行时标识（`run.log` 实测）：`calc_id = 5`，输入校验和 `483900772`。

---

## 10. 限制（照实写）

1. **单场景演示算例**：一条虚构破裂 + 单一 GMPE + 10 个地震动场，不是本社区的地震安全评估，也没有不确定性表达。
2. **脆弱性未校准**：曲线中位数是文献量级值，`vs30` 是演练取值（250–400 m/s，全部 `vs30measured=false`）。
3. **无时程**：只有震后静态受损分布，GeoRelay 把它当作 t=60 s 的既成灾情；没有「逐秒倒塌演化」这回事。
4. **只到楼栋**：不产出道路 / 管网破坏，道路关闭是人工设定（第 8 节）。
5. **分级阈值是演练假设**：0.5 的累计概率阈值换成 0.3 或 0.7，等级分布会变——变的是判据层，不是模型。
6. **CLI 未走通**：本机内存占用 82–94%，`oq engine --run` 的 psutil 80% 门限不放开；归档结果由引擎 API 驱动产出（第 4 节已说明等价性与边界）。**换到内存空闲的机器上，CLI 原命令应当可以直接跑，但本机未验证。**
7. **归档未记录耗时**：`startedAt` / `finishedAt` / `wallClockS` 为空，本页不给耗时结论。
8. **求解器目录不入库**：`.venv-oq/` 被忽略，换机器需重装；`models/quake_oq/` 目前没有求解器侧的 `README.md`（`fragility.xml` 注释里引用了它），假设清单以本页与各输入文件注释为准。

---

## 11. 相关文件

- 输入：`models/quake_oq/{job.ini,exposure.csv,exposure_model.xml,fragility.xml,site_model.csv,rupture_model.xml}`
- 映射与规则：`models/quake_oq/mapping.json`、`models/quake_oq/drill-rules.json`、`models/quake_oq/closures.json`
- 脚本：`scripts/model_run_oq.ts`、`scripts/model_ingest.ts`、`scripts/model_verify.ts`
- 回放缓存：`src/data/model-runs/oq-quake-damage-20261118.json`
- 总览：[`docs/models/README.md`](README.md)
