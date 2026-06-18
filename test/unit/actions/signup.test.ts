import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/actions/paramExtraction', async () => {
  const actual = await vi.importActual<any>(
    '../../../src/actions/paramExtraction'
  )
  return { ...actual, extractSignupParams: vi.fn() }
})

import { signupAction } from '../../../src/actions/signup'
import { extractSignupParams } from '../../../src/actions/paramExtraction'
import { WaapError } from '../../../src/errors'

function fakeRuntime(svcOverrides: Partial<any> = {}) {
  return {
    agentId: 'test-agent',
    getSetting: (_k: string) => undefined,
    getService: (_t: any) => ({
      isReady: () => false,
      signup: vi.fn().mockResolvedValue({
        address: '0xnewwallet',
        suiAddress: '0xnewsuiwallet'
      }),
      ...svcOverrides
    })
  } as any
}

const fakeMessage = (text: string) =>
  ({ content: { text }, userId: 'u', roomId: 'r', agentId: 'a' } as any)

describe('signupAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('has WAAP_SIGNUP name and expected similes', () => {
    expect(signupAction.name).toBe('WAAP_SIGNUP')
    expect(signupAction.similes).toContain('CREATE_WALLET')
    expect(signupAction.similes).toContain('CREATE_ACCOUNT')
    expect(signupAction.similes).toContain('REGISTER')
  })

  it('validate() returns true when service exists but is not ready', async () => {
    expect(
      await signupAction.validate(fakeRuntime(), fakeMessage('sign up'))
    ).toBe(true)
  })

  it('validate() returns false when service is already ready (logged in)', async () => {
    const runtime = fakeRuntime({ isReady: () => true })
    expect(await signupAction.validate(runtime, fakeMessage('sign up'))).toBe(
      false
    )
  })

  it('validate() returns false when no service exists', async () => {
    const runtime = { getService: () => null } as any
    expect(await signupAction.validate(runtime, fakeMessage('sign up'))).toBe(
      false
    )
  })

  it('happy path: extracts params, calls svc.signup, returns address via callback', async () => {
    ;(extractSignupParams as any).mockResolvedValue({
      ok: true,
      value: { email: 'alice@example.com', password: 'MySecure123' }
    })
    const callback = vi.fn()
    const result = await signupAction.handler(
      fakeRuntime(),
      fakeMessage(
        'Create a wallet with email alice@example.com and password MySecure123'
      ),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    expect((result as any).data).toMatchObject({
      address: '0xnewwallet',
      suiAddress: '0xnewsuiwallet'
    })
    const final = callback.mock.calls[callback.mock.calls.length - 1][0]
    expect(final.text).toContain('Account created and logged in')
    expect(final.text).toContain('0xnewwallet')
    expect(final.text).toContain('0xnewsuiwallet')
  })

  it('password never appears in callback text or result text', async () => {
    const password = 'SuperSecret999'
    ;(extractSignupParams as any).mockResolvedValue({
      ok: true,
      value: { email: 'alice@example.com', password }
    })
    const callback = vi.fn()
    const result = await signupAction.handler(
      fakeRuntime(),
      fakeMessage(`Create wallet with password ${password}`),
      undefined,
      {},
      callback
    )
    // Check all callback calls
    for (const call of callback.mock.calls) {
      expect(call[0].text).not.toContain(password)
      if (call[0].content) {
        expect(JSON.stringify(call[0].content)).not.toContain(password)
      }
    }
    // Check result
    expect((result as any).text).not.toContain(password)
    if ((result as any).data) {
      expect(JSON.stringify((result as any).data)).not.toContain(password)
    }
  })

  it('param extraction failure: returns false, reports error via callback', async () => {
    ;(extractSignupParams as any).mockResolvedValue({
      ok: false,
      error: 'missing email'
    })
    const callback = vi.fn()
    const result = await signupAction.handler(
      fakeRuntime(),
      fakeMessage('sign up'),
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

  it('service error with "already exists": suggests login instead', async () => {
    ;(extractSignupParams as any).mockResolvedValue({
      ok: true,
      value: { email: 'alice@example.com', password: 'MySecure123' }
    })
    const runtime = fakeRuntime({
      signup: vi
        .fn()
        .mockRejectedValue(new WaapError('account already exists', 'UNKNOWN'))
    })
    const callback = vi.fn()
    const result = await signupAction.handler(
      runtime,
      fakeMessage('sign up'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('log in instead')
      })
    )
  })

  it('service error (other): reports error message via callback', async () => {
    ;(extractSignupParams as any).mockResolvedValue({
      ok: true,
      value: { email: 'alice@example.com', password: 'MySecure123' }
    })
    const runtime = fakeRuntime({
      signup: vi
        .fn()
        .mockRejectedValue(new WaapError('network timeout', 'NETWORK'))
    })
    const callback = vi.fn()
    const result = await signupAction.handler(
      runtime,
      fakeMessage('sign up'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect((result as any).error).toBeInstanceOf(Error)
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('network timeout')
      })
    )
  })

  it('fetch-failed error: includes the network remediation hint', async () => {
    // Same diagnostic as login.ts — kept in sync because both go through the
    // same backend.
    ;(extractSignupParams as any).mockResolvedValue({
      ok: true,
      value: { email: 'alice@example.com', password: 'somepw' }
    })
    const runtime = fakeRuntime({
      signup: vi
        .fn()
        .mockRejectedValue(new WaapError('fetch failed', 'UNKNOWN'))
    })
    const callback = vi.fn()
    const result = await signupAction.handler(
      runtime,
      fakeMessage('sign up'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    const cb = callback.mock.calls[callback.mock.calls.length - 1][0]
    // Shared `formatNetworkError` helper — same phrasing as login.ts.
    expect(cb.text).toContain("Couldn't reach the WaaP backend")
    expect(cb.text).toMatch(/RPC|retry|network/i)
  })

  it('no service: returns rejectNoService result', async () => {
    const runtime = { getService: () => null } as any
    const callback = vi.fn()
    const result = await signupAction.handler(
      runtime,
      fakeMessage('sign up'),
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
