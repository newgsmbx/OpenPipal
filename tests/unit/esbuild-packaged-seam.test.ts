/**
 * 装机版 esbuild 的两条红线，dev 下结构性复现不了，只能按源码钉住：
 *   ① 主进程不得顶层 import esbuild（会被打进 bundle，worker 自举时 __filename 指向 bundle → 主线程永挂）；
 *   ② 入口必须在任何 require('esbuild') 之前把装机版的二进制路径指到 app.asar.unpacked 的真实文件
 *      （worker 线程里没有 Electron 的 asar 改写，spawn app.asar/… 报 `spawn ENOTDIR`，2026-09-08 装机版
 *      1.1.2 实撞），找不到文件才退回 ESBUILD_WORKER_THREADS=0（主线程 execFileSync，能跑但每次 spawn 进程）。
 * 真机复现 / 修后验证：node scripts/qa/packaged-esbuild-probe.mjs /Applications/OpenPipal.app
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { isAbsolute, join } from 'path'
import { trackedFiles } from '../helpers/tracked-files'

const root = join(__dirname, '../..')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf-8')

describe('装机版 esbuild 接缝', () => {
  it('env.ts：装机版先指 unpacked 二进制，找不到才关 worker 线程；env 是入口的第二个 import（先于一切业务模块）', () => {
    const env = read('src/main/env.ts')
    expect(env).toMatch(/app\.isPackaged && !process\.env\.ESBUILD_BINARY_PATH && !process\.env\.ESBUILD_WORKER_THREADS/)
    expect(env).toMatch(/'app\.asar\.unpacked', 'node_modules', '@esbuild', `\$\{process\.platform\}-\$\{process\.arch\}`/)
    expect(env).toMatch(/process\.platform === 'win32' \? \['esbuild\.exe'\] : \['bin', 'esbuild'\]/)
    expect(env).toMatch(/if \(existsSync\(binary\)\) process\.env\.ESBUILD_BINARY_PATH = binary\s*\n\s*else process\.env\.ESBUILD_WORKER_THREADS = '0'/)
    const entryImports = read('src/main/index.ts').split('\n').filter((line) => /^import /.test(line)).slice(0, 2)
    expect(entryImports).toEqual(["import './main-log'", "import './env'"])
  })

  it('主进程没有任何模块顶层 import esbuild 的值——只允许运行时 require', () => {
    const offenders = trackedFiles(root, 'src/main')
      .filter((file) => file.endsWith('.ts'))
      .map((file) => (isAbsolute(file) ? file : join(root, file)))
      .filter((file) => /^\s*import\s+(?!type\b)[^;]*from\s+'esbuild'/m.test(readFileSync(file, 'utf-8')))
      .map((file) => file.slice(root.length + 1))
    expect(offenders).toEqual([])
  })

  it('三处运行时 require 写法一致：artifact-store / ds-compile / hook-loader', () => {
    for (const rel of ['src/main/artifact-store.ts', 'src/main/ds-compile.ts', 'src/main/hooks/hook-loader.ts']) {
      expect(read(rel), rel).toMatch(/require\('esbuild'\)/)
    }
  })
})
