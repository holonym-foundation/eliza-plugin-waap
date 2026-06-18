import { describe, it, expect } from 'vitest'
import { waapWalletProvider } from '../../src/provider'
import type { WaapWalletState } from '../../src/types'
import type { PendingAuthz } from '../../src/services/WaapService'

function fakeRuntime(
  state: WaapWalletState | null,
  pending: PendingAuthz | null = null
) {
  return {
    getService: () =>
      state
        ? {
            isReady: () => true,
            getState: () => state,
            getChainState: () => state.chainState,
            getCanonicalChain: () => state.chainState.canonical,
            getPolicy: () => state.policy,
            getAddress: () =>
              state.chainState.family === 'sui'
                ? state.suiAddress
                : state.evmAddress,
            getPendingAuthz: () => pending
          }
        : null
  } as any
}

const message = { content: { text: 'test' } } as any
const stateArg = {} as any

describe('waapWalletProvider', () => {
  it('returns logged-out grounding when service is not present', async () => {
    const result = await waapWalletProvider.get!(
      fakeRuntime(null),
      message,
      stateArg
    )
    expect(result.text).toContain('not logged in')
    expect(result.values).toMatchObject({ waapLoggedIn: false })
  })

  it('returns logged-out grounding when service exists but is not ready', async () => {
    const runtime = {
      getService: () => ({ isReady: () => false })
    } as any
    const result = await waapWalletProvider.get!(runtime, message, stateArg)
    expect(result.text).toContain('not logged in')
    expect(result.values).toMatchObject({ waapLoggedIn: false })
  })

  it('returns wallet state for ready EVM service', async () => {
    const walletState: WaapWalletState = {
      evmAddress: '0xabc',
      suiAddress: '0x' + 'cd'.repeat(32),
      chainState: { family: 'evm', chainId: 137, canonical: 'evm:137' },
      policy: {
        authorizationMethod: 'telegram',
        dailySpendLimitUsd: 500
      }
    }
    const result = await waapWalletProvider.get!(
      fakeRuntime(walletState),
      message,
      stateArg
    )
    expect(result.text).toContain('0xabc')
    expect(result.text).toContain('evm:137')
    expect(result.text).toContain('telegram')
    expect(result.text).toContain('500')
  })

  it('exposes structured values', async () => {
    const walletState: WaapWalletState = {
      evmAddress: '0xdef',
      suiAddress: '0x' + 'ab'.repeat(32),
      chainState: { family: 'evm', chainId: 1, canonical: 'evm:1' },
      policy: { authorizationMethod: 'disabled' }
    }
    const result = await waapWalletProvider.get!(
      fakeRuntime(walletState),
      message,
      stateArg
    )
    expect(result.values).toMatchObject({
      waapAddress: '0xdef',
      waapEvmAddress: '0xdef',
      waapSuiAddress: '0x' + 'ab'.repeat(32),
      waapChainCanonical: 'evm:1',
      waapChainFamily: 'evm',
      waapEvmChainId: 1,
      waap2faMethod: 'disabled'
    })
  })

  it('handles missing dailySpendLimitUsd gracefully', async () => {
    const walletState: WaapWalletState = {
      evmAddress: '0xabc',
      suiAddress: '0x' + 'cd'.repeat(32),
      chainState: { family: 'evm', chainId: 1, canonical: 'evm:1' },
      policy: { authorizationMethod: 'disabled' }
    }
    const result = await waapWalletProvider.get!(
      fakeRuntime(walletState),
      message,
      stateArg
    )
    expect(result.text).toContain('no limit set')
  })

  it('grounds the logged-in status and supported-chains list', async () => {
    const walletState: WaapWalletState = {
      evmAddress: '0xabc',
      suiAddress: '0x' + 'cd'.repeat(32),
      chainState: { family: 'evm', chainId: 1, canonical: 'evm:1' },
      policy: { authorizationMethod: 'disabled' }
    }
    const result = await waapWalletProvider.get!(
      fakeRuntime(walletState),
      message,
      stateArg
    )
    expect(result.text).toContain('logged in')
    expect(result.text).toContain('Supported chains')
    expect(result.text).toContain('polygon')
    expect(result.text).toContain('Pending 2FA: none')
    expect(result.values).toMatchObject({ waapLoggedIn: true })
  })

  it('grounds pending authz so the LLM cannot deny it', async () => {
    const walletState: WaapWalletState = {
      evmAddress: '0xabc',
      suiAddress: '0x' + 'cd'.repeat(32),
      chainState: { family: 'evm', chainId: 1, canonical: 'evm:1' },
      policy: { authorizationMethod: 'email' }
    }
    const pending: PendingAuthz = {
      kind: 'send-tx',
      startedAt: Date.UTC(2026, 3, 30, 12, 0, 0),
      method: 'email',
      payloadId: '0xdeadbeef'
    }
    const result = await waapWalletProvider.get!(
      fakeRuntime(walletState, pending),
      message,
      stateArg
    )
    expect(result.text).toContain('Pending 2FA: a send-tx request')
    expect(result.text).toContain('email')
    expect(result.values).toMatchObject({
      waapPendingAuthzKind: 'send-tx',
      waapPendingAuthzMethod: 'email'
    })
  })

  it('exposes Sui values when on Sui chain', async () => {
    const suiAddr = '0x' + 'ab'.repeat(32)
    const walletState: WaapWalletState = {
      evmAddress: '0xdef',
      suiAddress: suiAddr,
      chainState: {
        family: 'sui',
        network: 'mainnet',
        canonical: 'sui:mainnet'
      },
      policy: { authorizationMethod: 'disabled' }
    }
    const result = await waapWalletProvider.get!(
      fakeRuntime(walletState),
      message,
      stateArg
    )
    expect(result.text).toContain(suiAddr)
    expect(result.text).toContain('sui:mainnet')
    expect(result.values).toMatchObject({
      waapAddress: suiAddr,
      waapSuiAddress: suiAddr,
      waapChainCanonical: 'sui:mainnet',
      waapChainFamily: 'sui',
      waapSuiNetwork: 'mainnet'
    })
  })
})
