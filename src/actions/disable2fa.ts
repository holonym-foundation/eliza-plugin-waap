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

export const disable2faAction: Action = {
  name: 'WAAP_DISABLE_2FA',
  similes: [
    'TURN_OFF_2FA',
    'REMOVE_2FA',
    'DISABLE_TWO_FACTOR',
    'DEACTIVATE_2FA',
    'DISABLE_MFA',
    'REMOVE_TWO_FACTOR_AUTH'
  ],
  description:
    'Disable two-factor authentication (2FA) on the WaaP wallet. ALWAYS requires an external approval via the CURRENTLY-CONFIGURED method (the one being disabled) — the user has up to 5 minutes to complete it. The action does NOT block on that wait: it returns its own approval instructions immediately and the change applies in the background. DESTRUCTIVE — only dispatch this action when the most recent user message is an unambiguous explicit instruction to disable 2FA (e.g. "disable 2FA", "turn off 2FA", "remove my 2FA"). Do NOT dispatch in response to status questions like "is 2FA on?" or "do I have 2FA?". Do NOT dispatch in the same turn that you ask the user to confirm — wait for their explicit "yes, disable it" reply first. NARRATION REQUIREMENT: the action ITSELF posts the approval instructions the moment it runs (which channel to check and how to confirm), so keep your accompanying REPLY SHORT and do NOT repeat them — e.g. "On it — disabling 2FA now." If the provider context already shows 2FA is `disabled`, do NOT dispatch — the handler will short-circuit, but it is more honest to answer in plain text that there is nothing to disable.',

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    // Stay available pre-login — handler emits "please log in first" via
    // rejectNoService(). Otherwise the LLM picks a generic chat reply on
    // "disable 2FA" and silently no-ops.
    return !!getWaapServiceRaw(runtime)
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const svc = getWaapService(runtime)

    if (!svc) {
      return rejectNoService(callback)
    }

    // Check current status first. Guard the read — if the backend is
    // unreachable this would otherwise throw out of the handler with no
    // user-facing message (enable2fa guards the same call).
    let status
    try {
      status = await svc.get2faStatus()
    } catch (err) {
      const text = `Couldn't read your 2FA status: ${summarizeViemError(
        (err as Error).message
      )}`
      await callback?.({ text })
      return { success: false, text, error: err as Error }
    }
    const { method } = status

    if (method === 'disabled') {
      const text = '2FA is already disabled on your wallet.'
      await callback?.({ text })

      return { success: true, text, data: { method: 'disabled' } }
    }

    // No pre-action preview — it goes stale on signing/2FA failures (the
    // current-method approval rejected, network issue, etc.) and visually
    // drowns out the actual error. The current method is shown in the error
    // path below where it's most useful for the user.

    // Non-blocking: returns the instruction below as soon as the approval
    // prompt is out (the only message guaranteed to reach the web UI). The CLI
    // keeps running in the background to apply the change; the user confirms
    // with a 2FA-status read. See dispatchAuthzGatedAction.
    const out = await dispatchAuthzGatedAction({
      runtime,
      message,
      svc,
      ctx: 'disable2fa',
      pendingText: `🔓 Disabling 2FA — check ${channelForMethod(
        method
      )} and approve the request. Once approved, ask me "is 2FA on?" and I'll confirm. (Or say "cancel my pending 2FA" to abort.)`,
      awaitingPrefix: () =>
        '🔐 Approve disabling 2FA via your current 2FA method',
      run: (progress) => svc.disable2fa(progress),
      successText: () => '✅ 2FA has been disabled on your wallet.',
      errorText: (error) =>
        [
          `❌ Failed to disable 2FA: ${summarizeViemError(error.message)}`,
          '',
          `(Current method: ${method}.)`
        ].join('\n'),
      successData: () => ({ method: 'disabled' })
    })

    // Empty text means the helper suppressed the result (session changed
    // mid-wait, or aborted by logout / cancel) — stay silent.
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
      { name: '{{user}}', content: { text: 'Disable 2FA on my wallet' } },
      {
        name: '{{agent}}',
        content: {
          text: 'On it — disabling 2FA now.',
          thought:
            'User explicitly asked to disable 2FA. The action posts its own approval instructions (which channel to approve via and how to confirm) when it runs, so I keep my REPLY short rather than repeating them.',
          actions: ['WAAP_DISABLE_2FA']
        }
      }
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'Turn off two-factor authentication' }
      },
      {
        name: '{{agent}}',
        content: {
          text: 'On it — disabling 2FA now.',
          thought:
            'User explicitly asked to turn off two-factor auth. The action posts its own approval instructions when it runs, so I keep my REPLY short rather than repeating where to approve.',
          actions: ['WAAP_DISABLE_2FA']
        }
      }
    ],
    // Negative example — DO NOT dispatch on status queries. The user is
    // asking whether 2FA is on, not asking to turn it off.
    [
      { name: '{{user}}', content: { text: 'is 2FA on?' } },
      {
        name: '{{agent}}',
        content: {
          text: "I'll check your 2FA status now.",
          thought:
            'Status question — the user wants to know whether 2FA is enabled, NOT to disable it. Read the live state by dispatching WAAP_2FA_STATUS; do NOT dispatch WAAP_DISABLE_2FA, and do NOT hardcode an enabled/disabled answer or a method label — those must come from the action result.',
          actions: ['WAAP_2FA_STATUS']
        }
      }
    ]
  ]
}
