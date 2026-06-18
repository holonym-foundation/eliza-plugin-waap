import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback
} from '@elizaos/core'

import {
  channelForMethod,
  dispatchAuthzGatedAction,
  getWaapService,
  getWaapServiceRaw,
  rejectNoService,
  summarizeViemError
} from './actionUtils'
import { extractEnable2faParams } from './paramExtraction'

// NOTE: `phone` is NOT an enable-able method here — the plugin cannot manage
// phone 2FA (see the note on enable2faSchema). It stays on the read/display
// side only. Do not add it back to these maps.
const METHOD_LABELS: Record<string, string> = {
  email: 'Email',
  telegram: 'Telegram',
  external_wallet: 'External Wallet'
}

/** Map a method to the user-facing description of the credential it needs. */
const REQUIRED_CREDENTIAL_HINT: Record<string, string> = {
  email: 'an email address (e.g. "enable 2FA via email you@example.com")',
  telegram:
    'a Telegram chat ID (e.g. "enable 2FA via telegram chat ID 7381029636")',
  external_wallet:
    'a hardware-wallet EVM address (e.g. "enable 2FA via external wallet 0x1234567890abcdef1234567890abcdef12345678")'
}

export const enable2faAction: Action = {
  name: 'WAAP_ENABLE_2FA',
  similes: [
    'SETUP_2FA',
    'ENABLE_TWO_FACTOR',
    'TURN_ON_2FA',
    'ADD_2FA',
    'SET_UP_2FA',
    'ACTIVATE_2FA',
    'ENABLE_MFA',
    'SETUP_TWO_FACTOR_AUTH'
  ],
  description:
    'Enable two-factor authentication (2FA) on the WaaP wallet. Supports THREE methods, each requiring a specific credential value: (1) email + email address, (2) telegram + Telegram chat ID, (3) external_wallet + EVM hardware-wallet address. Phone 2FA is NOT supported by this plugin — never offer it. If 2FA is already enabled, the change is gated by the existing method (2-step flow); otherwise 1-step. ALWAYS requires an external approval — an approval request is sent to the user\'s 2FA channel and they have up to 5 minutes to complete it. The action does NOT block on that wait: it returns its own approval instructions immediately and the change applies in the background. DESTRUCTIVE — only dispatch this action when the most recent user message is an unambiguous explicit instruction to enable 2FA AND specifies BOTH the method AND the credential value (e.g. "enable 2FA via email agent@gmail.com", "set up 2FA with telegram chat ID 12345", "use my hardware wallet 0xabc... for 2FA"). Do NOT dispatch when the user has only said "enable 2FA" (no method), or "enable 2FA via email" (method without value), or "do I have 2FA?" (status question). In each of those cases reply asking for the missing piece(s) and wait for the next user turn before dispatching. NARRATION REQUIREMENT: the action ITSELF posts the full approval instructions the moment it runs (which channel to check, whether it is a 1-step or 2-step change, and how to confirm), so keep your accompanying REPLY SHORT and do NOT repeat those instructions — e.g. "On it — setting up email 2FA now." (name the method the user actually chose). Do NOT predict success.',

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    // Stay available pre-login — handler emits "please log in first" via
    // rejectNoService(). Otherwise the LLM picks a generic chat reply on
    // "enable 2FA" and silently no-ops.
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

    const params = await extractEnable2faParams(runtime, message, state)

    if (!params.ok) {
      // The schema's refine() already produces a method-specific message
      // when the user supplied a method but not the value. Re-frame it as a
      // friendly prompt so the agent re-asks instead of just echoing
      // "Invalid 2FA setup details: ..." to the user.
      // Count method keyword hits in the error message. The refine() error
      // for "method without value" includes exactly one keyword; the enum-
      // violation error (no method picked at all) lists all four. Only pick
      // a specific hint when exactly one keyword appears — otherwise fall
      // back to the generic "ask for both" prompt below.
      const lower = params.error.toLowerCase()
      const matches: Array<keyof typeof REQUIRED_CREDENTIAL_HINT> = []
      if (lower.includes('email')) matches.push('email')
      if (lower.includes('telegram')) matches.push('telegram')
      if (lower.includes('wallet')) matches.push('external_wallet')
      const guessedMethod = matches.length === 1 ? matches[0] : undefined

      const friendly = guessedMethod
        ? `I can enable 2FA, but I still need ${REQUIRED_CREDENTIAL_HINT[guessedMethod]}. Please reply with that and I'll set it up.`
        : `I can enable 2FA — which method would you like (email, Telegram, or external hardware wallet)? Please include the corresponding value (email address / chat ID / wallet address).`

      await callback?.({ text: friendly })
      return {
        success: false,
        text: friendly,
        error: new Error(`Invalid 2FA setup details: ${params.error}`)
      }
    }

    const label = METHOD_LABELS[params.value.method] ?? params.value.method

    // Determine whether the change is a 2-step flow (existing method active →
    // approve current + verify new) or a 1-step flow (no current method →
    // verify new only). The CLI's banner explicitly says "2FA method change
    // requires up to 2 confirmations when an existing method is active" —
    // mirror that distinction so the user knows where they are in the flow.
    let priorMethod: string | undefined
    try {
      const status = await svc.get2faStatus()
      priorMethod = status.method
    } catch {
      // If status read fails, fall back to single-step labeling — better than
      // labeling something "Step 1/2" when we don't actually know how many.
      priorMethod = undefined
    }
    const willHavePriorApproval =
      priorMethod !== undefined && priorMethod !== 'disabled'

    // No pre-action preview — it goes stale on signing/2FA failures (an
    // existing 2FA approval rejected, a malformed email, etc.) and visually
    // drowns out the actual error. The chosen method is shown in BOTH the
    // success and error text below.

    // Deterministic instruction shown the moment the approval prompt is out —
    // self-contained because it's the only message guaranteed to reach the web
    // UI. Composed here from known params (no LLM, no live channel).
    const newChannel = channelForMethod(params.value.method)
    const pendingText = willHavePriorApproval
      ? `🔐 Enabling ${label} 2FA — this is a 2-step change, so you'll receive TWO approval requests. Approve BOTH: first authorize the change via your current ${priorMethod} 2FA, then verify the new ${label} method. Once you've approved both, ask me "is 2FA on?" and I'll confirm. (Or say "cancel my pending 2FA" to abort.)`
      : `🔐 Enabling ${label} 2FA — check ${newChannel} and approve the verification request. Once approved, ask me "is 2FA on?" and I'll confirm. (Or say "cancel my pending 2FA" to abort.)`

    // Non-blocking: returns the instruction above as soon as the approval
    // prompt is out (so it reaches the web UI, which only sees a callback at
    // handler-return). The CLI keeps running in the background to apply the
    // change; the user confirms with a 2FA-status read. See
    // dispatchAuthzGatedAction for why blocking can't work on the web UI.
    const out = await dispatchAuthzGatedAction({
      runtime,
      message,
      svc,
      ctx: 'enable2fa',
      pendingText,
      awaitingPrefix: (authzCount) =>
        willHavePriorApproval
          ? authzCount === 1
            ? `🔐 Step 1/2 — approve this change via your current 2FA method (${priorMethod})`
            : '🔐 Step 2/2 — verify your new 2FA method'
          : '🔐 Verify your new 2FA method',
      run: (progress) =>
        svc.enable2fa(
          {
            method: params.value.method,
            email: params.value.email,
            telegramChatId: params.value.telegramChatId,
            walletAddress: params.value.walletAddress
          },
          progress
        ),
      successText: (result) =>
        `✅ 2FA enabled via ${METHOD_LABELS[result.method] ?? result.method}.`,
      errorText: (error) =>
        `❌ Failed to enable 2FA via ${label}: ${summarizeViemError(
          error.message
        )}`,
      successData: (result) => ({ method: result.method })
    })

    // Empty text means the helper suppressed the result (the session changed
    // mid-wait, or the op was aborted by logout / cancel) — stay silent so it
    // can't surface in the wrong session.
    if (out.text) {
      await callback?.({
        text: out.text,
        ...(out.data ? { content: out.data } : {})
      })
    }

    return {
      success: out.success,
      text: out.text,
      ...(out.data ? { data: out.data } : {}),
      ...(out.error ? { error: out.error } : {})
    }
  },

  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'Enable 2FA with my email agent@example.com' }
      },
      {
        name: '{{agent}}',
        content: {
          text: 'On it — setting up email 2FA now.',
          thought:
            'User wants email 2FA with a concrete address. The action posts its own approval instructions (which channel to check and how to confirm) the moment it runs, so I keep my REPLY short and do not repeat them.',
          actions: ['WAAP_ENABLE_2FA']
        }
      }
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'Set up telegram 2FA with chat ID 7381029636' }
      },
      {
        name: '{{agent}}',
        content: {
          text: 'On it — setting up Telegram 2FA now.',
          thought:
            'User wants telegram 2FA with a specific chat ID. The action posts its own approval instructions when it runs, so I keep my REPLY short rather than repeating them.',
          actions: ['WAAP_ENABLE_2FA']
        }
      }
    ],
    // Negative example — phone 2FA is NOT supported by this plugin. Do NOT
    // dispatch; explain and offer the supported methods instead.
    [
      {
        name: '{{user}}',
        content: { text: 'Enable phone 2FA on +15551234567' }
      },
      {
        name: '{{agent}}',
        content: {
          text: "Phone 2FA isn't supported by this wallet. I can set up 2FA via email, Telegram, or an external hardware wallet — which would you like?",
          thought:
            'User asked for phone 2FA, which this plugin cannot manage (it would break the session on the next login). I must NOT dispatch WAAP_ENABLE_2FA with phone; instead explain it is unsupported and offer email / telegram / external_wallet.',
          actions: []
        }
      }
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'Use my hardware wallet 0xabcdef0123456789abcdef0123456789abcdef01 for 2FA'
        }
      },
      {
        name: '{{agent}}',
        content: {
          text: 'On it — setting up external-wallet 2FA now.',
          thought:
            'User wants external_wallet 2FA with a specific EVM hardware-wallet address. The action posts its own approval instructions when it runs, so I keep my REPLY short.',
          actions: ['WAAP_ENABLE_2FA']
        }
      }
    ],
    // Positive example — 2-step flow when an existing method is active. Provider
    // shows current 2FA method = email; user is switching to Telegram. REPLY must
    // walk through both steps explicitly so the user knows to approve the change
    // via the existing email channel FIRST, then verify the new Telegram method.
    [
      {
        name: '{{user}}',
        content: { text: 'Switch my 2FA to telegram chat ID 7381029636' }
      },
      {
        name: '{{agent}}',
        content: {
          text: 'On it — switching your 2FA to Telegram now.',
          thought:
            'Provider shows current 2FA method = email and the user is switching to telegram — a 2-step change. The action itself posts the full instructions (including that this is a 2-step change needing TWO approvals and how to confirm), so I keep my REPLY short rather than duplicating them.',
          actions: ['WAAP_ENABLE_2FA']
        }
      }
    ],
    // Negative example — method specified but credential value MISSING. The
    // CLI requires both for every method (email + address, telegram + chat ID,
    // external_wallet + 0x address); without the value
    // the schema's refine() rejects and the action falls back to a friendly
    // re-ask. Better to never dispatch in the first place.
    [
      { name: '{{user}}', content: { text: 'enable 2FA via email' } },
      {
        name: '{{agent}}',
        content: {
          text: "Sure — what email address should I use? Reply with the address (for example: 'enable 2FA via email you@example.com') and I'll set it up.",
          thought:
            'User picked email as the 2FA method but did NOT include the email address. WAAP_ENABLE_2FA requires BOTH method AND value. I must NOT dispatch this turn — reply asking for the email address and wait for the next user message.',
          actions: ['REPLY']
        }
      }
    ],
    [
      { name: '{{user}}', content: { text: 'How can I enable 2FA?' } },
      {
        name: '{{agent}}',
        content: {
          text: 'I can enable 2FA for you! Which method would you like — email, Telegram, or external hardware wallet? Please include the corresponding value (email address, Telegram chat ID, or wallet address).',
          thought:
            'User wants to enable 2FA but has not specified a method or value. I should ask which method they prefer AND for the matching credential — DO NOT dispatch WAAP_ENABLE_2FA in this turn because I do not yet have either piece.',
          actions: []
        }
      }
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'I want to add two-factor authentication to my wallet'
        }
      },
      {
        name: '{{agent}}',
        content: {
          text: 'I can set up 2FA for your wallet. Which method would you like — email, Telegram, or external hardware wallet? And please share the matching value (email address / chat ID / wallet address).',
          thought:
            'User wants to set up 2FA but has not chosen a method or supplied a credential. I should ask for both, and ONLY dispatch WAAP_ENABLE_2FA in a later turn once they reply with the concrete method + credential.',
          actions: []
        }
      }
    ],
    // Negative example — DO NOT dispatch on status / advice queries.
    [
      { name: '{{user}}', content: { text: 'do I have 2FA enabled?' } },
      {
        name: '{{agent}}',
        content: {
          text: "I'll check your 2FA status now.",
          thought:
            "Status question — the user wants to know whether 2FA is configured, NOT to enable it. Read the live state by dispatching WAAP_2FA_STATUS; do NOT dispatch WAAP_ENABLE_2FA, and do NOT hardcode 'enabled' or 'disabled' — that fact must come from the action result, never from priors.",
          actions: ['WAAP_2FA_STATUS']
        }
      }
    ]
  ]
}
