import type { CliEvent, CliPhaseStage, TwoFaMethod } from '../cliRunner'

export type CommandContext =
  | 'send-tx'
  | 'sign-tx'
  | 'sign-message'
  | 'sign-typed-data'
  | 'set-policy'
  | 'enable2fa'
  | 'disable2fa'

const TIMEOUT_COPY = "I'll wait up to 5 minutes."

const METHOD_COPY: Record<TwoFaMethod, string> = {
  telegram: `⏳ Approve this transaction in Telegram. ${TIMEOUT_COPY}`,
  email: `⏳ Approval link sent to your email. ${TIMEOUT_COPY}`,
  external_wallet: `⏳ Confirm this transaction in your hardware wallet. ${TIMEOUT_COPY}`,
  phone: `⏳ Enter the OTP sent to your phone. ${TIMEOUT_COPY}`,
  disabled: ''
}

const APPROVED_COPY: Record<CommandContext, string> = {
  'send-tx': 'Approved — sending transaction...',
  'sign-tx': 'Approved — signing transaction...',
  'sign-message': 'Approved — finalizing signature...',
  'sign-typed-data': 'Approved — finalizing signature...',
  'set-policy': 'Approved — applying policy change...',
  enable2fa: 'Approved — updating 2FA settings...',
  disable2fa: 'Approved — disabling 2FA...'
}

/**
 * One-line copy for each phase stage. Mirrors the emoji prefixes the CLI
 * uses in human mode so the agent chat shows the same progress trail the
 * user would see running waap-cli directly.
 *
 * `policy_engine_decision` is special: it carries a `decision` string
 * ('WaitForAuthz' | 'Done' | 'Reject' | ...) — the static copy here is
 * just the lead-in; the renderer appends the decision value at runtime.
 */
const PHASE_COPY: Record<CliPhaseStage, string> = {
  keyshare_loading: '🔑 Loading wallet keyshare...',
  keyshare_ready: '✅ Keyshare ready',
  keyshare_recovering:
    '⚠️  No keyshare found for this account — recovering by creating a fresh one. (Account setup is being completed now.)',
  signing_started: '🔏 Signing...',
  policy_engine_contacting: '📡 Contacting policy engine...',
  policy_engine_decision: '🛡️  Policy engine decision',
  completing_signature: '🔏 Completing signature...',
  signature_verified: '✅ Signature verified',
  applying_to_policy_engine: '📡 Applying change to policy engine...',
  // The following four are formatted at runtime in renderEvent because they
  // carry payload fields that need to appear in the output string. The
  // entries here are placeholders so the Record<CliPhaseStage, string>
  // exhaustiveness check passes; the runtime code overrides them.
  tx_preview: '📋 Transaction details',
  broadcasting: '📡 Broadcasting transaction...',
  broadcasted: '✅ Transaction submitted',
  account_creating: '📝 Creating account...',
  account_created: '✅ Account created — fetching credentials...',
  session_saved: '💾 Session saved.',
  logging_in: '🔐 Logging in...',
  authenticated: '✅ Authenticated — fetching keyshare...'
}

/**
 * Pure function: converts a CliEvent into a user-facing string to send via
 * Eliza's callback(), or null if the event should not produce user output.
 */
export function renderEvent(
  event: CliEvent,
  ctx: CommandContext
): string | null {
  switch (event.event) {
    case 'submitted':
      return null

    case 'awaiting_2fa': {
      const base =
        METHOD_COPY[event.method] ||
        `⏳ Approval required via ${event.method}. ${TIMEOUT_COPY}`

      // For external_wallet 2FA, the CLI emits a confirmation URL that the
      // user must open in a browser. Append it so the user knows where to go.
      if (event.method === 'external_wallet' && event.confirmUrl) {
        return [
          base,
          '🔗 Open this URL in your browser to confirm:',
          event.confirmUrl
        ].join('\n')
      }

      return base
    }

    case 'approved':
      return APPROVED_COPY[ctx] ?? 'Approved — processing...'

    case 'phase': {
      // Curate which phases reach chat. Keep only user-actionable phases
      // (security warnings, signing previews, long broadcast waits, 2FA-
      // adjacent transitions). Internal milestones (keyshare load, policy-
      // engine roundtrip, signature rounds, signup/login internal stages)
      // are dropped — they create out-of-order visual noise in the Eliza
      // UI when an action fails fast, and add little value when it
      // succeeds. The phase events still flow through the CLI/parser, so
      // future UI surfaces can render them if needed.
      const USER_ACTIONABLE_STAGES = new Set<CliPhaseStage>([
        'keyshare_recovering', // account-was-incomplete security signal
        'tx_preview', // gas/nonce details before signing
        'broadcasting', // long wait
        'broadcasted' // success with txHash
      ])
      if (!USER_ACTIONABLE_STAGES.has(event.stage)) return null

      const base = PHASE_COPY[event.stage]
      if (!base) return null

      // tx_preview is rendered as a multi-line block with the resolved
      // gas/nonce details so the user can sanity-check the transaction
      // before signing. Mirrors the CLI's "📋 Transaction details:" block.
      if (event.stage === 'tx_preview' && event.to) {
        const lines = ['📋 Transaction details:', `- To: ${event.to}`]
        if (event.from) lines.push(`- From: ${event.from}`)
        if (event.value)
          lines.push(`- Value: ${event.value} ${event.unit ?? 'ETH'}`)
        if (event.chainId !== undefined)
          lines.push(`- Chain ID: ${event.chainId}`)
        if (event.chain) lines.push(`- Chain: ${event.chain}`)
        if (event.nonce !== undefined) lines.push(`- Nonce: ${event.nonce}`)
        if (event.gas) lines.push(`- Gas estimate: ${event.gas}`)
        return lines.join('\n')
      }

      // broadcasting carries optional chain context.
      if (event.stage === 'broadcasting') {
        const ctx = event.chainId ?? event.chain
        return ctx ? `${base} (chain ${ctx})` : base
      }

      // broadcasted carries the txHash and chain.
      if (event.stage === 'broadcasted' && event.txHash) {
        const ctx =
          event.chainId !== undefined
            ? ` on chain ${event.chainId}`
            : event.chain
              ? ` on ${event.chain}`
              : ''
        return `✅ Transaction submitted${ctx}: ${event.txHash}`
      }

      return base
    }

    case 'result':
    case 'error':
      return null

    default:
      return null
  }
}
