import { describe, it, expect, vi, beforeEach } from 'vitest'

import { cancel2faAction } from '../../../src/actions/cancel2fa'

function fakeRuntime(svcOverrides: Partial<any> = {}) {
  return {
    agentId: 'test-agent',
    getSetting: (_k: string) => undefined,
    getService: (_t: any) => ({
      isReady: () => true,
      cancelPendingAuthz: vi.fn().mockReturnValue(null),
      ...svcOverrides
    })
  } as any
}

const fakeMessage = (text: string) =>
  ({ content: { text }, userId: 'u', roomId: 'r', agentId: 'a' }) as any

describe('cancel2faAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('has WAAP_CANCEL_2FA name and intuitive similes', () => {
    expect(cancel2faAction.name).toBe('WAAP_CANCEL_2FA')
    expect(cancel2faAction.similes).toContain('CANCEL_2FA')
    expect(cancel2faAction.similes).toContain('CANCEL_PENDING_2FA')
    expect(cancel2faAction.similes).toContain('ABORT_2FA')
  })

  it('validate() returns true when service is ready', async () => {
    expect(
      await cancel2faAction.validate(fakeRuntime(), fakeMessage('cancel 2fa'))
    ).toBe(true)
  })

  it('validate() returns true even when service is not ready (handler emits "please log in first" or "no pending 2FA")', async () => {
    const runtime = { getService: () => ({ isReady: () => false }) } as any
    expect(
      await cancel2faAction.validate(runtime, fakeMessage('cancel 2fa'))
    ).toBe(true)
  })

  it('validate() returns false only when the service is not registered at all', async () => {
    const runtime = { getService: () => null } as any
    expect(
      await cancel2faAction.validate(runtime, fakeMessage('cancel 2fa'))
    ).toBe(false)
  })

  it('handler: when nothing is pending, reports no-op success and does not lie', async () => {
    const callback = vi.fn()
    const result = await cancel2faAction.handler(
      fakeRuntime(),
      fakeMessage('cancel my pending 2fa'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({
      success: true,
      data: { cancelled: false }
    })
    expect((result as any).text).toContain('No pending 2FA')
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        content: { cancelled: false }
      })
    )
  })

  it('handler: when an op is pending, cancels and reports the kind/age', async () => {
    const startedAt = Date.now() - 3 * 60_000 // 3 minutes ago
    const runtime = fakeRuntime({
      cancelPendingAuthz: vi.fn().mockReturnValue({
        kind: 'send-tx',
        startedAt,
        method: 'email'
      })
    })
    const callback = vi.fn()
    const result = await cancel2faAction.handler(
      runtime,
      fakeMessage('cancel my pending 2fa'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({
      success: true,
      data: { cancelled: true, kind: 'send-tx', method: 'email' }
    })
    expect((result as any).text).toContain('Cancelled')
    expect((result as any).text).toContain('transaction')
    expect((result as any).text).toContain('3 min')
  })

  it('handler: maps known kinds to user-friendly labels', async () => {
    const runtime = fakeRuntime({
      cancelPendingAuthz: vi.fn().mockReturnValue({
        kind: 'set-policy',
        startedAt: Date.now()
      })
    })
    const callback = vi.fn()
    const result = await cancel2faAction.handler(
      runtime,
      fakeMessage('abort'),
      undefined,
      {},
      callback
    )
    expect((result as any).text).toContain('policy change')
  })

  it('handler: surfaces the raw kind for unknown labels (forward compat)', async () => {
    const runtime = fakeRuntime({
      cancelPendingAuthz: vi.fn().mockReturnValue({
        kind: 'future-op-not-yet-mapped',
        startedAt: Date.now()
      })
    })
    const callback = vi.fn()
    const result = await cancel2faAction.handler(
      runtime,
      fakeMessage('abort'),
      undefined,
      {},
      callback
    )
    expect((result as any).text).toContain('future-op-not-yet-mapped')
  })
})
