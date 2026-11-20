# OpenQuake 地震算例（quake_scenario_damage_v1）

固定、可复跑的单场景地震受损算例，用来把「逐资产受损状态分布」落到 GeoRelay 的楼栋上。
**这不是本社区的抗震评估**，只是一个规模很小、参数全公开的演示算例。

## 文件

| 文件 | 作用 |
|---|---|
| `job.ini` | 算例主配置：`calculation_mode = scenario_damage`、`random_seed = 42`、GMPE `BooreAtkinson2008`、`truncation_level = 3.0`、`number_of_ground_motion_fields = 10`、强度测度 PGA |
| `rupture_model.xml` | 场景震源：M6.2，震中 (121.4730, 31.2650)，深 8 km，沿走向 0–15 km |
| `exposure.csv` | 12 个资产 B01–B12（社区坐标），B01–B09 `RC_8`、B10–B12 `URM_5`，每个 3,600,000 / 1,200,000 名义造价 |
| `exposure_model.xml` | 暴露模型（把 `exposure.csv` 包成 oQ 能读的 NRML） |
| `fragility.xml` | 脆弱性曲线：`no_damage / slight / moderate / extensive / complete` 五状态，按 taxonomy 分别给中值/离散度 |
| `site_model.csv` | 场地参数 vs30 250–400 m/s |
| `mapping.json` | 资产 B01–B12 → 预置演练社区楼栋（`bld-preset6`…`bld-preseth`）的人工映射 |
| `drill-rules.json` | 受损状态概率 → 演练分级（倒塌/严重/中等/轻微）的判据（**不属于模型结论**） |
| `closures.json` | 道路/接驳点关闭设定（**人工设定，不由楼栋受损推导**） |

## 复跑

```powershell
npm run model:run:oq -- --force      # 强制重跑求解器并重建归档
npm run model:run:oq -- --dry-run    # 只做路径/版本自检
npm run model:run:oq                 # 已有 ok 归档时直接复用，不重跑
npm run model:ingest                 # 归档 + 映射 + 规则 → src/data/model-runs/*.json
npm run model:verify                 # 追溯与闭环校验
```

求解器装在 `.venv-oq`（Python 3.11 + `openquake.engine 3.26.2`）。`OQ_PYTHON` 环境变量可指向别的解释器。

## 为什么走 Engine API 驱动脚本

`oq engine --run job.ini` 与 `python -m openquake.commands run job.ini` 都会先进入 `run_calc()` 的内存门限循环：

```python
while True:
    used_mem = psutil.virtual_memory().percent
    if used_mem < 80:
        break
    logging.info('Memory occupation %d%%, the user should free some memory' % used_mem)
    time.sleep(5)
```

本机系统内存占用长期 82–94%（与演练无关的桌面程序），CLI 只会每 5 秒打一条日志、永不启动计算。
因此归档里带 `_driver/run_via_engine_api.py`：它调用同一套 `oqparam` / `calculators` 对象，**不改** GMPE、脆弱性曲线、随机种子与输出内容，也不改 oQ 源码。

## 输出

主输出是官方 `damages-rlzs` 导出的 `output/avg_damages-rlz-000_5.csv`：每个资产 5 个受损状态的概率，逐行相加 ≈ 1。

> 注意：oQ 3.26.2 的导出键是 `damages-rlzs` / `damages-stats`，**没有** `dmg_by_asset` 这个键（早期 oQ 文档里的写法）。本算例用的是 `damages-rlzs` 的 CSV 导出；`scripts/model_run_oq.ts` 会把它另存一份 `dmg_by_asset.csv` 以对齐归档契约文件名。

其余输出：`avg_gmf_5.csv`（PGA）、`site_model_5.csv`、`realizations_5.csv`、`aggrisk-_5.csv`、`risk_by_event_5.csv`、`sigma_epsilon_5.csv`、`events_5.csv`、`gmf-data_5.csv`、`sitemesh_5.csv`。

## 资产映射与分级（本机实测）

`model:ingest` 按 `drill-rules.json` 换算，结果：B01–B09「中等」（9 栋）、B10「严重」、B11/B12「倒塌」（URM_5 受损更重，与脆弱性曲线一致）。

楼栋受损事件只进入 `ImpactEvent` 的 `building` 类型——它只影响界面展示与 AI 引用，**不会**封路、不会阻断入口。

## 道路与接驳点关闭

`closures.json` 是本轮单独设定的演练决定：西门主动脉 @120 s、中央接驳点 @180 s，`mode = manual`。
把这部分单独放一个文件，就是为了避免把「楼栋受损分布」误当成「道路中断结论」——那是一次不成立的外推。

## 限制

- 单场景、单实现（`realizations_5.csv` 只有 1 条、权重 1.0），没有概率地震危险性分析，也没有多次抽样。
- 12 个资产的造价与脆弱性曲线为演示参数，不是本社区的真实建筑资料。
- 资产 → 楼栋是坐标级的近似映射，不是逐栋核对。
- 分级阈值（0.5）是演练判据，不是规范条文。
- 算例耗时、算例规模都与真实区域尺度相差很远。

相关文档：[`docs/models/quake-openquake.md`](../../docs/models/quake-openquake.md)
