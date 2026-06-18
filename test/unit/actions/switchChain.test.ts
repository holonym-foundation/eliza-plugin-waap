import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/actions/paramExtraction', async () => {
  const actual = await vi.importActual<any>(
    '../../../src/actions/paramExtraction'
  )
  return { ...actual, extractSwitchChainParams: vi.fn() }
})

import { switchChainAction } from '../../../src/actions/switchChain'
import { extractSwitchChainParams } from '../../../src/actions/paramExtraction'
import { WaapError } from '../../../src/errors'

function fakeRuntime(svcOverrides: Partial<any> = {}) {
  return {
    agentId: 'test-agent',
    getSetting: (_k: string) => undefined,
    getService: (_t: any) => ({
      isReady: () => true,
      switchChain: vi.fn(),
      ...svcOverrides
    })
  } as any
}

const fakeMessage = (text: string) =>
  ({ content: { text }, userId: 'u', roomId: 'r', agentId: 'a' }) as any

describe('switchChainAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('has WAAP_SWITCH_CHAIN name and expected similes', () => {
    expect(switchChainAction.name).toBe('WAAP_SWITCH_CHAIN')
    expect(switchChainAction.similes).toContain('CHANGE_CHAIN')
    expect(switchChainAction.similes).toContain('SET_CHAIN')
    expect(switchChainAction.similes).toContain('USE_NETWORK')
  })

  it('validate() returns true when service is ready', async () => {
    expect(
      await switchChainAction.validate(
        fakeRuntime(),
        fakeMessage('switch chain')
      )
    ).toBe(true)
  })

  it('validate() returns true even when service is not ready (handler emits "please log in first")', async () => {
    const runtime = fakeRuntime({ isReady: () => false })
    expect(
      await switchChainAction.validate(runtime, fakeMessage('switch chain'))
    ).toBe(true)
  })

  it('validate() returns false when no service exists', async () => {
    const runtime = { getService: () => null } as any
    expect(
      await switchChainAction.validate(runtime, fakeMessage('switch chain'))
    ).toBe(false)
  })

  it('happy path: extracts chain name, resolves to chainId, calls svc.switchChain', async () => {
    ;(extractSwitchChainParams as any).mockResolvedValue({
      ok: true,
      value: { chain: 'polygon' }
    })
    const callback = vi.fn()
    const result = await switchChainAction.handler(
      fakeRuntime(),
      fakeMessage('Switch to Polygon'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    expect((result as any).data).toMatchObject({
      chainState: { family: 'evm', chainId: 137, canonical: 'evm:137' },
      name: 'polygon'
    })
    const final = callback.mock.calls[callback.mock.calls.length - 1][0]
    expect(final.text).toContain('Switched to polygon')
    expect(final.text).toContain('chain ID 137')
  })

  it('happy path with numeric chain ID', async () => {
    ;(extractSwitchChainParams as any).mockResolvedValue({
      ok: true,
      value: { chain: 42161 }
    })
    const callback = vi.fn()
    const result = await switchChainAction.handler(
      fakeRuntime(),
      fakeMessage('Use chain 42161'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    expect((result as any).data).toMatchObject({
      chainState: { family: 'evm', chainId: 42161, canonical: 'evm:42161' }
    })
    const final = callback.mock.calls[callback.mock.calls.length - 1][0]
    expect(final.text).toContain('arbitrum')
    expect(final.text).toContain('42161')
  })

  it('unknown chain: returns error with supported chains list', async () => {
    ;(extractSwitchChainParams as any).mockResolvedValue({
      ok: true,
      value: { chain: 'solana' }
    })
    const callback = vi.fn()
    const result = await switchChainAction.handler(
      fakeRuntime(),
      fakeMessage('Switch to Solana'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Unknown chain')
      })
    )
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('ethereum') })
    )
  })

  it('param extraction failure: returns false, reports error via callback', async () => {
    ;(extractSwitchChainParams as any).mockResolvedValue({
      ok: false,
      error: 'no chain specified'
    })
    const callback = vi.fn()
    const result = await switchChainAction.handler(
      fakeRuntime(),
      fakeMessage('switch'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect((result as any).error).toBeInstanceOf(Error)
    expect((result as any).error.message).toContain('no chain specified')
    const reply = String(callback.mock.calls[0][0]?.text ?? '')
    expect(reply).toMatch(/Which chain/i)
    expect(reply).toMatch(/sui|polygon|ethereum/i)
  })

  it('service error: maps error to user-facing message', async () => {
    ;(extractSwitchChainParams as any).mockResolvedValue({
      ok: true,
      value: { chain: 'polygon' }
    })
    const runtime = fakeRuntime({
      switchChain: vi.fn().mockImplementation(() => {
        throw new WaapError('service not initialized', 'UNKNOWN')
      })
    })
    const callback = vi.fn()
    const result = await switchChainAction.handler(
      runtime,
      fakeMessage('switch'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect((result as any).error).toBeInstanceOf(Error)
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('service not initialized')
      })
    )
  })

  it('no service: returns rejectNoService result', async () => {
    const runtime = { getService: () => null } as any
    const callback = vi.fn()
    const result = await switchChainAction.handler(
      runtime,
      fakeMessage('switch'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('not logged in')
      })
    )
  })

  it('Sui: switch to sui:mainnet returns Sui chain state', async () => {
    ;(extractSwitchChainParams as any).mockResolvedValue({
      ok: true,
      value: { chain: 'sui:mainnet' }
    })
    const callback = vi.fn()
    const result = await switchChainAction.handler(
      fakeRuntime(),
      fakeMessage('Switch to Sui'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    expect((result as any).data).toMatchObject({
      chainState: {
        family: 'sui',
        network: 'mainnet',
        canonical: 'sui:mainnet'
      }
    })
    const final = callback.mock.calls[callback.mock.calls.length - 1][0]
    expect(final.text).toContain('sui:mainnet')
  })

  it('Sui: switch to sui:testnet returns Sui testnet chain state', async () => {
    ;(extractSwitchChainParams as any).mockResolvedValue({
      ok: true,
      value: { chain: 'sui:testnet' }
    })
    const callback = vi.fn()
    const result = await switchChainAction.handler(
      fakeRuntime(),
      fakeMessage('Switch to Sui testnet'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    expect((result as any).data).toMatchObject({
      chainState: {
        family: 'sui',
        network: 'testnet',
        canonical: 'sui:testnet'
      }
    })
    const final = callback.mock.calls[callback.mock.calls.length - 1][0]
    expect(final.text).toContain('sui:testnet')
  })
})
