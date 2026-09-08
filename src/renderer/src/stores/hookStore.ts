/**
 * Hook Store —— 规矩（插件 hooks/）的清单与文件式开关。
 *
 * 只是主进程 `hooks:list` 的一份缓存：对话流里的「已定下规矩」那一行按它算"现在还开着没有"，
 * 插件页按它列清单。刷新时机：收到 hook_notice 事件、插件页打开、开关操作之后。
 * 刷新正在进行时又来一次请求，不丢：记一笔，等这次结束再补跑一次——否则连点两下开关，
 * 第二下改完盘、界面还停在第一下的样子。
 */
import { create } from 'zustand'
import type { HookEntry } from '../types'

interface HookState {
  entries: HookEntry[]
  /** 拿到过一次清单；拿不到清单的端（浏览器插件 listHooks 返回 null）永远是 false */
  loaded: boolean
  loading: boolean
  refresh: () => Promise<void>
  setEnabled: (file: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
}

let pendingRefresh = false
let inflight: Promise<void> | null = null

export const useHookStore = create<HookState>((set, get) => ({
  entries: [],
  loaded: false,
  loading: false,

  refresh: async () => {
    if (!window.api.listHooks) return
    if (inflight) {
      pendingRefresh = true
      return inflight
    }
    inflight = (async () => {
      set({ loading: true })
      try {
        do {
          pendingRefresh = false
          const entries = await window.api.listHooks!()
          if (Array.isArray(entries)) set({ entries, loaded: true })
        } while (pendingRefresh)
      } catch (error) {
        console.warn('[Hooks] 规矩清单刷新失败', error)
      } finally {
        set({ loading: false })
        inflight = null
      }
    })()
    return inflight
  },

  setEnabled: async (file, enabled) => {
    if (!window.api.setHookEnabled) return { ok: false, error: 'unsupported' }
    const result = await window.api.setHookEnabled(file, enabled)
    await get().refresh()
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  }
}))
