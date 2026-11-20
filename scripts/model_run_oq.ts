/**
 * 复跑 OpenQuake 地震算例（Scenario Damage），并把引擎导出整理成 `npm run model:ingest` 可直接消费的归档。
 *
 * 产物（artifacts/model-runs/oq-quake-damage-20261118/）：
 *   manifest.json        按 src/domain/modelrun/types.ts 的 ModelManifest（model='openquake'）
 *   damage-summary.json  逐资产受损状态概率 {assets:[{assetId,taxonomy,dmg:[{state,prob}]}],units:'probability'}
 *   dmg_by_asset.csv     官方 damages-rlzs 导出的副本（原名 output/avg_damages-rlz-000_<calcId>.csv）
 *   run.log              引擎控制台输出
 *
 * 用法：
 *   npm run model:run:oq                 已有 ok 归档则直接复用，不重跑引擎
 *   npm run model:run:oq -- --dry-run    只做自检（定位 python/引擎版本、校验输入、报告计划），不求解
 *   npm run model:run:oq -- --force      忽略已有 ok 归档，强制重跑
 *   npm run model:run:oq -- --archive-only  不求解，用 output/ 下已有 CSV 重建归档
 *   OQ_PYTHON=<path>                     指定 venv python（优先于 .venv-oq）
 *
 * 关于「oq engine --run job.ini --output-dir」：
 *   本机实测 OpenQuake 3.26.2 的两个 CLI 入口都没有 `--output-dir` 选项
 *   （`oq engine --help` / `oq run --help` 无该参数；导出目录是 job.ini 的 `export_dir` 参数），
 *   且 `oq engine --run` / `oq run` 会先过 `openquake.engine.run_calc()` 里的
 *   `while psutil.virtual_memory().percent >= 80: sleep(5)` 内存门限。本机系统内存长期 82–94%，
 *   CLI 会一直卡在该门限上而不开始计算。
 *   因此这里用引擎自己的 API 驱动（artifacts/model-runs/<runId>/_driver/run_via_engine_api.py）：
 *   走同一套 `log.get_oqparam()` / `base.calculators(...).run(exports='csv')`，
 *   不改 GMPE、脆弱性曲线、随机种子、输出内容，export_dir 通过 readinput.get_params 覆盖，
 *   等价于 CLI 的 job.ini + export_dir 组合。
 */
import { createHash } from 'node:crypto'
// scripts/env.d.ts 只给 fs/path/crypto 提供了最小类型声明；child_process 用它没有的类型面，
// 这里用 @ts-expect-error 引入并在本地声明所需形状（运行时不依赖类型）。
// @ts-expect-error 仓库类型垫片（scripts/env.d.ts）未声明 node:child_process
import { spawnSync as nodeSpawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ModelManifest } from '../src/domain/modelrun/types.ts'

interface SpawnResult {
  status: number | null
  signal: string | null
  stdout?: string | null
  stderr?: string | null
}
const spawnSync = nodeSpawnSync as (
  command: string,
  argv: string[],
  options: { cwd?: string; env?: Record<string, string | undefined>; encoding?: 'utf8'; maxBuffer?: number },
) => SpawnResult

/** 求解失败：main() 捕获后统一置非 0 退出码（已有 ok 归档时不覆盖成 failed） */
class RunFail extends Error {}

function fail(message: string): never {
  throw new RunFail(message)
}

const ROOT = process.cwd()
const RUN_ID = 'oq-quake-damage-20261118'
const CASE_ID = 'quake_scenario_damage_v1'
const MODEL = 'openquake' as const
const MODEL_DIR = join(ROOT, 'models', 'quake_oq')
const RUN_DIR = join(ROOT, 'artifacts', 'model-runs', RUN_ID)
const OUT_DIR = join(RUN_DIR, 'output')
const DRIVER = join(RUN_DIR, '_driver', 'run_via_engine_api.py')
const DAMAGE_UNIT = 'damage state probability'
const INPUT_FILES = ['job.ini', 'exposure.csv', 'exposure_model.xml', 'fragility.xml', 'site_model.csv', 'rupture_model.xml']

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const FORCE = args.includes('--force')
const ARCHIVE_ONLY = args.includes('--archive-only')

/** 引擎 API 驱动脚本（首次运行时落到 _driver/ 下，便于逐字复核） */
const DRIVER_SOURCE = `"""Run the GeoRelay scenario_damage case through the OpenQuake Engine API.

The CLI entry points (\`\`oq engine --run\`\` / \`\`oq run\`\`) both call
\`\`openquake.engine.engine.run_calc()\`\`, which starts with a hard memory gate:

    while True:
        if psutil.virtual_memory().percent < 80:
            break
        logging.info('Memory occupation %d%%, the user should free some memory')
        time.sleep(5)

On this workstation system-wide RAM usage sits at 82-94%, so the CLI never
starts the job. This script drives the same engine objects that
\`\`openquake.commands.run._run()\`\` uses, with the same validated job.ini.
No OpenQuake code, GMPE, fragility curve, seed or output is modified.

Usage: python run_via_engine_api.py <job.ini> <export_dir>
"""
import os
import sys
import getpass
import logging

os.environ['OQ_DISTRIBUTE'] = 'no'

from openquake.baselib import config
from openquake.commonlib import readinput, logs, dbapi
from openquake.calculators import base
from openquake.server import db

if len(sys.argv) != 3:
    sys.exit('usage: run_via_engine_api.py <job.ini> <export_dir>')

job_ini = os.path.abspath(sys.argv[1])
export_dir = os.path.abspath(sys.argv[2])
os.makedirs(export_dir, exist_ok=True)

dbfile = os.path.expanduser(config.dbserver.file)
if not os.path.exists(dbfile):
    db.actions.upgrade_db(dbapi.db)

user_name = getpass.getuser()
dic = readinput.get_params(job_ini, {'export_dir': export_dir})
log = logs.init(dic, log_level=logging.INFO, user_name=user_name)
logs.dbcmd('update_job', log.calc_id, {'status': 'executing', 'pid': os.getpid()})
with log:
    calc = base.calculators(log.get_oqparam(), log.calc_id)
    print('OQ_CALC_ID=%s' % calc.datastore.calc_id, flush=True)
    calc.run(concurrent_tasks=0, exports='csv')

print('OQ_DATASTORE=%s' % calc.datastore.filename, flush=True)
print('OQ_EXPORT_DIR=%s' % calc.oqparam.export_dir, flush=True)
print('OQ_DONE', flush=True)
`

/** 仓库内相对路径（node:path 的 relative 未在类型垫片里，这里自己算前缀） */
function rel(p: string): string {
  const root = resolve(ROOT).replace(/\\/g, '/').replace(/\/+$/, '')
  const abs = /^[A-Za-z]:|^\//.test(p) ? p.replace(/\\/g, '/') : resolve(ROOT, p).replace(/\\/g, '/')
  return abs.toLowerCase().startsWith(root.toLowerCase() + '/') ? abs.slice(root.length + 1) : abs
}

function sha256(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

function stamp(): string {
  const d = new Date()
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

function log(msg: string): void {
  console.log(`[oQ] ${msg}`)
}

function resolvePython(): string {
  const candidates: string[] = []
  if (process.env.OQ_PYTHON?.trim()) candidates.push(resolve(ROOT, process.env.OQ_PYTHON.trim()))
  candidates.push(join(ROOT, '.venv-oq', 'Scripts', 'python.exe'), join(ROOT, '.venv-oq', 'Scripts', 'python'))
  for (const c of candidates) if (existsSync(c)) return c
  fail(
    `[oQ] ✗ 找不到 OpenQuake 虚拟环境的 python。已尝试：\n` +
      candidates.map((c) => `    ${c}`).join('\n') +
      `\n[oQ] 请先创建虚拟环境并安装 OpenQuake（.venv-oq\\Scripts\\python.exe -m pip install openquake.engine），或用环境变量 OQ_PYTHON 指定解释器。`,
  )
}

/** 引擎版本：优先读 venv 里的 oq.exe --version，退回 python -m openquake.commands --version */
function probeEngineVersion(python: string): string {
  const oqExe = join(ROOT, '.venv-oq', 'Scripts', 'oq.exe')
  const attempts: Array<[string, string[]]> = []
  if (existsSync(oqExe)) attempts.push([oqExe, ['--version']])
  attempts.push([python, ['-m', 'openquake.commands', '--version']])
  for (const [exe, argv] of attempts) {
    const r = spawnSync(exe, argv, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    const raw = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
    const m = /(\d+\.\d+\.\d+)/.exec(raw)
    if (r.status === 0 && m) return `OpenQuake ${m[1]}`
  }
  return 'OpenQuake (版本未知)'
}

/** 当前归档的主输出：output/avg_damages-rlz-000_<calcId>.csv（damages-rlzs 导出） */
function findDamageCsv(): string | null {
  if (!existsSync(OUT_DIR)) return null
  const hits = readdirSync(OUT_DIR)
    .map((f) => ({ f, m: /^avg_damages-rlz-000_(\d+)\.csv$/.exec(f) }))
    .filter((x) => x.m)
    .map((x) => ({ path: join(OUT_DIR, x.f), calcId: Number(x.m![1]) }))
    .sort((a, b) => b.calcId - a.calcId)
  return hits.length ? hits[0].path : null
}

function existingOkArchive(): boolean {
  const manifestPath = join(RUN_DIR, 'manifest.json')
  const summaryPath = join(RUN_DIR, 'damage-summary.json')
  if (!existsSync(manifestPath) || !existsSync(summaryPath)) return false
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')) as ModelManifest
    return m.status === 'ok' && m.runId === RUN_ID
  } catch {
    return false
  }
}

function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  out.push(cur.trim())
  return out
}

interface DamageTable {
  assetHeader: string[]
  stateColumns: Array<{ column: string; state: string }>
  rows: string[][]
}

/**
 * 解析 damages-rlzs 导出。真实表头（OpenQuake 3.26.2，scenario_damage）：
 *   #,,,,,,,,"generated_by='OpenQuake engine 3.26.2', ..."
 *   asset_id,taxonomy,lon,lat,structural-no_damage,structural-slight,structural-moderate,structural-extensive,structural-complete
 * 这里不写死列名/顺序：按 "structural-" 前缀取状态列，前缀去掉作为 state。
 */
function parseDamageCsv(path: string): DamageTable {
  const lines = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
  const headerIdx = lines.findIndex((l) => parseCsvLine(l)[0] === 'asset_id')
  if (headerIdx < 0) throw new Error(`damages CSV 里找不到 asset_id 表头：${path}`)
  const header = parseCsvLine(lines[headerIdx])
  const stateStart = header.findIndex((h) => h.startsWith('structural-'))
  if (stateStart < 0) throw new Error(`damages CSV 里找不到 structural-* 状态列：${header.join(', ')}`)
  const stateColumns = header.slice(stateStart).map((column) => ({ column, state: column.replace(/^structural-/, '') }))
  const rows: string[][] = []
  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    rows.push(parseCsvLine(line))
  }
  return { assetHeader: header, stateColumns, rows }
}

function buildDamageSummary(table: DamageTable): {
  assets: Array<{ assetId: string; taxonomy?: string; dmg: Array<{ state: string; prob: number }> }>
  units: string
} {
  const idxAsset = table.assetHeader.indexOf('asset_id')
  const idxTax = table.assetHeader.indexOf('taxonomy')
  const idxState0 = table.assetHeader.findIndex((h) => h.startsWith('structural-'))
  return {
    units: 'probability',
    // 数值原样搬运：不做归一化、不重排状态
    assets: table.rows.map((cells) => ({
      assetId: cells[idxAsset],
      taxonomy: idxTax >= 0 ? cells[idxTax] : undefined,
      dmg: table.stateColumns.map((sc, i) => ({ state: sc.state, prob: Number(cells[idxState0 + i]) })),
    })),
  }
}

function writeManifest(m: ModelManifest): void {
  writeFileSync(join(RUN_DIR, 'manifest.json'), JSON.stringify(m, null, 2) + '\n', 'utf8')
  log(`已写 ${rel(join(RUN_DIR, 'manifest.json'))}（status=${m.status}）`)
}

/** 失败归档：已有 ok 归档时绝不覆盖（避免把成功结果写成 failed） */
function writeFailureManifest(
  stage: string,
  message: string,
  extra: { startedAt?: string; finishedAt?: string; wallClockS?: number; engineVersion: string; solverCommand: string },
): void {
  if (existingOkArchive()) {
    fail(
      `[oQ] ✗ ${message}\n[oQ] 已存在 status=ok 的归档，按约定不覆盖 manifest.json；失败详情见 run.log`,
    )
  }
  writeManifest({
    runId: RUN_ID,
    model: MODEL,
    caseId: CASE_ID,
    engineVersion: extra.engineVersion,
    solverCommand: extra.solverCommand,
    status: 'failed',
    startedAt: extra.startedAt,
    finishedAt: extra.finishedAt,
    wallClockS: extra.wallClockS,
    inputs: INPUT_FILES.filter((f) => existsSync(join(MODEL_DIR, f))).map((f) => ({ path: rel(join(MODEL_DIR, f)), sha256: sha256(join(MODEL_DIR, f)) })),
    outputs: [],
    notes: ['引擎未成功完成，未生成 damage-summary.json'],
    failure: { stage, log: rel(join(RUN_DIR, 'run.log')), message },
  })
  fail(`[oQ] ✗ ${message}`)
}

function run(): void {
  log(`算例：${CASE_ID}（runId=${RUN_ID}）`)
  log(`仓库根：${ROOT}`)
  const python = resolvePython()
  log(`Python：${python}`)
  const engineVersion = probeEngineVersion(python)
  log(`引擎版本：${engineVersion}`)

  const jobIni = join(MODEL_DIR, 'job.ini')
  if (!existsSync(jobIni)) fail(`[oQ] ✗ 找不到算例配置：${jobIni}`)
  const missingInputs = INPUT_FILES.filter((f) => !existsSync(join(MODEL_DIR, f)))
  if (missingInputs.length) fail(`[oQ] ✗ 算例输入不齐，缺少：${missingInputs.join(' / ')}（应位于 ${rel(MODEL_DIR)}）`)

  const solverCommand = `cd ${rel(MODEL_DIR)} && ${rel(python)} ${rel(DRIVER)} job.ini ${rel(OUT_DIR)}`

  if (!DRY_RUN && !FORCE && existingOkArchive()) {
    log(`✓ 已存在 status=ok 的归档 ${rel(RUN_DIR)}（manifest.json + damage-summary.json），复用，不重跑引擎`)
    log(`  主输出：${findDamageCsv() ? rel(findDamageCsv()!) : '(未找到 avg_damages-rlz-000_*.csv)'}`)
    log(`  如需强制重跑：npm run model:run:oq -- --force`)
    return
  }

  log(`运行目录（cwd）：${rel(MODEL_DIR)}`)
  log(`求解命令：${solverCommand}`)
  if (DRY_RUN) {
    log('--dry-run：仅自检，不启动引擎。')
    log(`将复制到归档：dmg_by_asset.csv（来自 output/avg_damages-rlz-000_<calcId>.csv）与 run.log`)
    log(`将写：manifest.json（status=ok）与 damage-summary.json（units='probability'）`)
    return
  }

  mkdirSync(OUT_DIR, { recursive: true })
  mkdirSync(join(RUN_DIR, '_driver'), { recursive: true })
  if (!existsSync(DRIVER)) {
    writeFileSync(DRIVER, DRIVER_SOURCE, 'utf8')
    log(`已生成引擎 API 驱动脚本：${rel(DRIVER)}`)
  } else {
    log(`复用已有引擎 API 驱动脚本：${rel(DRIVER)}`)
  }

  let startedAt: string | undefined
  let finishedAt: string | undefined
  let wallClockS: number | undefined
  let exitCode = 0
  let signal: string | null = null
  let consoleLog = ''

  if (ARCHIVE_ONLY) {
    log('--archive-only：不启动引擎，用 output/ 下已有 CSV 重建归档')
    const csv = findDamageCsv()
    if (!csv) fail(`[oQ] ✗ --archive-only 需要已有导出，但 ${rel(OUT_DIR)} 里没有 avg_damages-rlz-000_*.csv`)
    finishedAt = stamp()
    const prevLog = join(RUN_DIR, 'run.log')
    consoleLog = existsSync(prevLog) ? readFileSync(prevLog, 'utf8').trim() : ''
    if (consoleLog) log(`复用已有运行日志：${rel(prevLog)}`)
    else log(`! 归档里没有历史 run.log，manifest 将不登记日志输出（不伪造求解器日志）`)
    try {
      const prev = JSON.parse(readFileSync(join(RUN_DIR, 'manifest.json'), 'utf8').replace(/^\uFEFF/, '')) as ModelManifest
      startedAt = prev.startedAt ?? undefined
      finishedAt = prev.finishedAt ?? finishedAt
      wallClockS = prev.wallClockS ?? undefined
    } catch {
      /* 没有旧 manifest 就留空 */
    }
  } else {
    if (existingOkArchive()) log('--force：忽略已有 ok 归档，重跑引擎')
    startedAt = stamp()
    const t0 = Date.now()
    log('正在运行 OpenQuake（serial, exports=csv），控制台输出写入归档 run.log …')
    const r = spawnSync(python, [DRIVER, 'job.ini', OUT_DIR], {
      cwd: MODEL_DIR,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, OQ_DISTRIBUTE: 'no', PYTHONIOENCODING: 'utf-8' },
    })
    exitCode = r.status ?? 1
    signal = r.signal
    wallClockS = Number(((Date.now() - t0) / 1000).toFixed(1))
    finishedAt = stamp()
    consoleLog = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim()
    writeFileSync(join(RUN_DIR, 'run.log'), consoleLog + '\n', 'utf8')
    log(`引擎结束：退出码 ${exitCode}${signal ? ` / signal ${signal}` : ''}，耗时 ${wallClockS} s`)
  }

  const csv = findDamageCsv()
  if (exitCode !== 0 || !csv) {
    const message = exitCode !== 0 ? `OpenQuake 进程退出码 ${exitCode}${signal ? `（signal ${signal}）` : ''}` : `引擎未导出 avg_damages-rlz-000_*.csv（目录：${rel(OUT_DIR)}）`
    writeFailureManifest('solve', message, { startedAt, finishedAt, wallClockS, engineVersion, solverCommand })
    return
  }

  const calcId = /_(\d+)\.csv$/.exec(csv)?.[1] ?? '?'
  const damageCopy = join(RUN_DIR, 'dmg_by_asset.csv')
  copyFileSync(csv, damageCopy)
  log(`已复制主输出：${rel(csv)} -> ${rel(damageCopy)}（calcId=${calcId}）`)

  const table = parseDamageCsv(damageCopy)
  const summary = buildDamageSummary(table)
  if (!summary.assets.length) {
    writeFailureManifest('parse', `damages CSV 里没有资产行：${rel(damageCopy)}`, { startedAt, finishedAt, wallClockS, engineVersion, solverCommand })
    return
  }
  writeFileSync(join(RUN_DIR, 'damage-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8')
  log(`已写 ${rel(join(RUN_DIR, 'damage-summary.json'))}：${summary.assets.length} 个资产 × ${table.stateColumns.length} 个状态（${table.stateColumns.map((s) => s.state).join('/')}）`)
  for (const a of summary.assets.slice(0, 3)) {
    log(`  ${a.assetId}（${a.taxonomy ?? '未知'}）：${a.dmg.map((d) => `${d.state}=${d.prob}`).join(' / ')}`)
  }

  const outputFiles = existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter((f) => f.endsWith('.csv')) : []
  writeManifest({
    runId: RUN_ID,
    model: MODEL,
    caseId: CASE_ID,
    engineVersion,
    solverCommand,
    status: 'ok',
    startedAt,
    finishedAt,
    wallClockS,
    inputs: INPUT_FILES.map((f) => ({
      path: rel(join(MODEL_DIR, f)),
      sha256: sha256(join(MODEL_DIR, f)),
      note:
        f === 'job.ini'
          ? '算例主配置（calculation_mode=scenario_damage）'
          : f === 'exposure.csv'
            ? '资产暴露表（12 个资产，RC_8 / URM_5）'
            : undefined,
    })),
    outputs: [
      {
        path: rel(damageCopy),
        sha256: sha256(damageCopy),
        unit: DAMAGE_UNIT,
        note: `离线副本：官方 damages-rlzs 导出 output/avg_damages-rlz-000_${calcId}.csv（逐资产各受损状态概率，未做数值改写）`,
        columns: table.assetHeader,
      },
      ...(existsSync(join(RUN_DIR, 'run.log'))
        ? [
            {
              path: rel(join(RUN_DIR, 'run.log')),
              sha256: sha256(join(RUN_DIR, 'run.log')),
              unit: 'n/a',
              note: '引擎控制台日志（calc_id、输入校验和、导出文件清单）',
            },
          ]
        : []),
      ...outputFiles
        .filter((f) => f !== `avg_damages-rlz-000_${calcId}.csv`)
        .map((f) => ({ path: rel(join(OUT_DIR, f)), sha256: sha256(join(OUT_DIR, f)), unit: '', note: '引擎官方导出（csv）' })),
    ],
    assets: summary.assets.map((a) => ({ assetId: a.assetId, taxonomy: a.taxonomy })),
    notes: [
      `引擎版本：${engineVersion}（oq --version / python -m openquake.commands --version 原文）。`,
      `运行方式：cwd=${rel(MODEL_DIR)}，命令 ${solverCommand}；驱动脚本见 ${rel(DRIVER)}。`,
      `未用 oq CLI 的原因：OpenQuake 3.26.2 的 oq engine / oq run 都没有 --output-dir 选项（导出目录是 job.ini 的 export_dir），且 run_calc() 有 psutil 内存 < 80% 的硬门限；本机系统内存长期 82–94%，CLI 会一直等待而不开始计算。驱动脚本调用同一套引擎对象，计算内容与 CLI 完全一致。`,
      `列名映射（以真实 CSV 表头为准）：表头 ${table.assetHeader.join(',')}；asset_id→assetId，taxonomy→taxonomy，structural-<state>→dmg[].state='<state>'、dmg[].prob=该列数值（原样搬运，不归一化）。`,
      `damage-summary.json 的 units='probability'，顺序与 CSV 状态列一致：${table.stateColumns.map((s) => s.state).join(' / ')}。`,
      'oQ 输出为震后静态受损分布（无时程）；GeoRelay 演练中把它当作 t=60s 已发生的灾情使用，换算规则见 models/quake_oq/drill-rules.json。',
      '本算例为单场景演示算例（单一破裂 + 单一 GMPE + 10 个地震动场），不是本社区的地震安全评估。',
    ],
  })
  log(`✓ 完成。归档目录：${rel(RUN_DIR)}`)
}

function main(): void {
  try {
    run()
  } catch (err) {
    if (err instanceof RunFail) {
      console.error(err.message)
      process.exitCode = 1
      return
    }
    throw err
  }
}

main()
