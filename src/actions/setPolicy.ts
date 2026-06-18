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
  getWaapService,
  getWaapServiceRaw,
  rejectNoService,
  summarizeViemError
} from './actionUtils'
import { renderEvent } from './eventRendering'
import { extractSetPolicyParams } from './paramExtraction'

export const setPolicyAction: Action = {
  name: 'WAAP_SET_POLICY',
  similes: [
    'SET_POLICY',
    'SET_SPEND_LIMIT',
    'UPDATE_WALLET_POLICY',
    'CHANGE_DAILY_LIMIT'
  ],
  description:
    'Update the wallet\'s spending policy (daily spend limit in USD). Policy changes are signed by the wallet and may emit an awaiting_2fa event. DESTRUCTIVE — only dispatch this action when the most recent user message is an unambiguous explicit instruction to change the limit (e.g. "set my daily limit to $500", "raise my spend cap to 2k"). Do NOT dispatch in response to status questions like "what is my limit?" or "what is my spending policy?". Do NOT dispatch in the same turn that you ask the user to confirm the new value — wait for their explicit "yes, set it" reply first. NARRATION RESTRAINT: keep your accompanying REPLY brief (e.g. "On it."). Do NOT mention 2FA, email, Telegram, approval channels, or any predicted outcome — the plugin emits an awaiting_2fa event automatically if 2FA actually fires, and predicting it upfront produces misleading copy when the action fails before reaching 2FA.',

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    // Stay available pre-login — handler emits "please log in first" via
    // rejectNoService(). Otherwise the LLM picks a generic chat reply on
    // policy-change asks and silently no-ops.
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

    const params = await extractSetPolicyParams(runtime, message, state)

    if (!params.ok) {
      // Schema rejects when no spend-limit number was extracted or when it
      // exceeds the $0–$10,000 range. Friendly re-ask instead of raw zod.
      const text =
        'What daily spend limit (in USD)? Reply with a number, for example ' +
        '`set my daily spend limit to $500`. Allowed range: $0–$10,000.'
      await callback?.({ text })

      return {
        success: false,
        text,
        error: new Error(`Invalid policy update: ${params.error}`)
      }
    }

    // No pre-action preview — it goes stale on signing/2FA failures and
    // visually drowns out the actual error. The attempted limit is shown in
    // BOTH the success and error text below so the user always sees what
    // was tried, regardless of outcome.
    //
    // No preemptive 2FA copy either — the renderEvent/awaiting_2fa path
    // surfaces the prompt only when the wallet's policy actually requires
    // one. Predictive 2FA narration would also be wrong on pre-flight
    // failures.

    try {
      // setPolicy() applies the change AND re-reads the policy from the
      // backend, returning the server-confirmed state. Report THAT value, not
      // the requested one — if the backend clamps or normalizes the limit,
      // echoing the input would misreport what was actually applied. Falls
      // back to the requested value only if the refresh somehow omits it.
      const updated = await svc.setPolicy(params.value, {
        onEvent: async (event) => {
          const rendered = renderEvent(event, 'set-policy')
          if (!rendered) return
          await emitLiveText(runtime, message, rendered)
        }
      })

      const confirmed =
        updated.dailySpendLimitUsd ?? params.value.dailySpendLimitUsd
      const text = `✅ Daily spend limit set to $${confirmed}.`
      await callback?.({
        text,
        content: { dailySpendLimitUsd: confirmed }
      })

      return {
        success: true,
        text,
        data: { dailySpendLimitUsd: confirmed }
      }
    } catch (err) {
      const error = err as Error
      const text = [
        `❌ Set policy failed: ${summarizeViemError(error.message)}`,
        '',
        `Tried: daily spend limit $${params.value.dailySpendLimitUsd} USD.`
      ].join('\n')
      await callback?.({ text })

      return { success: false, text, error }
    }
  },

  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'Set my daily spend limit to $500' }
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll update your daily spend limit to $500.",
          thought:
            'Policy mutations are signed by the wallet itself. WAAP_SET_POLICY handles 2FA on its own — I should NOT preemptively tell the user to approve a 2FA request; the plugin will surface an approval prompt only if one is actually triggered.',
          actions: ['WAAP_SET_POLICY']
        }
      }
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'Lower my wallet limit to 1000 dollars' }
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll set your daily spend limit to $1000.",
          thought:
            'Lowering the limit is a security tightening operation — still goes through the same signed-policy flow as raising it. WAAP_SET_POLICY accepts dailySpendLimitUsd in the 0–10000 range.',
          actions: ['WAAP_SET_POLICY']
        }
      }
    ],
    // Negative example — DO NOT dispatch WAAP_SET_POLICY on status queries.
    // Per the system prompt's ROUTING RULE, "what's my spend limit?" ALWAYS
    // dispatches WAAP_GET_POLICY so the chat shows the live limit from a
    // fresh action card — `actions: []` would let the LLM guess from
    // conversation memory, and the limit can change between turns.
    [
      { name: '{{user}}', content: { text: 'what is my spend limit?' } },
      {
        name: '{{agent}}',
        content: {
          text: 'Pulling your current spend limit. Let me know if you want to change it.',
          thought:
            'Status question. The system prompt\'s ROUTING RULE says ALWAYS dispatch WAAP_GET_POLICY for spend-limit questions — never guess from conversation memory. Crucially, do NOT dispatch WAAP_SET_POLICY: the user asked what the limit is, not to change it. Wait for an explicit "set my limit to $X" instruction before invoking the set action.',
          actions: ['WAAP_GET_POLICY']
        }
      }
    ]
  ]
}
