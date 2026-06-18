// Tests WAAP_LIST_CHAINS — supported-chain list routed through the action
// callback (real newlines render correctly) instead of free-form REPLY.

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { listChainsAction } from '../../../src/actions/listChains'

const messageWithSource = () =>
  ({ content: { text: 'list chains', source: 'discord' }, roomId: 'r' }) as any

const messageWithoutSource = () =>
  ({ content: { text: 'list chains' }, roomId: 'r' }) as any

const fakeRuntime = (sendMessageToTarget?: any) =>
  ({
    agentId: 'test-agent',
    sendMessageToTarget,
    getService: () => null // listChains needs no service — chain defs are static
  }) as any

describe('listChainsAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('has WAAP_LIST_CHAINS name and chain-list similes', () => {
    expect(listChainsAction.name).toBe('WAAP_LIST_CHAINS')
    expect(listChainsAction.similes).toContain('SUPPORTED_CHAINS')
    expect(listChainsAction.similes).toContain('LIST_CHAINS')
  })

  it('validate() always returns true (chain list is static, available pre-login)', async () => {
    expect(
      await listChainsAction.validate(fakeRuntime(), messageWithSource())
    ).toBe(true)
    // Even with no runtime/service:
    expect(
      await listChainsAction.validate({} as any, messageWithoutSource())
    ).toBe(true)
  })

  it('live channel ok: callback gets terse line; rich list via sendMessageToTarget', async () => {
    const sendMessageToTarget = vi.fn().mockResolvedValue(undefined)
    const callback = vi.fn()
    await listChainsAction.handler(
      fakeRuntime(sendMessageToTarget),
      messageWithSource(),
      undefined,
      {},
      callback
    )

    const cbText = callback.mock.calls[0][0].text as string
    expect(cbText).not.toContain('\n')

    const liveText = sendMessageToTarget.mock.calls[0][1].text as string
    // EVM section
    expect(liveText).toContain('EVM chains')
    expect(liveText).toContain('chainId 1')
    expect(liveText).toContain('chainId 137')
    // Sui section
    expect(liveText).toContain('Sui networks')
    expect(liveText).toContain('sui:mainnet')
    expect(liveText).toContain('sui:testnet')
    expect(liveText).toContain('sui:devnet')
    // Real newlines, not escapes
    expect(liveText).toContain('\n')
    expect(liveText).not.toContain('\\n')
  })

  it('live channel unavailable: rich list falls into the callback', async () => {
    const callback = vi.fn()
    await listChainsAction.handler(
      fakeRuntime(undefined),
      messageWithoutSource(),
      undefined,
      {},
      callback
    )
    const cbText = callback.mock.calls[0][0].text as string
    expect(cbText).toContain('chainId 1')
    expect(cbText).toContain('sui:mainnet')
    expect(cbText).toContain('\n')
  })

  it('content payload includes structured EVM + Sui lists for LLM grounding', async () => {
    const callback = vi.fn()
    await listChainsAction.handler(
      fakeRuntime(vi.fn().mockResolvedValue(undefined)),
      messageWithSource(),
      undefined,
      {},
      callback
    )
    const content = callback.mock.calls[0][0].content
    expect(content.evmChains).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chainId: 1, name: expect.any(String) }),
        expect.objectContaining({ chainId: 137, name: expect.any(String) })
      ])
    )
    expect(content.suiNetworks).toEqual([
      'sui:mainnet',
      'sui:testnet',
      'sui:devnet'
    ])
  })

  it('groups EVM chain aliases under their canonical chain ID (no duplicate IDs)', async () => {
    // CHAIN_NAMES has multiple aliases per ID (eth/mainnet/ethereum → 1).
    // The list should show each chain ID exactly once.
    const callback = vi.fn()
    await listChainsAction.handler(
      fakeRuntime(vi.fn().mockResolvedValue(undefined)),
      messageWithSource(),
      undefined,
      {},
      callback
    )
    const evmChains = callback.mock.calls[0][0].content.evmChains as Array<{
      chainId: number
    }>
    const ids = evmChains.map((c) => c.chainId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
