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
  rejectNoService
} from './actionUtils'

const KIND_LABELS: Record<string, string> = {
  'send-tx': 'transaction',
  'sign-tx': 'transaction signature',
  'sign-message': 'message signature',
  'sign-typed-data': 'typed-data signature',
  'set-policy': 'policy change',
  'enable-2fa': '2FA enable',
  'disable-2fa': '2FA disable'
}

export const cancel2faAction: Action = {
  name: 'WAAP_CANCEL_2FA',
  similes: [
    'CANCEL_2FA',
    'CANCEL_PENDING_2FA',
    'CANCEL_APPROVAL',
    'ABORT_2FA',
    'STOP_PENDING_TRANSACTION',
    'CANCEL_PENDING_TRANSACTION'
  ],
  description:
    'Cancel an in-flight 2FA approval that is still waiting for the user to approve via email/Telegram. Use this when the user says "cancel my pending 2FA", "abort the previous transaction", "I do not want to approve that", or wants to start over after a stale approval prompt is blocking new actions.',

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    // Stay available pre-login — handler is a no-op when nothing is pending,
    // and emits a clear "no pending 2FA" or "please log in first" message
    // instead of silently dropping the action.
    return !!getWaapServiceRaw(runtime)
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const svc = getWaapService(runtime)

    if (!svc) {
      return rejectNoService(callback)
    }

    const cancelled = svc.cancelPendingAuthz()

    if (!cancelled) {
      const text = 'No pending 2FA approval to cancel.'
      await callback?.({ text, content: { cancelled: false } })
      return { success: true, text, data: { cancelled: false } }
    }

    const label = KIND_LABELS[cancelled.kind] ?? cancelled.kind
    const ageMs = Date.now() - cancelled.startedAt
    const ageMin = Math.max(1, Math.round(ageMs / 60_000))
    const text =
      `Cancelled the pending ${label} (was awaiting 2FA approval for ${ageMin} min). ` +
      `You can now start a new request.`

    await callback?.({
      text,
      content: {
        cancelled: true,
        kind: cancelled.kind,
        method: cancelled.method,
        ageMs
      }
    })

    return {
      success: true,
      text,
      data: {
        cancelled: true,
        kind: cancelled.kind,
        method: cancelled.method
      }
    }
  },

  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'cancel my pending 2FA approval' }
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll cancel the pending 2FA approval so you can start fresh.",
          thought:
            "User wants to abort the in-flight 2FA approval. I'll route through WAAP_CANCEL_2FA which aborts the CLI subprocess and clears local state.",
          actions: ['WAAP_CANCEL_2FA']
        }
      }
    ],
    [
      {
        name: '{{user}}',
        content: { text: "abort that, I don't want to approve it" }
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Cancelling the pending request now.',
          thought:
            'User is rejecting the previous action. WAAP_CANCEL_2FA will cancel any in-flight 2FA-requiring operation.',
          actions: ['WAAP_CANCEL_2FA']
        }
      }
    ]
  ]
}
