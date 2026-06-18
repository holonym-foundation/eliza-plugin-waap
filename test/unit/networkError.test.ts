// Pins the shared unreachable-backend diagnostic. Three layers must agree:
//   1. `isNetworkError` must match every `node:fetch` / DNS / connection
//      family of error string we've seen at the action layer.
//   2. `formatNetworkError` must surface a clear, generic remediation so the
//      user isn't left staring at an opaque "fetch failed".
//   3. `summarizeViemError` must route network errors through (2), so every
//      action that uses it (sendTx, signTx, signMessage, signTypedData,
//      setPolicy, getBalance, request) shows the same remediation.
//
// If any of these regress, the user is back to staring at "fetch failed".

import { describe, it, expect } from 'vitest'

import {
  formatNetworkError,
  isNetworkError,
  summarizeViemError
} from '../../src/actions/actionUtils'

describe('isNetworkError', () => {
  // Every variant we've actually observed in the wild on this codebase.
  const NETWORK_ERROR_MESSAGES = [
    'fetch failed',
    'TypeError: fetch failed',
    'connect ECONNREFUSED 127.0.0.1:8000',
    'getaddrinfo ENOTFOUND backend.example',
    'connect ETIMEDOUT 10.0.0.1:443',
    'request to https://backend.example/login failed, reason: getaddrinfo EAI_AGAIN',
    'network is unreachable',
    'request timeout'
  ]

  it.each(NETWORK_ERROR_MESSAGES)('matches: %s', (msg) => {
    expect(isNetworkError(msg)).toBe(true)
  })

  // Things that look error-shaped but are NOT network errors — must NOT
  // match, otherwise legitimate domain errors get the network remediation
  // which is wrong + misleading.
  const NON_NETWORK_ERRORS = [
    'invalid email or password',
    'Login failed (401): Invalid email or password',
    'insufficient funds for gas * price + value',
    'execution reverted: ERC20: insufficient allowance',
    'nonce too low',
    'No valid gas coins found for the transaction',
    'No session — please log in first',
    'unexpected JSON from CLI'
  ]

  it.each(NON_NETWORK_ERRORS)('does NOT match: %s', (msg) => {
    expect(isNetworkError(msg)).toBe(false)
  })
})

describe('formatNetworkError', () => {
  const out = formatNetworkError('fetch failed')

  it('echoes the raw message so operators can correlate with logs', () => {
    expect(out).toContain('fetch failed')
    expect(out).toContain("Couldn't reach the WaaP backend")
  })

  it('names plausible causes (RPC URL, backend down, local network)', () => {
    expect(out).toMatch(/RPC.*url|RPC.*endpoint/i)
    expect(out).toMatch(/down|retry/i)
    expect(out).toMatch(/network|firewall|proxy/i)
  })

  it('is multi-line so the chat bubble renders the bullet list', () => {
    expect(out).toContain('\n')
    expect(out.split('\n').length).toBeGreaterThan(4)
  })
})

describe('summarizeViemError routes network errors through formatNetworkError', () => {
  // This is the integration point that propagates the diagnostic to every
  // action whose error path goes through summarizeViemError (sendTx, signTx,
  // signMessage, signTypedData, setPolicy, getBalance, request). If this
  // breaks, those actions revert to the old generic "RPC network error" line.
  it('"fetch failed" → multi-line remediation', () => {
    const out = summarizeViemError('fetch failed')
    expect(out).toContain("Couldn't reach the WaaP backend")
    expect(out).toMatch(/RPC|retry/i)
  })

  it('"getaddrinfo ENOTFOUND ..." → multi-line remediation', () => {
    const out = summarizeViemError('getaddrinfo ENOTFOUND backend.example')
    expect(out).toContain("Couldn't reach the WaaP backend")
  })

  it('non-network errors are NOT routed through formatNetworkError', () => {
    const marker = "Couldn't reach the WaaP backend"
    expect(
      summarizeViemError('insufficient funds for gas * price + value')
    ).not.toContain(marker)
    expect(summarizeViemError('execution reverted: foo')).not.toContain(marker)
    expect(summarizeViemError('nonce too low')).not.toContain(marker)
    expect(summarizeViemError('user rejected')).not.toContain(marker)
  })

  it('unmapped errors still pass through verbatim', () => {
    const novel = 'totally unfamiliar error from a downstream we have not seen'
    expect(summarizeViemError(novel)).toBe(novel)
  })
})

// ── Action-level pins for the diagnostic ────────────────────────────────────
//
// Three actions previously bypassed `summarizeViemError` and printed the raw
// `error.message` straight into the user-facing reply. That defeats the
// shared remediation: when the backend is unreachable, `2fa status`,
// `switch chain`, and `logout` would all just print "fetch failed" instead of
// the multi-line diagnostic. Pin each one so the wrap can't be silently
// removed in a future refactor.

import { logoutAction } from '../../src/actions/logout'
import { switchChainAction } from '../../src/actions/switchChain'
import { twoFaStatusAction } from '../../src/actions/twoFaStatus'
import { vi } from 'vitest'

const fakeMessage = (text: string) =>
  ({ content: { text }, userId: 'u', roomId: 'r', agentId: 'a' } as any)

const NETWORK_MARKER = "Couldn't reach the WaaP backend"

describe('Action error paths route network failures through formatNetworkError', () => {
  it('twoFaStatusAction surfaces the network diagnostic on fetch failure', async () => {
    const runtime = {
      agentId: 'a',
      getService: () => ({
        isReady: () => true,
        get2faStatus: vi.fn().mockRejectedValue(new Error('fetch failed'))
      })
    } as any
    const callback = vi.fn()
    await twoFaStatusAction.handler(
      runtime,
      fakeMessage('2fa status'),
      undefined,
      {},
      callback
    )
    const text = String(callback.mock.calls[0][0]?.text ?? '')
    // Anti-regression: was previously raw `error.message`, no diagnostic.
    expect(text).toContain(NETWORK_MARKER)
  })

  it('switchChainAction surfaces the network diagnostic on fetch failure', async () => {
    const runtime = {
      agentId: 'a',
      getSetting: () => undefined,
      getService: () => ({
        isReady: () => true,
        switchChain: vi.fn(() => {
          throw new Error('fetch failed')
        })
      })
    } as any
    const callback = vi.fn()
    const paramExtraction = await import('../../src/actions/paramExtraction')
    const spy = vi
      .spyOn(paramExtraction, 'extractSwitchChainParams')
      .mockResolvedValue({ ok: true, value: { chain: 'polygon' } } as any)
    try {
      await switchChainAction.handler(
        runtime,
        fakeMessage('switch to polygon'),
        undefined,
        {},
        callback
      )
    } finally {
      spy.mockRestore()
    }
    const text = String(callback.mock.calls[0][0]?.text ?? '')
    // Anti-regression: was previously raw `error.message`, no diagnostic.
    expect(text).toContain(NETWORK_MARKER)
  })

  it('logoutAction surfaces the network diagnostic on fetch failure', async () => {
    const runtime = {
      agentId: 'a',
      getService: () => ({
        isReady: () => true,
        logout: vi.fn().mockRejectedValue(new Error('fetch failed'))
      })
    } as any
    const callback = vi.fn()
    await logoutAction.handler(
      runtime,
      fakeMessage('log out'),
      undefined,
      {},
      callback
    )
    const text = String(callback.mock.calls[0][0]?.text ?? '')
    // Anti-regression: was previously raw `error.message`, no diagnostic.
    expect(text).toContain(NETWORK_MARKER)
  })
})
