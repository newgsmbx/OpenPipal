/**
 * hook-registry 单测——从真实插件目录布局到 LoadedHook。
 *
 * 用 OPENPIPAL_ISOLATED_HOME 把数据根切到临时目录（data-root 的正式隔离口），
 * 在里面摆一个标准插件包（plugin.json + hooks/*.ts），验：
 *   文件在即生效 / 坏文件进 failures 不连坐 / 改了文件下一次重编译（mtime+size 缓存）/
 *   插件被禁用就不加载 / OPENPIPAL_DISABLE_HOOKS=1 整层跳过 / 报告快照与结果一致
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const HOME = mkdtempSync(join(tmpdir(), 'openpipal-hook-registry-'))
process.env.OPENPIPAL_ISOLATED_HOME = HOME

const {
  loadActiveHooks, getHookReport, resetHookCache,
  probeHookFileWrite, probeHookChanges, snapshotHookSignatures, refreshHookSignatures, setHookFileEnabled, listHookEntries, formatHookNoticeForModel
} = await import('../../src/main/hooks/hook-registry')
const { PLUGIN_SCHEMA_URL } = await import('../../src/main/plugin-manager')

const DATA = join(HOME, '.openpipal')
const PLUGINS = join(DATA, 'plugins')

function plugin(name: string, files: Record<string, string>): string {
  const dir = join(PLUGINS, name)
  mkdirSync(join(dir, 'hooks'), { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name }), 'utf-8')
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), content, 'utf-8')
  }
  return dir
}

const GOOD = `export const description = '读成绩表前先遮名字'
export default function (hook) { hook.on('tool_result', () => undefined) }`

beforeAll(() => { mkdirSync(PLUGINS, { recursive: true }) })
afterAll(() => { rmSync(HOME, { recursive: true, force: true }) })
beforeEach(() => {
  rmSync(PLUGINS, { recursive: true, force: true })
  mkdirSync(PLUGINS, { recursive: true })
  rmSync(join(DATA, 'plugins.config.json'), { force: true })
  delete process.env.OPENPIPAL_DISABLE_HOOKS
  resetHookCache()
})

describe('hook-registry', () => {
  it('文件在即生效；坏文件进 failures，好文件照常', async () => {
    plugin('local-rules', {
      'hooks/mask-names.ts': GOOD,
      'hooks/broken.ts': 'export default function (hook) { hook.on("nope", () => {}) }'
    })
    const { hooks, failures } = await loadActiveHooks()
    expect(hooks.map(h => h.id)).toEqual(['local-rules/mask-names'])
    expect(hooks[0].description).toBe('读成绩表前先遮名字')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ id: 'local-rules/broken' })
    expect(failures[0].error).toMatch(/不认识的事件「nope」/)

    const report = getHookReport()
    expect(report.map(r => [r.id, r.status])).toEqual([['local-rules/broken', 'error'], ['local-rules/mask-names', 'ok']])
    expect(report[1]).toMatchObject({ description: '读成绩表前先遮名字', events: ['tool_result'] })
  })

  it('改了文件就重编译（mtime+size 缓存），删了就失效', async () => {
    const dir = plugin('local-rules', { 'hooks/rule.ts': GOOD })
    const first = await loadActiveHooks()
    expect(first.hooks[0].description).toBe('读成绩表前先遮名字')

    const file = join(dir, 'hooks', 'rule.ts')
    writeFileSync(file, GOOD.replace('读成绩表前先遮名字', '改过的描述'), 'utf-8')
    const later = new Date(Date.now() + 5_000)
    utimesSync(file, later, later)
    const second = await loadActiveHooks()
    expect(second.hooks[0].description).toBe('改过的描述')

    rmSync(file)
    const third = await loadActiveHooks()
    expect(third.hooks).toEqual([])
    expect(getHookReport()).toEqual([])
  })

  it('禁用的插件不加载', async () => {
    plugin('local-rules', { 'hooks/rule.ts': GOOD })
    writeFileSync(join(DATA, 'plugins.config.json'), JSON.stringify({ disabled: ['local-rules'] }), 'utf-8')
    const { hooks, failures } = await loadActiveHooks()
    expect(hooks).toEqual([])
    expect(failures).toEqual([])
  })

  it('OPENPIPAL_DISABLE_HOOKS=1 整层跳过', async () => {
    plugin('local-rules', { 'hooks/rule.ts': GOOD })
    process.env.OPENPIPAL_DISABLE_HOOKS = '1'
    const { hooks } = await loadActiveHooks()
    expect(hooks).toEqual([])
    expect(getHookReport()).toEqual([])
  })

  it('没有插件目录时安静返回空', async () => {
    rmSync(PLUGINS, { recursive: true, force: true })
    await expect(loadActiveHooks()).resolves.toEqual({ hooks: [], failures: [] })
  })
})

describe('probeHookFileWrite：工具刚写完的文件是不是规矩', () => {
  it('写进 hooks/ 的文件当场加载，结论是加载器的；~ 与相对路径都认', async () => {
    const dir = plugin('local-rules', { 'hooks/mask.ts': GOOD })
    const abs = join(dir, 'hooks', 'mask.ts')
    const [notice] = await probeHookFileWrite(abs)
    expect(notice).toEqual({ status: 'ok', hookId: 'local-rules/mask', pluginName: 'local-rules', file: abs, description: '读成绩表前先遮名字' })
    expect(formatHookNoticeForModel(notice)).toMatch(/【规矩已生效】读成绩表前先遮名字/)

    const viaTilde = await probeHookFileWrite('~/.openpipal/plugins/local-rules/hooks/mask.ts')
    expect(viaTilde[0]?.file).toBe(abs)
    const viaRelative = await probeHookFileWrite('hooks/mask.ts', dir)
    expect(viaRelative[0]?.file).toBe(abs)

    // 探针加载过的文件，下一轮 loadActiveHooks 直接用缓存（同一份结果）
    const { hooks } = await loadActiveHooks()
    expect(hooks.map(h => h.id)).toEqual(['local-rules/mask'])
  })

  it('不是规矩相关的路径一律空数组', async () => {
    plugin('local-rules', { 'hooks/mask.ts': GOOD, 'skills/x/SKILL.md': '# x' })
    expect(await probeHookFileWrite(join(HOME, 'Documents', 'a.ts'))).toEqual([])
    expect(await probeHookFileWrite(join(PLUGINS, 'local-rules', 'skills', 'x', 'SKILL.md'))).toEqual([])
    expect(await probeHookFileWrite(join(PLUGINS, 'local-rules', 'hooks', 'README.md'))).toEqual([])
    expect(await probeHookFileWrite(join(PLUGINS, 'local-rules', 'hooks', 'deep', 'x.ts'))).toEqual([])
    expect(await probeHookFileWrite('')).toEqual([])
  })

  it('写坏的文件给出可读原因；缺 plugin.json 也说清楚', async () => {
    const dir = plugin('local-rules', { 'hooks/bad.ts': 'export default (hook) => { hook.on("nope", () => {}) }' })
    const [bad] = await probeHookFileWrite(join(dir, 'hooks', 'bad.ts'))
    expect(bad.status).toBe('error')
    expect(bad.error).toMatch(/不认识的事件「nope」/)
    expect(formatHookNoticeForModel(bad)).toMatch(/【规矩没生效】/)

    rmSync(join(dir, 'plugin.json'))
    const [orphan] = await probeHookFileWrite(join(dir, 'hooks', 'bad.ts'))
    expect(orphan.status).toBe('error')
    expect(orphan.error).toMatch(/无效.*plugin\.json/)
  })

  it('先写 hooks 再写 plugin.json：写 manifest 时把已有规矩都报一遍', async () => {
    const dir = join(PLUGINS, 'local-rules')
    mkdirSync(join(dir, 'hooks'), { recursive: true })
    writeFileSync(join(dir, 'hooks', 'a.ts'), GOOD, 'utf-8')
    writeFileSync(join(dir, 'hooks', 'b.ts'), GOOD.replace('读成绩表前先遮名字', '第二条'), 'utf-8')
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: 'local-rules' }), 'utf-8')
    const notices = await probeHookFileWrite(join(dir, 'plugin.json'))
    expect(notices.map(n => [n.hookId, n.status, n.description])).toEqual([
      ['local-rules/a', 'ok', '读成绩表前先遮名字'],
      ['local-rules/b', 'ok', '第二条']
    ])
  })

  it('probeHookChanges：按本轮基线比对——新文件、改过的文件当场加载，没变的不重报', async () => {
    const dir = plugin('local-rules', { 'hooks/a.ts': GOOD })
    await loadActiveHooks()
    const baseline = snapshotHookSignatures()   // 本轮开始时 a 已在
    expect(await probeHookChanges(baseline)).toEqual([])

    // 模型用 bash 又建了一个 b、改了 a
    writeFileSync(join(dir, 'hooks', 'b.ts'), GOOD.replace('读成绩表前先遮名字', '第二条'), 'utf-8')
    writeFileSync(join(dir, 'hooks', 'a.ts'), GOOD.replace('读成绩表前先遮名字', '改过的 a'), 'utf-8')
    const later = new Date(Date.now() + 5_000)
    utimesSync(join(dir, 'hooks', 'a.ts'), later, later)
    const notices = await probeHookChanges(baseline)
    expect(notices.map(n => [n.hookId, n.status, n.description]).sort()).toEqual([
      ['local-rules/a', 'ok', '改过的 a'],
      ['local-rules/b', 'ok', '第二条']
    ])
    expect(await probeHookChanges(baseline)).toEqual([])   // 报过一次基线就更新了

    writeFileSync(join(dir, 'hooks', 'c.ts'), 'export default () => {}', 'utf-8')
    const [bad] = await probeHookChanges(baseline)
    expect(bad).toMatchObject({ hookId: 'local-rules/c', status: 'error' })
  })

  it('基线是本轮自己的：别的会话/插件页动了缓存，不会被这轮当成"刚定的规矩"报出来', async () => {
    const dir = plugin('local-rules', { 'hooks/a.ts': GOOD })
    await loadActiveHooks()
    const mine = snapshotHookSignatures()
    // 插件页关了又开：进程级缓存被清，但文件指纹没变
    setHookFileEnabled(join(dir, 'hooks', 'a.ts'), false)
    setHookFileEnabled(join(dir, 'hooks', 'a.ts.off'), true)
    expect(await probeHookChanges(mine)).toEqual([])
    // 写入探针记过的文件，之后的 bash 探针不再重报
    writeFileSync(join(dir, 'hooks', 'd.ts'), GOOD, 'utf-8')
    const viaWrite = await probeHookFileWrite(join(dir, 'hooks', 'd.ts'), undefined, undefined, mine)
    expect(viaWrite).toHaveLength(1)
    expect(await probeHookChanges(mine)).toEqual([])
  })

  it('停用的插件里写规矩：明确说不会生效', async () => {
    const dir = plugin('local-rules', { 'hooks/mask.ts': GOOD })
    writeFileSync(join(DATA, 'plugins.config.json'), JSON.stringify({ disabled: ['local-rules'] }), 'utf-8')
    const [notice] = await probeHookFileWrite(join(dir, 'hooks', 'mask.ts'))
    expect(notice.status).toBe('error')
    expect(notice.error).toMatch(/已停用/)
  })
})

describe('文件式开关与清单', () => {
  it('关 = 改名 .off，开 = 改回；只认 hooks/ 直接子文件', async () => {
    const dir = plugin('local-rules', { 'hooks/mask.ts': GOOD })
    const file = join(dir, 'hooks', 'mask.ts')
    const off = setHookFileEnabled(file, false)
    expect(off).toEqual({ ok: true, file: file + '.off' })
    expect((await loadActiveHooks()).hooks).toEqual([])

    const entries = await listHookEntries()
    expect(entries).toEqual([expect.objectContaining({ id: 'local-rules/mask', status: 'off', offReason: 'file', description: '读成绩表前先遮名字', file: file + '.off' })])

    const on = setHookFileEnabled(file + '.off', true)
    expect(on).toEqual({ ok: true, file })
    expect((await loadActiveHooks()).hooks.map(h => h.id)).toEqual(['local-rules/mask'])

    expect(setHookFileEnabled(join(HOME, 'Documents', 'x.ts'), false)).toMatchObject({ ok: false })
    expect(setHookFileEnabled(join(dir, 'plugin.json'), false)).toMatchObject({ ok: false })
    expect(setHookFileEnabled(join(dir, 'hooks', 'missing.ts'), false)).toMatchObject({ ok: false, error: '文件不存在' })
  })

  it('同名的 .ts 与 .ts.off 并存：清单只列生效的那条；关掉时丢弃旧 .off 再改名；开 .off 时同名生效版在则拒', async () => {
    const dir = plugin('local-rules', { 'hooks/mask.ts': GOOD, 'hooks/mask.ts.off': GOOD.replace('读成绩表前先遮名字', '旧的') })
    const entries = await listHookEntries()
    expect(entries.map(e => [e.id, e.status])).toEqual([['local-rules/mask', 'ok']])

    expect(setHookFileEnabled(join(dir, 'hooks', 'mask.ts.off'), true)).toMatchObject({ ok: false, error: expect.stringContaining('同名') })

    expect(setHookFileEnabled(join(dir, 'hooks', 'mask.ts'), false)).toEqual({ ok: true, file: join(dir, 'hooks', 'mask.ts.off') })
    const after = await listHookEntries()
    expect(after.map(e => [e.id, e.status, e.description])).toEqual([['local-rules/mask', 'off', '读成绩表前先遮名字']])
  })

  it('refreshHookSignatures：命令开跑前刷基线，之前别人动的文件不会被这条命令的探针报出来', async () => {
    const dir = plugin('local-rules', { 'hooks/a.ts': GOOD })
    await loadActiveHooks()
    const baseline = snapshotHookSignatures()
    // 别的会话在本轮开始后、这条 bash 开跑前写了 b
    writeFileSync(join(dir, 'hooks', 'b.ts'), GOOD.replace('读成绩表前先遮名字', '别人的'), 'utf-8')
    refreshHookSignatures(baseline)
    expect(await probeHookChanges(baseline)).toEqual([])
    // 这条 bash 期间写的 c 才报
    writeFileSync(join(dir, 'hooks', 'c.ts'), GOOD.replace('读成绩表前先遮名字', '这轮的'), 'utf-8')
    expect((await probeHookChanges(baseline)).map(n => n.description)).toEqual(['这轮的'])
  })

  it('清单：生效 / 加载失败 / 整个插件停用 三种都列，按插件名与 id 排序', async () => {
    plugin('b-rules', { 'hooks/ok.ts': GOOD, 'hooks/bad.ts': 'export default () => {}' })
    plugin('a-off', { 'hooks/sleepy.ts': GOOD.replace('读成绩表前先遮名字', '停用插件里的') })
    writeFileSync(join(DATA, 'plugins.config.json'), JSON.stringify({ disabled: ['a-off'] }), 'utf-8')
    const entries = await listHookEntries()
    expect(entries.map(e => [e.id, e.status, e.offReason ?? '-', e.description])).toEqual([
      ['a-off/sleepy', 'off', 'plugin', '停用插件里的'],
      ['b-rules/bad', 'error', '-', undefined],
      ['b-rules/ok', 'ok', '-', '读成绩表前先遮名字']
    ])
    expect(entries[1].error).toMatch(/没有注册任何事件/)
  })
})
