import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback
} from '@elizaos/core'

import {
  getWaapService,
  getWaapServiceRaw,
  rejectNoService,
  summarizeViemError
} from './actionUtils'
import { extractSwitchChainParams } from './paramExtraction'
import { resolveChain, chainDisplayName, supportedChainsText } from '../chains'

export const switchChainAction: Action = {
  name: 'WAAP_SWITCH_CHAIN',
  similes: ['CHANGE_CHAIN', 'SET_CHAIN', 'USE_NETWORK'],
  description:
    'Switch the active chain for the WaaP wallet. Supports EVM chains (ethereum, polygon, base, arbitrum, optimism, bsc, sepolia, avalanche) and Sui networks (sui:mainnet, sui:testnet, sui:devnet).',

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    // Stay available pre-login — handler emits "please log in first" via
    // rejectNoService(). Otherwise the LLM picks a generic chat reply on
    // "switch to polygon" and silently no-ops.
    return !!getWaapServiceRaw(runtime)
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const svc = getWaapService(runtime)

    if (!svc) {
      return rejectNoService(callback)
    }

    const params = await extractSwitchChainParams(runtime, message, state)

    if (!params.ok) {
      // Schema rejects when no chain identifier was extracted. Friendly
      // re-ask listing the supported formats instead of raw zod text.
      const text =
        'Which chain? Reply with a name (`ethereum`, `polygon`, `base`, ' +
        '`arbitrum`, `optimism`, `bsc`, `sui`, `sui:testnet`, `sui:devnet`), ' +
        'a numeric chain ID (e.g. `137`), or a namespaced ID (`evm:137`).'
      await callback?.({ text })

      return {
        success: false,
        text,
        error: new Error(`Invalid chain details: ${params.error}`)
      }
    }

    const chainState = resolveChain(params.value.chain)

    if (chainState === null) {
      const text = `Unknown chain. Supported: ${supportedChainsText()}`
      await callback?.({ text })

      return { success: false, text, error: new Error(text) }
    }

    try {
      svc.switchChain(chainState.canonical)
      const name = chainDisplayName(chainState)
      const text =
        chainState.family === 'evm'
          ? `Switched to ${name} (chain ID ${chainState.chainId})`
          : `Switched to ${chainState.canonical}`

      await callback?.({ text, content: { chainState, name } })

      return { success: true, text, data: { chainState, name } }
    } catch (err) {
      const error = err as Error
      // Route through summarizeViemError so unreachable-backend failures
      // ("fetch failed", ECONN*, getaddrinfo) get the shared multi-line
      // network-error remediation. Most chain switches don't make network
      // calls, but RPC pre-validation can — and when it does, the operator
      // deserves the same diagnostic the other actions provide.
      const text = `Switch chain failed: ${summarizeViemError(error.message)}`
      await callback?.({ text })

      return { success: false, text, error }
    }
  },

  examples: [
    [
      { name: '{{user}}', content: { text: 'Switch to Polygon' } },
      {
        name: '{{agent}}',
        content: {
          text: "I'll switch your wallet to the Polygon network.",
          thought:
            "User wants to switch to Polygon (chainId 137). I'll use WAAP_SWITCH_CHAIN to update the active chain.",
          actions: ['WAAP_SWITCH_CHAIN']
        }
      }
    ],
    [
      { name: '{{user}}', content: { text: 'Use Base network' } },
      {
        name: '{{agent}}',
        content: {
          text: "I'll switch to Base for you.",
          thought:
            "User wants to switch to Base (chainId 8453). I'll use WAAP_SWITCH_CHAIN.",
          actions: ['WAAP_SWITCH_CHAIN']
        }
      }
    ],
    [
      { name: '{{user}}', content: { text: 'Switch to Sui testnet' } },
      {
        name: '{{agent}}',
        content: {
          text: "I'll switch your wallet to Sui testnet.",
          thought:
            "User wants to switch to Sui testnet. I'll use WAAP_SWITCH_CHAIN with 'sui:testnet'.",
          actions: ['WAAP_SWITCH_CHAIN']
        }
      }
    ],
    // Negative example — DO NOT dispatch WAAP_SWITCH_CHAIN on status questions.
    // Per the system prompt's ROUTING RULE, "what chain am I on?" ALWAYS
    // dispatches WAAP_GET_CHAIN so the chat shows a fresh action card —
    // `actions: []` would let the LLM guess from conversation memory, and
    // the active chain can change between turns (CLI switch, other tab).
    [
      { name: '{{user}}', content: { text: 'what chain am I on?' } },
      {
        name: '{{agent}}',
        content: {
          text: 'Pulling your active chain.',
          thought:
            'Active-chain status question. The system prompt\'s ROUTING RULE says ALWAYS dispatch WAAP_GET_CHAIN for these — never guess from conversation memory. Crucially, do NOT dispatch WAAP_SWITCH_CHAIN: the user asked which chain they are on, not to switch. Wait for an explicit "switch to <chain>" instruction before invoking the switch action.',
          actions: ['WAAP_GET_CHAIN']
        }
      }
    ]
  ]
}
