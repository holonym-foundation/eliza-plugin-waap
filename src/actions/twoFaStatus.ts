import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback
} from '@elizaos/core'

import {
  emitLiveText,
  getWaapServiceRaw,
  summarizeViemError
} from './actionUtils'

const METHOD_LABELS: Record<string, string> = {
  email: 'Email',
  telegram: 'Telegram',
  external_wallet: 'External Wallet',
  phone: 'Phone',
  disabled: 'Disabled'
}

export const twoFaStatusAction: Action = {
  name: 'WAAP_2FA_STATUS',
  similes: [
    'CHECK_2FA',
    'TWO_FACTOR_STATUS',
    'MFA_STATUS',
    'GET_2FA_STATUS',
    'IS_2FA_ENABLED',
    'TWO_FACTOR_CHECK',
    'MY_2FA_METHOD',
    'WHAT_2FA',
    'WHAT_IS_MY_2FA',
    '2FA_QUERY',
    'DO_I_HAVE_2FA',
    'IS_TWO_FACTOR_ON'
  ],
  description:
    "Check the current 2FA (two-factor authentication) status of the WaaP wallet. Returns BOTH the method (email / telegram / external_wallet / disabled) AND, when enabled, the registered destination it's bound to — the actual email address, Telegram chat ID, or hardware-wallet address(es). Read-only — no auth required to dispatch. ALWAYS dispatch this action when the user asks about their 2FA status, whether 2FA is enabled, what 2FA method is configured, OR which email / number / wallet their 2FA is set to (e.g. \"what's my 2FA email?\") — INCLUDING when the wallet is not logged in AND when an earlier turn already implied the answer. The 2FA destination is NOT the same as the login email and is NOT stored in conversation memory — it must come from THIS action, never from priors. Do NOT pick NONE just because conversation history hints at the answer; the user expects the answer to come from this action's card. The handler has a not-logged-in branch that emits clean sign-up / log-in instructions.",

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    // Stay available pre-login — handler shows the not-logged-in state
    // explicitly via the action callback so the LLM keeps dispatching this
    // action over NONE / free-form replies on follow-up 2FA questions.
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
        '🔒 Cannot read 2FA status — you are not logged in.',
        '',
        '   Sign up with: `create a new account with email <you@example.com> and password <pw>`.',
        '   Log in with:  `log in with email <you@example.com> and password <pw>`.',
        '   Or, for an agent-owned wallet, set `WAAP_EMAIL` / `WAAP_PASSWORD` in the agent secrets to log in automatically (keeps the password out of chat).'
      ].join('\n')
      const liveOk = await emitLiveText(runtime, message, richText)
      const callbackText = liveOk
        ? '🔒 Cannot read 2FA — wallet not logged in.'
        : richText
      await callback?.({ text: callbackText, content: { loggedIn: false } })
      return { success: true, text: callbackText, data: { loggedIn: false } }
    }

    try {
      const { method, value } = await svc.get2faStatus()
      const label = METHOD_LABELS[method] ?? method

      if (method === 'disabled') {
        const richText = [
          '⚠️  2FA is currently DISABLED on your wallet.',
          '   Anyone with your password can move funds. Enable it with `enable 2FA via email your-email@example.com` (or telegram / external_wallet) to require approval before signing.'
        ].join('\n')
        // Push the multi-line warning verbatim via the live channel; falls
        // back to inlining it in the callback when the host has no live
        // handler. Terse callback text keeps `\n` out of conversation memory.
        const liveOk = await emitLiveText(runtime, message, richText)
        const callbackText = liveOk ? '⚠️  2FA is DISABLED.' : richText
        await callback?.({ text: callbackText, content: { method } })
        return { success: true, text: callbackText, data: { method } }
      }

      // Include the registered destination (email / chat ID / phone / wallet)
      // when the backend exposes it, so the user can confirm WHICH address is
      // protecting the account — not just the method. Single-line on purpose
      // (keeps `\n` out of conversation memory).
      const text = value
        ? `🔐 2FA is enabled via ${label} — ${value}.`
        : `🔐 2FA is enabled via ${label}.`
      await callback?.({
        text,
        content: { method, ...(value ? { value } : {}) }
      })
      return {
        success: true,
        text,
        data: { method, ...(value ? { value } : {}) }
      }
    } catch (err) {
      const error = err as Error
      // Route through summarizeViemError so unreachable-backend failures
      // ("fetch failed", ECONN*, getaddrinfo) get the shared multi-line
      // network-error remediation instead of an opaque one-liner.
      const text = `Failed to check 2FA status: ${summarizeViemError(
        error.message
      )}`
      await callback?.({ text })

      return { success: false, text, error }
    }
  },

  examples: [
    [
      { name: '{{user}}', content: { text: 'What is my 2FA status?' } },
      {
        name: '{{agent}}',
        content: {
          text: "I'll check your current 2FA settings.",
          thought:
            "User wants to know their 2FA status. I'll use WAAP_2FA_STATUS to check.",
          actions: ['WAAP_2FA_STATUS']
        }
      }
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'Is two-factor authentication enabled?' }
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Let me check your 2FA configuration.',
          thought:
            "User is asking about their 2FA setup. I'll check with WAAP_2FA_STATUS.",
          actions: ['WAAP_2FA_STATUS']
        }
      }
    ],
    // The 2FA destination (which email/number/wallet) is a wallet fact too —
    // it must come from this action, NEVER recalled from an earlier turn where
    // the user typed it while enabling 2FA.
    [
      { name: '{{user}}', content: { text: "what's my 2FA email?" } },
      {
        name: '{{agent}}',
        content: {
          text: 'Let me look up the email your 2FA is set to.',
          thought:
            "User wants the registered 2FA destination, not just whether it's on. That value comes from WAAP_2FA_STATUS (which returns the method AND the bound email/number/wallet) — I must NOT answer from the address they typed earlier when enabling 2FA; conversation memory is not authoritative for wallet facts.",
          actions: ['WAAP_2FA_STATUS']
        }
      }
    ]
  ]
}
