import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/actions/paramExtraction', async () => {
  const actual = await vi.importActual<any>(
    '../../../src/actions/paramExtraction'
  )
  return { ...actual, extractSignMessageParams: vi.fn() }
})

import { signMessageAction } from '../../../src/actions/signMessage'
import { extractSignMessageParams } from '../../../src/actions/paramExtraction'
import { WaapError } from '../../../src/errors'

function fakeRuntime(svcOverrides: Partial<any> = {}) {
  return {
    agentId: 'test-agent',
    getSetting: (_k: string) => undefined,
    getService: (_t: any) => ({
      isReady: () => true,
      getAddress: () => '0xabc',
      signMessage: vi.fn().mockResolvedValue({ signature: '0xsig' }),
      ...svcOverrides
    })
  } as any
}

const fakeMessage = (text: string) =>
  ({ content: { text }, userId: 'u', roomId: 'r', agentId: 'a' }) as any

describe('signMessageAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('has WAAP_SIGN_MESSAGE name and expected similes', () => {
    expect(signMessageAction.name).toBe('WAAP_SIGN_MESSAGE')
    expect(signMessageAction.similes).toContain('SIGN_MESSAGE')
    expect(signMessageAction.similes).toContain('PERSONAL_SIGN')
  })

  it('validate() returns true when service is ready', async () => {
    expect(
      await signMessageAction.validate(fakeRuntime(), fakeMessage('sign hi'))
    ).toBe(true)
  })

  it('validate() returns true even when service is not ready (handler emits "please log in first")', async () => {
    const runtime = { getService: () => ({ isReady: () => false }) } as any
    expect(await signMessageAction.validate(runtime, fakeMessage('sign'))).toBe(
      true
    )
  })

  it('validate() returns false only when the service is not registered at all', async () => {
    const runtime = { getService: () => null } as any
    expect(await signMessageAction.validate(runtime, fakeMessage('sign'))).toBe(
      false
    )
  })

  it('happy path: extracts params, calls svc.signMessage, reports signature via callback', async () => {
    ;(extractSignMessageParams as any).mockResolvedValue({
      ok: true,
      value: { message: 'hello' }
    })
    const callback = vi.fn()
    const result = await signMessageAction.handler(
      fakeRuntime(),
      fakeMessage("sign 'hello'"),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    expect((result as any).data).toMatchObject({ signature: '0xsig' })
    const final = callback.mock.calls[callback.mock.calls.length - 1][0]
    expect(final.text).toContain('Message signed')
    expect(final.text).toContain('0xsig')
  })

  it('2FA flow: in-flight progress streams via runtime.sendMessageToTarget (not buffered callback)', async () => {
    // Progress events bypass the storage callback so the user sees them
    // during the up-to-5-minute wait. Final result still goes via callback.
    ;(extractSignMessageParams as any).mockResolvedValue({
      ok: true,
      value: { message: 'hello' }
    })
    const callback = vi.fn()
    const sendMessageToTarget = vi.fn().mockResolvedValue(undefined)
    const runtime = {
      agentId: 'test-agent',
      sendMessageToTarget,
      getService: () => ({
        isReady: () => true,
        signMessage: vi.fn().mockImplementation(async (_i: any, ctx: any) => {
          await ctx?.onEvent?.({
            event: 'awaiting_2fa',
            method: 'telegram',
            payloadId: 'p',
            timeoutMs: 1
          })
          await ctx?.onEvent?.({ event: 'approved', payloadId: 'p' })
          return { signature: '0xsig' }
        })
      })
    } as any
    const message = {
      content: { text: 'sign', source: 'discord' },
      roomId: 'r'
    } as any
    await signMessageAction.handler(runtime, message, undefined, {}, callback)
    const liveTexts = sendMessageToTarget.mock.calls.map(
      (c: any[]) => c[1]?.text
    )
    expect(liveTexts.some((t: string) => t?.includes('Telegram'))).toBe(true)
    expect(liveTexts.some((t: string) => t?.includes('Approved'))).toBe(true)
  })

  it('param extraction failure: returns false, reports error via callback', async () => {
    ;(extractSignMessageParams as any).mockResolvedValue({
      ok: false,
      error: 'no message'
    })
    const callback = vi.fn()
    const result = await signMessageAction.handler(
      fakeRuntime(),
      fakeMessage('sign something'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect((result as any).error).toBeInstanceOf(Error)
    expect((result as any).error.message).toContain('no message')
    const reply = String(callback.mock.calls[0][0]?.text ?? '')
    expect(reply).toMatch(/message/i)
    expect(reply).toMatch(/quotes/i)
  })

  it('service error: maps WaapError to user-facing message and returns false', async () => {
    ;(extractSignMessageParams as any).mockResolvedValue({
      ok: true,
      value: { message: 'hi' }
    })
    const runtime = {
      getService: () => ({
        isReady: () => true,
        signMessage: vi
          .fn()
          .mockRejectedValue(new WaapError('2fa timeout', 'TWO_FA_TIMEOUT'))
      })
    } as any
    const callback = vi.fn()
    const result = await signMessageAction.handler(
      runtime,
      fakeMessage('sign'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect((result as any).error).toBeInstanceOf(Error)
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('2fa timeout') })
    )
  })

  it('Sui: signMessage works on Sui chain (no chain-specific rejection)', async () => {
    ;(extractSignMessageParams as any).mockResolvedValue({
      ok: true,
      value: { message: 'hello sui' }
    })
    const runtime = fakeRuntime({
      getChainFamily: () => 'sui',
      signMessage: vi.fn().mockResolvedValue({ signature: '0xsuisig' })
    })
    const callback = vi.fn()
    const result = await signMessageAction.handler(
      runtime,
      fakeMessage("sign 'hello sui'"),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    expect((result as any).data).toMatchObject({ signature: '0xsuisig' })
    const final = callback.mock.calls[callback.mock.calls.length - 1][0]
    expect(final.text).toContain('Message signed')
    expect(final.text).toContain('0xsuisig')
  })

  it('surfaces the signed-message bytes when the CLI returns them (Sui parity)', async () => {
    ;(extractSignMessageParams as any).mockResolvedValue({
      ok: true,
      value: { message: 'hello sui' }
    })
    const runtime = fakeRuntime({
      getChainFamily: () => 'sui',
      signMessage: vi
        .fn()
        .mockResolvedValue({ signature: '0xsuisig', bytes: 'aGVsbG8gc3Vp' })
    })
    const callback = vi.fn()
    const result = await signMessageAction.handler(
      runtime,
      fakeMessage("sign 'hello sui'"),
      undefined,
      {},
      callback
    )
    expect((result as any).data).toMatchObject({
      signature: '0xsuisig',
      bytes: 'aGVsbG8gc3Vp'
    })
    const final = callback.mock.calls[callback.mock.calls.length - 1][0]
    expect(final.text).toContain('aGVsbG8gc3Vp')
  })

  it('omits bytes for EVM sign-message (CLI returns none)', async () => {
    ;(extractSignMessageParams as any).mockResolvedValue({
      ok: true,
      value: { message: 'hi' }
    })
    const callback = vi.fn()
    const result = await signMessageAction.handler(
      fakeRuntime(),
      fakeMessage("sign 'hi'"),
      undefined,
      {},
      callback
    )
    expect((result as any).data).not.toHaveProperty('bytes')
  })
})
