import { describe, it, expect } from 'vitest'
import { renderEvent } from '../../src/actions/eventRendering'
import type { CliEvent } from '../../src/cliRunner'

describe('renderEvent()', () => {
  it('silent on submitted', () => {
    expect(
      renderEvent({ event: 'submitted', payloadId: 'p1' }, 'send-tx')
    ).toBeNull()
  })

  it('renders telegram 2FA prompt', () => {
    const out = renderEvent(
      {
        event: 'awaiting_2fa',
        method: 'telegram',
        payloadId: 'p1',
        timeoutMs: 300000
      },
      'send-tx'
    )
    expect(out).toContain('Telegram')
    expect(out).toContain('5 minutes')
  })

  it('renders email 2FA prompt', () => {
    const out = renderEvent(
      {
        event: 'awaiting_2fa',
        method: 'email',
        payloadId: 'p1',
        timeoutMs: 300000
      },
      'sign-message'
    )
    expect(out).toContain('email')
  })

  it('renders external_wallet 2FA prompt', () => {
    const out = renderEvent(
      {
        event: 'awaiting_2fa',
        method: 'external_wallet',
        payloadId: 'p1',
        timeoutMs: 300000
      },
      'send-tx'
    )
    expect(out).toContain('hardware wallet')
  })

  it('renders external_wallet 2FA prompt with confirmUrl when provided', () => {
    const out = renderEvent(
      {
        event: 'awaiting_2fa',
        method: 'external_wallet',
        payloadId: 'p1',
        timeoutMs: 300000,
        confirmUrl: 'https://wallet.example.com/confirm?id=abc'
      },
      'send-tx'
    )
    expect(out).toContain('hardware wallet')
    expect(out).toContain('https://wallet.example.com/confirm?id=abc')
  })

  it('renders approved event', () => {
    const out = renderEvent({ event: 'approved', payloadId: 'p1' }, 'send-tx')
    expect(out).toContain('Approved')
  })

  it('silent on result', () => {
    expect(
      renderEvent({ event: 'result', ok: true, txHash: '0xabc' }, 'send-tx')
    ).toBeNull()
  })

  it('silent on error', () => {
    expect(
      renderEvent({ event: 'error', message: 'x', code: 'NETWORK' }, 'send-tx')
    ).toBeNull()
  })

  it('renders phone 2FA prompt for completeness', () => {
    const out = renderEvent(
      {
        event: 'awaiting_2fa',
        method: 'phone',
        payloadId: 'p1',
        timeoutMs: 300000
      },
      'send-tx'
    )
    expect(out).toContain('phone')
  })

  // ─── phase events (CLI-plugin parity coverage) ───────────────────────────

  describe('phase events', () => {
    // Internal phases are curated out — they created out-of-order visual
    // noise in the Eliza UI when an action fails fast. The CLI keeps
    // emitting them; the plugin just doesn't render them.
    it('returns null for curated-out internal phases', () => {
      const dropped = [
        'keyshare_loading',
        'keyshare_ready',
        'signing_started',
        'policy_engine_contacting',
        'policy_engine_decision',
        'completing_signature',
        'signature_verified',
        'applying_to_policy_engine',
        'account_creating',
        'account_created',
        'session_saved',
        'logging_in',
        'authenticated'
      ] as const

      for (const stage of dropped) {
        expect(
          renderEvent({ event: 'phase', stage } as CliEvent, 'send-tx')
        ).toBeNull()
      }
    })

    it('renders keyshare_recovering with explanation (security signal — kept)', () => {
      const out = renderEvent(
        { event: 'phase', stage: 'keyshare_recovering' } as CliEvent,
        'send-tx'
      )
      expect(out).toContain('No keyshare found')
      expect(out).toMatch(/recover/i)
    })

    it('renders tx_preview as a multi-line block with all populated fields', () => {
      const out = renderEvent(
        {
          event: 'phase',
          stage: 'tx_preview',
          from: '0xfrom1234567890abcdef1234567890abcdef1234',
          to: '0xto1234567890abcdef1234567890abcdef1234',
          value: '0.5',
          chainId: 137,
          nonce: 7,
          gas: '21000',
          unit: 'MATIC'
        } as CliEvent,
        'send-tx'
      )
      expect(out).toContain('Transaction details')
      expect(out).toContain('0xto1234567890abcdef1234567890abcdef1234')
      expect(out).toContain('0xfrom1234567890abcdef1234567890abcdef1234')
      expect(out).toContain('0.5 MATIC')
      expect(out).toContain('137')
      expect(out).toContain('Nonce: 7')
      expect(out).toContain('21000')
    })

    it('renders tx_preview with chain string for Sui (no chainId/nonce/gas)', () => {
      const out = renderEvent(
        {
          event: 'phase',
          stage: 'tx_preview',
          from: '0xfrom',
          to: '0xto',
          value: '1000000',
          chain: 'sui:mainnet',
          unit: 'MIST'
        } as CliEvent,
        'send-tx'
      )
      expect(out).toContain('1000000 MIST')
      expect(out).toContain('sui:mainnet')
      expect(out).not.toContain('Nonce:')
      expect(out).not.toContain('Gas estimate:')
    })

    it('renders broadcasting with chain context', () => {
      const out = renderEvent(
        { event: 'phase', stage: 'broadcasting', chainId: 1 } as CliEvent,
        'send-tx'
      )
      expect(out).toMatch(/Broadcasting/i)
      expect(out).toContain('1')
    })

    it('renders broadcasted with txHash and chainId', () => {
      const out = renderEvent(
        {
          event: 'phase',
          stage: 'broadcasted',
          txHash: '0xabc123',
          chainId: 137
        } as CliEvent,
        'send-tx'
      )
      expect(out).toContain('Transaction submitted')
      expect(out).toContain('0xabc123')
      expect(out).toContain('137')
    })

    it('renders broadcasted with txHash and chain string for Sui', () => {
      const out = renderEvent(
        {
          event: 'phase',
          stage: 'broadcasted',
          txHash: '0xabc123',
          chain: 'sui:mainnet'
        } as CliEvent,
        'send-tx'
      )
      expect(out).toContain('0xabc123')
      expect(out).toContain('sui:mainnet')
    })

    it('auth phase events are curated out (covered by the dropped-stages test above)', () => {
      // Auth-flow phases (account_creating, logging_in, etc.) used to be
      // rendered as one-line bubbles, but they created noise on fast
      // signup/login flows where the success banner already covers the
      // outcome. The CLI still emits them; the plugin just doesn't render.
      // Asserted via the consolidated "returns null for curated-out
      // internal phases" test.
      expect(true).toBe(true)
    })

    it('returns null for an unknown stage so unknown CLI events are silently dropped', () => {
      const out = renderEvent(
        // @ts-expect-error — testing runtime safety on an unknown stage
        { event: 'phase', stage: 'completely_unknown_stage' } as CliEvent,
        'send-tx'
      )
      expect(out).toBeNull()
    })
  })
})
