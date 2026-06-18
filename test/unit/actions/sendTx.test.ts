import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/actions/paramExtraction', async () => {
  const actual = await vi.importActual<any>(
    '../../../src/actions/paramExtraction'
  )
  return {
    ...actual,
    extractSendTxParams: vi.fn()
  }
})

import { sendTxAction } from '../../../src/actions/sendTx'
import {
  extractSendTxParams,
  sendTxSchema
} from '../../../src/actions/paramExtraction'
import { WaapError } from '../../../src/errors'

function fakeRuntime(svcOverrides: Partial<any> = {}) {
  return {
    agentId: 'test-agent',
    getSetting: (_k: string) => undefined,
    getService: (_type: any) => ({
      isReady: () => true,
      getAddress: () => '0xabc',
      getChainState: () => ({ family: 'evm', chainId: 1, canonical: 'evm:1' }),
      getChainFamily: () => 'evm',
      sendTx: vi.fn().mockResolvedValue({
        txHash: '0xdead',
        from: '0xabc'
      }),
      ...svcOverrides
    }),
    composeState: vi.fn().mockResolvedValue({}),
    updateRecentMessageState: vi.fn().mockResolvedValue({})
  } as any
}

function fakeMessage(text: string) {
  return {
    content: { text },
    userId: 'user-1',
    roomId: 'room-1',
    agentId: 'test-agent'
  } as any
}

describe('sendTxAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const EVM40 = `0x${'a'.repeat(40)}`
  const SUI64 = `0x${'b'.repeat(64)}`

  // recipient length must match the active chain family.
  it('rejects a 64-hex (Sui-length) recipient on an EVM chain', async () => {
    ;(extractSendTxParams as any).mockResolvedValue({
      ok: true,
      value: { to: SUI64, value: '1' }
    })
    const callback = vi.fn()
    const result = await sendTxAction.handler(
      fakeRuntime(),
      fakeMessage(`send 1 ETH to ${SUI64}`),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect((result as any).text).toMatch(/40 hex/i)
  })

  it('rejects a 40-hex (EVM-length) recipient on a Sui chain', async () => {
    ;(extractSendTxParams as any).mockResolvedValue({
      ok: true,
      value: { to: EVM40, value: '1000' }
    })
    const suiRuntime = fakeRuntime({
      getChainFamily: () => 'sui',
      getChainState: () => ({ family: 'sui', canonical: 'sui:mainnet' })
    })
    const callback = vi.fn()
    const result = await sendTxAction.handler(
      suiRuntime,
      fakeMessage(`send 1000 MIST to ${EVM40}`),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect((result as any).text).toMatch(/64 hex/i)
  })

  // Sui MIST is an integer base unit — reject fractional amounts.
  it('rejects a fractional MIST value on a Sui chain', async () => {
    ;(extractSendTxParams as any).mockResolvedValue({
      ok: true,
      value: { to: SUI64, value: '0.5' }
    })
    const suiRuntime = fakeRuntime({
      getChainFamily: () => 'sui',
      getChainState: () => ({ family: 'sui', canonical: 'sui:mainnet' })
    })
    const callback = vi.fn()
    const result = await sendTxAction.handler(
      suiRuntime,
      fakeMessage(`send 0.5 SUI to ${SUI64}`),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect((result as any).text).toMatch(/MIST/i)
  })

  it('rejects non-numeric value strings at schema level', () => {
    const hexResult = sendTxSchema.safeParse({
      to: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
      value: '0x1a',
      chainId: 1
    })
    expect(hexResult.success).toBe(false)

    const textResult = sendTxSchema.safeParse({
      to: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
      value: 'all my eth',
      chainId: 1
    })
    expect(textResult.success).toBe(false)

    const validResult = sendTxSchema.safeParse({
      to: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
      value: '0.01',
      chainId: 1
    })
    expect(validResult.success).toBe(true)

    const noPrefixResult = sendTxSchema.safeParse({
      to: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
      value: '.5',
      chainId: 1
    })
    expect(noPrefixResult.success).toBe(true)
  })

  it('has WAAP_SEND_TX name and expected similes', () => {
    expect(sendTxAction.name).toBe('WAAP_SEND_TX')
    expect(sendTxAction.similes).toContain('SEND_TRANSACTION')
    expect(sendTxAction.similes).toContain('TRANSFER')
  })

  it('validate() returns true when service is ready', async () => {
    const runtime = fakeRuntime()
    const result = await sendTxAction.validate(
      runtime,
      fakeMessage('send 0.01 eth to 0xdead')
    )
    expect(result).toBe(true)
  })

  it('validate() returns true even when service is not ready (handler emits "please log in first")', async () => {
    const runtime = {
      getService: () => ({ isReady: () => false })
    } as any
    const result = await sendTxAction.validate(runtime, fakeMessage('send'))
    expect(result).toBe(true)
  })

  it('validate() returns false only when the service is not registered at all', async () => {
    const runtime = { getService: () => null } as any
    const result = await sendTxAction.validate(runtime, fakeMessage('send'))
    expect(result).toBe(false)
  })

  it('happy path: extracts params, calls svc.sendTx, reports tx hash via callback', async () => {
    ;(extractSendTxParams as any).mockResolvedValue({
      ok: true,
      value: {
        to: '0x000000000000000000000000000000000000dEaD',
        value: '0.01',
        chainId: 1,
        rpc: 'https://eth.llamarpc.com'
      }
    })

    const callback = vi.fn()
    const runtime = fakeRuntime()

    const result = await sendTxAction.handler(
      runtime,
      fakeMessage('send 0.01 eth to 0xdead'),
      undefined,
      {},
      callback
    )

    expect(result).toMatchObject({ success: true })
    expect((result as any).text).toContain('Transaction sent')
    expect((result as any).data).toMatchObject({
      txHash: '0xdead',
      from: '0xabc'
    })
    expect(callback).toHaveBeenCalled()
    const finalCall = callback.mock.calls[callback.mock.calls.length - 1][0]
    expect(finalCall.text).toContain('Transaction sent')
    expect(finalCall.text).toContain('0xdead')
  })

  it('2FA flow: in-flight progress streams via runtime.sendMessageToTarget (not buffered callback)', async () => {
    // Progress events (awaiting_2fa, approved) bypass the storage callback so
    // the user sees them in real time during the up-to-5-minute 2FA wait.
    // The final result still goes via callback. Asserting via separate channels
    // pins the contract: progress in live, finals in callback.
    ;(extractSendTxParams as any).mockResolvedValue({
      ok: true,
      value: {
        to: '0x000000000000000000000000000000000000dEaD',
        value: '0.01',
        chainId: 1
      }
    })

    const callback = vi.fn()
    const sendMessageToTarget = vi.fn().mockResolvedValue(undefined)
    const runtime = {
      agentId: 'test-agent',
      sendMessageToTarget,
      getService: () => ({
        isReady: () => true,
        getAddress: () => '0xabc',
        getChainState: () => ({
          family: 'evm',
          chainId: 1,
          canonical: 'evm:1'
        }),
        getChainFamily: () => 'evm',
        sendTx: vi.fn().mockImplementation(async (_input: any, ctx: any) => {
          await ctx?.onEvent?.({ event: 'submitted', payloadId: 'p1' })
          await ctx?.onEvent?.({
            event: 'awaiting_2fa',
            method: 'telegram',
            payloadId: 'p1',
            timeoutMs: 300_000
          })
          await ctx?.onEvent?.({ event: 'approved', payloadId: 'p1' })
          return { txHash: '0xfinal', from: '0xabc' }
        })
      })
    } as any

    const message = {
      content: { text: 'send', source: 'discord' },
      userId: 'user-1',
      roomId: 'room-1',
      agentId: 'test-agent'
    } as any

    await sendTxAction.handler(runtime, message, undefined, {}, callback)

    const liveTexts = sendMessageToTarget.mock.calls.map(
      (c: any[]) => c[1]?.text
    )
    expect(liveTexts.some((t: string) => t?.includes('Telegram'))).toBe(true)
    expect(liveTexts.some((t: string) => t?.includes('Approved'))).toBe(true)

    const callbackTexts = callback.mock.calls.map((c: any[]) => c[0].text)
    // Final result with the tx hash still goes via callback.
    expect(callbackTexts.some((t: string) => t.includes('0xfinal'))).toBe(true)
  })

  it('param extraction failure: returns false, reports error via callback', async () => {
    ;(extractSendTxParams as any).mockResolvedValue({
      ok: false,
      error: 'missing recipient address'
    })

    const callback = vi.fn()
    const result = await sendTxAction.handler(
      fakeRuntime(),
      fakeMessage('send some money somewhere'),
      undefined,
      {},
      callback
    )

    expect(result).toMatchObject({ success: false })
    expect((result as any).error).toBeInstanceOf(Error)
    // Returned error preserves the technical detail for logs.
    expect((result as any).error.message).toContain('missing recipient')
    // Callback text is the friendly re-ask, not the raw zod message.
    const reply = String(callback.mock.calls[0][0]?.text ?? '')
    expect(reply).toMatch(/recipient address/i)
    expect(reply).toMatch(/amount/i)
    expect(reply).not.toContain('zod')
  })

  it('service error: maps WaapError to user-facing message and returns false', async () => {
    ;(extractSendTxParams as any).mockResolvedValue({
      ok: true,
      value: {
        to: '0x000000000000000000000000000000000000dEaD',
        value: '0.01',
        chainId: 1
      }
    })

    const runtime = {
      getService: () => ({
        isReady: () => true,
        getAddress: () => '0xabc',
        getChainState: () => ({
          family: 'evm',
          chainId: 1,
          canonical: 'evm:1'
        }),
        getChainFamily: () => 'evm',
        sendTx: vi
          .fn()
          .mockRejectedValue(
            new WaapError('daily spend limit exceeded', 'POLICY_REJECTED')
          )
      })
    } as any

    const callback = vi.fn()
    const result = await sendTxAction.handler(
      runtime,
      fakeMessage('send'),
      undefined,
      {},
      callback
    )

    expect(result).toMatchObject({ success: false })
    expect((result as any).error).toBeInstanceOf(Error)
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('daily spend limit exceeded')
      })
    )
  })

  it('preview does not announce 2FA preemptively (only the awaiting_2fa CLI event triggers that copy)', async () => {
    // Regression: previous preview text always ended with "Waiting for 2FA
    // approval..." — surfaced even on insufficient-funds failures or
    // policy-disabled 2FA. The 2FA prompt now comes from renderEvent() in
    // response to the CLI's awaiting_2fa event, not from this preview.
    ;(extractSendTxParams as any).mockResolvedValue({
      ok: true,
      value: {
        to: '0x000000000000000000000000000000000000dEaD',
        value: '0.01',
        chainId: 1
      }
    })

    const callback = vi.fn()
    const runtime = fakeRuntime({
      sendTx: vi.fn().mockResolvedValue({ txHash: '0xdead', from: '0xabc' })
    })

    await sendTxAction.handler(
      runtime,
      fakeMessage('send'),
      undefined,
      {},
      callback
    )

    // Pre-action preview was removed entirely (Fix A: stale preview drowns
    // out the actual error on pre-flight failures). The attempted tx params
    // are now in BOTH the success and error text. Verify across all
    // callbacks that no 2FA preempt copy ever leaks.
    const allText = callback.mock.calls
      .map((c: any[]) => String(c[0]?.text ?? ''))
      .join('\n')
    expect(allText).not.toContain('Waiting for 2FA')
    expect(allText).not.toContain('2FA approval')
    // The success/error text still echoes the To: / Value: / Chain: lines
    expect(allText).toMatch(/To: 0x|Chain: /)
  })

  it('Sui sendTx: preview shows MIST unit and sui:mainnet chain', async () => {
    const suiAddr = '0x' + 'ab'.repeat(32)
    ;(extractSendTxParams as any).mockResolvedValue({
      ok: true,
      value: { to: suiAddr, value: '1000000000' }
    })

    const runtime = fakeRuntime({
      getChainState: () => ({
        family: 'sui',
        network: 'mainnet',
        canonical: 'sui:mainnet'
      }),
      getChainFamily: () => 'sui',
      getAddress: () => suiAddr,
      sendTx: vi.fn().mockResolvedValue({
        txHash: '0xsuitxhash',
        from: suiAddr
      })
    })

    const callback = vi.fn()
    const result = await sendTxAction.handler(
      runtime,
      fakeMessage('send 1 SUI'),
      undefined,
      {},
      callback
    )

    expect(result).toMatchObject({ success: true })
    expect((result as any).data).toMatchObject({
      txHash: '0xsuitxhash',
      from: suiAddr
    })
    const allTexts = callback.mock.calls.map((c: any[]) => c[0].text)
    expect(allTexts.some((t: string) => t.includes('MIST'))).toBe(true)
    expect(allTexts.some((t: string) => t.includes('sui:mainnet'))).toBe(true)
    expect(allTexts.some((t: string) => t.includes('0xsuitxhash'))).toBe(true)
  })
})
