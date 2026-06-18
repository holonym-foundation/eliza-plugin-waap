import { describe, it, expect, vi, beforeEach } from 'vitest'

import { twoFaStatusAction } from '../../../src/actions/twoFaStatus'
import { WaapError } from '../../../src/errors'

function fakeRuntime(svcOverrides: Partial<any> = {}) {
  return {
    agentId: 'test-agent',
    getSetting: (_k: string) => undefined,
    getService: (_t: any) => ({
      isReady: () => true,
      get2faStatus: vi.fn().mockResolvedValue({ method: 'email' }),
      ...svcOverrides
    })
  } as any
}

const fakeMessage = (text: string) =>
  ({ content: { text }, userId: 'u', roomId: 'r', agentId: 'a' }) as any

describe('twoFaStatusAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('has WAAP_2FA_STATUS name', () => {
    expect(twoFaStatusAction.name).toBe('WAAP_2FA_STATUS')
    expect(twoFaStatusAction.similes).toContain('CHECK_2FA')
  })

  it('validate() returns true when service is ready', async () => {
    expect(
      await twoFaStatusAction.validate(fakeRuntime(), fakeMessage('2fa status'))
    ).toBe(true)
  })

  it('validate() returns true even when service is not ready (handler emits a usable not-logged-in action card)', async () => {
    const runtime = { getService: () => ({ isReady: () => false }) } as any
    expect(
      await twoFaStatusAction.validate(runtime, fakeMessage('2fa status'))
    ).toBe(true)
  })

  it('not logged in: emits a usable action-card with sign-up / log-in instructions (success=true, NOT a canned reject)', async () => {
    // Anti-NONE shape: returning success=false with a one-liner makes the
    // LLM bypass this action on follow-up 2FA questions. Same fix as the
    // other read-only actions.
    const runtime = {
      agentId: 'a',
      getService: () => ({ isReady: () => false })
    } as any
    const callback = vi.fn()
    const result = await twoFaStatusAction.handler(
      runtime,
      fakeMessage('2fa status'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    expect((result as any).data).toMatchObject({ loggedIn: false })
    const cbText = callback.mock.calls[0][0].text as string
    expect(cbText).toMatch(/not logged in/i)
    expect(cbText).toMatch(/sign up|log in/i)
  })

  it('validate() returns false only when the service is not registered at all', async () => {
    const runtime = { getService: () => null } as any
    expect(
      await twoFaStatusAction.validate(runtime, fakeMessage('2fa status'))
    ).toBe(false)
  })

  it('reports enabled method (email)', async () => {
    const callback = vi.fn()
    const result = await twoFaStatusAction.handler(
      fakeRuntime(),
      fakeMessage('what is my 2fa status'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    expect((result as any).text).toContain('Email')
    expect((result as any).data).toMatchObject({ method: 'email' })
  })

  it('reports the registered destination value when present (email + address)', async () => {
    const runtime = fakeRuntime({
      get2faStatus: vi
        .fn()
        .mockResolvedValue({ method: 'email', value: 'agent@example.com' })
    })
    const callback = vi.fn()
    const result = await twoFaStatusAction.handler(
      runtime,
      fakeMessage("what's my 2fa email"),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    expect((result as any).text).toContain('Email')
    expect((result as any).text).toContain('agent@example.com')
    expect((result as any).data).toMatchObject({
      method: 'email',
      value: 'agent@example.com'
    })
  })

  it('omits the value cleanly when the backend does not expose it', async () => {
    const runtime = fakeRuntime({
      get2faStatus: vi.fn().mockResolvedValue({ method: 'email' })
    })
    const callback = vi.fn()
    const result = await twoFaStatusAction.handler(
      runtime,
      fakeMessage('2fa status'),
      undefined,
      {},
      callback
    )
    expect((result as any).text).toBe('🔐 2FA is enabled via Email.')
    expect((result as any).data).not.toHaveProperty('value')
  })

  it('reports enabled method (telegram)', async () => {
    const runtime = fakeRuntime({
      get2faStatus: vi.fn().mockResolvedValue({ method: 'telegram' })
    })
    const callback = vi.fn()
    const result = await twoFaStatusAction.handler(
      runtime,
      fakeMessage('2fa status'),
      undefined,
      {},
      callback
    )
    expect((result as any).text).toContain('Telegram')
  })

  it('reports disabled status', async () => {
    const runtime = fakeRuntime({
      get2faStatus: vi.fn().mockResolvedValue({ method: 'disabled' })
    })
    const callback = vi.fn()
    const result = await twoFaStatusAction.handler(
      runtime,
      fakeMessage('is 2fa enabled'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    // The disabled-state message uses uppercase DISABLED for emphasis;
    // match case-insensitively to keep the test stable against future
    // tone tweaks while still asserting the concept.
    expect((result as any).text).toMatch(/disabled/i)
  })

  it('error path: reports failure', async () => {
    const runtime = fakeRuntime({
      get2faStatus: vi
        .fn()
        .mockRejectedValue(new WaapError('network error', 'NETWORK'))
    })
    const callback = vi.fn()
    const result = await twoFaStatusAction.handler(
      runtime,
      fakeMessage('2fa status'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect((result as any).text).toContain('network error')
  })
})
