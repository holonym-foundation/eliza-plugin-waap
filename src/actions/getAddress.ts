//
// Reading the wallet's EVM and Sui addresses from `svc.getState()` and pushing
// the answer through the action callback rather than letting the LLM compose a
// free-form REPLY from the `waapWallet` provider context.
//
// Why this is its own action: the LLM's free-form replies emit `\n` as the
// literal two-character escape (visible as backslash + n in chat) instead of
// real newline characters. Action-callback text bypasses that LLM rendering
// step entirely — the chat client renders the action's text bubble as-is, with
// real newlines. So routing address questions through an action removes our
// dependence on LLM formatting fidelity.
//
// No CLI call is made: addresses live in the in-memory `WaapWalletState`
// already (populated at login/signup), so this is a pure read.
import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback
} from '@elizaos/core'

import { emitLiveText, getWaapServiceRaw } from './actionUtils'

export const getAddressAction: Action = {
  name: 'WAAP_GET_ADDRESS',
  similes: [
    'GET_ADDRESS',
    'SHOW_ADDRESS',
    'MY_ADDRESS',
    'WHAT_IS_MY_ADDRESS',
    'WALLET_ADDRESS',
    'GET_WALLET_ADDRESS',
    'EVM_ADDRESS',
    'SUI_ADDRESS',
    'WHERE_IS_MY_WALLET',
    'WALLET_ADDR',
    'MY_WALLET_ADDR',
    'PUBLIC_KEY',
    'MY_ETH_ADDRESS',
    'MY_SUI_ADDRESS'
  ],
  description:
    "Show the wallet's EVM and Sui addresses. Read-only — no 2FA. ALWAYS dispatch this action whenever the user asks for any of: their address, their wallet address, their EVM address, their Sui address, or 'where's my wallet' — INCLUDING when the waapWallet provider says the wallet is not logged in. The action's own handler emits a clean action-card prompt with sign-up / log-in instructions in that case; replying free-form (\"you need to log in first\") instead of dispatching produces inconsistent UX. Routing the answer through this action also ensures the addresses render with real Markdown line breaks instead of literal `\\n` escape sequences. NARRATION RESTRAINT: keep your accompanying REPLY text terse (e.g. \"Here are your wallet addresses.\") and do NOT include the addresses themselves in the REPLY — the action emits them.",

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    // Stay available pre-login — the handler shows the not-logged-in state
    // explicitly via the action callback (with sign-up / log-in instructions)
    // so the chat renders a consistent action card instead of letting the
    // LLM produce a free-form "you need to log in" reply.
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

    // No service registered — should not happen given validate(), but guard
    // anyway so we never throw in the handler.
    if (!svc) {
      const text = 'WaaP wallet is not available.'
      await callback?.({ text })
      return { success: false, text, error: new Error(text) }
    }

    // Pre-login: emit the addresses-unavailable bubble through the same
    // live-channel pattern as the logged-in path. We do NOT short-circuit
    // with rejectNoService here because the canned one-liner makes the LLM
    // judge "no point dispatching" and answer free-form on the next turn.
    if (!svc.isReady()) {
      const richText = [
        '🔒 No wallet addresses yet — you are not logged in.',
        '',
        '   Sign up with: `create a new account with email <you@example.com> and password <pw>`.',
        '   Log in with:  `log in with email <you@example.com> and password <pw>`.',
        '   Or, for an agent-owned wallet, set `WAAP_EMAIL` / `WAAP_PASSWORD` in the agent secrets to log in automatically (keeps the password out of chat).'
      ].join('\n')
      const liveOk = await emitLiveText(runtime, message, richText)
      const callbackText = liveOk
        ? '🔒 No addresses yet — wallet not logged in.'
        : richText
      await callback?.({ text: callbackText, content: { loggedIn: false } })
      return { success: true, text: callbackText, data: { loggedIn: false } }
    }

    const s = svc.getState()

    // Build the rich, multi-line answer with real newline characters. This
    // text goes via the live channel where the chat renderer honors real
    // newlines. The terse callback text below is what the LLM sees in
    // conversation memory — keeping it free of `\n` prevents downstream
    // re-narration from leaking the escape sequence as literal characters.
    const lines = ['📬 Your wallet addresses:']
    if (s.evmAddress) lines.push(`- EVM: ${s.evmAddress}`)
    if (s.suiAddress) lines.push(`- Sui: ${s.suiAddress}`)
    const richText = lines.join('\n')

    const liveOk = await emitLiveText(runtime, message, richText)
    const callbackText = liveOk ? '📬 Wallet addresses sent.' : richText

    await callback?.({
      text: callbackText,
      content: { evmAddress: s.evmAddress, suiAddress: s.suiAddress }
    })

    return {
      success: true,
      text: callbackText,
      data: { evmAddress: s.evmAddress, suiAddress: s.suiAddress }
    }
  },

  examples: [
    [
      { name: '{{user}}', content: { text: "What's my address?" } },
      {
        name: '{{agent}}',
        content: {
          text: 'Here are your wallet addresses.',
          thought:
            "User wants their wallet addresses. I'll dispatch WAAP_GET_ADDRESS — routing through the action ensures the addresses render with real newlines instead of the LLM emitting them as a free-form reply (which would inject literal `\\n` escapes).",
          actions: ['WAAP_GET_ADDRESS']
        }
      }
    ],
    [
      { name: '{{user}}', content: { text: 'show me my wallet address' } },
      {
        name: '{{agent}}',
        content: {
          text: 'Here are your addresses.',
          thought:
            "User asked for their wallet address. WAAP_GET_ADDRESS handles both EVM and Sui addresses; I'll dispatch it instead of free-form replying.",
          actions: ['WAAP_GET_ADDRESS']
        }
      }
    ],
    [
      { name: '{{user}}', content: { text: 'what is my evm address' } },
      {
        name: '{{agent}}',
        content: {
          text: 'Pulling your wallet addresses now.',
          thought:
            "Even when the user asks specifically about EVM, dispatch WAAP_GET_ADDRESS — it returns both addresses and the user can read whichever they need. Don't include the address in my REPLY text; the action emits it.",
          actions: ['WAAP_GET_ADDRESS']
        }
      }
    ]
  ]
}
