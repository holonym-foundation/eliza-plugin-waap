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
import { extractSignMessageParams } from './paramExtraction'

export const signMessageAction: Action = {
  name: 'WAAP_SIGN_MESSAGE',
  similes: ['SIGN_MESSAGE', 'PERSONAL_SIGN', 'EIP191_SIGN'],
  description:
    "Sign an arbitrary message with the WaaP wallet. Uses EIP-191 (personal_sign) on EVM chains and native signing on Sui. Most messages sign immediately without 2FA — DO NOT tell the user to approve a 2FA request preemptively. The plugin will surface a 2FA prompt automatically only when the wallet's policy actually requires one.",

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    // Stay available pre-login — handler emits "please log in first" via
    // rejectNoService(). Otherwise the LLM picks a generic chat reply on
    // "sign this message" and silently no-ops.
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

    const params = await extractSignMessageParams(runtime, message, state)

    if (!params.ok) {
      // Schema rejects when no extractable message string is in the user
      // text (empty or > 65536 chars). Friendly re-ask shows the format we
      // expect — quoted plain text or a 0x-hex string — without dumping the
      // raw zod error to chat.
      const text =
        'What message would you like to sign? Reply with the text in quotes, like ' +
        '`sign "hello world"`, or paste a 0x-prefixed hex string for raw-bytes signing.'
      await callback?.({ text })

      return {
        success: false,
        text,
        error: new Error(`Invalid message details: ${params.error}`)
      }
    }

    try {
      const result = await svc.signMessage(params.value, {
        onEvent: async (event) => {
          const rendered = renderEvent(event, 'sign-message')
          if (!rendered) return
          await emitLiveText(runtime, message, rendered)
        }
      })

      const richLines = ['✅ Message signed.', `Signature: ${result.signature}`]
      // Sui sign-message also returns the signed message bytes (base64).
      if (result.bytes) richLines.push(`Bytes: ${result.bytes}`)
      const richText = richLines.join('\n')

      const content = {
        signature: result.signature,
        ...(result.bytes ? { bytes: result.bytes } : {})
      }

      // Push the multi-line summary verbatim via the live channel; the
      // terse callback text keeps newlines out of conversation memory so
      // the LLM doesn't echo `\n` literally in follow-up summaries.
      const liveOk = await emitLiveText(runtime, message, richText)
      const callbackText = liveOk ? '✅ Message signed.' : richText
      await callback?.({ text: callbackText, content })

      return {
        success: true,
        text: callbackText,
        data: content
      }
    } catch (err) {
      const error = err as Error
      const text = `❌ Sign message failed: ${summarizeViemError(
        error.message
      )}`
      await callback?.({ text })

      return { success: false, text, error }
    }
  },

  examples: [
    [
      { name: '{{user}}', content: { text: "Sign the message 'hello'" } },
      {
        name: '{{agent}}',
        content: {
          text: "I'll sign that message with your WaaP wallet now.",
          thought:
            "User wants to sign an arbitrary message via EIP-191 personal_sign. I'll route through WAAP_SIGN_MESSAGE — the wallet will produce a recoverable signature.",
          actions: ['WAAP_SIGN_MESSAGE']
        }
      }
    ],
    [
      {
        name: '{{user}}',
        content: { text: "Sign 'I authorize the transfer of funds'" }
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll sign that message now.",
          thought:
            'Authorization-style message. WAAP_SIGN_MESSAGE handles policy/2FA on its own — I should NOT preemptively tell the user to approve a 2FA request. The plugin will surface an approval prompt only if one is actually triggered.',
          actions: ['WAAP_SIGN_MESSAGE']
        }
      }
    ],
    [
      {
        name: '{{user}}',
        content: { text: "Sign 'hello world' on Sui" }
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll sign that message with your Sui wallet.",
          thought:
            'User wants to sign a message on Sui. WAAP_SIGN_MESSAGE supports both EVM and Sui signing.',
          actions: ['WAAP_SIGN_MESSAGE']
        }
      }
    ],
    // Negative example — DO NOT dispatch on capability questions. The user is
    // asking whether signing is supported, not asking us to sign anything.
    [
      {
        name: '{{user}}',
        content: { text: 'can you sign arbitrary messages?' }
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Yes — I can sign any string with your WaaP wallet using EIP-191 personal_sign on EVM, or native signing on Sui. Tell me the message you want signed.',
          thought:
            'Capability question — answer in plain text. I should NOT dispatch WAAP_SIGN_MESSAGE; without a concrete message string the param extractor would fail. Wait for an explicit instruction containing the message to sign before invoking the action.',
          actions: []
        }
      }
    ]
  ]
}
