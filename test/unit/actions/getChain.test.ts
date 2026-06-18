// Tests WAAP_GET_CHAIN — single-line answer routed through the action
// callback so the LLM can't shortcut and guess the chain from history.

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { getChainAction } from '../../../src/actions/getChain'

function fakeService(over: Partial<any> = {}) {
  return {
    isReady: () => true,
    getChainState: () => ({
      family: 'evm',
      chainId: 1,
      canonical: 'evm:1'
    }),
    ...over
  }
}

const message = (text = 'what chain') =>
  ({ content: { text, source: 'discord' }, roomId: 'r' }) as any

const messageNoSource = (text = 'what chain') =>
  ({ content: { text }, roomId: 'r' }) as any

const runtime = (svc: any, sendMessageToTarget?: any) =>
  ({
    agentId: 'test-agent',
    sendMessageToTarget,
    getService: () => svc
  }) as any

describe('getChainAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('has WAAP_GET_CHAIN name and chain-question similes', () => {
    expect(getChainAction.name).toBe('WAAP_GET_CHAIN')
    expect(getChainAction.similes).toContain('ACTIVE_CHAIN')
    expect(getChainAction.similes).toContain('MY_CHAIN')
    expect(getChainAction.similes).toContain('WHAT_CHAIN')
  })

  it('validate() returns true even when service is not ready', async () => {
    expect(
      await getChainAction.validate(
        runtime(fakeService({ isReady: () => false })),
        message()
      )
    ).toBe(true)
  })

  it('not logged in: emits sign-up / log-in instructions via callback (success=true)', async () => {
    const callback = vi.fn()
    const result = await getChainAction.handler(
      runtime(fakeService({ isReady: () => false })),
      messageNoSource(),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    expect((result as any).data).toMatchObject({ loggedIn: false })
    const cbText = callback.mock.calls[0][0].text as string
    expect(cbText).toMatch(/not logged in/i)
    expect(cbText).toMatch(/sign up|log in/i)
  })

  it('logged in (EVM): callback returns single-line chain summary with display name + canonical', async () => {
    const callback = vi.fn()
    await getChainAction.handler(
      runtime(fakeService()),
      messageNoSource(),
      undefined,
      {},
      callback
    )
    const cbText = callback.mock.calls[0][0].text as string
    // Must include canonical identifier (LLM uses this in next turn)
    expect(cbText).toContain('evm:1')
    // Must include human-readable name (user-friendly)
    expect(cbText.toLowerCase()).toMatch(/ethereum|chain id 1/)
    // Single-line — no newlines to mangle
    expect(cbText).not.toContain('\n')
  })

  it('logged in (Sui): callback returns the canonical sui:<network> string + family hint', async () => {
    const callback = vi.fn()
    await getChainAction.handler(
      runtime(
        fakeService({
          getChainState: () => ({
            family: 'sui',
            network: 'mainnet',
            canonical: 'sui:mainnet'
          })
        })
      ),
      messageNoSource(),
      undefined,
      {},
      callback
    )
    const cbText = callback.mock.calls[0][0].text as string
    expect(cbText).toContain('sui:mainnet')
  })

  it('content payload includes structured chain fields for grounding', async () => {
    const callback = vi.fn()
    await getChainAction.handler(
      runtime(fakeService()),
      messageNoSource(),
      undefined,
      {},
      callback
    )
    expect(callback.mock.calls[0][0].content).toMatchObject({
      canonical: 'evm:1',
      family: 'evm',
      chainId: 1
    })
  })

  it('rejects when service is not registered', async () => {
    const callback = vi.fn()
    const result = await getChainAction.handler(
      { getService: () => null } as any,
      messageNoSource(),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
  })
})
