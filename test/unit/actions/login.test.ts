import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/actions/paramExtraction', async () => {
  const actual = await vi.importActual<any>(
    '../../../src/actions/paramExtraction'
  )
  return { ...actual, extractLoginParams: vi.fn() }
})

import { loginAction } from '../../../src/actions/login'
import { extractLoginParams } from '../../../src/actions/paramExtraction'
import { WaapError } from '../../../src/errors'

function fakeRuntime(svcOverrides: Partial<any> = {}) {
  return {
    agentId: 'test-agent',
    getSetting: (_k: string) => undefined,
    getService: (_t: any) => ({
      isReady: () => false,
      login: vi.fn().mockResolvedValue({
        address: '0xmywallet',
        suiAddress: '0xmysuiwallet'
      }),
      ...svcOverrides
    })
  } as any
}

const fakeMessage = (text: string) =>
  ({ content: { text }, userId: 'u', roomId: 'r', agentId: 'a' } as any)

describe('loginAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('has WAAP_LOGIN name and expected similes', () => {
    expect(loginAction.name).toBe('WAAP_LOGIN')
    expect(loginAction.similes).toContain('SIGN_IN')
    expect(loginAction.similes).toContain('CONNECT_WALLET')
  })

  it('validate() returns true when service exists but is not ready', async () => {
    expect(
      await loginAction.validate(fakeRuntime(), fakeMessage('log in'))
    ).toBe(true)
  })

  it('validate() returns false when service is already ready (logged in)', async () => {
    const runtime = fakeRuntime({ isReady: () => true })
    expect(await loginAction.validate(runtime, fakeMessage('log in'))).toBe(
      false
    )
  })

  it('validate() returns false when no service exists', async () => {
    const runtime = { getService: () => null } as any
    expect(await loginAction.validate(runtime, fakeMessage('log in'))).toBe(
      false
    )
  })

  it('happy path: extracts params, calls svc.login, returns address via callback', async () => {
    ;(extractLoginParams as any).mockResolvedValue({
      ok: true,
      value: { email: 'alice@example.com', password: 'MySecure123' }
    })
    const callback = vi.fn()
    const result = await loginAction.handler(
      fakeRuntime(),
      fakeMessage(
        'Log in with email alice@example.com and password MySecure123'
      ),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    expect((result as any).data).toMatchObject({
      address: '0xmywallet',
      suiAddress: '0xmysuiwallet'
    })
    const final = callback.mock.calls[callback.mock.calls.length - 1][0]
    expect(final.text).toContain('Logged in')
    expect(final.text).toContain('0xmywallet')
    expect(final.text).toContain('0xmysuiwallet')
  })

  it('password never appears in callback text or result text', async () => {
    const password = 'SuperSecret999'
    ;(extractLoginParams as any).mockResolvedValue({
      ok: true,
      value: { email: 'alice@example.com', password }
    })
    const callback = vi.fn()
    const result = await loginAction.handler(
      fakeRuntime(),
      fakeMessage(`Log in with password ${password}`),
      undefined,
      {},
      callback
    )
    for (const call of callback.mock.calls) {
      expect(call[0].text).not.toContain(password)
      if (call[0].content) {
        expect(JSON.stringify(call[0].content)).not.toContain(password)
      }
    }
    expect((result as any).text).not.toContain(password)
    if ((result as any).data) {
      expect(JSON.stringify((result as any).data)).not.toContain(password)
    }
  })

  it('param extraction failure: returns false, reports error via callback', async () => {
    ;(extractLoginParams as any).mockResolvedValue({
      ok: false,
      error: 'missing email'
    })
    const callback = vi.fn()
    const result = await loginAction.handler(
      fakeRuntime(),
      fakeMessage('log in'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect((result as any).error).toBeInstanceOf(Error)
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Invalid')
      })
    )
  })

  it('auth-failure error: rewrites generic 401 into a friendlier "did you mean to sign up?" message', async () => {
    // The backend returns a single generic 401 for both wrong-password and
    // no-such-account so it can't leak which case it was. The plugin can't
    // tell either, but it CAN suggest signing up — the user may simply not
    // have an account yet.
    ;(extractLoginParams as any).mockResolvedValue({
      ok: true,
      value: { email: 'alice@example.com', password: 'wrong' }
    })
    const runtime = fakeRuntime({
      login: vi
        .fn()
        .mockRejectedValue(
          new WaapError(
            'Login failed (401): Invalid email or password',
            'UNKNOWN'
          )
        )
    })
    const callback = vi.fn()
    const result = await loginAction.handler(
      runtime,
      fakeMessage('log in'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    const cb = callback.mock.calls[callback.mock.calls.length - 1][0]
    // Friendly text — not the raw "401 / invalid email or password" string
    expect(cb.text).toContain("Couldn't log in")
    expect(cb.text).toContain('alice@example.com')
    expect(cb.text).toContain('create a new account')
    expect(cb.text).not.toMatch(/401/)
  })

  it('non-auth service error: surfaces the raw error verbatim (preserves diagnostic detail for unexpected failures)', async () => {
    ;(extractLoginParams as any).mockResolvedValue({
      ok: true,
      value: { email: 'alice@example.com', password: 'somepw' }
    })
    const runtime = fakeRuntime({
      login: vi
        .fn()
        .mockRejectedValue(new WaapError('rpc unreachable', 'NETWORK'))
    })
    const callback = vi.fn()
    const result = await loginAction.handler(
      runtime,
      fakeMessage('log in'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('rpc unreachable')
      })
    )
  })

  it('fetch-failed error: includes the network remediation hint (so users do not chase the opaque message)', async () => {
    // When the backend is unreachable, node:fetch throws "fetch failed" with
    // no further context. Pin the shared remediation here so future
    // regressions don't degrade back to the opaque message.
    ;(extractLoginParams as any).mockResolvedValue({
      ok: true,
      value: { email: 'alice@example.com', password: 'somepw' }
    })
    const runtime = fakeRuntime({
      login: vi.fn().mockRejectedValue(new WaapError('fetch failed', 'UNKNOWN'))
    })
    const callback = vi.fn()
    const result = await loginAction.handler(
      runtime,
      fakeMessage('log in'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    const cb = callback.mock.calls[callback.mock.calls.length - 1][0]
    // The shared `formatNetworkError` helper in actionUtils gives us a
    // backend-agnostic remediation message — pin only the parts that should
    // never change so login.ts and signup.ts can keep their phrasing in sync.
    expect(cb.text).toContain("Couldn't reach the WaaP backend")
    expect(cb.text).toMatch(/RPC|retry|network/i)
  })

  it('no service: returns rejectNoService result', async () => {
    const runtime = { getService: () => null } as any
    const callback = vi.fn()
    const result = await loginAction.handler(
      runtime,
      fakeMessage('log in'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('not logged in')
      })
    )
  })
})
