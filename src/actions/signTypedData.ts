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
import { extractSignTypedDataParams } from './paramExtraction'

export const signTypedDataAction: Action = {
  name: 'WAAP_SIGN_TYPED_DATA',
  similes: ['SIGN_TYPED_DATA', 'EIP712_SIGN', 'STRUCTURED_SIGN'],
  description:
    'Sign EIP-712 structured data with the WaaP wallet. EVM only — not available on Sui. May emit an awaiting_2fa event if the wallet\'s policy requires approval. NARRATION RESTRAINT: keep your accompanying REPLY brief (e.g. "On it."). Do NOT mention 2FA, email, Telegram, approval channels, or predict success/failure — the action emits its own awaiting_2fa and result events; predictive narration is wrong when 2FA is not required for this signature.',

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    // Stay available pre-login. Both the not-logged-in and not-on-EVM
    // rejections are produced inside the handler so the user always gets
    // a clear message instead of a silent no-op.
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

    if (svc.getChainFamily() !== 'evm') {
      const text =
        'EIP-712 typed data signing is only available on EVM chains. Switch to an EVM chain first.'
      await callback?.({ text })
      return { success: false, text, error: new Error(text) }
    }

    const params = await extractSignTypedDataParams(runtime, message, state)

    if (!params.ok) {
      // Extractor uses a regex to find a JSON object in the user text
      // (LLM round-tripping is unreliable for nested EIP-712 structure).
      // When it can't find one — or the JSON doesn't match the EIP-712
      // shape — we re-ask with a concrete example instead of the raw error.
      const text =
        'I need the EIP-712 typed data as a JSON object. Paste the full payload ' +
        '(with `types`, `domain`, `primaryType`, and `message` fields) in your next ' +
        "message and I'll sign it. EIP-712 is EVM-only — make sure your wallet is on an EVM chain."
      await callback?.({ text })

      return {
        success: false,
        text,
        error: new Error(`Invalid typed data: ${params.error}`)
      }
    }

    // EIP-712 domain-chain guard. Signing typed data scoped to a *different*
    // chain than the wallet is on is a classic approval-phishing vector
    // (e.g. a Permit for a chain the user didn't mean to authorize). Refuse on
    // mismatch. (getChainState is only read when a domain.chainId is present.)
    const domain = (params.value.data?.domain ?? {}) as Record<string, unknown>
    if (domain.chainId !== undefined && domain.chainId !== null) {
      const domainChainId = Number(domain.chainId as never)
      const activeChainId = Number(
        (svc.getChainState() as { chainId?: number }).chainId
      )
      if (
        Number.isFinite(domainChainId) &&
        Number.isFinite(activeChainId) &&
        domainChainId !== activeChainId
      ) {
        const text =
          `This typed data is scoped to chain ${domainChainId}, but your wallet is on ` +
          `chain ${activeChainId}. I won't sign it — switch to chain ${domainChainId} first ` +
          'if this is intentional.'
        await callback?.({ text })
        return {
          success: false,
          text,
          error: new Error(
            `EIP-712 domain.chainId ${domainChainId} != active chain ${activeChainId}`
          )
        }
      }
    }

    try {
      const result = await svc.signTypedData(params.value, {
        onEvent: async (event) => {
          const rendered = renderEvent(event, 'sign-typed-data')
          if (!rendered) return
          await emitLiveText(runtime, message, rendered)
        }
      })

      // Surface WHAT was authorized (type + verifying contract) so the user
      // can see it, not just a bare "signed" confirmation.
      const primaryType = params.value.data?.primaryType
      const verifyingContract = domain.verifyingContract
      const richText = [
        '✅ Typed data signed.',
        primaryType ? `Type: ${primaryType}` : null,
        verifyingContract ? `Contract: ${verifyingContract}` : null,
        `Signature: ${result.signature}`
      ]
        .filter(Boolean)
        .join('\n')

      // Push the multi-line summary verbatim via the live channel; the
      // terse callback text keeps newlines out of conversation memory so
      // the LLM doesn't echo `\n` literally in follow-up summaries.
      const liveOk = await emitLiveText(runtime, message, richText)
      const callbackText = liveOk ? '✅ Typed data signed.' : richText
      await callback?.({
        text: callbackText,
        content: { signature: result.signature }
      })

      return {
        success: true,
        text: callbackText,
        data: { signature: result.signature }
      }
    } catch (err) {
      const error = err as Error
      const text = `❌ Sign typed data failed: ${summarizeViemError(
        error.message
      )}`
      await callback?.({ text })

      return { success: false, text, error }
    }
  },

  examples: [
    [
      {
        name: '{{user}}',
        content: {
          text: 'Sign this EIP-712 payload: {"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"chainId","type":"uint256"}],"Greeting":[{"name":"text","type":"string"}]},"domain":{"name":"Demo","chainId":1},"primaryType":"Greeting","message":{"text":"hello"}}'
        }
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll sign that EIP-712 structured data with your WaaP wallet now.",
          thought:
            "User pasted a complete EIP-712 typed-data JSON payload (types, domain, primaryType, message). WAAP_SIGN_TYPED_DATA extracts the JSON blob from the message text via a bracket-depth scanner (LLM round-tripping is unreliable for nested structured data) and validates the EIP-712 shape before signing. I should only dispatch when the user's message actually contains the JSON — if they just say 'sign typed data' with no payload, I must reply asking for the JSON instead.",
          actions: ['WAAP_SIGN_TYPED_DATA']
        }
      }
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'Sign typed data for a Permit2 approval' }
      },
      {
        name: '{{agent}}',
        content: {
          text: "Happy to sign a Permit2 EIP-712 approval. Paste the typed-data JSON (must include `types`, `domain`, `primaryType`, and `message`) and I'll sign it.",
          thought:
            "User wants a Permit2 EIP-712 signature but hasn't pasted the typed-data JSON in this message. WAAP_SIGN_TYPED_DATA needs the actual JSON in the user's text — without it the regex extractor will fail. I must NOT dispatch WAAP_SIGN_TYPED_DATA this turn; reply asking for the JSON blob and wait for the next message before dispatching.",
          actions: ['REPLY']
        }
      }
    ]
  ]
}
