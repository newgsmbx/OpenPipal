import { describe, expect, it } from 'vitest'
import {
  DARWIN_PLATFORM_PACKAGE_HOSTS,
  evaluateMacAsar,
  resolveMissingDarwinPackages,
} from '../../scripts/build-macos.mjs'

// 1.1.1 的 x64 DMG 里装的全是 arm64 的 esbuild / sharp / canvas（2026-09-06 asar 对比实测），Intel 机器上
// 这些模块加载不了。这里守两件事：缺的那套平台包算得出来（版本由宿主包钉死）、出厂检查认得出"混进另一架构"。
describe('macOS build stages the other architecture and checks the result', () => {
  const manifests: Record<string, { version: string; optionalDependencies: Record<string, string> }> = {
    esbuild: { version: '0.21.5', optionalDependencies: { '@esbuild/darwin-arm64': '0.21.5', '@esbuild/darwin-x64': '0.21.5' } },
    sharp: { version: '0.35.4', optionalDependencies: {
      '@img/sharp-darwin-arm64': '0.35.4', '@img/sharp-darwin-x64': '0.35.4',
      '@img/sharp-libvips-darwin-arm64': '1.2.4', '@img/sharp-libvips-darwin-x64': '1.2.4',
    } },
    '@napi-rs/canvas': { version: '0.1.80', optionalDependencies: { '@napi-rs/canvas-darwin-arm64': '0.1.80', '@napi-rs/canvas-darwin-x64': '0.1.80' } },
    '@vscode/ripgrep': { version: '1.18.0', optionalDependencies: { '@vscode/ripgrep-darwin-arm64': '1.18.0', '@vscode/ripgrep-darwin-x64': '1.18.0' } },
  }

  // 本机 npm 装的是哪套平台包取决于 os/cpu：只有 darwin 主机才能断言"只补另一架构那五个"，
  // Windows CI 上两套都不在、十个全算缺，那不是这条契约要守的
  it.skipIf(process.platform !== 'darwin')('resolves the platform packages the host npm did not install, pinned to the host package version', () => {
    // 本机是 arm64：darwin-arm64 那套已在 node_modules，只该补 x64 的五个
    const missing = resolveMissingDarwinPackages(['x64', 'arm64'], (host: string) => manifests[host])
    const names = missing.map(pkg => pkg.name).sort()
    const expected = DARWIN_PLATFORM_PACKAGE_HOSTS.map(spec => spec.name(process.arch === 'arm64' ? 'x64' : 'arm64')).sort()
    expect(names).toEqual(expected)
    expect(missing.find(pkg => pkg.name === '@img/sharp-libvips-darwin-x64')?.version).toBe('1.2.4')
  })

  it('refuses to build when a host package has no prebuilt binary for one of the two architectures', () => {
    const broken = { ...manifests, '@napi-rs/canvas': { version: '0.1.80', optionalDependencies: { '@napi-rs/canvas-darwin-arm64': '0.1.80' } } }
    expect(() => resolveMissingDarwinPackages(['x64', 'arm64'], (host: string) => broken[host])).toThrow(/darwin-x64/)
  })

  it('fails the factory check when the other architecture leaks in or the own one is missing', () => {
    const own = (arch: string) => DARWIN_PLATFORM_PACKAGE_HOSTS.map(spec => `/node_modules/${spec.name(arch)}`)
    expect(evaluateMacAsar({ arch: 'x64', asarEntries: own('x64'), unpackedRgExecutable: true }).verdict).toBe('PASS')
    const leaked = evaluateMacAsar({ arch: 'x64', asarEntries: [...own('x64'), '/node_modules/@esbuild/darwin-arm64'], unpackedRgExecutable: true })
    expect(leaked.verdict).toBe('FAIL')
    expect(leaked.findings.join('\n')).toMatch(/另一架构.*@esbuild\/darwin-arm64/)
    const missing = evaluateMacAsar({ arch: 'arm64', asarEntries: own('arm64').slice(1), unpackedRgExecutable: true })
    expect(missing.findings.join('\n')).toMatch(/缺 \/node_modules\/@esbuild\/darwin-arm64/)
    expect(evaluateMacAsar({ arch: 'arm64', asarEntries: own('arm64'), unpackedRgExecutable: false }).findings.join('\n')).toMatch(/随包 rg/)
  })
})
