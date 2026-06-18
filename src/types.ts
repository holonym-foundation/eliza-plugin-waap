
/** Chain family — high-level routing discriminator. */
export type ChainFamily = 'evm' | 'sui'

/**
 * Canonical namespaced chain identifier — what the CLI expects on the wire.
 * Examples: 'evm:1' (Ethereum mainnet), 'evm:137' (Polygon), 'evm:8453' (Base),
 * 'sui:mainnet', 'sui:testnet', 'sui:devnet'.
 * Matches CHAIN_EVM_1 / CHAIN_SUI_MAINNET constants in waap-cli's sui branch.
 */
export type ChainId = `evm:${number}` | `sui:${string}`

export type TwoFaMethod =
  | 'email'
  | 'telegram'
  | 'external_wallet'
  | 'phone'
  | 'disabled'

export interface WaapPolicy {
  authorizationMethod: TwoFaMethod
  dailySpendLimitUsd?: number
  minRiskFor2fa?: string
}

/**
 * Discriminated union — captures EVM's numeric chainId and Sui's network name.
 * Use `state.family === 'evm'` to narrow.
 */
export type WaapChainState =
  | { family: 'evm'; chainId: number; canonical: ChainId }
  | { family: 'sui'; network: string; canonical: ChainId }

export interface WaapWalletState {
  evmAddress: string
  suiAddress: string
  chainState: WaapChainState
  policy: WaapPolicy
}

// ── Action input types ──

export interface GetBalanceInput {
  chainId?: number | string // EVM chain id or Sui chain string (e.g. 'sui:mainnet')
  rpc?: string // RPC URL override
}

export interface SignMessageInput {
  message: string
  permissionToken?: string
}

export interface SignTypedDataInput {
  data: object
  permissionToken?: string
}

export interface SendTxInput {
  to?: string
  value?: string // ETH for EVM, MIST for Sui
  chainId?: number // EVM chain id
  chain?: string // canonical chain string (e.g. 'evm:1', 'sui:mainnet')
  rpc?: string
  data?: string // EVM only — contract calldata
  legacy?: boolean // EVM only — Type 0 tx
  permissionToken?: string
}

export interface SetPolicyInput {
  dailySpendLimitUsd?: number
}

export interface SignTxInput {
  to: string
  value?: string
  chainId?: number
  rpc?: string
  data?: string
  legacy?: boolean
  permissionToken?: string
}

export interface RequestInput {
  method: string
  params?: unknown[]
  chainId?: number
  rpc?: string
}

/** Method + destination for enabling 2FA. Exactly one destination field must be set. */
export interface Enable2faInput {
  method: Exclude<TwoFaMethod, 'disabled'>
  /** Email address (required when method is 'email'). */
  email?: string
  /** Phone number in E.164 format, e.g. "+15551234567" (required when method is 'phone'). */
  phoneNumber?: string
  /** Telegram chat ID (required when method is 'telegram'). */
  telegramChatId?: string
  /** External wallet address (required when method is 'external_wallet'). */
  walletAddress?: string
}
