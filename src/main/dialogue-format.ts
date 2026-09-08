/**
 * "对话正文"的唯一判据（主进程侧）：给 Evolver（记忆提取 / 保存 Agent / dream）看的历史只含用户和助手
 * 真正说的话。只按 role 滤只能去掉工具回执；胶囊提醒、思考、权限卡、断流残片、运行时快照、定时触发
 * 的 role 也是 user / assistant，不按种类滤掉就会被当成"用户 / 助手说过的话"写进记忆或 agent.md。
 * 滤在切片之前——切完再滤，窗口已经被这些消息吃掉了（说了记不住的成因）。
 * 读侧放进模型载荷的判据在 conversation-store.ts（shouldReplayStoredMessage），口径比这里宽（工具回执要回放）。
 */
import type { ChatMessage } from './agent-runtime/contracts'

export const NON_DIALOGUE_KINDS: ReadonlySet<string> = new Set([
  'inject-notice',
  'thinking',
  'permission_request',
  'incomplete',
  'runtime-context',
  'task-trigger',
  'tool'
])

export function isDialogueMessage(message: ChatMessage): boolean {
  return (message.role === 'user' || message.role === 'assistant') && !NON_DIALOGUE_KINDS.has(message.messageKind ?? '')
}

/** 最近 maxMessages 条对话正文，每条截到 maxChars，`[用户] …` / `[助手] …` 一行一条 */
export function formatDialogue(messages: ChatMessage[], options: { maxMessages: number; maxChars: number }): string {
  return messages
    .filter(isDialogueMessage)
    .slice(-options.maxMessages)
    .map((m) => `[${m.role === 'user' ? '用户' : '助手'}] ${m.content.slice(0, options.maxChars)}`)
    .join('\n\n')
}
