/**
 * 后台写规矩。
 *
 * 前台助手只递交要求（set_rule 工具，立刻返回，主线任务不停）；这里排队交给写手（Evolver 的 set-rule
 * 技能）写文件，用注册表探针验证加载结果，加载失败就带着原因让写手再写一次，最后把结论送到渲染层
 * ——渲染层落成一枚胶囊。过程都有据可查：Evolver 的日志、规矩文件本身、插件页清单。
 *
 * 串行队列：写手写的是同一个目录，两条规矩并发写会互相踩（同名文件、读到半截的文件）。
 * 一条失败不影响下一条。
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { HookNotice } from '../../shared/hook-contract'
import { getPluginsRootDir, PLUGIN_SCHEMA_URL } from '../plugin-manager'
import { hooksDisabledByEnv, probeHookChanges, snapshotHookSignatures } from './hook-registry'

export const LOCAL_RULES_PLUGIN = 'local-rules'

/** 写出的文件加载失败时再让写手改一次；再失败就把原因给用户 */
const REWRITE_ATTEMPTS = 1

export interface RuleRequest {
  /** 大白话一句，用户会看到 */
  description: string
  /** 给写手看的触发条件与要做的事 */
  details: string
  /** 结论落到哪个会话；空 = 渲染层当前会话 */
  conversationId?: string
  roleName?: string
}

export interface RuleWriterInput extends RuleRequest {
  /** local-rules 插件根：写手唯一可读写的目录 */
  rulesDir: string
  /** 上一次写出的文件加载失败的原因（重写时带上） */
  previousError?: string
}

export type RuleWriter = (input: RuleWriterInput) => Promise<{ success: boolean; error?: string }>
export type RuleNoticeSink = (request: RuleRequest, notices: HookNotice[]) => void

export interface RequestRuleOptions {
  /** 默认走 setRuleWriter 注册的写手；测试注入 */
  writer?: RuleWriter
  /** 默认走 setRuleNoticeSink 注册的那个 */
  notify?: RuleNoticeSink
}

let sink: RuleNoticeSink = () => {}
let registeredWriter: RuleWriter | undefined
let queue: Promise<unknown> = Promise.resolve()
let active = 0

/** ipc-handlers 在启动时注册：把结论送到渲染层 */
export function setRuleNoticeSink(next: RuleNoticeSink): void {
  sink = next
}

/**
 * ipc-handlers 在启动时注册真正的写手（Evolver set-rule）。
 * 不在这里 import evolver-agent：本模块被 pi-core-runtime 引用，而 Evolver 带着 pi-coding-agent
 * 的工具实现——Runtime 层的源码图不许碰它（agent-runtime-boundary 测试钉着，动态 import 也算）。
 */
export function setRuleWriter(next: RuleWriter): void {
  registeredWriter = next
}

/**
 * 后台正在写规矩？主会话的 shell 探针据此让路：它按"本轮基线 vs 此刻"找新文件，
 * 后台此刻写出的文件会被它当成"这轮模型用 bash 建的"报进对话流，与后台自己的结论撞成两条。
 */
export function isRuleWriteActive(): boolean {
  return active > 0
}

/** local-rules 插件根；plugin.json 缺了就补——确定性归代码，不让写手猜清单格式 */
export function ensureLocalRulesPlugin(): string {
  const dir = join(getPluginsRootDir(), LOCAL_RULES_PLUGIN)
  mkdirSync(join(dir, 'hooks'), { recursive: true })
  const manifest = join(dir, 'plugin.json')
  if (!existsSync(manifest)) {
    writeFileSync(
      manifest,
      JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: LOCAL_RULES_PLUGIN, description: '在对话里定下的规矩' }, null, 2) + '\n',
      'utf-8'
    )
  }
  return dir
}

/**
 * 排队写一条规矩。返回的 Promise 只给测试和日志用——set_rule 工具不等它，
 * 结论走 notify 送出去。永不 reject。
 */
export function requestRule(request: RuleRequest, options: RequestRuleOptions = {}): Promise<HookNotice[]> {
  const run = queue.then(() => writeRule(request, options))
  queue = run.catch(() => undefined)
  return run
}

async function writeRule(request: RuleRequest, options: RequestRuleOptions): Promise<HookNotice[]> {
  const notify = options.notify ?? sink
  active++
  let notices: HookNotice[]
  try {
    notices = await produceNotices(request, options.writer ?? registeredWriter)
  } finally {
    active--
  }
  console.log(`[Rules] 「${request.description}」→ ${notices.map((n) => n.status + (n.error ? `（${n.error}）` : '')).join('，')}`)
  try {
    notify(request, notices)
  } catch (error) {
    console.warn('[Rules] 送出提醒失败:', error instanceof Error ? error.message : String(error))
  }
  return notices
}

async function produceNotices(request: RuleRequest, writer: RuleWriter | undefined): Promise<HookNotice[]> {
  if (hooksDisabledByEnv()) return [failureNotice(request, '规矩功能已被 OPENPIPAL_DISABLE_HOOKS 关闭')]
  if (!writer) return [failureNotice(request, '后台写手未就绪')]
  const rulesDir = ensureLocalRulesPlugin()
  // 基线在写手开跑前拍：探针只报这次写出来的文件；探针自己会把基线推到"此刻"，
  // 所以重写那一轮只看到重写期间改过的文件
  const baseline = snapshotHookSignatures()
  let previousError: string | undefined
  let notices: HookNotice[] = []
  for (let attempt = 0; attempt <= REWRITE_ATTEMPTS; attempt++) {
    let result: { success: boolean; error?: string }
    try {
      result = await writer({ ...request, rulesDir, previousError })
    } catch (error) {
      result = { success: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (!result.success) return [failureNotice(request, `后台没写成：${result.error || '未知错误'}`)]
    const changed = await probeHookChanges(baseline)
    // 首次就没产出文件是失败；重写没再动文件，就以上一轮的结论为准
    if (changed.length === 0) return attempt === 0 ? [failureNotice(request, '后台没有写出规矩文件')] : notices
    notices = changed
    const failed = changed.filter((n) => n.status === 'error')
    if (failed.length === 0) break
    previousError = failed.map((n) => `${n.file}: ${n.error}`).join('\n')
  }
  return notices
}

function failureNotice(request: RuleRequest, error: string): HookNotice {
  return {
    status: 'error',
    hookId: `${LOCAL_RULES_PLUGIN}/${request.description}`,
    pluginName: LOCAL_RULES_PLUGIN,
    file: '',
    description: request.description,
    error
  }
}
