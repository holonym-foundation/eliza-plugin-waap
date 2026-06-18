import type { WaapChainState, ChainId } from './types'

export const CHAIN_NAMES: Record<string, number> = {
  ethereum: 1,
  mainnet: 1,
  eth: 1,
  sepolia: 11155111,
  polygon: 137,
  matic: 137,
  arbitrum: 42161,
  base: 8453,
  optimism: 10,
  avalanche: 43114,
  avax: 43114,
  bsc: 56,
  bnb: 56,
  binance: 56
}

export const SUI_NETWORKS = ['mainnet', 'testnet', 'devnet'] as const
export type SuiNetwork = (typeof SUI_NETWORKS)[number]

/**
 * Resolve a user-provided chain identifier to a WaapChainState.
 *
 * Accepts:
 *   - EVM chain names: "polygon", "base", "arbitrum"
 *   - EVM numeric IDs: 137, 42161
 *   - Namespaced EVM: "evm:137", "evm:8453"
 *   - Sui bare: "sui" → defaults to mainnet
 *   - Sui namespaced: "sui:mainnet", "sui:testnet", "sui:devnet"
 *
 * Returns null if the input can't be resolved.
 */
export function resolveChain(input: string | number): WaapChainState | null {
  if (typeof input === 'number') {
    return input > 0
      ? {
          family: 'evm',
          chainId: input,
          canonical: `evm:${input}` as ChainId
        }
      : null
  }

  const normalized = input.trim().toLowerCase()

  // Namespaced Sui: "sui:mainnet", "sui:testnet", "sui:devnet"
  if (normalized.startsWith('sui:')) {
    const network = normalized.slice(4)
    if (!SUI_NETWORKS.includes(network as SuiNetwork)) return null
    return { family: 'sui', network, canonical: `sui:${network}` as ChainId }
  }

  // Bare "sui" → defaults to mainnet
  if (normalized === 'sui') {
    return {
      family: 'sui',
      network: 'mainnet',
      canonical: 'sui:mainnet' as ChainId
    }
  }

  // Namespaced EVM: "evm:137"
  if (normalized.startsWith('evm:')) {
    const num = Number(normalized.slice(4))
    if (isNaN(num) || num <= 0) return null
    return { family: 'evm', chainId: num, canonical: `evm:${num}` as ChainId }
  }

  // Numeric string: "137"
  const asNumber = Number(normalized)
  if (!isNaN(asNumber) && asNumber > 0) {
    return {
      family: 'evm',
      chainId: asNumber,
      canonical: `evm:${asNumber}` as ChainId
    }
  }

  // Named EVM chain: "polygon", "base", etc.
  const chainId = CHAIN_NAMES[normalized]
  if (chainId !== undefined) {
    return { family: 'evm', chainId, canonical: `evm:${chainId}` as ChainId }
  }

  return null
}

/**
 * Human-readable display name for a chain state.
 * EVM: returns the first name longer than 3 chars (e.g. "ethereum" for 1, "polygon" for 137).
 * Sui: returns "sui:network" (e.g. "sui:mainnet").
 */
export function chainDisplayName(state: WaapChainState): string {
  if (state.family === 'sui') return state.canonical

  for (const [name, id] of Object.entries(CHAIN_NAMES)) {
    if (id === state.chainId && name.length > 3) return name
  }

  return `chain ${state.chainId}`
}

/** List of supported chain names for error messages. */
export function supportedChainsText(): string {
  const evmNames = [...new Set(Object.values(CHAIN_NAMES))].map((id) => {
    for (const [name, cid] of Object.entries(CHAIN_NAMES)) {
      if (cid === id && name.length > 3) return name
    }
    return `chain ${id}`
  })
  return [...evmNames, 'sui', 'sui:testnet', 'sui:devnet'].join(', ')
}

// ── Backward compat (used by old resolveChainId callers) ──

/** @deprecated Use resolveChain() instead */
export function resolveChainId(input: string | number): number | null {
  const state = resolveChain(input)
  if (!state || state.family !== 'evm') return null
  return state.chainId
}

/** @deprecated Use chainDisplayName() instead */
export function chainIdToName(chainId: number): string {
  return chainDisplayName({
    family: 'evm',
    chainId,
    canonical: `evm:${chainId}` as ChainId
  })
}
