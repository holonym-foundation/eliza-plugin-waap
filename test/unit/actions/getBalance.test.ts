import { describe, it, expect, vi, beforeEach } from 'vitest'

import { getBalanceAction } from '../../../src/actions/getBalance'
import { WaapError } from '../../../src/errors'

function fakeRuntime(svcOverrides: Partial<any> = {}) {
  return {
    agentId: 'test-agent',
    getSetting: (_k: string) => undefined,
    // extractGetBalanceParams needs useModel + composeState
    useModel: vi.fn().mockResolvedValue('{}'),
    composeState: vi.fn().mockResolvedValue({ values: {}, data: {}, text: '' }),
    getService: (_t: any) => ({
      isReady: () => true,
      getAddress: () => '0xabc',
      getState: () => ({
        evmAddress: '0xabc',
        suiAddress: '0xsui123',
        chainState: { family: 'evm', chainId: 1, canonical: 'evm:1' },
        policy: { authorizationMethod: 'disabled' }
      }),
      getChainState: () => ({ family: 'evm', chainId: 1, canonical: 'evm:1' }),
      getChainFamily: () => 'evm',
      getBalance: vi.fn().mockResolvedValue({
        balanceRaw: '0xde0b6b3a7640000',
        balanceFormatted: '1',
        chainId: 'evm:1',
        address: '0xabc'
      }),
      ...svcOverrides
    })
  } as any
}

const fakeMessage = (text: string) =>
  ({ content: { text }, userId: 'u', roomId: 'r', agentId: 'a' }) as any

describe('getBalanceAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('has WAAP_GET_BALANCE name and expected similes', () => {
    expect(getBalanceAction.name).toBe('WAAP_GET_BALANCE')
    expect(getBalanceAction.similes).toContain('GET_BALANCE')
    expect(getBalanceAction.similes).toContain('CHECK_BALANCE')
  })

  it('validate() returns true when service is ready', async () => {
    expect(
      await getBalanceAction.validate(fakeRuntime(), fakeMessage('balance'))
    ).toBe(true)
  })

  it('validate() returns true even when service is not ready (handler emits a usable not-logged-in action card)', async () => {
    const runtime = { getService: () => ({ isReady: () => false }) } as any
    expect(
      await getBalanceAction.validate(runtime, fakeMessage('balance'))
    ).toBe(true)
  })

  it('not logged in: emits a usable action-card with sign-up / log-in instructions (success=true, NOT a canned reject)', async () => {
    // Same anti-NONE pattern as WAAP_GET_ADDRESS / WAAP_WALLET_STATUS — we
    // need the LLM to keep dispatching this action on follow-up balance
    // questions instead of picking NONE because conversation history says
    // "not logged in".
    const runtime = {
      agentId: 'a',
      getService: () => ({ isReady: () => false })
    } as any
    const callback = vi.fn()
    const result = await getBalanceAction.handler(
      runtime,
      fakeMessage('balance'),
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

  it('validate() returns false only when the service is not registered at all', async () => {
    const runtime = { getService: () => null } as any
    expect(
      await getBalanceAction.validate(runtime, fakeMessage('balance'))
    ).toBe(false)
  })

  it('happy path: queries both EVM and Sui balances when no chain specified', async () => {
    const callback = vi.fn()
    const result = await getBalanceAction.handler(
      fakeRuntime(),
      fakeMessage("what's my balance"),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    const final = callback.mock.calls[callback.mock.calls.length - 1][0]
    expect(final.text).toContain('EVM:')
    expect(final.text).toContain('1 ETH')
    expect(final.text).toContain('evm:1')
    expect(final.text).toContain('Sui:')
  })

  it('service error: maps WaapError to user-facing message and returns false', async () => {
    const runtime = {
      useModel: vi.fn().mockResolvedValue('{}'),
      composeState: vi
        .fn()
        .mockResolvedValue({ values: {}, data: {}, text: '' }),
      getSetting: (_k: string) => undefined,
      getService: () => ({
        isReady: () => true,
        getAddress: () => '0xabc',
        getState: () => ({
          evmAddress: '0xabc',
          suiAddress: '',
          chainState: { family: 'evm', chainId: 1, canonical: 'evm:1' },
          policy: { authorizationMethod: 'disabled' }
        }),
        getChainFamily: () => 'evm',
        getBalance: vi
          .fn()
          .mockRejectedValue(new WaapError('rpc unreachable', 'NETWORK'))
      })
    } as any
    const callback = vi.fn()
    const result = await getBalanceAction.handler(
      runtime,
      fakeMessage('balance'),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect((result as any).error).toBeInstanceOf(Error)
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('rpc unreachable')
      })
    )
  })

  it('Sui-only query: when LLM extracts chainId="sui:mainnet" from "what is my Sui balance", queries only Sui (not both chains)', async () => {
    // Regression: previously the get-balance schema only accepted numeric
    // chainIds, so "what's my Sui balance" couldn't be expressed and the
    // action fell into the "no chain specified" branch and printed BOTH EVM
    // and Sui balances. With the schema and template now accepting
    // chainId="sui:mainnet", the action takes the single-chain branch and
    // labels the unit as SUI even when the wallet's active chain is EVM.
    const getBalanceMock = vi.fn().mockResolvedValue({
      balanceRaw: '1000000000',
      balanceFormatted: '1',
      chainId: 'sui:mainnet',
      address: '0xsui'
    })
    const runtime = fakeRuntime({ getBalance: getBalanceMock })
    runtime.useModel = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ chainId: 'sui:mainnet' }))

    const callback = vi.fn()
    const result = await getBalanceAction.handler(
      runtime,
      fakeMessage("what's my Sui balance"),
      undefined,
      {},
      callback
    )

    expect(result).toMatchObject({ success: true })
    expect(getBalanceMock).toHaveBeenCalledTimes(1)
    expect(getBalanceMock).toHaveBeenCalledWith({
      chainId: 'sui:mainnet',
      rpc: undefined
    })
    const final = callback.mock.calls[callback.mock.calls.length - 1][0]
    expect(final.text).toContain('1 SUI')
    expect(final.text).toContain('sui:mainnet')
    // Raw on-chain amount appended (CLI parity): Sui shows decimal MIST.
    expect(final.text).toContain('(1000000000 MIST)')
    // Single-chain branch: just one "Balance:" line, not separate EVM+Sui lines
    expect(final.text).not.toContain('EVM balance:')
    expect(final.text).not.toContain('Sui balance:')
  })

  it('Sui balance: shows SUI unit and sui:mainnet chain when active chain is Sui', async () => {
    const suiAddr = '0x' + 'ab'.repeat(32)
    const runtime = fakeRuntime({
      getState: () => ({
        evmAddress: '0xabc',
        suiAddress: suiAddr,
        chainState: {
          family: 'sui',
          network: 'mainnet',
          canonical: 'sui:mainnet'
        },
        policy: { authorizationMethod: 'disabled' }
      }),
      getChainState: () => ({
        family: 'sui',
        network: 'mainnet',
        canonical: 'sui:mainnet'
      }),
      getChainFamily: () => 'sui',
      getAddress: () => suiAddr,
      getBalance: vi.fn().mockResolvedValue({
        balanceRaw: '1000000000',
        balanceFormatted: '1',
        chainId: 'sui:mainnet',
        address: suiAddr
      })
    })
    const callback = vi.fn()
    const result = await getBalanceAction.handler(
      runtime,
      fakeMessage("what's my balance"),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    const final = callback.mock.calls[callback.mock.calls.length - 1][0]
    // Active chain is Sui, so EVM balance line shows SUI unit
    expect(final.text).toContain('1 SUI')
    expect(final.text).toContain('sui:mainnet')
  })
})
