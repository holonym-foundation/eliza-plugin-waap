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
import { extractSendTxParams } from './paramExtraction'

export const sendTxAction: Action = {
  name: 'WAAP_SEND_TX',
  similes: [
    'SEND_TRANSACTION',
    'SEND_ETH',
    'SEND_TOKENS',
    'TRANSFER',
    'SEND_FUNDS'
  ],
  description:
    'Send a transaction from the WaaP wallet. Supports EVM chains and Sui networks. May emit an awaiting_2fa event if the wallet\'s policy requires approval. DESTRUCTIVE — only dispatch this action when the most recent user message is an unambiguous explicit instruction to send funds (e.g. "send 0.1 ETH to 0x...", "transfer 10 USDC to alice.eth"). Do NOT dispatch in response to status questions like "can I send X?" or "what would it cost to send X?". Do NOT dispatch in the same turn that you ask the user to confirm the transaction details — wait for their explicit "yes, send it" reply first. NARRATION RESTRAINT: keep your accompanying REPLY brief (e.g. "On it."). Do NOT mention 2FA, email, Telegram, approval channels, gas costs, or predict success/failure — the action emits its own preview, awaiting_2fa, and result events; predicting them upfront is wrong on pre-flight failures (insufficient funds, gas-estimation reverts) or when 2FA is not required.',

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    // Stay available even pre-login; the handler emits a clear "please log
    // in first" via rejectNoService(). Otherwise the LLM picks a generic
    // chat reply on "send eth to ..." and silently no-ops.
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

    // Chain/currency mismatch guard. The user can be on Sui and say
    // "send 0.001 ETH" — without this guard the LLM extractor would convert
    // their amount into MIST as if they meant SUI, and we'd silently send
    // Sui tokens. Refuse and ask them to switch chains first instead.
    const userText = (message.content?.text ?? '').toLowerCase()
    const evmCurrency =
      /\b(eth|ether|matic|bnb|avax|arb|op|usdc|usdt|dai|weth)\b/i.test(userText)
    const suiCurrency = /\b(sui|mist)\b/i.test(userText)
    const chainState = svc.getChainState()

    if (chainState.family === 'sui' && evmCurrency && !suiCurrency) {
      const text =
        `You're currently on \`${chainState.canonical}\` (Sui), but your message ` +
        'mentions an EVM asset (ETH/MATIC/BNB/etc.). To send EVM funds, switch chains first ' +
        '("switch to ethereum", "switch to polygon", or "switch to base"). ' +
        'To send Sui funds on this chain, restate the amount in SUI or MIST.'
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
        'mentions a Sui asset (SUI/MIST). To send Sui funds, switch chains first ' +
        '("switch to sui mainnet" or "switch to sui testnet"). ' +
        "To send native funds on this EVM chain, restate the amount in ETH (or this chain's native asset)."
      await callback?.({ text })
      return {
        success: false,
        text,
        error: new Error(
          `chain/currency mismatch: active chain is ${chainState.canonical} but message mentions Sui asset`
        )
      }
    }

    const params = await extractSendTxParams(
      runtime,
      message,
      state,
      svc.getChainState()
    )

    if (!params.ok) {
      // The Zod schema rejects when `to` or `value` is missing or malformed.
      // Surface a friendly re-ask instead of the raw error so the user knows
      // what to provide. Detail still goes into the returned error for logs.
      const text =
        'I need at minimum the recipient address and amount. Reply like ' +
        '`send 0.01 ETH to 0x1234567890abcdef1234567890abcdef12345678 on Polygon` ' +
        "(the address must be the full 40 hex characters) and I'll prepare the transaction."
      await callback?.({ text })

      return {
        success: false,
        text,
        error: new Error(`Invalid transaction details: ${params.error}`)
      }
    }

    const unit = chainState.family === 'sui' ? 'MIST' : 'ETH'

    // Per-chain sanity guards the shared zod schema can't express (it is
    // family-agnostic: `to` accepts 40- or 64-hex, `value` accepts decimals).
    // Catch a wrong-length recipient and fractional Sui MIST *before* an
    // irreversible send.
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
    if (chainState.family === 'sui' && !/^\d+$/.test(params.value.value)) {
      const text =
        'On Sui, amounts are in MIST — whole numbers only ' +
        '(1 SUI = 1,000,000,000 MIST). ' +
        `\`${params.value.value}\` is not a whole number, so I won't send it. ` +
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

    // No pre-action "Transaction details" preview here — it goes stale on
    // pre-flight failures (insufficient funds, gas-estimation reverts) and
    // visually drowns out the actual error. The attempted parameters are
    // included in BOTH the success and the error output below so the user
    // always sees what was tried, regardless of outcome.
    //
    // Likewise: do NOT announce "Waiting for 2FA approval" preemptively —
    // 2FA is only required when policy demands it (risk score, spend limits)
    // and is skipped on cheap pre-flight failures. The `awaiting_2fa` CLI
    // event drives the actual prompt via renderEvent below.

    try {
      const result = await svc.sendTx(params.value, {
        onEvent: async (event) => {
          const rendered = renderEvent(event, 'send-tx')
          if (!rendered) return
          await emitLiveText(runtime, message, rendered)
        }
      })

      const txId = result.txHash ?? '(unknown)'
      const richText = [
        '✅ Transaction sent.',
        `- To: ${params.value.to}`,
        `- Value: ${params.value.value} ${unit}`,
        `- Chain: ${chainState.canonical}`,
        `- From: ${result.from}`,
        `- Tx hash: ${txId}`
      ].join('\n')

      // Push the multi-line summary verbatim via the live channel; the
      // terse callback text keeps newlines out of conversation memory so
      // the LLM doesn't re-emit them as literal `\n` in follow-ups.
      const liveOk = await emitLiveText(runtime, message, richText)
      const callbackText = liveOk
        ? `✅ Transaction sent on ${chainState.canonical}: ${txId}`
        : richText

      await callback?.({
        text: callbackText,
        content: { txHash: result.txHash, from: result.from }
      })

      return {
        success: true,
        text: callbackText,
        data: { txHash: result.txHash, from: result.from }
      }
    } catch (err) {
      const error = err as Error
      // Lead with the human-readable reason on line 1 so even a truncated
      // chat bubble (or one collapsed inside an action card) still shows
      // the actionable info. Attempted params follow as a "Tried:" block.
      const text = [
        `❌ Transaction failed: ${summarizeViemError(error.message)}`,
        '',
        'Tried:',
        `- To: ${params.value.to}`,
        `- Value: ${params.value.value} ${unit}`,
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
          text: 'Send 0.01 ETH to 0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead on mainnet'
        }
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll send 0.01 ETH to that address on Ethereum mainnet now.",
          thought:
            "User wants to transfer ETH from the WaaP wallet on chainId 1. I'll use WAAP_SEND_TX with the parsed recipient and amount.",
          actions: ['WAAP_SEND_TX']
        }
      }
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'Transfer 0.5 MATIC on Polygon to 0xabcdef0123456789abcdef0123456789abcdef01'
        }
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll prepare that Polygon transfer now.",
          thought:
            "User wants to transfer 0.5 native MATIC on Polygon (chainId 137) to a complete 40-char address. I'll route through WAAP_SEND_TX. The plugin will surface a 2FA approval prompt automatically if the wallet's policy actually requires one — I should NOT preemptively tell the user to approve. Note: WAAP_SEND_TX moves the chain's NATIVE asset only (ETH, MATIC, BNB, etc.); ERC-20 token transfers like USDC/USDT require explicit ABI-encoded calldata in `data` — without that, the action would silently send the wrong asset. If the user asks for an ERC-20 transfer, ask for the token contract and amount and prepare the transfer calldata before dispatching.",
          actions: ['WAAP_SEND_TX']
        }
      }
    ],
    // Negative example — DO NOT dispatch on speculative / status questions.
    // The user is asking whether they can send, not asking us to send. Reply
    // with plain text and wait for an explicit instruction.
    [
      {
        name: '{{user}}',
        content: {
          text: 'can I send 1 ETH to 0xabcdef0123456789abcdef0123456789abcdef01?'
        }
      },
      {
        name: '{{agent}}',
        content: {
          text: "Yes, you can send 1 ETH to that address from this wallet — let me know if you'd like me to go ahead and send it.",
          thought:
            'Speculative question — the user has not yet instructed me to send. I should NOT dispatch WAAP_SEND_TX. Answer in plain text and wait for an explicit "yes, send it" before invoking the action.',
          actions: []
        }
      }
    ]
  ]
}
