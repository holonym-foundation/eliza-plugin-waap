//
// Returns the wallet's spending policy (daily spend limit + 2FA gate)
// through the action callback. The limit is a single value, but we still
// route through an action so the user gets a consistent action card and
// the LLM has no chance to guess a stale number from conversation history.

import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback
} from '@elizaos/core'

import { emitLiveText, getWaapServiceRaw } from './actionUtils'

export const getPolicyAction: Action = {
  name: 'WAAP_GET_POLICY',
  similes: [
    'GET_POLICY',
    'GET_SPEND_LIMIT',
    'CHECK_SPEND_LIMIT',
    'CHECK_LIMIT',
    'MY_LIMIT',
    'MY_SPEND_LIMIT',
    'MY_DAILY_LIMIT',
    'WHAT_IS_MY_LIMIT',
    'SPENDING_LIMIT',
    'DAILY_LIMIT',
    'SHOW_POLICY',
    'SHOW_LIMIT',
    'SPEND_CAP'
  ],
  description:
    'Show the WaaP wallet\'s current spending policy — daily spend limit (USD) and which 2FA method gates signing. Read-only — no auth required to dispatch. ALWAYS dispatch this when the user asks any of: "what\'s my limit?", "what\'s my daily spend limit?", "my spend cap", "show my policy", "how much can I send per day?", or any close variant — INCLUDING when the limit was already mentioned earlier in the conversation. Do NOT pick NONE or compose the answer free-form from conversation history; the limit can change between turns (set-policy may have been dispatched, the wallet\'s policy may have been edited via the CLI). The handler has a not-logged-in branch that emits sign-up / log-in instructions.',

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
        '🔒 No spending policy — you are not logged in.',
        '',
        '   Sign up with: `create a new account with email <you@example.com> and password <pw>`.',
        '   Log in with:  `log in with email <you@example.com> and password <pw>`.',
        '   Or, for an agent-owned wallet, set `WAAP_EMAIL` / `WAAP_PASSWORD` in the agent secrets to log in automatically (keeps the password out of chat).'
      ].join('\n')
      const liveOk = await emitLiveText(runtime, message, richText)
      const callbackText = liveOk
        ? '🔒 No spending policy — wallet not logged in.'
        : richText
      await callback?.({ text: callbackText, content: { loggedIn: false } })
      return { success: true, text: callbackText, data: { loggedIn: false } }
    }

    const policy = svc.getPolicy()
    const limitText =
      policy.dailySpendLimitUsd != null
        ? `$${policy.dailySpendLimitUsd}/day`
        : 'not set'
    // Mirror the CLI `policy get`, which reports `minRiskFor2FA` (the risk
    // level at/above which 2FA is required) alongside the limit and method —
    // showing "not set" when the backend hasn't configured it. Omitting it
    // (as before) silently trimmed a real policy field from the user's view.
    const minRiskText = policy.minRiskFor2fa ?? 'not set'

    // Three lines: limit + 2FA method + min-risk threshold. Single live bubble
    // so it renders cleanly; terse callback text keeps newlines out of
    // conversation memory (matches the rest of the read-only actions' pattern).
    const richText = [
      '🛡️  Spending policy:',
      `- Daily spend limit: ${limitText}`,
      `- 2FA method: ${policy.authorizationMethod}`,
      `- Min. risk for 2FA: ${minRiskText}`
    ].join('\n')

    const liveOk = await emitLiveText(runtime, message, richText)
    const callbackText = liveOk ? '🛡️  Spending policy sent.' : richText

    await callback?.({
      text: callbackText,
      content: {
        dailySpendLimitUsd: policy.dailySpendLimitUsd ?? null,
        authorizationMethod: policy.authorizationMethod,
        minRiskFor2fa: policy.minRiskFor2fa ?? null
      }
    })

    return {
      success: true,
      text: callbackText,
      data: {
        dailySpendLimitUsd: policy.dailySpendLimitUsd ?? null,
        authorizationMethod: policy.authorizationMethod,
        minRiskFor2fa: policy.minRiskFor2fa ?? null
      }
    }
  },

  examples: [
    [
      { name: '{{user}}', content: { text: "what's my daily spend limit?" } },
      {
        name: '{{agent}}',
        content: {
          text: 'Pulling your spending policy.',
          thought:
            'Spend-limit question. Even if the limit was mentioned earlier in this conversation, dispatch WAAP_GET_POLICY — the limit can change between turns (set-policy in another tab, CLI edit). Never guess from history.',
          actions: ['WAAP_GET_POLICY']
        }
      }
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'how much can I send per day?' }
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Checking your daily spend limit.',
          thought:
            'Daily-cap question. Dispatch WAAP_GET_POLICY for a fresh, grounded answer.',
          actions: ['WAAP_GET_POLICY']
        }
      }
    ]
  ]
}
