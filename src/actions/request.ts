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
import { extractRequestParams } from './paramExtraction'

// WAAP_REQUEST is a READ-ONLY passthrough. Default-deny: only well-known read
// methods are allowed. State-changing / signing methods (eth_sendTransaction,
// eth_sendRawTransaction, eth_sign, personal_sign, eth_signTypedData*,
// eth_signTransaction, wallet_*) must go through the dedicated, 2FA-gated
// actions — never this passthrough. Compared case-insensitively.
const READ_ONLY_RPC_METHODS = new Set([
  'eth_blocknumber',
  'eth_chainid',
  'eth_gasprice',
  'eth_feehistory',
  'eth_maxpriorityfeepergas',
  'eth_getbalance',
  'eth_getcode',
  'eth_getstorageat',
  'eth_gettransactioncount',
  'eth_call',
  'eth_estimategas',
  'eth_getblockbyhash',
  'eth_getblockbynumber',
  'eth_getblocktransactioncountbyhash',
  'eth_getblocktransactioncountbynumber',
  'eth_gettransactionbyhash',
  'eth_gettransactionbyblockhashandindex',
  'eth_gettransactionbyblocknumberandindex',
  'eth_gettransactionreceipt',
  'eth_getlogs',
  'eth_getproof',
  'eth_syncing',
  'eth_protocolversion',
  'eth_accounts',
  'net_version',
  'net_listening',
  'net_peercount',
  'web3_clientversion'
])

export const requestAction: Action = {
  name: 'WAAP_REQUEST',
  similes: ['RPC_REQUEST', 'EIP1193_REQUEST', 'JSON_RPC', 'ETH_CALL'],
  description:
    'Perform a generic EIP-1193 JSON-RPC request through the WaaP wallet. EVM only — not available on Sui. Use this ONLY for standard read-only chain queries (e.g. eth_blockNumber, eth_chainId, eth_getBalance, eth_getTransactionReceipt, eth_call, eth_estimateGas, eth_gasPrice, eth_getCode, eth_getLogs). Do NOT use this to log in, sign up, sign messages, send transactions, or change wallet state — those have dedicated WAAP_LOGIN, WAAP_SIGNUP, WAAP_SIGN_MESSAGE, WAAP_SEND_TX, etc. actions. There is no eth_login, eth_signup, or similar auth RPC method — never fabricate one.',

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    // Stay available pre-login; both not-logged-in and not-on-EVM rejections
    // are produced inside the handler so the user gets a clear message
    // instead of a silent no-op.
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
        'JSON-RPC requests are only available on EVM chains. Switch to an EVM chain first.'
      await callback?.({ text })
      return { success: false, text, error: new Error(text) }
    }

    const params = await extractRequestParams(runtime, message, state)

    if (!params.ok) {
      // Schema rejects when the user didn't name a JSON-RPC method, or the
      // method/param shape failed validation. Friendly re-ask instead of
      // raw zod text.
      const text =
        'Which JSON-RPC method? Reply with the method name plus any params it ' +
        'needs — for example `eth_blockNumber`, `eth_chainId`, or ' +
        '`eth_getBalance ["0xYourAddress","latest"]`. Note: this is EVM-only.'
      await callback?.({ text })

      return {
        success: false,
        text,
        error: new Error(`Invalid RPC request: ${params.error}`)
      }
    }

    if (!READ_ONLY_RPC_METHODS.has(params.value.method.toLowerCase())) {
      const text =
        `\`${params.value.method}\` isn't a read-only JSON-RPC method, so I won't run it through ` +
        'WAAP_REQUEST. Use WAAP_SEND_TX to send, WAAP_SIGN_TX / WAAP_SIGN_MESSAGE / ' +
        'WAAP_SIGN_TYPED_DATA to sign, or WAAP_LOGIN / WAAP_SIGNUP to authenticate.'
      await callback?.({ text })
      return {
        success: false,
        text,
        error: new Error(
          `RPC method not allowed on read-only passthrough: ${params.value.method}`
        )
      }
    }

    try {
      const result = await svc.request({
        method: params.value.method,
        params: params.value.params,
        chainId: params.value.chainId,
        rpc: params.value.rpc
      })

      const dataStr =
        typeof result.data === 'object'
          ? JSON.stringify(result.data, null, 2)
          : String(result.data)

      const richText = [`RPC result for ${params.value.method}:`, dataStr].join(
        '\n'
      )

      // Push the (possibly multi-line, JSON-pretty-printed) result via the
      // live channel so the user sees real newlines verbatim. The terse
      // callback text keeps `\n` out of conversation memory so the LLM
      // doesn't echo escape sequences in follow-up summaries.
      const liveOk = await emitLiveText(runtime, message, richText)
      const callbackText = liveOk
        ? `RPC ${params.value.method} returned.`
        : richText

      await callback?.({
        text: callbackText,
        content: { method: params.value.method, data: result.data }
      })

      return {
        success: true,
        text: callbackText,
        data: { method: params.value.method, result: result.data }
      }
    } catch (err) {
      const error = err as Error
      const text = `❌ RPC request \`${
        params.value.method
      }\` failed: ${summarizeViemError(error.message)}`
      await callback?.({ text })

      return { success: false, text, error }
    }
  },

  examples: [
    [
      {
        name: '{{user}}',
        content: { text: 'What is the current block number?' }
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll check the current block number for you.",
          thought:
            "User wants the latest block number. I'll use WAAP_REQUEST with eth_blockNumber.",
          actions: ['WAAP_REQUEST']
        }
      }
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'Get the transaction receipt for 0xabc123' }
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll fetch that transaction receipt.",
          thought:
            "User wants a tx receipt. I'll use WAAP_REQUEST with eth_getTransactionReceipt.",
          actions: ['WAAP_REQUEST']
        }
      }
    ]
  ]
}
