import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback
} from '@elizaos/core'

import { resolveChain } from '../chains'
import {
  emitLiveText,
  getWaapServiceRaw,
  summarizeViemError
} from './actionUtils'
import { extractGetBalanceParams } from './paramExtraction'

export const getBalanceAction: Action = {
  name: 'WAAP_GET_BALANCE',
  similes: [
    'GET_BALANCE',
    'CHECK_BALANCE',
    'WALLET_BALANCE',
    'HOW_MUCH',
    'MY_BALANCE',
    'MY_FUNDS',
    'DO_I_HAVE_FUNDS',
    'BALANCE_QUERY',
    'CHECK_FUNDS',
    'HOW_MUCH_DO_I_HAVE',
    'ETH_BALANCE',
    'SUI_BALANCE'
  ],
  description:
    "Read the on-chain balance of the wallet's own address. Supports EVM chains and Sui networks. Optionally specify an EVM chain (e.g. 'on Polygon'). Read-only — no 2FA required. ALWAYS dispatch this action when the user asks about their balance — INCLUDING when the wallet is not logged in AND when an earlier turn already implied the answer. Do NOT pick NONE just because conversation history hints at the answer; the user expects the answer to come from this action's card. The handler has a not-logged-in branch that emits clean sign-up / log-in instructions. NARRATION RESTRAINT: keep your accompanying REPLY terse and do NOT include the balance number in the REPLY — the action emits it.",

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    // Stay available even when the wallet isn't logged in — the handler
    // shows the not-logged-in state explicitly via the action callback so
    // the LLM keeps dispatching this action (rather than answering free-form
    // when it sees "not logged in" in the provider context).
    return !!getWaapServiceRaw(runtime)
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
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
      // Pre-login: emit the same action-card prompt the other read-only
      // actions use. Returning success=true (with loggedIn=false) instead of
      // a canned reject keeps the LLM choosing this action over NONE on
      // follow-up balance questions.
      const richText = [
        '🔒 No balance to show — you are not logged in.',
        '',
        '   Sign up with: `create a new account with email <you@example.com> and password <pw>`.',
        '   Log in with:  `log in with email <you@example.com> and password <pw>`.',
        '   Or, for an agent-owned wallet, set `WAAP_EMAIL` / `WAAP_PASSWORD` in the agent secrets to log in automatically (keeps the password out of chat).'
      ].join('\n')
      const liveOk = await emitLiveText(runtime, message, richText)
      const callbackText = liveOk
        ? '🔒 No balance — wallet not logged in.'
        : richText
      await callback?.({ text: callbackText, content: { loggedIn: false } })
      return { success: true, text: callbackText, data: { loggedIn: false } }
    }

    try {
      const extracted = await extractGetBalanceParams(runtime, message, state)

      if (!extracted.ok) {
        const text = `Invalid balance request: ${extracted.error}`
        await callback?.({ text })
        return { success: false, text }
      }

      const params = extracted.value
      const walletState = svc.getState()

      // If user asked for a specific chain, query just that chain.
      // Otherwise query both EVM and Sui (if the wallet has both addresses).
      if (params.chainId || params.rpc) {
        const result = await svc.getBalance({
          chainId: params.chainId,
          rpc: params.rpc
        })
        // Pick the display unit from the *requested* chain's family, not the
        // wallet's currently-active chain — otherwise a "what's my Sui balance"
        // query while the wallet is on EVM would label SUI as "ETH".
        const requestedFamily = params.chainId
          ? (resolveChain(params.chainId)?.family ?? svc.getChainFamily())
          : svc.getChainFamily()
        const unit = requestedFamily === 'sui' ? 'SUI' : 'ETH'
        // Mirror the CLI `balance` command, which appends the raw on-chain
        // amount: EVM as a bare wei hex, Sui as decimal MIST.
        const rawSuffix = result.balanceRaw
          ? ` (${result.balanceRaw}${requestedFamily === 'sui' ? ' MIST' : ''})`
          : ''
        const text = `💰 Balance: ${result.balanceFormatted} ${unit} on ${result.chainId}${rawSuffix}`

        await callback?.({
          text,
          content: {
            balanceRaw: result.balanceRaw,
            balanceFormatted: result.balanceFormatted,
            chainId: result.chainId,
            address: result.address
          }
        })

        return { success: true, text, data: result }
      }

      // No specific chain — query both EVM and Sui explicitly
      // Always pass explicit chainId so active chain doesn't affect results
      const evmChainId =
        walletState.chainState.family === 'evm'
          ? walletState.chainState.chainId
          : 1
      const evmResult = await svc.getBalance({ chainId: evmChainId })
      const lines = [
        '💰 Balance:',
        `- EVM: ${evmResult.balanceFormatted} ETH on ${evmResult.chainId}`
      ]
      const data: Record<string, unknown> = { evm: evmResult }

      if (walletState.suiAddress) {
        try {
          const suiResult = await svc.getBalance({
            chainId: 'sui:mainnet'
          })
          lines.push(
            `- Sui: ${suiResult.balanceFormatted} SUI on ${suiResult.chainId}`
          )
          data.sui = suiResult
        } catch {
          lines.push('- Sui: unable to fetch')
        }
      }

      const richText = lines.join('\n')

      // Push the multi-line balance breakdown verbatim via the live channel.
      // Falls back to inlining it in the callback when the host has no live
      // handler. The terse callback text keeps `\n` out of conversation
      // memory so the LLM doesn't echo the escape sequence back as literal
      // characters in follow-up summaries.
      const liveOk = await emitLiveText(runtime, message, richText)
      const callbackText = liveOk ? '💰 Balance fetched.' : richText

      await callback?.({ text: callbackText, content: data })

      return { success: true, text: callbackText, data }
    } catch (err) {
      const error = err as Error
      const text = `❌ Get balance failed: ${summarizeViemError(error.message)}`
      await callback?.({ text })

      return { success: false, text, error }
    }
  },

  examples: [
    [
      { name: '{{user}}', content: { text: "What's my balance?" } },
      {
        name: '{{agent}}',
        content: {
          text: "I'll check your wallet balance now.",
          thought:
            "User wants their own wallet balance. I'll route through WAAP_GET_BALANCE which defaults to the WaaP wallet's address on the configured chain — read-only, no 2FA needed.",
          actions: ['WAAP_GET_BALANCE']
        }
      }
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'Check my balance on Polygon' }
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll check your wallet balance on Polygon.",
          thought:
            'User specified a chain. WAAP_GET_BALANCE will query the balance on Polygon (chain 137) for the wallet address.',
          actions: ['WAAP_GET_BALANCE']
        }
      }
    ]
  ]
}
