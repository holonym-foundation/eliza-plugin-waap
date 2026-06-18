import { describe, it, expect, vi, beforeEach } from 'vitest'

import { requestAction } from '../../../src/actions/request'
import { WaapError } from '../../../src/errors'

function fakeRuntime(svcOverrides: Partial<any> = {}) {
  return {
    agentId: 'test-agent',
    getSetting: (_k: string) => undefined,
    useModel: vi
      .fn()
      .mockResolvedValue(JSON.stringify({ method: 'eth_blockNumber' })),
    composeState: vi.fn().mockResolvedValue({ values: {}, data: {}, text: '' }),
    getService: (_t: any) => ({
      isReady: () => true,
      getAddress: () => '0xabc',
      getChainFamily: () => 'evm',
      getChainState: () => ({ family: 'evm', chainId: 1, canonical: 'evm:1' }),
      request: vi.fn().mockResolvedValue({ data: '0x1234' }),
      ...svcOverrides
    })
  } as any
}

const fakeMessage = (text: string) =>
  ({ content: { text }, userId: 'u', roomId: 'r', agentId: 'a' } as any)

describe('requestAction', () => {
  beforeEach(() => vi.clearAllMocks())

  // Default-deny allowlist: state-changing / signing RPC methods must not be
  // proxied through the read-only passthrough.
  it('rejects a state-changing RPC method (eth_sendRawTransaction)', async () => {
    const requestSpy = vi.fn().mockResolvedValue({ data: '0x' })
    const runtime = fakeRuntime({ request: requestSpy })
    runtime.useModel = vi.fn().mockResolvedValue(
      JSON.stringify({
        method: 'eth_sendRawTransaction',
        params: ['0xdeadbeef']
      })
    )
    const callback = vi.fn()
    const result = await requestAction.handler(
      runtime,
      fakeMessage('eth_sendRawTransaction 0xdeadbeef'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect(requestSpy).not.toHaveBeenCalled()
    expect((result as any).text).toMatch(/read-only|WAAP_SEND_TX/i)
  })

  it('allows a read-only method (eth_blockNumber)', async () => {
    const requestSpy = vi.fn().mockResolvedValue({ data: '0x10' })
    const runtime = fakeRuntime({ request: requestSpy })
    runtime.useModel = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ method: 'eth_blockNumber' }))
    const result = await requestAction.handler(
      runtime,
      fakeMessage('block number'),
      undefined,
      {},
      vi.fn()
    )
    expect(result).toMatchObject({ success: true })
    expect(requestSpy).toHaveBeenCalled()
  })

  it('has WAAP_REQUEST name and expected similes', () => {
    expect(requestAction.name).toBe('WAAP_REQUEST')
    expect(requestAction.similes).toContain('RPC_REQUEST')
    expect(requestAction.similes).toContain('JSON_RPC')
  })

  it('validate() returns true when service is ready and on EVM', async () => {
    expect(
      await requestAction.validate(fakeRuntime(), fakeMessage('block number'))
    ).toBe(true)
  })

  it('validate() returns true even when service is not ready (handler emits "please log in first")', async () => {
    const runtime = { getService: () => ({ isReady: () => false }) } as any
    expect(
      await requestAction.validate(runtime, fakeMessage('block number'))
    ).toBe(true)
  })

  it('validate() returns false only when the service is not registered at all', async () => {
    const runtime = { getService: () => null } as any
    expect(
      await requestAction.validate(runtime, fakeMessage('block number'))
    ).toBe(false)
  })

  it('validate() stays true on Sui chain — the handler emits the EVM-only rejection so the user sees a real message instead of a silent no-op', async () => {
    const runtime = fakeRuntime({
      getChainFamily: () => 'sui'
    })
    expect(
      await requestAction.validate(runtime, fakeMessage('block number'))
    ).toBe(true)
  })

  it('handler rejects when on Sui chain', async () => {
    const runtime = fakeRuntime({
      getChainFamily: () => 'sui'
    })
    const callback = vi.fn()
    const result = await requestAction.handler(
      runtime,
      fakeMessage('block number'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect((result as any).text).toContain('EVM chains')
  })

  it('error path: reports service failure', async () => {
    const runtime = fakeRuntime({
      request: vi
        .fn()
        .mockRejectedValue(new WaapError('rpc unreachable', 'NETWORK'))
    })
    const callback = vi.fn()
    const result = await requestAction.handler(
      runtime,
      fakeMessage('get block number'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect((result as any).text).toContain('rpc unreachable')
  })
})
