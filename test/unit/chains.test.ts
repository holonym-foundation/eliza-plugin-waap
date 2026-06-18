import { describe, it, expect } from 'vitest'
import {
  resolveChain,
  chainDisplayName,
  supportedChainsText,
  resolveChainId,
  chainIdToName
} from '../../src/chains'

describe('resolveChain', () => {
  // EVM — existing behavior preserved
  it('resolves "polygon" to EVM chain state', () => {
    const result = resolveChain('polygon')
    expect(result).toEqual({
      family: 'evm',
      chainId: 137,
      canonical: 'evm:137'
    })
  })

  it('resolves numeric 42161 to EVM chain state', () => {
    const result = resolveChain(42161)
    expect(result).toEqual({
      family: 'evm',
      chainId: 42161,
      canonical: 'evm:42161'
    })
  })

  it('resolves "evm:8453" to EVM chain state', () => {
    const result = resolveChain('evm:8453')
    expect(result).toEqual({
      family: 'evm',
      chainId: 8453,
      canonical: 'evm:8453'
    })
  })

  it('resolves numeric string "137" to EVM chain state', () => {
    const result = resolveChain('137')
    expect(result).toEqual({
      family: 'evm',
      chainId: 137,
      canonical: 'evm:137'
    })
  })

  // Sui — new behavior
  it('resolves "sui" to sui:mainnet', () => {
    const result = resolveChain('sui')
    expect(result).toEqual({
      family: 'sui',
      network: 'mainnet',
      canonical: 'sui:mainnet'
    })
  })

  it('resolves "sui:testnet" to sui:testnet', () => {
    const result = resolveChain('sui:testnet')
    expect(result).toEqual({
      family: 'sui',
      network: 'testnet',
      canonical: 'sui:testnet'
    })
  })

  it('resolves "sui:devnet" to sui:devnet', () => {
    const result = resolveChain('sui:devnet')
    expect(result).toEqual({
      family: 'sui',
      network: 'devnet',
      canonical: 'sui:devnet'
    })
  })

  it('returns null for unknown chain', () => {
    expect(resolveChain('solana')).toBeNull()
  })

  it('returns null for invalid sui network', () => {
    expect(resolveChain('sui:fakenet')).toBeNull()
  })

  it('returns null for negative number', () => {
    expect(resolveChain(-1)).toBeNull()
  })

  it('returns null for invalid evm: prefix', () => {
    expect(resolveChain('evm:abc')).toBeNull()
  })
})

describe('chainDisplayName', () => {
  it('returns "polygon" for evm:137', () => {
    expect(
      chainDisplayName({ family: 'evm', chainId: 137, canonical: 'evm:137' })
    ).toBe('polygon')
  })

  it('returns "ethereum" for evm:1', () => {
    expect(
      chainDisplayName({ family: 'evm', chainId: 1, canonical: 'evm:1' })
    ).toBe('ethereum')
  })

  it('returns "sui:mainnet" for sui mainnet', () => {
    expect(
      chainDisplayName({
        family: 'sui',
        network: 'mainnet',
        canonical: 'sui:mainnet'
      })
    ).toBe('sui:mainnet')
  })

  it('returns "chain N" for unknown chain id', () => {
    expect(
      chainDisplayName({
        family: 'evm',
        chainId: 99999,
        canonical: 'evm:99999'
      })
    ).toBe('chain 99999')
  })
})

describe('supportedChainsText', () => {
  it('includes both EVM and Sui chains', () => {
    const text = supportedChainsText()
    expect(text).toContain('ethereum')
    expect(text).toContain('polygon')
    expect(text).toContain('sui')
    expect(text).toContain('sui:testnet')
  })
})

describe('backward compat', () => {
  it('resolveChainId returns number for EVM chains', () => {
    expect(resolveChainId('polygon')).toBe(137)
    expect(resolveChainId(42161)).toBe(42161)
  })

  it('resolveChainId returns null for Sui', () => {
    expect(resolveChainId('sui')).toBeNull()
  })

  it('chainIdToName returns name', () => {
    expect(chainIdToName(137)).toBe('polygon')
  })
})
