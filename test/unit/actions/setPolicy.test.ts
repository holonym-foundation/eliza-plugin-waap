import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/actions/paramExtraction', async () => {
  const actual = await vi.importActual<any>(
    '../../../src/actions/paramExtraction'
  )
  return { ...actual, extractSetPolicyParams: vi.fn() }
})

import { setPolicyAction } from '../../../src/actions/setPolicy'
import { extractSetPolicyParams } from '../../../src/actions/paramExtraction'
import { WaapError } from '../../../src/errors'

function fakeRuntime(svcOverrides: Partial<any> = {}) {
  return {
    agentId: 'test-agent',
    getSetting: (_k: string) => undefined,
    getService: (_t: any) => ({
      isReady: () => true,
      setPolicy: vi.fn().mockResolvedValue({
        dailySpendLimitUsd: 500,
        authorizationMethod: 'telegram'
      }),
      ...svcOverrides
    })
  } as any
}

const fakeMessage = (text: string) =>
  ({ content: { text }, userId: 'u', roomId: 'r', agentId: 'a' }) as any

describe('setPolicyAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('has WAAP_SET_POLICY name and expected similes', () => {
    expect(setPolicyAction.name).toBe('WAAP_SET_POLICY')
    expect(setPolicyAction.similes).toContain('SET_POLICY')
    expect(setPolicyAction.similes).toContain('SET_SPEND_LIMIT')
  })

  it('validate() returns true when service is ready', async () => {
    expect(
      await setPolicyAction.validate(fakeRuntime(), fakeMessage('limit'))
    ).toBe(true)
  })

  it('validate() returns true even when service is not ready (handler emits "please log in first")', async () => {
    const runtime = { getService: () => ({ isReady: () => false }) } as any
    expect(await setPolicyAction.validate(runtime, fakeMessage('limit'))).toBe(
      true
    )
  })

  it('validate() returns false only when the service is not registered at all', async () => {
    const runtime = { getService: () => null } as any
    expect(await setPolicyAction.validate(runtime, fakeMessage('limit'))).toBe(
      false
    )
  })

  it('happy path: extracts params, calls svc.setPolicy, reports new limit via callback', async () => {
    ;(extractSetPolicyParams as any).mockResolvedValue({
      ok: true,
      value: { dailySpendLimitUsd: 500 }
    })
    const callback = vi.fn()
    const result = await setPolicyAction.handler(
      fakeRuntime(),
      fakeMessage('set limit to 500'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    expect((result as any).data).toMatchObject({ dailySpendLimitUsd: 500 })
    const final = callback.mock.calls[callback.mock.calls.length - 1][0]
    expect(final.text).toContain('Daily spend limit set to $500')
  })

  it('reports the SERVER-CONFIRMED limit, not the requested one (backend clamped)', async () => {
    // User asks for 1,000,000 but the backend clamps to 10,000. We must report
    // what was actually applied, not echo the request.
    ;(extractSetPolicyParams as any).mockResolvedValue({
      ok: true,
      value: { dailySpendLimitUsd: 1_000_000 }
    })
    const callback = vi.fn()
    const result = await setPolicyAction.handler(
      fakeRuntime({
        setPolicy: vi.fn().mockResolvedValue({ dailySpendLimitUsd: 10_000 })
      }),
      fakeMessage('set limit to 1000000'),
      undefined,
      {},
      callback
    )
    expect((result as any).data).toMatchObject({ dailySpendLimitUsd: 10_000 })
    const final = callback.mock.calls[callback.mock.calls.length - 1][0]
    expect(final.text).toContain('$10000')
    expect(final.text).not.toContain('1000000')
  })

  it('preview does not announce 2FA preemptively (avoids stale-string bleed)', async () => {
    // The specific failure mode was a stale "Waiting for 2FA approval..."
    // string from a policy-change action surfacing in chat history later. The
    // preview now states only the intended change; renderEvent surfaces the
    // 2FA prompt only when the CLI actually emits awaiting_2fa.
    ;(extractSetPolicyParams as any).mockResolvedValue({
      ok: true,
      value: { dailySpendLimitUsd: 100 }
    })
    const callback = vi.fn()
    await setPolicyAction.handler(
      // Backend confirms the same value the user asked for.
      fakeRuntime({
        setPolicy: vi.fn().mockResolvedValue({ dailySpendLimitUsd: 100 })
      }),
      fakeMessage('set my daily limit to $100'),
      undefined,
      {},
      callback
    )
    // Pre-action preview was removed entirely (Fix A: stale preview drowns
    // out the actual error on signing/2FA failures). The attempted limit is
    // now in BOTH the success and error text. Verify across all callbacks.
    const allText = callback.mock.calls
      .map((c: any[]) => String(c[0]?.text ?? ''))
      .join('\n')
    expect(allText).toContain('$100')
    expect(allText).not.toContain('Waiting for 2FA')
    expect(allText).not.toContain('2FA approval')
  })

  it('2FA flow: in-flight progress streams via runtime.sendMessageToTarget (not buffered callback)', async () => {
    ;(extractSetPolicyParams as any).mockResolvedValue({
      ok: true,
      value: { dailySpendLimitUsd: 500 }
    })
    const callback = vi.fn()
    const sendMessageToTarget = vi.fn().mockResolvedValue(undefined)
    const runtime = {
      agentId: 'test-agent',
      sendMessageToTarget,
      getService: () => ({
        isReady: () => true,
        setPolicy: vi.fn().mockImplementation(async (_i: any, ctx: any) => {
          await ctx?.onEvent?.({
            event: 'awaiting_2fa',
            method: 'telegram',
            payloadId: 'p',
            timeoutMs: 1
          })
          await ctx?.onEvent?.({ event: 'approved', payloadId: 'p' })
          return { dailySpendLimitUsd: 500, authorizationMethod: 'telegram' }
        })
      })
    } as any
    const message = {
      content: { text: 'limit', source: 'discord' },
      roomId: 'r'
    } as any
    await setPolicyAction.handler(runtime, message, undefined, {}, callback)
    const liveTexts = sendMessageToTarget.mock.calls.map(
      (c: any[]) => c[1]?.text
    )
    expect(liveTexts.some((t: string) => t?.includes('Telegram'))).toBe(true)
    expect(liveTexts.some((t: string) => t?.includes('Approved'))).toBe(true)
  })

  it('param extraction failure: returns false, reports error via callback', async () => {
    ;(extractSetPolicyParams as any).mockResolvedValue({
      ok: false,
      error: 'no amount'
    })
    const callback = vi.fn()
    const result = await setPolicyAction.handler(
      fakeRuntime(),
      fakeMessage('limit'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect((result as any).error).toBeInstanceOf(Error)
    expect((result as any).error.message).toContain('no amount')
    const reply = String(callback.mock.calls[0][0]?.text ?? '')
    expect(reply).toMatch(/daily spend limit/i)
    expect(reply).toMatch(/USD/i)
  })

  it('service error: maps WaapError to user-facing message and returns false', async () => {
    ;(extractSetPolicyParams as any).mockResolvedValue({
      ok: true,
      value: { dailySpendLimitUsd: 500 }
    })
    const runtime = {
      getService: () => ({
        isReady: () => true,
        setPolicy: vi
          .fn()
          .mockRejectedValue(new WaapError('limit too high', 'INVALID_PARAMS'))
      })
    } as any
    const callback = vi.fn()
    const result = await setPolicyAction.handler(
      runtime,
      fakeMessage('limit'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect((result as any).error).toBeInstanceOf(Error)
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('limit too high')
      })
    )
  })
})
