import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/actions/paramExtraction', async () => {
  const actual = await vi.importActual<any>(
    '../../../src/actions/paramExtraction'
  )
  return { ...actual, extractSignTypedDataParams: vi.fn() }
})

import { signTypedDataAction } from '../../../src/actions/signTypedData'
import { extractSignTypedDataParams } from '../../../src/actions/paramExtraction'
import { WaapError } from '../../../src/errors'

const sampleData = {
  types: { EIP712Domain: [] },
  domain: {},
  primaryType: 'Mail',
  message: {}
}

function fakeRuntime(svcOverrides: Partial<any> = {}) {
  return {
    agentId: 'test-agent',
    getSetting: (_k: string) => undefined,
    getService: (_t: any) => ({
      isReady: () => true,
      getChainFamily: () => 'evm',
      signTypedData: vi.fn().mockResolvedValue({ signature: '0xsig712' }),
      ...svcOverrides
    })
  } as any
}

const fakeMessage = (text: string) =>
  ({ content: { text }, userId: 'u', roomId: 'r', agentId: 'a' } as any)

describe('signTypedDataAction', () => {
  beforeEach(() => vi.clearAllMocks())

  // EIP-712 domain-chain guard: refuse typed data scoped to another chain.
  it('refuses to sign EIP-712 data scoped to a different chain', async () => {
    const signSpy = vi.fn().mockResolvedValue({ signature: '0xsig' })
    const runtime = fakeRuntime({
      signTypedData: signSpy,
      getChainState: () => ({ family: 'evm', chainId: 1, canonical: 'evm:1' })
    })
    ;(extractSignTypedDataParams as any).mockResolvedValue({
      ok: true,
      value: {
        data: {
          types: {},
          domain: { chainId: 999 },
          primaryType: 'Permit',
          message: {}
        }
      }
    })
    const result = await signTypedDataAction.handler(
      runtime,
      fakeMessage('sign this'),
      undefined,
      {},
      vi.fn()
    )
    expect(result).toMatchObject({ success: false })
    expect(signSpy).not.toHaveBeenCalled()
    expect((result as any).text).toMatch(/chain 999|won't sign/i)
  })

  it('signs EIP-712 data whose domain.chainId matches the active chain', async () => {
    const signSpy = vi.fn().mockResolvedValue({ signature: '0xsig' })
    const runtime = fakeRuntime({
      signTypedData: signSpy,
      getChainState: () => ({ family: 'evm', chainId: 1, canonical: 'evm:1' })
    })
    ;(extractSignTypedDataParams as any).mockResolvedValue({
      ok: true,
      value: {
        data: {
          types: {},
          domain: { chainId: 1 },
          primaryType: 'Permit',
          message: {}
        }
      }
    })
    const result = await signTypedDataAction.handler(
      runtime,
      fakeMessage('sign this'),
      undefined,
      {},
      vi.fn()
    )
    expect(result).toMatchObject({ success: true })
    expect(signSpy).toHaveBeenCalled()
  })

  it('has WAAP_SIGN_TYPED_DATA name and expected similes', () => {
    expect(signTypedDataAction.name).toBe('WAAP_SIGN_TYPED_DATA')
    expect(signTypedDataAction.similes).toContain('SIGN_TYPED_DATA')
    expect(signTypedDataAction.similes).toContain('EIP712_SIGN')
  })

  it('validate() returns true when service is ready', async () => {
    expect(
      await signTypedDataAction.validate(fakeRuntime(), fakeMessage('sign'))
    ).toBe(true)
  })

  it('validate() returns true even when service is not ready (handler emits "please log in first")', async () => {
    const runtime = { getService: () => ({ isReady: () => false }) } as any
    expect(
      await signTypedDataAction.validate(runtime, fakeMessage('sign'))
    ).toBe(true)
  })

  it('validate() returns false only when the service is not registered at all', async () => {
    const runtime = { getService: () => null } as any
    expect(
      await signTypedDataAction.validate(runtime, fakeMessage('sign'))
    ).toBe(false)
  })

  it('happy path: extracts params, calls svc.signTypedData, reports signature via callback', async () => {
    ;(extractSignTypedDataParams as any).mockResolvedValue({
      ok: true,
      value: { data: sampleData }
    })
    const callback = vi.fn()
    const result = await signTypedDataAction.handler(
      fakeRuntime(),
      fakeMessage('sign typed data'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    expect((result as any).data).toMatchObject({ signature: '0xsig712' })
    const final = callback.mock.calls[callback.mock.calls.length - 1][0]
    expect(final.text).toContain('Typed data signed')
    expect(final.text).toContain('0xsig712')
  })

  it('2FA flow: in-flight progress streams via runtime.sendMessageToTarget (not buffered callback)', async () => {
    ;(extractSignTypedDataParams as any).mockResolvedValue({
      ok: true,
      value: { data: sampleData }
    })
    const callback = vi.fn()
    const sendMessageToTarget = vi.fn().mockResolvedValue(undefined)
    const runtime = {
      agentId: 'test-agent',
      sendMessageToTarget,
      getService: () => ({
        isReady: () => true,
        getChainFamily: () => 'evm',
        signTypedData: vi.fn().mockImplementation(async (_i: any, ctx: any) => {
          await ctx?.onEvent?.({
            event: 'awaiting_2fa',
            method: 'email',
            payloadId: 'p',
            timeoutMs: 1
          })
          await ctx?.onEvent?.({ event: 'approved', payloadId: 'p' })
          return { signature: '0xsig712' }
        })
      })
    } as any
    const message = {
      content: { text: 'sign', source: 'discord' },
      roomId: 'r'
    } as any
    await signTypedDataAction.handler(runtime, message, undefined, {}, callback)
    const liveTexts = sendMessageToTarget.mock.calls.map(
      (c: any[]) => c[1]?.text
    )
    expect(liveTexts.some((t: string) => t?.includes('email'))).toBe(true)
    expect(liveTexts.some((t: string) => t?.includes('Approved'))).toBe(true)
  })

  it('param extraction failure: returns false, reports error via callback', async () => {
    ;(extractSignTypedDataParams as any).mockResolvedValue({
      ok: false,
      error: 'invalid data'
    })
    const callback = vi.fn()
    const result = await signTypedDataAction.handler(
      fakeRuntime(),
      fakeMessage('sign'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect((result as any).error).toBeInstanceOf(Error)
    expect((result as any).error.message).toContain('invalid data')
    const reply = String(callback.mock.calls[0][0]?.text ?? '')
    expect(reply).toMatch(/EIP-712/i)
    expect(reply).toMatch(/JSON/i)
  })

  it('service error: maps WaapError to user-facing message and returns false', async () => {
    ;(extractSignTypedDataParams as any).mockResolvedValue({
      ok: true,
      value: { data: sampleData }
    })
    const runtime = {
      getService: () => ({
        isReady: () => true,
        getChainFamily: () => 'evm',
        signTypedData: vi
          .fn()
          .mockRejectedValue(new WaapError('user denied', 'POLICY_REJECTED'))
      })
    } as any
    const callback = vi.fn()
    const result = await signTypedDataAction.handler(
      runtime,
      fakeMessage('sign'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect((result as any).error).toBeInstanceOf(Error)
    // Raw "user denied" gets collapsed by summarizeViemError to a friendlier
    // one-liner ("Reason: rejected by the signer.") — assert against the
    // summary form, since the user-facing copy is what the test is verifying.
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/rejected/i) })
    )
  })

  it('Sui: validate() stays true on Sui — the handler emits the EVM-only rejection so the user sees a real message instead of a silent no-op', async () => {
    const runtime = fakeRuntime({ getChainFamily: () => 'sui' })
    expect(
      await signTypedDataAction.validate(
        runtime,
        fakeMessage('sign typed data')
      )
    ).toBe(true)
  })

  it('Sui: handler rejects with EVM-only message when on Sui chain', async () => {
    const runtime = fakeRuntime({ getChainFamily: () => 'sui' })
    const callback = vi.fn()
    const result = await signTypedDataAction.handler(
      runtime,
      fakeMessage('sign typed data'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('EVM chains')
      })
    )
  })
})
