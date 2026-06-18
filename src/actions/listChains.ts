//
// Lists every supported chain (EVM names with chain IDs + Sui networks) in a
// multi-line bubble. Routes "what chains do you support?" / "list chains"
// through the action callback so the chat renders real newlines instead of
// the LLM emitting `\n` as escape characters in a free-form REPLY.
//
// No CLI call: chain definitions live in the local `chains` module.

import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback
} from '@elizaos/core'

import { CHAIN_NAMES, SUI_NETWORKS } from '../chains'
import { emitLiveText } from './actionUtils'

export const listChainsAction: Action = {
  name: 'WAAP_LIST_CHAINS',
  similes: [
    'LIST_CHAINS',
    'SUPPORTED_CHAINS',
    'AVAILABLE_CHAINS',
    'WHICH_CHAINS',
    'WHAT_CHAINS',
    'SHOW_CHAINS',
    'CHAINS_SUPPORTED',
    'LIST_NETWORKS',
    'SUPPORTED_NETWORKS',
    'AVAILABLE_NETWORKS',
    'WHICH_NETWORKS',
    'WHAT_NETWORKS'
  ],
  description:
    'List every chain the WaaP wallet supports — EVM chains with their numeric chain IDs and the three Sui networks. Read-only — no auth required, dispatchable pre-login. ALWAYS dispatch this action when the user asks "what chains do you support?", "which networks?", "list chains", or any variant — INCLUDING when an earlier turn already mentioned a chain or the wallet is not logged in. Do NOT pick NONE; the user expects the canonical list to come from this action\'s card. Routing through the action also ensures the multi-line list renders with real Markdown line breaks instead of literal `\\n` escapes. NARRATION RESTRAINT: keep your accompanying REPLY terse (e.g. "Here are the supported chains.") — do NOT include the chain list in the REPLY; the action emits it.',

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    // No service needed — chain definitions are static. Always available.
    return true
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    // Group EVM aliases by their canonical chain ID so the list shows each
    // chain once with a representative name + ID, rather than e.g. "eth/eth/
    // mainnet/ethereum" all on separate lines for chainId 1.
    const evmByChainId = new Map<number, string[]>()
    for (const [name, id] of Object.entries(CHAIN_NAMES)) {
      const list = evmByChainId.get(id) ?? []
      list.push(name)
      evmByChainId.set(id, list)
    }
    const evmLines = Array.from(evmByChainId.entries())
      .sort(([a], [b]) => a - b)
      .map(([id, names]) => {
        // First alias is canonical; the rest are aliases the user can type.
        const [primary, ...aliases] = names
        const aliasStr = aliases.length
          ? ` (aliases: ${aliases.join(', ')})`
          : ''
        return `- ${primary} — chainId ${id}${aliasStr}`
      })

    const suiLines = SUI_NETWORKS.map((n) => `- sui:${n}`)

    const richText = [
      '🌐 Supported chains:',
      '',
      '**EVM chains:**',
      ...evmLines,
      '',
      '**Sui networks:**',
      ...suiLines
    ].join('\n')

    const liveOk = await emitLiveText(runtime, message, richText)
    const callbackText = liveOk ? '🌐 Supported chains sent.' : richText

    const evmChains = Array.from(evmByChainId.entries()).map(([id, names]) => ({
      chainId: id,
      name: names[0],
      aliases: names.slice(1)
    }))
    const content = {
      evmChains,
      suiNetworks: SUI_NETWORKS.map((n) => `sui:${n}`)
    }
    await callback?.({ text: callbackText, content })

    return { success: true, text: callbackText, data: content }
  },

  examples: [
    [
      { name: '{{user}}', content: { text: 'what chains do you support?' } },
      {
        name: '{{agent}}',
        content: {
          text: 'Here are the supported chains.',
          thought:
            "User wants the supported-chain list. I'll dispatch WAAP_LIST_CHAINS — routing through the action ensures the multi-line list renders with real newlines.",
          actions: ['WAAP_LIST_CHAINS']
        }
      }
    ],
    [
      { name: '{{user}}', content: { text: 'which networks can I use?' } },
      {
        name: '{{agent}}',
        content: {
          text: 'Here are the networks you can switch to.',
          thought:
            "User wants supported chains. WAAP_LIST_CHAINS lists EVM chains with chain IDs and Sui networks. I won't include the list in my REPLY; the action emits it.",
          actions: ['WAAP_LIST_CHAINS']
        }
      }
    ]
  ]
}
