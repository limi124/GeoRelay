/**
 * 复跑 FDS 火灾算例，并把求解器原始输出整理成 `npm run model:ingest` 可直接消费的归档。
 *
 * 产物（artifacts/model-runs/fds-fire-entrance-20261118/）：
 *   manifest.json        按 src/domain/modelrun/types.ts 的 ModelManifest
 *   devc-summary.json    4 个 VISIBILITY 采样点的时程（只搬运，不插值；排除 *_TEMP / *_EXT）
 *   fire_entrance_smoke_v1_devc.csv / .out / _hrr.csv / run.log   求解器原始输出副本
 *
 * 用法：
 *   npm run model:run:fds                  已有 ok 归档则直接复用，不重跑求解器
 *   npm run model:run:fds -- --dry-run     只做自检（定位求解器、校验输入、报告计划），不求解
 *   npm run model:run:fds -- --force       忽略已有 ok 归档，强制重跑
 *   npm run model:run:fds -- --archive-only  不求解，用 models/fire_fds/ 下已有输出重建归档
 *   FDS_EXE=<path>                         指定 fds 可执行文件（优先于默认安装路径）
 *
 * 实现要点：
 *  1. 在 models/fire_fds/ 下运行（FDS 把 *_devc.csv / *.out 写在 cwd）。
 *  2. fds.exe 需要同目录的 Intel MPI DLL（bin/mpi），否则进程以 0xC0000135 直接退出，
 *     因此子进程 PATH 里前置 bin 与 bin/mpi。
 *  3. 求解失败时写 status='failed' 的 manifest，不写 devc-summary.json，退出码 1。
 */
import { createHash } from 'node:crypto'
// scripts/env.d.ts 只给 fs/path/crypto 提供了最小类型声明；child_process 用它没有的类型面，
// 这里用 @ts-expect-error 引入并在本地声明所需形状（运行时不依赖类型）。
// @ts-expect-error 仓库类型垫片（scripts/env.d.ts）未声明 node:child_process
import { spawnSync as nodeSpawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

/** 求解失败：main() 捕获后统一置非 0 退出码（不写假的 summary/manifest） */
class RunFail extends Error {}

function fail(message: string): never {
  throw new RunFail(message)
}

const ROOT = process.cwd()
const RUN_ID = 'fds-fire-entrance-20261118'
const CASE_ID = 'fire_entrance_smoke_v1'
const MODEL = 'fds' as const
const MODEL_DIR = join(ROOT, 'models', 'fire_fds')
const CASE_FILE = `${CASE_ID}.fds`
const RUN_DIR = join(ROOT, 'artifacts', 'model-runs', RUN_ID)
const DEFAULT_FDS = join(ROOT, '.tools', 'fds', 'firemodels', 'FDS6', 'bin', 'fds.exe')
const VISIBILITY_UNIT = 'm'
const QUANTITY = 'visibility'

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const FORCE = args.includes('--force')
const ARCHIVE_ONLY = args.includes('--archive-only')

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
  console.log(`[FDS] ${msg}`)
}

/** 定位 fds 可执行文件：FDS_EXE > 默认安装路径；都找不到则报错退出 */
function resolveFdsExe(): string {
  const fromEnv = process.env.FDS_EXE?.trim()
  const candidates: string[] = []
  if (fromEnv) candidates.push(resolve(ROOT, fromEnv))
  candidates.push(DEFAULT_FDS)
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  fail(
    `[FDS] ✗ 找不到 fds 可执行文件。已尝试：\n` +
      candidates.map((c) => `    ${c}`).join('\n') +
      `\n[FDS] 请先安装 FDS 6（把 FDS6 解压到 .tools/fds/firemodels/FDS6/），或用环境变量 FDS_EXE 指定 fds.exe。`,
  )
}

/** fds.exe 依赖同目录的 Intel MPI DLL，子进程 PATH 必须前置 bin 与 bin/mpi */
function fdsEnv(exe: string): Record<string, string | undefined> {
  const binDir = dirname(exe)
  const mpiDir = join(binDir, 'mpi')
  const parts = [binDir, mpiDir, process.env.PATH ?? ''].filter(Boolean)
  return { ...process.env, PATH: parts.join(';') }
}

interface FdsVersion {
  version: string
  revision: string
  mpi: string
  raw: string
}

function probeVersion(exe: string): FdsVersion {
  const r = spawnSync(exe, ['-v'], { env: fdsEnv(exe), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const raw = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  const rev = /FDS revision\s*:\s*(\S+)/.exec(raw)?.[1] ?? ''
  const semver = /FDS-([\d.]+)/.exec(rev)?.[1] ?? ''
  const mpi = /MPI library version\s*:\s*(.+)/.exec(raw)?.[1]?.trim() ?? ''
  return { version: semver || 'unknown', revision: rev || 'unknown', mpi, raw }
}

function engineVersionOf(v: FdsVersion): string {
  return v.version === 'unknown' ? 'FDS (版本未知)' : `FDS ${v.version}（${v.revision}${v.mpi ? `，${v.mpi}` : ''}）`
}

/** 已有 ok 归档（manifest + summary + 原始 devc csv）则复用，不重跑求解器 */
function existingOkArchive(): boolean {
  const manifestPath = join(RUN_DIR, 'manifest.json')
  const summaryPath = join(RUN_DIR, 'devc-summary.json')
  const devcPath = join(RUN_DIR, `${CASE_ID}_devc.csv`)
  if (!existsSync(manifestPath) || !existsSync(summaryPath) || !existsSync(devcPath)) return false
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')) as ModelManifest
    return m.status === 'ok' && m.runId === RUN_ID
  } catch {
    return false
  }
}

interface DevcTable {
  units: string[]
  columns: string[]
  rows: number[][]
}

function parseCsvLine(line: string): string[] {
  return line.split(',').map((s) => s.trim().replace(/^"|"$/g, ''))
}

/** FDS 的 _devc.csv：第 1 行单位，第 2 行通道名，之后每行第 1 列是时间 */
function parseDevcCsv(path: string): DevcTable {
  const lines = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 3) throw new Error(`devc.csv 行数不足：${path}`)
  const units = parseCsvLine(lines[0])
  const columns = parseCsvLine(lines[1])
  const rows: number[][] = []
  for (const line of lines.slice(2)) {
    const cells = parseCsvLine(line)
    const nums = cells.map((c) => (c === '' ? Number.NaN : Number(c)))
    if (nums.some((n) => !Number.isFinite(n))) continue
    rows.push(nums)
  }
  return { units, columns, rows }
}

/** 采样点：以 models/fire_fds/mapping.json 为准；ID 精确匹配，排除 _TEMP / _EXT */
function visibilityChannels(table: DevcTable): Array<{ sampleId: string; colIndex: number; unit: string }> {
  const mappingPath = join(MODEL_DIR, 'mapping.json')
  let wanted: string[] = []
  if (existsSync(mappingPath)) {
    const mapping = JSON.parse(readFileSync(mappingPath, 'utf8').replace(/^\uFEFF/, '')) as {
      samples?: Array<{ sampleId: string }>
    }
    wanted = (mapping.samples ?? []).map((s) => s.sampleId)
  }
  if (!wanted.length) {
    wanted = table.columns.slice(1).filter((c) => !/_(TEMP|EXT)$/i.test(c))
  }
  const out: Array<{ sampleId: string; colIndex: number; unit: string }> = []
  for (const id of wanted) {
    if (/_(TEMP|EXT)$/i.test(id)) continue
    const colIndex = table.columns.indexOf(id)
    if (colIndex < 0) {
      throw new Error(`求解器输出里找不到采样点 ${id}（devc.csv 表头：${table.columns.join(', ')}）`)
    }
    out.push({ sampleId: id, colIndex, unit: table.units[colIndex] || VISIBILITY_UNIT })
  }
  if (!out.length) throw new Error('没有解析到任何 VISIBILITY 采样点')
  return out
}

function summarize(table: DevcTable, channels: ReturnType<typeof visibilityChannels>): {
  samples: Array<{ sampleId: string; unit: string; quantity: string; series: Array<{ t: number; value: number | null }> }>
  tEnd: number
  dtS: number
} {
  const times = table.rows.map((r) => r[0])
  const samples = channels.map((ch) => ({
    sampleId: ch.sampleId,
    unit: ch.unit,
    quantity: QUANTITY,
    // 数值直接搬运：缺测写 null，不插值
    series: table.rows.map((r) => ({ t: r[0], value: Number.isFinite(r[ch.colIndex]) ? r[ch.colIndex] : null })),
  }))
  const diffs = times.slice(1).map((t, i) => t - times[i]).filter((d) => d > 0).sort((a, b) => a - b)
  const dtS = diffs.length ? Number(diffs[Math.floor(diffs.length / 2)].toFixed(3)) : 0
  return { samples, tEnd: times.length ? times[times.length - 1] : 0, dtS }
}

function writeManifest(m: ModelManifest): void {
  writeFileSync(join(RUN_DIR, 'manifest.json'), JSON.stringify(m, null, 2) + '\n', 'utf8')
  log(`已写 ${rel(join(RUN_DIR, 'manifest.json'))}（status=${m.status}）`)
}

function run(): void {
  log(`算例：${CASE_ID}（runId=${RUN_ID}）`)
  log(`仓库根：${ROOT}`)
  log(`FDS_EXE=${process.env.FDS_EXE ?? '(未设置，使用默认安装路径)'}`)
  const exe = resolveFdsExe()
  log(`求解器路径：${exe}`)

  const casePath = join(MODEL_DIR, CASE_FILE)
  if (!existsSync(casePath)) fail(`[FDS] ✗ 找不到算例输入：${casePath}`)

  const ver = probeVersion(exe)
  log(`求解器版本：${engineVersionOf(ver)}`)

  if (!DRY_RUN && !FORCE && existingOkArchive()) {
    log(`✓ 已存在 status=ok 的归档 ${rel(RUN_DIR)}（manifest.json + devc-summary.json + devc.csv），复用，不重跑求解器`)
    log(`  如需强制重跑：npm run model:run:fds -- --force`)
    return
  }

  const cmdLine = `${rel(exe)} ${CASE_FILE}`
  log(`运行目录（cwd）：${rel(MODEL_DIR)}`)
  log(`求解命令：${cmdLine}`)
  if (DRY_RUN) {
    log('--dry-run：仅自检，不启动求解器。')
    log(`将复制到归档：${CASE_ID}_devc.csv / ${CASE_ID}.out / ${CASE_ID}_hrr.csv / run.log`)
    log(`将写：manifest.json（status=ok）与 devc-summary.json（4 个 VISIBILITY 采样点）`)
    return
  }

  const solverOutputs = {
    devc: join(MODEL_DIR, `${CASE_ID}_devc.csv`),
    out: join(MODEL_DIR, `${CASE_ID}.out`),
    hrr: join(MODEL_DIR, `${CASE_ID}_hrr.csv`),
  }

  let exitCode = 0
  let signal: string | null = null
  let startedAt: string | undefined
  let finishedAt: string | undefined
  let wallClockS: number | undefined
  let consoleLog = ''

  if (ARCHIVE_ONLY) {
    // 只整理归档，不调用求解器：用于复用另一台机器/另一个进程已算完的 cwd 输出
    log('--archive-only：不启动求解器，直接用 models/fire_fds/ 下已有的求解器输出重建归档')
    const miss = Object.values(solverOutputs).filter((p) => !existsSync(p))
    if (miss.length) fail(`[FDS] ✗ --archive-only 需要已有输出，但缺少：${miss.map(rel).join(' / ')}`)
    mkdirSync(RUN_DIR, { recursive: true })
    const prevPath = join(RUN_DIR, 'manifest.json')
    if (existsSync(prevPath)) {
      try {
        const prev = JSON.parse(readFileSync(prevPath, 'utf8').replace(/^\uFEFF/, '')) as ModelManifest
        startedAt = prev.startedAt
        finishedAt = prev.finishedAt
        wallClockS = prev.wallClockS
      } catch {
        /* 旧 manifest 不可读就留空 */
      }
    }
    finishedAt = finishedAt ?? stamp()
    const rawConsole = join(MODEL_DIR, 'run.log')
    consoleLog = existsSync(rawConsole) ? readFileSync(rawConsole, 'utf8').trim() : readFileSync(solverOutputs.out, 'utf8').trim()
    writeFileSync(join(RUN_DIR, 'run.log'), consoleLog + '\n', 'utf8')
  } else {
    if (existingOkArchive()) log('--force：忽略已有 ok 归档，重跑求解器')
    mkdirSync(RUN_DIR, { recursive: true })
    startedAt = stamp()
    const t0 = Date.now()
    log('正在求解，FDS 的 stdout/stderr 会同时写入归档 run.log …')
    const r = spawnSync(exe, [CASE_FILE], {
      cwd: MODEL_DIR,
      env: fdsEnv(exe),
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    })
    exitCode = r.status ?? 1
    signal = r.signal
    wallClockS = Number(((Date.now() - t0) / 1000).toFixed(1))
    finishedAt = stamp()
    consoleLog = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim()
    writeFileSync(join(RUN_DIR, 'run.log'), consoleLog + '\n', 'utf8')
    log(`求解结束：退出码 ${exitCode}${signal ? ` / signal ${signal}` : ''}，耗时 ${wallClockS} s`)
  }

  const missing = Object.entries(solverOutputs).filter(([, p]) => !existsSync(p))
  const stopOk =
    /STOP:\s*FDS completed successfully/.test(consoleLog) ||
    (existsSync(solverOutputs.out) && /STOP:\s*FDS completed successfully/.test(readFileSync(solverOutputs.out, 'utf8')))
  if (exitCode !== 0 || missing.length) {
    const message =
      exitCode !== 0
        ? `FDS 进程退出码 ${exitCode}${signal ? `（signal ${signal}）` : ''}`
        : `FDS 未产出输出文件：${missing.map(([k]) => k).join(', ')}`
    writeManifest({
      runId: RUN_ID,
      model: MODEL,
      caseId: CASE_ID,
      engineVersion: engineVersionOf(ver),
      solverCommand: `cd ${rel(MODEL_DIR)} && ${cmdLine}`,
      status: 'failed',
      startedAt,
      finishedAt,
      wallClockS,
      inputs: [{ path: rel(casePath), sha256: sha256(casePath), note: 'FDS 输入文件' }],
      outputs: [],
      notes: ['求解器未成功完成，未生成 devc-summary.json'],
      failure: { stage: 'solve', log: rel(join(RUN_DIR, 'run.log')), message },
    })
    fail(`[FDS] ✗ ${message}`)
  }
  if (!stopOk) log('! 警告：控制台/.out 里没有 "STOP: FDS completed successfully"，但输出文件齐全，按退出码判定为完成')

  // 复制原始输出到归档
  const devcCopy = join(RUN_DIR, `${CASE_ID}_devc.csv`)
  const outCopy = join(RUN_DIR, `${CASE_ID}.out`)
  const hrrCopy = join(RUN_DIR, `${CASE_ID}_hrr.csv`)
  const logCopy = join(RUN_DIR, 'run.log')
  copyFileSync(solverOutputs.devc, devcCopy)
  copyFileSync(solverOutputs.out, outCopy)
  copyFileSync(solverOutputs.hrr, hrrCopy)
  log(`已复制归档输出：${[devcCopy, outCopy, hrrCopy, logCopy].map(rel).join(' / ')}`)

  const table = parseDevcCsv(devcCopy)
  const channels = visibilityChannels(table)
  const summary = summarize(table, channels)
  writeFileSync(join(RUN_DIR, 'devc-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8')
  log(
    `已写 ${rel(join(RUN_DIR, 'devc-summary.json'))}：${summary.samples.length} 个采样点，` +
      `${summary.samples[0]?.series.length ?? 0} 个时刻，tEnd=${summary.tEnd}s，dt≈${summary.dtS}s`,
  )
  for (const s of summary.samples) {
    log(`  采样点 ${s.sampleId}（${s.unit}）：首值 ${s.series[0]?.value} → 末值 ${s.series[s.series.length - 1]?.value}`)
  }

  writeManifest({
    runId: RUN_ID,
    model: MODEL,
    caseId: CASE_ID,
    engineVersion: engineVersionOf(ver),
    solverCommand: `cd ${rel(MODEL_DIR)} && ${cmdLine}`,
    status: 'ok',
    startedAt,
    finishedAt,
    wallClockS,
    inputs: [{ path: rel(casePath), sha256: sha256(casePath), note: 'FDS 输入文件（12×8×3 m，T_END=300 s，0.25 m 网格，12 个 DEVC）' }],
    outputs: [
      {
        path: rel(devcCopy),
        sha256: sha256(devcCopy),
        unit: `visibility: ${summary.samples[0]?.unit ?? VISIBILITY_UNIT}`,
        note: 'DEVC 采样输出（原始 CSV 副本）',
        columns: table.columns,
      },
      {
        path: rel(outCopy),
        sha256: sha256(outCopy),
        unit: 'n/a',
        note: 'FDS 求解日志（版本 / 网格 / 时间步 / 稳定性 / STOP 状态）',
      },
      {
        path: rel(hrrCopy),
        sha256: sha256(hrrCopy),
        unit: 'kW',
        note: '热释放速率输出',
      },
      {
        path: rel(logCopy),
        sha256: sha256(logCopy),
        unit: 'n/a',
        note: '求解器控制台输出（与 .out 内容重叠，便于逐字追溯）',
      },
    ],
    samples: summary.samples.map((s) => ({ sampleId: s.sampleId, quantity: QUANTITY, unit: s.unit })),
    notes: [
      `求解器版本：${ver.revision}${ver.mpi ? `；${ver.mpi}` : ''}（fds.exe -v 原文）。`,
      `运行方式：cwd=${rel(MODEL_DIR)}，命令 ${cmdLine}；子进程 PATH 前置 bin 与 bin/mpi（Intel MPI DLL 必需）。`,
      `网格与算例：单一 &MESH，0.25 m 均匀网格，48×32×12 = 18,432 单元格；计算域 12×8×3 m；T_END=300 s；DT_DEVC=5 s。`,
      `采样点：${summary.samples.map((s) => s.sampleId).join(' / ')}（z=1.7 m，y=4.0 m 中轴线）；已排除 *_TEMP 与 *_EXT 通道。`,
      'devc-summary.json 的数值是 devc.csv 的原样搬运：只取时间列与 4 个 VISIBILITY 列，缺测写 null，不插值、不平滑、不单位换算。',
      `时间基准：FDS 实际输出时刻由 CFL 自适应步长决定（首个间隔 ${summary.samples[0]?.series[1]?.t ?? 0}s），tEnd=${summary.tEnd}s。`,
      '本算例为固定小场景的演示算例，不是本社区的性能化防火设计或安全评估；未做网格无关性与敏感性分析。',
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
