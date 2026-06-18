import { describe, it, expect, vi, beforeEach } from 'vitest'

import { signTxAction } from '../../../src/actions/signTx'
import { WaapError } from '../../../src/errors'

const FAKE_TO = '0x1234567890abcdef1234567890abcdef12345678'

function fakeRuntime(svcOverrides: Partial<any> = {}) {
  return {
    agentId: 'test-agent',
    getSetting: (_k: string) => undefined,
    useModel: vi
      .fn()
      .mockResolvedValue(JSON.stringify({ to: FAKE_TO, value: '0.1' })),
    composeState: vi.fn().mockResolvedValue({ values: {}, data: {}, text: '' }),
    getService: (_t: any) => ({
      isReady: () => true,
      getAddress: () => '0xabc',
      getChainFamily: () => 'evm',
      getChainState: () => ({ family: 'evm', chainId: 1, canonical: 'evm:1' }),
      signTx: vi.fn().mockResolvedValue({
        signedTx: '0xdeadbeef'.padEnd(132, '0'),
        address: '0xabc'
      }),
      ...svcOverrides
    })
  } as any
}

const fakeMessage = (text: string) =>
  ({ content: { text }, userId: 'u', roomId: 'r', agentId: 'a' } as any)

describe('signTxAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('has WAAP_SIGN_TX name and expected similes', () => {
    expect(signTxAction.name).toBe('WAAP_SIGN_TX')
    expect(signTxAction.similes).toContain('SIGN_TRANSACTION_ONLY')
  })

  it('validate() returns true when service is ready', async () => {
    expect(
      await signTxAction.validate(fakeRuntime(), fakeMessage('sign tx'))
    ).toBe(true)
  })

  it('validate() returns true even when service is not ready (handler emits "please log in first")', async () => {
    const runtime = { getService: () => ({ isReady: () => false }) } as any
    expect(await signTxAction.validate(runtime, fakeMessage('sign tx'))).toBe(
      true
    )
  })

  it('validate() returns false only when the service is not registered at all', async () => {
    const runtime = { getService: () => null } as any
    expect(await signTxAction.validate(runtime, fakeMessage('sign tx'))).toBe(
      false
    )
  })

  it('validate() returns true on Sui chain (signTx supports Sui)', async () => {
    const runtime = fakeRuntime({
      getChainFamily: () => 'sui',
      getChainState: () => ({
        family: 'sui',
        network: 'mainnet',
        canonical: 'sui:mainnet'
      })
    })
    expect(await signTxAction.validate(runtime, fakeMessage('sign tx'))).toBe(
      true
    )
  })

  it('preview does not announce 2FA preemptively (matches the sendTx fix)', async () => {
    // Same regression class as sendTx: previous preview text always
    // ended with "Waiting for 2FA approval..." regardless of whether
    // the wallet's policy actually required 2FA. Renderer drives the
    // 2FA prompt from the awaiting_2fa CLI event instead.
    const callback = vi.fn()
    await signTxAction.handler(
      fakeRuntime(),
      fakeMessage(
        'sign a tx to 0x1234567890abcdef1234567890abcdef12345678 for 0.1 ETH'
      ),
      undefined,
      {},
      callback
    )

    // Pre-action preview was removed entirely (Fix A: no stale preview on
    // pre-flight failures). The successful sign-tx output should still
    // mention the no-broadcast nature, and NO callback should preemptively
    // talk about 2FA approval — that copy now comes only from the
    // awaiting_2fa CLI event via renderEvent.
    const allText = callback.mock.calls
      .map((c: any[]) => String(c[0]?.text ?? ''))
      .join('\n')
    expect(allText).toContain('not broadcast')
    expect(allText).not.toContain('Waiting for 2FA')
    expect(allText).not.toContain('2FA approval')
  })

  it('error path: reports service failure', async () => {
    const runtime = fakeRuntime({
      signTx: vi
        .fn()
        .mockRejectedValue(new WaapError('policy rejected', 'POLICY_REJECTED'))
    })
    const callback = vi.fn()
    const result = await signTxAction.handler(
      runtime,
      fakeMessage(
        'sign a tx to 0x1234567890abcdef1234567890abcdef12345678 for 0.1 ETH'
      ),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect((result as any).text).toContain('policy rejected')
  })

  it('Sui: surfaces signature + txBytes when the CLI returns no signedTx (parity)', async () => {
    const runtime = fakeRuntime({
      getChainFamily: () => 'sui',
      getChainState: () => ({ family: 'sui', canonical: 'sui:mainnet' }),
      signTx: vi.fn().mockResolvedValue({
        // Sui sign-tx returns signature + txBytes, NOT signedTx.
        signedTx: '',
        address: '0xsuiaddr',
        signature: '0xsuisig',
        txBytes: 'dHhieXRlcw=='
      })
    })
    // Sui needs a 64-hex address and an integer MIST value (the handler now
    // rejects EVM-length addresses / fractional MIST before signing).
    runtime.useModel = vi
      .fn()
      .mockResolvedValue(
        JSON.stringify({ to: `0x${'a'.repeat(64)}`, value: '500000000' })
      )
    const callback = vi.fn()
    const result = await signTxAction.handler(
      runtime,
      fakeMessage(
        'sign a tx to 0x1234567890abcdef1234567890abcdef12345678 for 0.1 SUI'
      ),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    expect((result as any).data).toMatchObject({
      signature: '0xsuisig',
      txBytes: 'dHhieXRlcw=='
    })
    const final = callback.mock.calls[callback.mock.calls.length - 1][0]
    expect(final.text).toContain('0xsuisig')
    expect(final.text).toContain('dHhieXRlcw==')
  })
})
