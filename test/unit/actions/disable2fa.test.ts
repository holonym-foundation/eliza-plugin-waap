import { describe, it, expect, vi, beforeEach } from 'vitest'

import { disable2faAction } from '../../../src/actions/disable2fa'
import { WaapError } from '../../../src/errors'

function fakeRuntime(svcOverrides: Partial<any> = {}) {
  return {
    agentId: 'test-agent',
    getSetting: (_k: string) => undefined,
    sendMessageToTarget: vi.fn().mockResolvedValue(undefined),
    getService: (_t: any) => ({
      isReady: () => true,
      getSessionEpoch: () => 1,
      getAddress: () => '0xabc',
      getChainFamily: () => 'evm',
      get2faStatus: vi.fn().mockResolvedValue({ method: 'email' }),
      disable2fa: vi.fn().mockResolvedValue(undefined),
      ...svcOverrides
    })
  } as any
}

const fakeMessage = (text: string) =>
  ({
    content: { text, source: 'discord' },
    userId: 'u',
    roomId: 'r',
    agentId: 'a'
  }) as any

/** Resolve queued microtasks so background live-channel deliveries can run. */
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('disable2faAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('has WAAP_DISABLE_2FA name and expected similes', () => {
    expect(disable2faAction.name).toBe('WAAP_DISABLE_2FA')
    expect(disable2faAction.similes).toContain('TURN_OFF_2FA')
    expect(disable2faAction.similes).toContain('REMOVE_2FA')
  })

  it('validate() returns true when service is ready', async () => {
    expect(
      await disable2faAction.validate(fakeRuntime(), fakeMessage('disable 2fa'))
    ).toBe(true)
  })

  it('validate() returns true even when service is not ready (handler emits "please log in first")', async () => {
    const runtime = { getService: () => ({ isReady: () => false }) } as any
    expect(
      await disable2faAction.validate(runtime, fakeMessage('disable 2fa'))
    ).toBe(true)
  })

  it('validate() returns false only when the service is not registered at all', async () => {
    const runtime = { getService: () => null } as any
    expect(
      await disable2faAction.validate(runtime, fakeMessage('disable 2fa'))
    ).toBe(false)
  })

  it('returns early when 2FA is already disabled', async () => {
    const runtime = fakeRuntime({
      get2faStatus: vi.fn().mockResolvedValue({ method: 'disabled' }),
      disable2fa: vi.fn()
    })
    const callback = vi.fn()
    const result = await disable2faAction.handler(
      runtime,
      fakeMessage('disable 2fa'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    expect((result as any).text).toContain('already disabled')
    // disable2fa should NOT have been called
    expect(runtime.getService().disable2fa).not.toHaveBeenCalled()
  })

  it('happy path: disables 2FA and reports success', async () => {
    const callback = vi.fn()
    const result = await disable2faAction.handler(
      fakeRuntime(),
      fakeMessage('disable 2fa'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    expect((result as any).data).toMatchObject({ method: 'disabled' })
    const lastCall = callback.mock.calls[callback.mock.calls.length - 1][0]
    expect(lastCall.text).toContain('disabled')
  })

  it('error path: reports failure', async () => {
    const runtime = fakeRuntime({
      disable2fa: vi
        .fn()
        .mockRejectedValue(new WaapError('2fa timeout', 'TWO_FA_TIMEOUT'))
    })
    const callback = vi.fn()
    const result = await disable2faAction.handler(
      runtime,
      fakeMessage('disable 2fa'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect((result as any).text).toContain('2fa timeout')
  })

  it('non-blocking: returns a self-contained instruction the moment the approval prompt is out', async () => {
    let finishOp!: () => void
    const disable2fa = vi.fn().mockImplementation(async (progress: any) => {
      await progress.onEvent({
        event: 'awaiting_2fa',
        method: 'email',
        payloadId: 'p1',
        timeoutMs: 300_000
      })
      return new Promise<void>((resolve) => {
        finishOp = () => resolve()
      })
    })
    const runtime = fakeRuntime({ disable2fa })
    const callback = vi.fn()

    const result = await disable2faAction.handler(
      runtime,
      fakeMessage('disable 2fa'),
      undefined,
      {},
      callback
    )

    expect(result).toMatchObject({ success: true, data: { pending: true } })
    const cbText = String(callback.mock.calls[0][0]?.text ?? '')
    expect(cbText).toMatch(/email inbox/i)
    expect(cbText).toMatch(/is 2FA on/i)

    finishOp()
    await flush()
  })

  it('session guard: completion landing after a session change is NOT delivered to the live channel', async () => {
    let epoch = 1
    let finishOp!: () => void
    const disable2fa = vi.fn().mockImplementation(async (progress: any) => {
      await progress.onEvent({
        event: 'awaiting_2fa',
        method: 'email',
        payloadId: 'p1',
        timeoutMs: 300_000
      })
      return new Promise<void>((resolve) => {
        finishOp = () => resolve()
      })
    })
    const runtime = fakeRuntime({ disable2fa, getSessionEpoch: () => epoch })
    const callback = vi.fn()

    await disable2faAction.handler(
      runtime,
      fakeMessage('disable 2fa'),
      undefined,
      {},
      callback
    )

    epoch = 2
    finishOp()
    await flush()

    const liveTexts = runtime.sendMessageToTarget.mock.calls.map(
      (c: any[]) => c[1].text
    )
    expect(liveTexts.some((t: string) => /disabled/.test(t))).toBe(false)
  })

  it('abort before any prompt (CLI_ABORTED): stays silent', async () => {
    const disable2fa = vi.fn().mockRejectedValue(
      Object.assign(new Error('CLI aborted by caller'), {
        code: 'CLI_ABORTED'
      })
    )
    const runtime = fakeRuntime({ disable2fa })
    const callback = vi.fn()

    const result = await disable2faAction.handler(
      runtime,
      fakeMessage('disable 2fa'),
      undefined,
      {},
      callback
    )

    expect(result).toMatchObject({ success: false, data: { aborted: true } })
    expect(callback).not.toHaveBeenCalled()
  })
})
