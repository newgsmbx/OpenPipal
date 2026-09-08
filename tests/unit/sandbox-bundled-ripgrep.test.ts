import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildSandboxConfig, resolveBundledRipgrep } from '../../src/main/sandbox-manager'

// 随包 ripgrep：沙箱库初始化时硬查 rg，缺了整段 OS 沙箱降级、Shell 执行被禁（2026-09-05 实撞：
// 机器上 Homebrew 的 ripgrep 被卸掉，同一个装机包前一天还好）。这里守三件事：
// 平台包装上了、路径指到真文件、沙箱配置真的把它交给了 SRT 而不是靠 PATH。
describe('bundled ripgrep for the OS sandbox', () => {
  const platformPkg = `@vscode/ripgrep-${process.platform}-${process.arch}`

  it('resolves the platform binary shipped with the app', () => {
    const rg = resolveBundledRipgrep()
    expect(rg, `${platformPkg} 没装上——npm install 按 os/cpu 挑可选依赖，别用 --no-optional`).not.toBeNull()
    // Windows 上路径是反斜杠，先统一成 posix 再比（2026-09-06 Windows CI 实撞：值对、断言错）
    expect(rg!.split('\\').join('/')).toContain(platformPkg)
    expect(fs.statSync(rg!).isFile()).toBe(true)
    if (process.platform !== 'win32') {
      expect(() => fs.accessSync(rg!, fs.constants.X_OK)).not.toThrow()
    }
  })

  it('hands that binary to the sandbox runtime instead of relying on PATH', () => {
    expect(buildSandboxConfig().ripgrep?.command).toBe(resolveBundledRipgrep())
  })
})
