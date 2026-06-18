//
// Returns the wallet's currently-active chain via the action callback.
// Single-line answer; we still route through an action (rather than letting
// the LLM read the provider and reply free-form) so the chat shows a
// consistent action card and the LLM has no opportunity to guess the wrong
// chain when conversation history conflicts with current state.

import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback
} from '@elizaos/core'

import { chainDisplayName } from '../chains'
import { emitLiveText, getWaapServiceRaw } from './actionUtils'

export const getChainAction: Action = {
  name: 'WAAP_GET_CHAIN',
  similes: [
    'GET_CHAIN',
    'ACTIVE_CHAIN',
    'CURRENT_CHAIN',
    'MY_CHAIN',
    'WHAT_CHAIN',
    'WHAT_NETWORK',
    'CURRENT_NETWORK',
    'ACTIVE_NETWORK',
    'WHICH_CHAIN_AM_I_ON',
    'WHICH_NETWORK'
  ],
  description:
    'Show the WaaP wallet\'s currently-active chain. Read-only — no auth required to dispatch. ALWAYS dispatch this when the user asks any of: "what chain am I on?", "current chain", "active chain", "which network?", or any close variant — INCLUDING when an earlier turn already mentioned a chain. Do NOT pick NONE or compose the answer free-form from conversation history; the active chain can change between turns (the user may have switched chains in another tab or via the CLI). The handler has a not-logged-in branch that emits sign-up / log-in instructions.',

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    return !!getWaapServiceRaw(runtime)
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const svc = getWaapServiceRaw(runtime)

    if (!svc) {
      const text = 'WaaP wallet is not available.'
      await callback?.({ text })
      return { success: false, text, error: new Error(text) }
    }

    if (!svc.isReady()) {
      const richText = [
        '🔒 No active chain — you are not logged in.',
        '',
        '   Sign up with: `create a new account with email <you@example.com> and password <pw>`.',
        '   Log in with:  `log in with email <you@example.com> and password <pw>`.',
        '   Or, for an agent-owned wallet, set `WAAP_EMAIL` / `WAAP_PASSWORD` in the agent secrets to log in automatically (keeps the password out of chat).'
      ].join('\n')
      const liveOk = await emitLiveText(runtime, message, richText)
      const callbackText = liveOk
        ? '🔒 No active chain — wallet not logged in.'
        : richText
      await callback?.({ text: callbackText, content: { loggedIn: false } })
      return { success: true, text: callbackText, data: { loggedIn: false } }
    }

    const cs = svc.getChainState()
    const display = chainDisplayName(cs)
    // Single-line answer; the canonical id already includes the family
    // prefix ("evm:1" / "sui:mainnet"), and the display name supplies a
    // human-readable label for EVM chains. Both go in one bubble.
    const text =
      cs.family === 'evm'
        ? `🌐 Active chain: ${display} (chain ID ${cs.chainId}, canonical \`${cs.canonical}\`).`
        : `🌐 Active chain: ${cs.canonical} (Sui ${cs.network}).`

    await callback?.({
      text,
      content: {
        canonical: cs.canonical,
        family: cs.family,
        chainId: cs.family === 'evm' ? cs.chainId : undefined,
        network: cs.family === 'sui' ? cs.network : undefined
      }
    })

    return {
      success: true,
      text,
      data: {
        canonical: cs.canonical,
        family: cs.family
      }
    }
  },

  examples: [
    [
      { name: '{{user}}', content: { text: 'what chain am I on?' } },
      {
        name: '{{agent}}',
        content: {
          text: 'Checking your active chain.',
          thought:
            'Active-chain question. Even if the answer seems obvious from conversation memory, the user could have switched chains in another tab or via the CLI — dispatch WAAP_GET_CHAIN for a fresh action-card answer.',
          actions: ['WAAP_GET_CHAIN']
        }
      }
    ],
    [
      { name: '{{user}}', content: { text: 'which network?' } },
      {
        name: '{{agent}}',
        content: {
          text: 'Pulling the active network.',
          thought:
            'Network question. Dispatch WAAP_GET_CHAIN — never guess from conversation history.',
          actions: ['WAAP_GET_CHAIN']
        }
      }
    ]
  ]
}
