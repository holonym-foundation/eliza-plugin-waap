//
// Returns a comprehensive snapshot of the wallet (login state, both addresses,
// active chain, 2FA method, daily spend limit, pending 2FA) in a single
// multi-line bubble. Routes "what's my wallet status?" / "summary" / "show me
// everything" / "am I logged in?" through the action callback so the chat
// renders real newlines instead of the LLM emitting `\n` as escape characters
// in a free-form REPLY.
//
// This is the broader companion to WAAP_GET_ADDRESS — same rationale, more
// fields. No CLI call: every fact comes from in-memory state, so this is a
// pure read.

import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback
} from '@elizaos/core'

import { emitLiveText, getWaapServiceRaw, rejectNoService } from './actionUtils'

export const walletStatusAction: Action = {
  name: 'WAAP_WALLET_STATUS',
  similes: [
    'WALLET_STATUS',
    'WALLET_INFO',
    'WALLET_SUMMARY',
    'SHOW_WALLET',
    'AM_I_LOGGED_IN',
    'LOGIN_STATUS',
    'CONNECTION_STATUS',
    'SHOW_EVERYTHING',
    'WHO_AM_I',
    'WALLET_OVERVIEW',
    'MY_WALLET',
    'WALLET_DETAILS',
    'PENDING_2FA',
    'PENDING_AUTHZ',
    'WHAT_IS_PENDING',
    'MY_POLICY',
    'SPENDING_POLICY'
  ],
  description:
    'Show a complete snapshot of the WaaP wallet — login status, EVM and Sui addresses, active chain, 2FA method, daily spend limit, and any pending 2FA approval. Read-only — no 2FA. ALWAYS dispatch this when the user asks any of: "what\'s my wallet status?", "am I logged in?", "show me everything", "summary", "wallet info", or any variant — INCLUDING when the wallet is not logged in AND when an earlier turn in the conversation already implied the answer. Do NOT pick NONE just because you think you already know whether the user is logged in; the user expects the answer to come from this action\'s card. The handler has a not-logged-in branch that emits clean sign-up / log-in instructions. Routing through the action also ensures the multi-line snapshot renders with real Markdown line breaks instead of literal `\\n` escapes. NARRATION RESTRAINT: keep your accompanying REPLY terse (e.g. "Pulling your wallet status now.") and do NOT include the wallet facts in the REPLY — the action emits them.',

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    // Stay available pre-login — handler still works (emits "not logged in"
    // status verbatim) so the user can see the actual state instead of the
    // action being silently invalid.
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
      return rejectNoService(callback)
    }

    if (!svc.isReady()) {
      // Show the not-logged-in state explicitly via the action callback so
      // the chat renders the prompt cleanly (rather than letting the LLM
      // re-narrate the provider's "not logged in" line with `\n` escapes).
      const richText = [
        '🔒 WaaP wallet status: **not logged in**.',
        '',
        '   Sign up with: `create a new account with email <you@example.com> and password <pw>`.',
        '   Log in with:  `log in with email <you@example.com> and password <pw>`.',
        '   Or, for an agent-owned wallet, set `WAAP_EMAIL` / `WAAP_PASSWORD` in the agent secrets to log in automatically (keeps the password out of chat).'
      ].join('\n')
      const liveOk = await emitLiveText(runtime, message, richText)
      const callbackText = liveOk
        ? '🔒 Wallet status: not logged in.'
        : richText
      await callback?.({ text: callbackText, content: { loggedIn: false } })
      return { success: true, text: callbackText, data: { loggedIn: false } }
    }

    const s = svc.getState()
    const pending = svc.getPendingAuthz()

    const limitLine =
      s.policy.dailySpendLimitUsd != null
        ? `- Daily spend limit: $${s.policy.dailySpendLimitUsd}/day`
        : '- Daily spend limit: not set'

    const lines = ['🟢 WaaP wallet status: **logged in**.']
    if (s.evmAddress) lines.push(`- EVM address: ${s.evmAddress}`)
    if (s.suiAddress) lines.push(`- Sui address: ${s.suiAddress}`)
    lines.push(
      `- Active chain: ${s.chainState.canonical}`,
      `- 2FA method: ${s.policy.authorizationMethod}`,
      limitLine,
      // Keep the snapshot consistent with WAAP_GET_POLICY, which also reports
      // the risk threshold at/above which 2FA is required ("not set" when the
      // backend hasn't configured it).
      `- Min. risk for 2FA: ${s.policy.minRiskFor2fa ?? 'not set'}`
    )
    if (pending) {
      const ageMin = Math.max(
        1,
        Math.round((Date.now() - pending.startedAt) / 60_000)
      )
      lines.push(
        `- Pending 2FA: ${pending.kind} via ${
          pending.method ?? 'approval'
        } (${ageMin} min ago)`
      )
    }

    const richText = lines.join('\n')
    const liveOk = await emitLiveText(runtime, message, richText)
    const callbackText = liveOk ? '🟢 Wallet status sent.' : richText

    const content = {
      loggedIn: true,
      evmAddress: s.evmAddress,
      suiAddress: s.suiAddress,
      chain: s.chainState.canonical,
      twoFaMethod: s.policy.authorizationMethod,
      dailySpendLimitUsd: s.policy.dailySpendLimitUsd ?? null,
      minRiskFor2fa: s.policy.minRiskFor2fa ?? null,
      pendingAuthz: pending
        ? { kind: pending.kind, method: pending.method }
        : null
    }
    await callback?.({ text: callbackText, content })

    return { success: true, text: callbackText, data: content }
  },

  examples: [
    [
      { name: '{{user}}', content: { text: "what's my wallet status?" } },
      {
        name: '{{agent}}',
        content: {
          text: 'Pulling your wallet status now.',
          thought:
            "User wants a wallet snapshot. I'll dispatch WAAP_WALLET_STATUS — routing through the action ensures the multi-line summary renders with real newlines.",
          actions: ['WAAP_WALLET_STATUS']
        }
      }
    ],
    [
      { name: '{{user}}', content: { text: 'am I logged in?' } },
      {
        name: '{{agent}}',
        content: {
          text: 'Checking your wallet status.',
          thought:
            'Login-status question. WAAP_WALLET_STATUS surfaces the login state in a clean action bubble — preferred over reading the provider and re-narrating it free-form.',
          actions: ['WAAP_WALLET_STATUS']
        }
      }
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'show me everything about my wallet' }
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Here is your wallet summary.',
          thought:
            "User wants the full snapshot. WAAP_WALLET_STATUS includes addresses, chain, 2FA, limit, pending — all in one bubble. I won't include the values in my REPLY; the action emits them.",
          actions: ['WAAP_WALLET_STATUS']
        }
      }
    ],
    // The user asked "am I logged in?" earlier in the same conversation
    // and we already replied. They asked again. This MUST still dispatch —
    // login state can change between turns (whoami completes, session
    // expires, login/logout via CLI), and the LLM has no way to know
    // without a fresh action call. Free-form replies based on conversation
    // memory have produced false "not logged in" answers when the provider
    // actually says "logged in". Always re-dispatch.
    [
      { name: '{{user}}', content: { text: 'am I logged in?' } },
      {
        name: '{{agent}}',
        content: {
          text: 'Checking your wallet status.',
          thought:
            'Login-state question — even if I answered the same question two turns ago, I do NOT trust conversation memory for this. The provider is the source of truth and it can flip between turns (whoami completion, session refresh, CLI login). Dispatch WAAP_WALLET_STATUS so the user sees a fresh action card with the actual current state.',
          actions: ['WAAP_WALLET_STATUS']
        }
      }
    ],
    // Same pattern, different phrasing — pin so similar wordings route here.
    [
      {
        name: '{{user}}',
        content: { text: 'is my wallet connected?' }
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Checking your wallet status.',
          thought:
            "Connection-state question. Don't free-form an answer based on what I think the state is; dispatch WAAP_WALLET_STATUS for a grounded action-card answer.",
          actions: ['WAAP_WALLET_STATUS']
        }
      }
    ]
  ]
}
