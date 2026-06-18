// src/actions/actionUtils.ts
import type {
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory
} from '@elizaos/core'

import type { CliEvent } from '../cliRunner'
import { WaapService } from '../services/WaapService'

import { renderEvent, type CommandContext } from './eventRendering'

/**
 * Returns the WaapService if it exists AND is ready (authenticated).
 * Returns null if the service doesn't exist or isn't logged in.
 * Use this for actions that require an authenticated wallet.
 */
export function getWaapService(runtime: IAgentRuntime): WaapService | null {
  const svc = runtime.getService<WaapService>(WaapService.serviceType)
  if (!svc) return null
  if (!svc.isReady()) return null
  return svc
}

/**
 * Returns the WaapService regardless of ready state.
 * Use this for signup/login actions that operate before authentication.
 */
export function getWaapServiceRaw(runtime: IAgentRuntime): WaapService | null {
  return runtime.getService<WaapService>(WaapService.serviceType) ?? null
}

export async function rejectNoService(
  callback?: HandlerCallback
): Promise<ActionResult> {
  const text = 'WaaP wallet is not logged in. Please sign up or log in first.'
  await callback?.({ text })
  return { success: false, text, error: new Error(text) }
}

/**
 * Push a transient progress message to the chat IMMEDIATELY, bypassing
 * Eliza's action-callback storage buffer.
 *
 * Background: when an action handler is running, the `callback` it receives
 * is a `storageCallback` that pushes into a local array — those messages
 * only flush to the chat AFTER the handler returns (see @elizaos/core's
 * processActions in dist/node/index.node.js). For our authz-gated CLI
 * commands that pause up to 5 minutes waiting on external 2FA approval,
 * that means every "⏳ Approval link sent…" / "Approved — signing…" line
 * we emit during the wait is invisible to the user until the action ends —
 * defeating the entire purpose of streaming progress.
 *
 * `runtime.sendMessageToTarget` invokes whatever per-source send handler
 * the host has registered (Discord, Telegram, web client, etc.) and pushes
 * the message right now. The target's `source` comes from the inbound
 * message; absent that, or absent a registered handler, the call throws
 * and we return `false`.
 *
 * Caller pattern for transient progress lines (awaiting_2fa, broadcasting,
 * approved, etc.):
 *
 *   await emitLiveText(runtime, message, line)
 *
 * Do NOT route progress lines through `callback?.({ text })` as a fallback —
 * those land in `storedCallbackData` and flush at handler end, which means
 * messages like "Approval link sent — I'll wait up to 5 minutes" appear AFTER
 * the action has already finished or been cancelled, looking like stale
 * instructions. The pre-narration in the agent's REPLY (per the character's
 * narration contract for enable_2fa/disable_2fa) is the user-visible signal
 * when Path B is unavailable.
 *
 * Do NOT use this for the FINAL result text either — keep that on
 * `callback?.({ text })` so it lands in conversation memory and the LLM can
 * reference it next turn. Live messages are intentionally NOT persisted:
 * they would otherwise pollute the agent's recent-message context with noise
 * like "🔑 Loading keyshare…" that nobody needs to recall.
 */
let warnedSources: Set<string> | null = null

export async function emitLiveText(
  runtime: IAgentRuntime,
  message: Memory,
  text: string
): Promise<boolean> {
  const source =
    typeof message.content?.source === 'string'
      ? message.content.source
      : undefined
  if (!source) {
    warnLiveTextOnce('<missing-source>', 'message.content.source is not set')
    return false
  }
  try {
    await runtime.sendMessageToTarget(
      {
        source,
        roomId: message.roomId,
        entityId: runtime.agentId
      },
      { text, source: 'waap-live' }
    )
    return true
  } catch (err) {
    warnLiveTextOnce(source, err instanceof Error ? err.message : String(err))
    return false
  }
}

/**
 * Log a single warning per (source, reason) combination so operators learn
 * why live progress isn't streaming on their host without spamming the log
 * for every event in a 5-minute wait. Output is intentionally one line and
 * starts with "[waap]" so it's grep-friendly alongside the service's other
 * lifecycle prints.
 */
function warnLiveTextOnce(source: string, reason: string): void {
  if (!warnedSources) warnedSources = new Set<string>()
  const key = `${source}::${reason}`
  if (warnedSources.has(key)) return
  warnedSources.add(key)
  // eslint-disable-next-line no-console
  console.warn(
    `[waap] live progress unavailable — runtime.sendMessageToTarget failed for source=${source} (${reason}). ` +
      `In-flight progress (and 2FA auto-confirmation) will be silent on this host; the 2FA actions still post their own approval instructions via the action result, and other actions deliver their final result via the action callback. ` +
      'To enable live progress, register a send handler for this source via runtime.registerSendHandler.'
  )
}

/** Minimal surface dispatchAuthzGatedAction needs from the WaapService. */
interface AuthzSessionView {
  getSessionEpoch(): number
  isReady(): boolean
}

export interface AuthzDispatchResult {
  success: boolean
  text: string
  data?: Record<string, unknown>
  error?: Error
}

export interface AuthzDispatchOptions<R> {
  runtime: IAgentRuntime
  message: Memory
  svc: AuthzSessionView
  /** renderEvent context for progress lines (e.g. 'enable2fa'). */
  ctx: CommandContext
  /**
   * Deterministic instruction returned to the user the moment the approval
   * prompt is out — tells them exactly what to approve and how to confirm.
   * This is the ONLY message guaranteed to reach the ElizaOS web UI, so it
   * must be self-contained (channel to check, 1-step vs 2-step, how to
   * confirm / cancel). Composed by the caller from known params, not the LLM.
   */
  pendingText: string
  /** Prefix line for the Nth (1-based) awaiting_2fa prompt — connectors only. */
  awaitingPrefix: (authzCount: number) => string
  /** Runs the gated service op, wiring the provided progress hook. */
  run: (progress: {
    onEvent: (e: CliEvent) => void | Promise<void>
  }) => Promise<R>
  successText: (result: R) => string
  errorText: (err: Error) => string
  successData?: (result: R) => Record<string, unknown>
}

/**
 * Runs a 2FA-gated wallet op WITHOUT blocking the Eliza handler for the full
 * up-to-5-minute approval wait. As soon as the approval prompt is out, it
 * returns `pendingText` — a self-contained instruction (what to approve, how
 * to confirm) — which the caller delivers via callback().
 *
 * Why this shape: the ElizaOS web UI registers NO send handler, so
 * `runtime.sendMessageToTarget` / `emitLiveText` is a silent no-op there
 * (verified: @elizaos/server never calls registerSendHandler; the browser
 * gets agent messages only through the action-callback pipeline, which
 * @elizaos/core flushes AFTER the handler returns). That leaves exactly two
 * facts about the web UI: (1) a callback only appears once the handler
 * returns, and (2) nothing can be pushed afterwards. So the only way to show
 * "check your email" promptly is to RETURN promptly — blocking would pin a
 * Processing spinner for the whole wait with no instruction. We return the
 * instruction immediately; the user approves out-of-band and then confirms
 * with a status read ("is 2FA on?"). The CLI keeps running in the background
 * to apply the change; the single-flight authz gate clears when it finishes.
 *
 * The eventual completion is still emitted via emitLiveText (epoch-guarded) —
 * a no-op on the web UI, but real auto-confirmation on platform connectors
 * (Discord/Telegram) that DO register a send handler. Aborts (logout /
 * explicit cancel → CLI_ABORTED) and post-session-change results are dropped
 * so nothing surfaces in the wrong session.
 *
 * If the op settles BEFORE any awaiting_2fa fires (nothing to approve, or an
 * early validation/network error), the result is surfaced inline instead.
 */
export async function dispatchAuthzGatedAction<R>(
  opts: AuthzDispatchOptions<R>
): Promise<AuthzDispatchResult> {
  const { runtime, message, svc, ctx } = opts
  const epoch = svc.getSessionEpoch()

  let resolveAwaiting!: () => void
  const awaiting = new Promise<void>((r) => {
    resolveAwaiting = r
  })
  let authzCount = 0

  const opPromise = opts.run({
    onEvent: async (e) => {
      if (e.event === 'awaiting_2fa') {
        authzCount++
        if (authzCount === 1) {
          resolveAwaiting()
        } else {
          // Later prompts (2-step switch) — connectors only; no-op on web UI.
          const baseLine = renderEvent(e, ctx)
          const prefix = opts.awaitingPrefix(authzCount)
          const composed =
            prefix && baseLine
              ? `${prefix}\n${baseLine}`
              : prefix || baseLine || ''
          if (composed) await emitLiveText(runtime, message, composed)
        }
        return
      }
      const line = renderEvent(e, ctx)
      if (line) await emitLiveText(runtime, message, line)
    }
  })

  const outcome = await Promise.race([
    awaiting.then(() => 'awaiting' as const),
    opPromise.then(
      () => 'settled' as const,
      () => 'settled' as const
    )
  ])

  if (outcome === 'settled') {
    // Op finished (or failed) before any 2FA prompt — surface inline.
    try {
      const result = await opPromise
      return {
        success: true,
        text: opts.successText(result),
        data: opts.successData?.(result)
      }
    } catch (err) {
      const error = err as Error
      if ((error as { code?: string })?.code === 'CLI_ABORTED') {
        return { success: false, text: '', error, data: { aborted: true } }
      }
      return { success: false, text: opts.errorText(error), error }
    }
  }

  // Approval prompt is out. Best-effort auto-confirmation on connectors with a
  // live channel (no-op on the web UI), epoch-guarded so a result landing
  // after a session change / abort never surfaces in the wrong session.
  void opPromise.then(
    async (result) => {
      if (svc.getSessionEpoch() !== epoch || !svc.isReady()) return
      await emitLiveText(runtime, message, opts.successText(result))
    },
    async (err) => {
      if ((err as { code?: string })?.code === 'CLI_ABORTED') return
      if (svc.getSessionEpoch() !== epoch || !svc.isReady()) return
      await emitLiveText(runtime, message, opts.errorText(err as Error))
    }
  )

  return { success: true, text: opts.pendingText, data: { pending: true } }
}

/**
 * User-facing phrase for where a 2FA approval arrives, by method. Used to
 * build the deterministic "check X" instruction the action returns the moment
 * the approval prompt is out.
 */
export function channelForMethod(method: string): string {
  switch (method) {
    case 'email':
      return 'your email inbox'
    case 'telegram':
      return 'Telegram'
    case 'external_wallet':
      return 'your hardware wallet'
    case 'phone':
      return 'your phone'
    default:
      return `your ${method} channel`
  }
}

/**
 * Detect the family of node:fetch / network errors that surface as opaque
 * messages at the action layer. We can't tell from a string alone whether
 * the auth server, an RPC endpoint, or some other downstream went down —
 * but every variant is worth surfacing the same actionable diagnostic for.
 */
export function isNetworkError(msg: string): boolean {
  return /fetch failed|ECONNREFUSED|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|getaddrinfo|network.*unreachable|(network|request|connection)\s*timed?\s*out|request timeout/i.test(
    msg
  )
}

/**
 * Multi-line diagnostic for unreachable-backend errors. Every action that
 * surfaces a string error to the user runs this when isNetworkError is true,
 * so the user gets consistent remediation regardless of which action tripped
 * over the unreachable backend (auth server, RPC, etc.).
 */
export function formatNetworkError(rawMsg: string): string {
  return [
    `Couldn't reach the WaaP backend (${rawMsg}).`,
    '',
    'Most common causes:',
    '  • The chain RPC endpoint is unreachable from this machine — try a different RPC URL via the `rpc` parameter.',
    '  • The WaaP backend or RPC is temporarily down — retry in a few minutes.',
    '  • A network, firewall, or proxy on this host is blocking the connection.'
  ].join('\n')
}

/**
 * Map common viem (and similar EVM-RPC) failure messages to a human-readable
 * summary. Returns the bare reason — callers prepend their own framing
 * (e.g. "❌ Transaction failed: <summary>") so the reason stays on the
 * first visible line of the chat bubble. Falls back to the original message
 * when no pattern matches so we never lose information — only compress it.
 *
 * Network errors (fetch failed, ECONN*, getaddrinfo, etc.) are routed
 * through formatNetworkError, which gives a multi-line remediation rather
 * than a one-line generic message — they almost always need operator
 * attention, not a retry.
 */
export function summarizeViemError(msg: string): string {
  if (/insufficient funds for gas \* price \+ value/i.test(msg)) {
    return 'insufficient balance to cover gas + value. Top up the wallet on this chain, or switch to a chain where you have funds.'
  }
  if (/nonce too low/i.test(msg)) {
    return 'nonce conflict. A previous transaction is still pending — wait a moment and retry.'
  }
  if (/replacement.*(fee|transaction).*(too low|underpriced)/i.test(msg)) {
    return "replacement fee too low. If you're trying to bump a stuck tx, raise the gas price."
  }
  if (/user rejected|user denied|request rejected/i.test(msg)) {
    return 'rejected by the signer.'
  }
  if (/intrinsic gas too low/i.test(msg)) {
    return 'gas limit too low for this transaction.'
  }
  if (/(execution reverted|contract.*revert)/i.test(msg)) {
    return 'the contract reverted the call. Check that the recipient/contract accepts this call and your inputs are correct.'
  }
  if (isNetworkError(msg)) {
    return formatNetworkError(msg)
  }
  // Sui-side equivalent of "insufficient funds": the Sui SDK rejects with
  // "No valid gas coins found for the transaction" when the sender's Sui
  // address holds no SUI on the active network.
  if (/no valid gas coins/i.test(msg)) {
    return 'no SUI available for gas on this network. Top up your Sui address with some SUI on the active chain (e.g. faucet for testnet) and try again.'
  }
  return msg
}
