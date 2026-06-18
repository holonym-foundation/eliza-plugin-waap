import { describe, it, expect } from 'vitest'
import type {
  ChainFamily,
  ChainId,
  WaapChainState,
  WaapPolicy,
  WaapWalletState,
  SignMessageInput,
  SendTxInput,
  SetPolicyInput,
  TwoFaMethod
} from '../../src/types'

describe('types.ts', () => {
  it('ChainFamily is a union of evm | sui', () => {
    const a: ChainFamily = 'evm'
    const b: ChainFamily = 'sui'
    expect(a).toBe('evm')
    expect(b).toBe('sui')
  })

  it('ChainId accepts canonical namespaced strings', () => {
    const evm: ChainId = 'evm:137'
    const sui: ChainId = 'sui:mainnet'
    expect(evm).toBe('evm:137')
    expect(sui).toBe('sui:mainnet')
  })

  it('WaapChainState narrows on family for EVM', () => {
    const s: WaapChainState = {
      family: 'evm',
      chainId: 137,
      canonical: 'evm:137'
    }
    expect(s.family).toBe('evm')
    if (s.family === 'evm') {
      expect(s.chainId).toBe(137)
    }
  })

  it('WaapChainState narrows on family for Sui', () => {
    const s: WaapChainState = {
      family: 'sui',
      network: 'mainnet',
      canonical: 'sui:mainnet'
    }
    if (s.family === 'sui') {
      expect(s.network).toBe('mainnet')
    }
  })

  it('WaapWalletState composes evmAddress + suiAddress + chainState + policy', () => {
    const state: WaapWalletState = {
      evmAddress: '0x' + 'ab'.repeat(20),
      suiAddress: '0x' + 'cd'.repeat(32),
      chainState: { family: 'evm', chainId: 1, canonical: 'evm:1' },
      policy: {
        authorizationMethod: 'disabled',
        dailySpendLimitUsd: 500
      }
    }
    expect(state.evmAddress).toMatch(/^0x[0-9a-f]{40}$/)
    expect(state.suiAddress).toMatch(/^0x[0-9a-f]{64}$/)
    expect(state.chainState.family).toBe('evm')
    expect(state.policy.dailySpendLimitUsd).toBe(500)
  })

  it('accepts evmAddress + suiAddress with Sui chain state', () => {
    const state: WaapWalletState = {
      evmAddress: '0x' + 'ab'.repeat(20),
      suiAddress: '0x' + 'cd'.repeat(32),
      chainState: {
        family: 'sui',
        network: 'mainnet',
        canonical: 'sui:mainnet'
      },
      policy: { authorizationMethod: 'disabled' }
    }
    expect(state.chainState.family).toBe('sui')
  })

  it('TwoFaMethod includes all documented values', () => {
    const methods: TwoFaMethod[] = [
      'email',
      'telegram',
      'external_wallet',
      'phone',
      'disabled'
    ]
    expect(methods).toHaveLength(5)
  })

  it('SendTxInput has optional EVM and Sui fields', () => {
    const evm: SendTxInput = {
      to: '0xdead',
      value: '0.01',
      chainId: 1
    }
    expect(evm.to).toBe('0xdead')

    const sui: SendTxInput = {
      to: '0x' + 'ab'.repeat(32),
      value: '1000000000',
      chain: 'sui:mainnet'
    }
    expect(sui.chain).toBe('sui:mainnet')
  })

  it('SignMessageInput accepts message + optional permissionToken', () => {
    const i: SignMessageInput = { message: 'hi' }
    expect(i.message).toBe('hi')

    const j: SignMessageInput = { message: 'hi', permissionToken: 'tok' }
    expect(j.permissionToken).toBe('tok')
  })

  it('SetPolicyInput has optional dailySpendLimitUsd', () => {
    const p: SetPolicyInput = { dailySpendLimitUsd: 500 }
    expect(p.dailySpendLimitUsd).toBe(500)
  })
})
