/**
 * 用户规矩（插件 hooks/）的跨进程契约：主进程 → preload → 渲染层 / 会话存储 共用同一份形状。
 * 面向规矩作者的类型（事件、HookAPI）住在 main/hooks/hook-types.ts，不在这里。
 */

/**
 * 规矩文件刚被写入/改动后，加载器给出的结论。
 * 对话流里的那行提醒、回给模型的反馈，都只从这里来——是加载器的事实，不是模型的宣称。
 */
export interface HookNotice {
  status: 'ok' | 'error'
  /** `<plugin>/<文件名去后缀>` */
  hookId: string
  pluginName: string
  /** 绝对路径 */
  file: string
  description: string
  error?: string
}

/** 插件页清单的一条：在生效的、加载失败的、被关掉的（文件 .off 或整个插件停用）都列 */
export interface HookEntry {
  id: string
  pluginName: string
  file: string
  description?: string
  status: 'ok' | 'error' | 'off'
  /** status 为 off 时：是这条规矩自己关了（文件改名 .off），还是所在插件整个停用 */
  offReason?: 'file' | 'plugin'
  error?: string
  events: string[]
}

export type HookToggleResult = { ok: true; file: string } | { ok: false; error: string }
