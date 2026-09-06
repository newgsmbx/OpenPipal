#!/usr/bin/env node
/**
 * 打 macOS 包（x64 + arm64）——先把另一架构的 darwin 平台包临时放进 node_modules。
 *
 * 裸跑 `electron-builder --mac` 打出来的 Intel 包**在 Intel Mac 上关键模块加载不了**：npm 只按本机
 * os/cpu 装可选依赖，arm64 机器的 node_modules 里只有 darwin-arm64 的 esbuild / sharp / libvips /
 * canvas / ripgrep，electron-builder 照单全收，x64 DMG 里装的全是 arm64 二进制（2026-09-06 对比两个
 * 架构的 asar 实测；1.1.1 的 x64 包就是这样出去的）。这个脚本在打包前把缺的那套 darwin-<arch>
 * 平台包放进来（做法与 build-windows.mjs 一样：npm pack 拉 tarball 解进 node_modules），打完再拿走；
 * 两套都在时，electron-builder.yml 的 files 用 ${arch} 宏只带本架构那套。
 *
 * 用法：node scripts/build-macos.mjs [--skip-bundle] [其余参数原样交给 electron-builder]
 *   npm run build:mac                                                          # 日常包 → dist/
 *   npm run release:build-macos -- --config.directories.output=../openpipal-mac-builds/1.1.2
 * 打完自动做出厂检查：每个架构的 app.asar 必须只带本架构的平台包，随包 rg 必须落成真实文件。
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readHostManifest } from './verify-windows-release.mjs'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const MAC_ARCHES = ['x64', 'arm64']

/** 运行时要用到的、按平台分包的原生依赖。宿主包 → 它在 darwin 上那个 optionalDependency 的名字。 */
export const DARWIN_PLATFORM_PACKAGE_HOSTS = [
  { host: 'esbuild', name: arch => `@esbuild/darwin-${arch}`, why: 'artifact / 设计稿编译（esbuild）' },
  { host: 'sharp', name: arch => `@img/sharp-darwin-${arch}`, why: 'read 工具的图片压缩（sharp）' },
  { host: 'sharp', name: arch => `@img/sharp-libvips-darwin-${arch}`, why: 'sharp 的 libvips 动态库' },
  { host: '@napi-rs/canvas', name: arch => `@napi-rs/canvas-darwin-${arch}`, why: 'pdfjs 渲染 PDF 页面（@napi-rs/canvas）' },
  { host: '@vscode/ripgrep', name: arch => `@vscode/ripgrep-darwin-${arch}`, why: 'OS 沙箱初始化硬查的 rg（sandbox-manager.ts）' },
]

/** electron-builder 给 macOS 解包目录起的名字：x64 不带架构后缀，arm64 带 */
export function macAppDir(outDir, arch) {
  return path.join(outDir, arch === 'x64' ? 'mac' : 'mac-arm64', 'OpenPipal.app')
}

function parseArgs(argv) {
  const options = { skipBundle: false, builderArgs: [], outDir: 'dist' }
  for (const arg of argv) {
    if (arg === '--skip-bundle') { options.skipBundle = true; continue }
    const output = arg.match(/^(?:--config|-c)\.directories\.output=(.+)$/)
    if (output) options.outDir = output[1]
    options.builderArgs.push(arg)
  }
  return options
}

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`)
  execFileSync(command, args, { cwd: PROJECT_ROOT, stdio: 'inherit', ...options })
}

function installDir(name) {
  return path.join(PROJECT_ROOT, 'node_modules', ...name.split('/'))
}

/** 把一个平台包放进 node_modules。返回撤销函数。 */
function stagePlatformPackage(name, version, scratchDir) {
  const spec = `${name}@${version}`
  const tarball = execFileSync('npm', ['pack', spec, '--pack-destination', scratchDir, '--silent'], {
    cwd: PROJECT_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit']
  }).trim().split('\n').pop()
  const target = installDir(name)
  fs.mkdirSync(target, { recursive: true })
  execFileSync('/usr/bin/tar', ['-xzf', path.join(scratchDir, tarball), '-C', target, '--strip-components=1'], { stdio: 'inherit' })
  console.log(`  + ${spec} → ${path.relative(PROJECT_ROOT, target)}`)
  return () => fs.rmSync(target, { recursive: true, force: true })
}

/** 本机 npm 没装的那些 darwin 平台包（通常是另一架构的），版本由宿主包钉死 */
export function resolveMissingDarwinPackages(arches, readManifest) {
  const missing = []
  for (const spec of DARWIN_PLATFORM_PACKAGE_HOSTS) {
    const manifest = readManifest(spec.host)
    if (!manifest) throw new Error(`读不到 ${spec.host} 的 package.json（node_modules 里没装？），不敢在缺它的情况下打包`)
    for (const arch of arches) {
      const name = spec.name(arch)
      const version = manifest.optionalDependencies?.[name]
      if (!version) throw new Error(`${spec.host}@${manifest.version} 没有 darwin-${arch} 预编译（${name}）——${spec.why}在 Intel/Apple Silicon 之一上会不可用`)
      if (fs.existsSync(installDir(name))) continue
      missing.push({ name, version })
    }
  }
  return missing
}

/** 出厂检查（纯判定，好测）：本架构的平台包在、另一架构的不在 */
export function evaluateMacAsar({ arch, asarEntries, unpackedRgExecutable }) {
  const entries = new Set(asarEntries.map(entry => entry.split('\\').join('/')))
  const findings = []
  const other = MAC_ARCHES.find(candidate => candidate !== arch)
  for (const spec of DARWIN_PLATFORM_PACKAGE_HOSTS) {
    const own = `/node_modules/${spec.name(arch)}`
    const foreign = `/node_modules/${spec.name(other)}`
    if (!entries.has(own)) findings.push(`缺 ${own}（${spec.why}）`)
    if (entries.has(foreign)) findings.push(`混进了另一架构的 ${foreign}`)
  }
  if (!unpackedRgExecutable) findings.push(`随包 rg 没落成 app.asar.unpacked 下的可执行文件（沙箱会降级）`)
  return { arch, verdict: findings.length === 0 ? 'PASS' : 'FAIL', findings }
}

export function inspectMacApp(outDir, arch) {
  const appDir = macAppDir(outDir, arch)
  const asarPath = path.join(appDir, 'Contents', 'Resources', 'app.asar')
  if (!fs.existsSync(asarPath)) return null
  const asar = createRequire(path.join(PROJECT_ROOT, 'package.json'))('@electron/asar')
  const asarEntries = asar.listPackage(asarPath, { isPack: false })
  const rg = path.join(appDir, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', '@vscode', `ripgrep-darwin-${arch}`, 'bin', 'rg')
  let unpackedRgExecutable = false
  try { fs.accessSync(rg, fs.constants.X_OK); unpackedRgExecutable = fs.statSync(rg).isFile() } catch { /* 缺就是缺 */ }
  return evaluateMacAsar({ arch, asarEntries, unpackedRgExecutable })
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const outDir = path.resolve(PROJECT_ROOT, options.outDir)
  if (!options.skipBundle) {
    run('npm', ['run', 'build'])
    run('npm', ['run', 'build:acp'])
  }
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-mac-deps-'))
  const undo = []
  try {
    console.log('\n== 放入缺的 darwin 平台包')
    for (const pkg of resolveMissingDarwinPackages(MAC_ARCHES, host => readHostManifest(PROJECT_ROOT, host))) {
      undo.push(stagePlatformPackage(pkg.name, pkg.version, scratchDir))
    }
    if (undo.length === 0) console.log('  （两套都在，无需放入）')
    run('npx', ['electron-builder', '--mac', ...options.builderArgs])
  } finally {
    for (const revert of undo.reverse()) revert()
    if (undo.length > 0) console.log('== 平台包已撤出 node_modules')
    fs.rmSync(scratchDir, { recursive: true, force: true })
  }
  console.log('\n== 出厂检查')
  let failed = false
  let inspected = 0
  for (const arch of MAC_ARCHES) {
    const report = inspectMacApp(outDir, arch)
    if (!report) continue
    inspected += 1
    console.log(`${report.verdict === 'PASS' ? '✓' : '✗'} darwin-${arch} ${report.verdict}  ${macAppDir(outDir, arch)}`)
    for (const finding of report.findings) console.log(`    ERROR ${finding}`)
    if (report.verdict !== 'PASS') failed = true
  }
  if (inspected === 0) { console.log(`✗ ${outDir} 下一个架构的 OpenPipal.app 都没有`); failed = true }
  return failed ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => process.exit(code)).catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exit(2)
  })
}
