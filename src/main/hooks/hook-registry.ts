/**
 * 规矩注册表：从启用的插件里找 hooks/ 文件，加载并缓存。
 *
 * - 文件式：文件在即生效，删掉即失效；单条开关是改名成 `<file>.off`（scanHooksDir 认这个后缀）；
 *   整包开关走插件页已有的 disabled 列表
 * - 每轮开始时重扫一次；按 mtime+size 缓存，没改过的文件不重编译——模型刚写完的文件下一轮就生效
 * - 工具刚写完规矩文件时 probeHookFileWrite 当场加载：对话流的「已定下规矩」提醒和回给模型的
 *   反馈都来自这次加载的事实，不来自模型的宣称
 * - 加载结果（成功/失败原因）留在这里，供插件页与对话流提醒读取
 * - 逃生舱口：OPENPIPAL_DISABLE_HOOKS=1 整层跳过（排查「是不是规矩搞的」时用）
 */
import { existsSync, readFileSync, renameSync, rmSync, statSync } from 'fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'path'
import { getOpenPipalHome } from '../data-root'
import {
  getDisabledPluginNames,
  getPluginsRootDir,
  HOOK_OFF_SUFFIX,
  listPluginHookFiles,
  listScannedPlugins,
  scanPluginDir
} from '../plugin-manager'
import { hookIdFor, loadHookFile, type LoadHookFileOptions } from './hook-loader'
import type { HookEntry, HookEventName, HookLoadFailure, HookLoadResult, HookNotice, LoadedHook } from './hook-types'
import type { HookToggleResult } from '../../shared/hook-contract'

interface CacheEntry {
  mtimeMs: number
  size: number
  result: HookLoadResult
}

export interface HookReportEntry {
  id: string
  pluginName: string
  file: string
  description?: string
  status: 'ok' | 'error'
  error?: string
  events: HookEventName[]
}

export type { HookEntry }

export interface ActiveHooks {
  hooks: LoadedHook[]
  failures: HookLoadFailure[]
}

const HOOK_EXT_RE = /\.(ts|js|mjs|cjs)$/i

const cache = new Map<string, CacheEntry>()
let lastReport: HookReportEntry[] = []

export function hooksDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENPIPAL_DISABLE_HOOKS === '1'
}

function toReport(result: HookLoadResult): HookReportEntry {
  if (result.ok) {
    const { hook } = result
    return {
      id: hook.id,
      pluginName: hook.pluginName,
      file: hook.file,
      description: hook.description,
      status: 'ok',
      events: (Object.keys(hook.handlers) as HookEventName[]).filter((name) => hook.handlers[name].length > 0)
    }
  }
  const { failure } = result
  return { id: failure.id, pluginName: failure.pluginName, file: failure.file, status: 'error', error: failure.error, events: [] }
}

function rememberResult(file: string, result: HookLoadResult): void {
  try {
    const stat = statSync(file)
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, result })
  } catch {
    cache.delete(file)
  }
}

/** 扫描 + 加载所有启用插件的 hook。永不抛出：坏文件进 failures，好文件照常生效 */
export async function loadActiveHooks(options?: LoadHookFileOptions): Promise<ActiveHooks> {
  if (hooksDisabledByEnv()) {
    lastReport = []
    return { hooks: [], failures: [] }
  }
  const files = listPluginHookFiles()
  const seen = new Set<string>()
  const results: HookLoadResult[] = []
  for (const { pluginName, file } of files) {
    seen.add(file)
    let stat: { mtimeMs: number; size: number }
    try {
      stat = statSync(file)
    } catch (error) {
      results.push({ ok: false, failure: { id: hookIdFor(pluginName, file), pluginName, file, error: `读取失败：${error instanceof Error ? error.message : String(error)}` } })
      continue
    }
    const cached = cache.get(file)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      results.push(cached.result)
      continue
    }
    const result = await loadHookFile(file, pluginName, options)
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, result })
    results.push(result)
  }
  for (const key of Array.from(cache.keys())) {
    if (!seen.has(key)) cache.delete(key)
  }
  lastReport = results.map(toReport)
  return {
    hooks: results.flatMap((r) => (r.ok ? [r.hook] : [])),
    failures: results.flatMap((r) => (r.ok ? [] : [r.failure]))
  }
}

/** 上一次加载的结果快照（插件页 / 对话流提醒用） */
export function getHookReport(): HookReportEntry[] {
  return lastReport
}

/** 测试与热重载用：清掉编译缓存 */
export function resetHookCache(): void {
  cache.clear()
  lastReport = []
}

// ---- 写入探针：工具刚写完的文件是不是规矩 ----

/** 工具参数里的路径 → 绝对路径：`~` 展开 + 相对路径按会话工作目录解析（与 pi 写工具同口径） */
function expandToolPath(raw: string, workingDir?: string): string {
  let candidate = raw.trim()
  if (candidate === '~' || candidate.startsWith('~/')) candidate = join(getOpenPipalHome(), candidate.slice(1))
  if (!isAbsolute(candidate)) candidate = resolve(workingDir || process.cwd(), candidate)
  return resolve(candidate)
}

interface PluginLocation {
  pluginName: string
  pluginDir: string
  kind: 'hook' | 'manifest'
}

/** 绝对路径落在 plugins/<name>/hooks/<file> 或 plugins/<name>/plugin.json 才算命中 */
function locateInPlugins(absPath: string): PluginLocation | undefined {
  const root = resolve(getPluginsRootDir())
  const rel = relative(root, absPath)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
  const parts = rel.split(sep)
  if (parts.length === 2 && parts[1] === 'plugin.json') {
    return { pluginName: parts[0], pluginDir: join(root, parts[0]), kind: 'manifest' }
  }
  if (parts.length === 3 && parts[1] === 'hooks' && HOOK_EXT_RE.test(parts[2])) {
    return { pluginName: parts[0], pluginDir: join(root, parts[0]), kind: 'hook' }
  }
  return undefined
}

function stemOf(file: string): string {
  return basename(file).replace(HOOK_EXT_RE, '')
}

/**
 * 工具刚写完一个文件：如果它是规矩文件（或规矩所在插件的 plugin.json），当场加载并给出结论。
 * 不是规矩相关的路径返回空数组。永不抛出。
 */
export async function probeHookFileWrite(
  rawPath: string,
  workingDir?: string,
  options?: LoadHookFileOptions,
  /** 本轮基线：写完顺手记上指纹，之后 bash 探针不会把同一个文件再报一遍 */
  baseline?: HookSignatures
): Promise<HookNotice[]> {
  if (hooksDisabledByEnv() || typeof rawPath !== 'string' || !rawPath.trim()) return []
  let abs: string
  try {
    abs = expandToolPath(rawPath, workingDir)
  } catch {
    return []
  }
  const located = locateInPlugins(abs)
  if (!located) return []
  const scanned = scanPluginDir(located.pluginDir, located.pluginName, getDisabledPluginNames())
  const known = new Set(scanned.hookFiles.map((file) => resolve(file)))
  const targets = located.kind === 'hook' ? [abs] : scanned.hookFiles.map((file) => resolve(file))
  const notices: HookNotice[] = []
  for (const file of targets) {
    const pluginName = scanned.info.invalid ? located.pluginName : scanned.info.name
    const base = { hookId: hookIdFor(pluginName, file), pluginName, file, description: stemOf(file) }
    if (scanned.info.invalid) {
      notices.push({ ...base, status: 'error', error: `插件 ${located.pluginName} 无效：${scanned.info.invalid}` })
      continue
    }
    if (!scanned.info.enabled) {
      notices.push({ ...base, status: 'error', error: `插件 ${pluginName} 已停用，规矩不会生效` })
      continue
    }
    if (!known.has(file)) {
      notices.push({ ...base, status: 'error', error: '文件不在插件的 hooks/ 目录里，或解析后逃出了插件根' })
      continue
    }
    const result = await loadHookFile(file, pluginName, options)
    rememberResult(file, result)
    const signature = signatureOf(file)
    if (baseline && signature) baseline.set(file, signature)
    notices.push(result.ok
      ? { ...base, status: 'ok', description: result.hook.description }
      : { ...base, status: 'error', error: result.failure.error })
  }
  return notices
}

/** 规矩文件的"指纹"表：file → mtime:size。每个会话轮次自己持一份基线，探针只对基线报变化 */
export type HookSignatures = Map<string, string>

function signatureOf(file: string): string | undefined {
  try {
    const stat = statSync(file)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return undefined
  }
}

/** 当前启用插件里所有规矩文件的指纹，作为本轮的基线 */
export function snapshotHookSignatures(): HookSignatures {
  const signatures: HookSignatures = new Map()
  refreshHookSignatures(signatures)
  return signatures
}

/**
 * 把基线刷成"此刻"的样子（原地改，调用方持有的就是同一个 Map）。
 * 在 bash/powershell 真要开跑之前刷一次，之后的探针只会看到**这条命令跑的期间**出现的变化——
 * 别的会话、插件页、用户在编辑器里的改动，只要发生在命令开跑之前，就不会被算到这条会话头上。
 * 命令执行那几秒里别人恰好也在写，仍会被一起报出来；那是并发写同一目录的固有代价，只是窗口极窄。
 */
export function refreshHookSignatures(baseline: HookSignatures): void {
  baseline.clear()
  if (hooksDisabledByEnv()) return
  for (const { file } of listPluginHookFiles()) {
    const signature = signatureOf(file)
    if (signature) baseline.set(file, signature)
  }
}

/**
 * 兜底探针：不知道哪个文件被改了（多半是模型用 bash 建的文件）时，把启用插件里
 * 所有规矩文件和**本轮基线**比一遍——新出现的、内容变了的当场加载并给结论，然后更新基线。
 *
 * 基线按会话轮次持有，不用进程级编译缓存来判"新不新"：缓存会被插件页开关、别的会话、
 * 缓存清理动到，拿它比对会把别人改的规矩当成"这轮刚定的"报进本会话（既多一行提醒，
 * 又给模型塞一句它没做过的事）。只看 mtime+size，几个 stat 的开销，每次 bash 之后跑得起。
 */
export async function probeHookChanges(baseline: HookSignatures, options?: LoadHookFileOptions): Promise<HookNotice[]> {
  if (hooksDisabledByEnv()) return []
  const notices: HookNotice[] = []
  const seen = new Set<string>()
  for (const { pluginName, file } of listPluginHookFiles()) {
    seen.add(file)
    const signature = signatureOf(file)
    if (!signature) continue
    if (baseline.get(file) === signature) continue
    baseline.set(file, signature)
    const result = await loadHookFile(file, pluginName, options)
    rememberResult(file, result)   // 文件可能在编译那几十毫秒里被删/改名——rememberResult 自己兜住，永不抛出
    const base = { hookId: hookIdFor(pluginName, file), pluginName, file, description: stemOf(file) }
    notices.push(result.ok
      ? { ...base, status: 'ok', description: result.hook.description }
      : { ...base, status: 'error', error: result.failure.error })
  }
  for (const key of Array.from(baseline.keys())) {
    if (!seen.has(key)) baseline.delete(key)
  }
  return notices
}

/** 回给模型的一句话：让它知道规矩到底生效了没有，不用它自己猜 */
export function formatHookNoticeForModel(notice: HookNotice): string {
  return notice.status === 'ok'
    ? `【规矩已生效】${notice.description}（${notice.file}）。从下一轮开始执行。告诉用户一句即可，不要贴代码。`
    : `【规矩没生效】${notice.file}：${notice.error || '未知原因'}。请修正文件后再写一次。`
}

// ---- 文件式开关与清单 ----

function isHookFileName(name: string): boolean {
  const logical = name.endsWith(HOOK_OFF_SUFFIX) ? name.slice(0, -HOOK_OFF_SUFFIX.length) : name
  return HOOK_EXT_RE.test(logical) && !logical.endsWith('.d.ts')
}

/**
 * 改名 `<file>` ↔ `<file>.off`。只认 plugins/<name>/hooks/ 直接子文件，别的一律拒。
 * 关：生效中的那份是事实源，同名的旧 `.off`（撤销过又让助手重写了一份的情形）直接丢掉再改名；
 * 开：若同名生效版已存在，拒绝——两份同 id 的规矩只能留一份，留的是正在生效的。
 */
export function setHookFileEnabled(file: string, enabled: boolean): HookToggleResult {
  if (typeof file !== 'string' || !file.trim()) return { ok: false, error: '缺少文件路径' }
  const abs = resolve(file)
  const root = resolve(getPluginsRootDir())
  const rel = relative(root, abs)
  const parts = rel.split(sep)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || parts.length !== 3 || parts[1] !== 'hooks' || !isHookFileName(parts[2])) {
    return { ok: false, error: '不是插件 hooks/ 里的规矩文件' }
  }
  const isOff = abs.endsWith(HOOK_OFF_SUFFIX)
  const target = enabled
    ? (isOff ? abs.slice(0, -HOOK_OFF_SUFFIX.length) : abs)
    : (isOff ? abs : abs + HOOK_OFF_SUFFIX)
  if (target === abs) return { ok: true, file: abs }
  if (!existsSync(abs)) return { ok: false, error: '文件不存在' }
  if (existsSync(target)) {
    if (enabled) return { ok: false, error: `已有一份生效中的同名规矩（${basename(target)}），先关掉或删掉它` }
    try {
      rmSync(target)
    } catch (error) {
      return { ok: false, error: `清理旧的 ${basename(target)} 失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  try {
    renameSync(abs, target)
  } catch (error) {
    return { ok: false, error: `改名失败：${error instanceof Error ? error.message : String(error)}` }
  }
  cache.delete(abs)
  cache.delete(target)
  return { ok: true, file: target }
}

/** 不执行代码地读 `export const description = '…'`——关掉的规矩不该为了列个名字就被跑一遍 */
function peekDescription(file: string): string | undefined {
  try {
    const source = readFileSync(file, 'utf-8')
    const match = source.match(/export\s+const\s+description\s*=\s*(['"`])([\s\S]*?)\1/)
    const text = match?.[2]?.trim()
    return text ? text.slice(0, 120) : undefined
  } catch {
    return undefined
  }
}

/** 所有插件里的规矩：生效的 / 加载失败的 / 关掉的，供插件页与对话流提醒判断"现在还开着没有" */
export async function listHookEntries(options?: LoadHookFileOptions): Promise<HookEntry[]> {
  await loadActiveHooks(options)
  const entries: HookEntry[] = lastReport.map((entry) => ({ ...entry }))
  for (const plugin of listScannedPlugins()) {
    if (plugin.info.invalid) continue
    const pluginName = plugin.info.name
    const liveFiles = new Set(plugin.hookFiles.map((file) => resolve(file)))
    for (const file of plugin.disabledHookFiles) {
      const logical = file.slice(0, -HOOK_OFF_SUFFIX.length)
      // 同名的生效版已经在清单里：这份 .off 是撤销过又被重写后的残留，不列第二条同 id 的
      if (liveFiles.has(resolve(logical))) continue
      entries.push({
        id: hookIdFor(pluginName, logical),
        pluginName,
        file,
        description: peekDescription(file) || stemOf(logical),
        status: 'off',
        offReason: 'file',
        events: []
      })
    }
    if (!plugin.info.enabled) {
      for (const file of plugin.hookFiles) {
        entries.push({
          id: hookIdFor(pluginName, file),
          pluginName,
          file,
          description: peekDescription(file) || stemOf(file),
          status: 'off',
          offReason: 'plugin',
          events: []
        })
      }
    }
  }
  return entries.sort((a, b) => a.pluginName.localeCompare(b.pluginName) || a.id.localeCompare(b.id))
}
