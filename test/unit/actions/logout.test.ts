import { describe, it, expect, vi, beforeEach } from 'vitest'

import { logoutAction } from '../../../src/actions/logout'
import { WaapError } from '../../../src/errors'

function fakeRuntime(svcOverrides: Partial<any> = {}) {
  return {
    agentId: 'test-agent',
    getSetting: (_k: string) => undefined,
    getService: (_t: any) => ({
      isReady: () => true,
      logout: vi.fn().mockResolvedValue(undefined),
      ...svcOverrides
    })
  } as any
}

const fakeMessage = (text: string) =>
  ({ content: { text }, userId: 'u', roomId: 'r', agentId: 'a' }) as any

describe('logoutAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('has WAAP_LOGOUT name and expected similes', () => {
    expect(logoutAction.name).toBe('WAAP_LOGOUT')
    expect(logoutAction.similes).toContain('SIGN_OUT')
    expect(logoutAction.similes).toContain('DISCONNECT_WALLET')
  })

  it('validate() returns true when service is ready', async () => {
    expect(
      await logoutAction.validate(fakeRuntime(), fakeMessage('logout'))
    ).toBe(true)
  })

  it('validate() returns true even when service is not ready (handler emits "please log in first")', async () => {
    const runtime = { getService: () => ({ isReady: () => false }) } as any
    expect(await logoutAction.validate(runtime, fakeMessage('logout'))).toBe(
      true
    )
  })

  it('validate() returns false only when the service is not registered at all', async () => {
    const runtime = { getService: () => null } as any
    expect(await logoutAction.validate(runtime, fakeMessage('logout'))).toBe(
      false
    )
  })

  it('happy path: logs out and reports success', async () => {
    const callback = vi.fn()
    const result = await logoutAction.handler(
      fakeRuntime(),
      fakeMessage('log out'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    expect((result as any).text).toContain('Logged out')
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Logged out') })
    )
  })

  it('error path: reports failure', async () => {
    const runtime = fakeRuntime({
      logout: vi
        .fn()
        .mockRejectedValue(new WaapError('session file locked', 'UNKNOWN'))
    })
    const callback = vi.fn()
    const result = await logoutAction.handler(
      runtime,
      fakeMessage('logout'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect((result as any).text).toContain('session file locked')
  })

  it('no service: rejects gracefully', async () => {
    const runtime = { getService: () => null } as any
    const callback = vi.fn()
    const result = await logoutAction.handler(
      runtime,
      fakeMessage('logout'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
  })
})
