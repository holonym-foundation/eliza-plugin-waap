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
import { extractSignTxParams } from './paramExtraction'

export const signTxAction: Action = {
  name: 'WAAP_SIGN_TX',
  similes: ['SIGN_TRANSACTION_ONLY', 'SIGN_WITHOUT_BROADCAST'],
  description:
    'Sign a transaction without broadcasting it. Supports EVM chains and Sui networks. Returns the raw signed transaction hex. Useful for multisig workflows, batching, or offline signing. May emit an awaiting_2fa event if the wallet\'s policy requires approval. DESTRUCTIVE — only dispatch this action when the most recent user message is an unambiguous explicit instruction to sign a specific transaction (e.g. "sign a tx to 0x... for 0.1 ETH"). Do NOT dispatch in response to questions about signing capabilities or workflow. Do NOT dispatch in the same turn that you ask the user to confirm — wait for their explicit "yes, sign it" reply first. NARRATION RESTRAINT: keep your accompanying REPLY brief (e.g. "On it."). Do NOT mention 2FA, email, Telegram, approval channels, or predict success/failure — the action emits its own preview, awaiting_2fa, and result events; predictive narration is wrong on pre-flight failures or when 2FA is not required.',

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    // Stay available pre-login — handler emits "please log in first" via
    // rejectNoService(). Otherwise the LLM picks a generic chat reply on
    // "sign this tx" and silently no-ops.
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

    // Chain/currency mismatch guard — same shape as WAAP_SEND_TX. Without
    // this, a user on Sui who says "sign a tx for 0.001 ETH..." would get
    // their amount silently re-cast as MIST and we'd build a Sui tx.
    const userText = (message.content?.text ?? '').toLowerCase()
    const evmCurrency =
      /\b(eth|ether|matic|bnb|avax|arb|op|usdc|usdt|dai|weth)\b/i.test(userText)
    const suiCurrency = /\b(sui|mist)\b/i.test(userText)
    const chainState = svc.getChainState()

    if (chainState.family === 'sui' && evmCurrency && !suiCurrency) {
      const text =
        `You're currently on \`${chainState.canonical}\` (Sui), but your message ` +
        'mentions an EVM asset (ETH/MATIC/BNB/etc.). To sign an EVM tx, switch chains first ' +
        '("switch to ethereum", "switch to polygon", or "switch to base"). ' +
        'To sign a Sui tx on this chain, restate the amount in SUI or MIST.'
      await callback?.({ text })
      return {
        success: false,
        text,
        error: new Error(
          `chain/currency mismatch: active chain is ${chainState.canonical} but message mentions EVM asset`
        )
      }
    }

    if (chainState.family === 'evm' && suiCurrency && !evmCurrency) {
      const text =
        `You're currently on \`${chainState.canonical}\` (EVM), but your message ` +
        'mentions a Sui asset (SUI/MIST). To sign a Sui tx, switch chains first ' +
        '("switch to sui mainnet" or "switch to sui testnet"). ' +
        "To sign an EVM tx on this chain, restate the amount in ETH (or this chain's native asset)."
      await callback?.({ text })
      return {
        success: false,
        text,
        error: new Error(
          `chain/currency mismatch: active chain is ${chainState.canonical} but message mentions Sui asset`
        )
      }
    }

    const params = await extractSignTxParams(runtime, message, state)

    if (!params.ok) {
      // The schema rejects when `to` is missing or malformed. Sign-tx allows
      // `value` to default to 0, so the only mandatory user-supplied field
      // is the recipient. Friendly re-ask instead of raw zod error.
      const text =
        'I need at minimum the recipient address. Reply like ' +
        '`sign a tx to 0x1234567890abcdef1234567890abcdef12345678 for 0.1 ETH on Polygon (no broadcast)` ' +
        "(the address must be the full 40 hex characters) and I'll sign it without broadcasting."
      await callback?.({ text })

      return {
        success: false,
        text,
        error: new Error(`Invalid transaction details: ${params.error}`)
      }
    }

    const unit = chainState.family === 'sui' ? 'MIST' : 'ETH'

    // Per-chain sanity guards the shared (family-agnostic) zod schema can't
    // express: a wrong-length recipient, and fractional Sui MIST. Catch them
    // before signing.
    const to = params.value.to
    const addrOk =
      chainState.family === 'sui'
        ? /^0x[0-9a-fA-F]{64}$/.test(to)
        : /^0x[0-9a-fA-F]{40}$/.test(to)
    if (!addrOk) {
      const want =
        chainState.family === 'sui'
          ? '64 hex characters (Sui)'
          : '40 hex characters (EVM)'
      const text =
        `That recipient address isn't valid for \`${chainState.canonical}\` — ` +
        `it must be ${want}. Double-check the address and resend.`
      await callback?.({ text })
      return {
        success: false,
        text,
        error: new Error(
          `recipient address length mismatch for ${chainState.family}: ${to}`
        )
      }
    }
    if (
      chainState.family === 'sui' &&
      params.value.value &&
      !/^\d+$/.test(params.value.value)
    ) {
      const text =
        'On Sui, amounts are in MIST — whole numbers only ' +
        '(1 SUI = 1,000,000,000 MIST). ' +
        `\`${params.value.value}\` is not a whole number, so I won't sign it. ` +
        'Restate the amount as an integer MIST value.'
      await callback?.({ text })
      return {
        success: false,
        text,
        error: new Error(
          `fractional MIST value rejected: ${params.value.value}`
        )
      }
    }

    // No pre-action preview here — it goes stale on pre-flight failures and
    // visually drowns out the actual error. The attempted parameters are
    // included in BOTH the success and error output below.
    //
    // No preemptive 2FA copy either — renderEvent surfaces the prompt on the
    // actual `awaiting_2fa` CLI event so we don't mislead the user when the
    // wallet's policy doesn't require 2FA for this signature.

    const valueLine = params.value.value
      ? ` for ${params.value.value} ${unit}`
      : ''

    try {
      const result = await svc.signTx(
        {
          to: params.value.to,
          value: params.value.value,
          chainId: params.value.chainId,
          rpc: params.value.rpc,
          data: params.value.data,
          legacy: params.value.legacy
          // permissionToken intentionally not forwarded from chat — the service
          // sources it from operator settings (lookupPermissionToken).
        },
        {
          onEvent: async (e) => {
            const line = renderEvent(e, 'sign-tx')
            if (!line) return
            await emitLiveText(runtime, message, line)
          }
        }
      )

      const richLines = [
        `✅ Transaction signed${valueLine} on ${chainState.canonical} (not broadcast).`,
        `- To: ${params.value.to}`,
        `- From: ${result.address}`
      ]
      // EVM yields a raw signed tx hex; Sui yields a signature + serialized
      // tx bytes (base64). Render whichever the chain produced.
      if (result.signedTx)
        richLines.push(`- Signed tx: ${result.signedTx.slice(0, 66)}...`)
      if (result.signature) richLines.push(`- Signature: ${result.signature}`)
      if (result.txBytes)
        richLines.push(`- Tx bytes: ${result.txBytes.slice(0, 66)}...`)
      const richText = richLines.join('\n')

      const content = {
        signedTx: result.signedTx,
        address: result.address,
        ...(result.signature ? { signature: result.signature } : {}),
        ...(result.txBytes ? { txBytes: result.txBytes } : {})
      }

      // Push the multi-line summary verbatim via the live channel; the
      // terse callback text keeps newlines out of conversation memory so
      // the LLM doesn't re-emit them as literal `\n` in follow-ups.
      const liveOk = await emitLiveText(runtime, message, richText)
      const callbackText = liveOk
        ? `✅ Transaction signed on ${chainState.canonical} (not broadcast).`
        : richText

      await callback?.({ text: callbackText, content })

      return {
        success: true,
        text: callbackText,
        data: content
      }
    } catch (err) {
      const error = err as Error
      // Reason on line 1 so even a truncated chat bubble shows it.
      const text = [
        `❌ Sign transaction failed: ${summarizeViemError(error.message)}`,
        '',
        'Tried:',
        `- To: ${params.value.to}${valueLine}`,
        `- Chain: ${chainState.canonical}`
      ].join('\n')
      await callback?.({ text })

      return { success: false, text, error }
    }
  },

  examples: [
    [
      {
        name: '{{user}}',
        content: {
          text: "Sign a transaction to 0x1234567890abcdef1234567890abcdef12345678 for 0.1 ETH on Polygon but don't broadcast it"
        }
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll sign that transaction without broadcasting it.",
          thought:
            "User wants to sign a tx without sending. I'll use WAAP_SIGN_TX which calls sign-tx (no broadcast).",
          actions: ['WAAP_SIGN_TX']
        }
      }
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: "Sign a transaction for me, I'll broadcast it myself"
        }
      },
      {
        name: '{{agent}}',
        content: {
          text: "Happy to — I'll sign locally and return the raw signed hex for you to broadcast. Tell me the recipient address, amount, and which chain.",
          thought:
            "User wants sign-only with no broadcast but hasn't supplied any transaction details (no recipient, amount, or chain). I must NOT dispatch WAAP_SIGN_TX this turn — reply asking for to/value/chain and wait for the next user message before dispatching.",
          actions: ['REPLY']
        }
      }
    ],
    // Negative example — DO NOT dispatch on capability questions.
    [
      {
        name: '{{user}}',
        content: {
          text: 'can you sign transactions without broadcasting them?'
        }
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Yes — I can sign a transaction with your WaaP wallet and return the raw signed hex without broadcasting it. Tell me the recipient, amount, and chain when you want me to do it.',
          thought:
            'Capability question — answer in plain text. I should NOT dispatch WAAP_SIGN_TX. Wait for an explicit instruction with concrete tx details before invoking the action.',
          actions: []
        }
      }
    ]
  ]
}
