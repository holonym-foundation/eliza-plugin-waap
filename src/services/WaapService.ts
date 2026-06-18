import os from 'node:os'
import path from 'node:path'

import { Service, ServiceType, type IAgentRuntime } from '@elizaos/core'

import { resolveChain } from '../chains'
import type { CliRunner, CliEvent } from '../cliRunner'
import { createCliRunner, CliError } from '../cliRunner'
import { WaapError, type WaapErrorCode } from '../errors'
import type {
  ChainFamily,
  ChainId,
  WaapChainState,
  WaapPolicy,
  WaapWalletState,
  GetBalanceInput,
  SignMessageInput,
  SignTypedDataInput,
  SendTxInput,
  SignTxInput,
  RequestInput,
  SetPolicyInput,
  Enable2faInput,
  TwoFaMethod
} from '../types'

export interface ProgressContext {
  onEvent?: (e: CliEvent) => void | Promise<void>
}

/** Operation kinds that go through the authz/2FA flow. */
export type AuthzOp =
  | 'send-tx'
  | 'sign-tx'
  | 'sign-message'
  | 'sign-typed-data'
  | 'set-policy'
  | 'enable-2fa'
  | 'disable-2fa'

/** Snapshot describing an in-flight 2FA-requiring operation. */
export interface PendingAuthz {
  /** Operation kind that triggered this authz. */
  kind: AuthzOp
  /** Wall-clock start time (ms). */
  startedAt: number
  /** 2FA method, if known yet (set after the CLI's awaiting_2fa event). */
  method?: TwoFaMethod
  /** Backend-issued payload id (msg_hash hex), if known yet. */
  payloadId?: string
}

export class WaapService extends Service {
  static readonly serviceType = ServiceType.WALLET

  declare runtime: IAgentRuntime

  private runner: CliRunner | null = null

  private sessionDir = ''

  private state: WaapWalletState | null = null

  private ready = false

  // Three-state startup machine:
  //   initializing=true,  ready=false → service is mid-hydration (whoami in flight)
  //   initializing=false, ready=false → no valid saved session; user must sign up / log in
  //   initializing=false, ready=true  → session loaded, all wallet ops available
  //
  // Without this, the provider can't tell the difference between "still booting"
  // and "no session" — both look like ready=false. During the 1–3 sec window
  // while whoami runs after agent restart, that miscategorisation makes the
  // LLM tell the user "you're not logged in" even when there's a perfectly
  // valid session on disk.
  private initializing = true

  // Monotonic session generation. Bumped whenever the authenticated identity
  // ends or is replaced — logout(), and every initialize() (which runs on
  // boot and at the tail of login()/signup()). A 2FA-gated operation that is
  // dispatched non-blocking captures this value and refuses to surface its
  // eventual completion if the epoch has since changed, so a result that
  // lands after the user logged out (or logged into a different account)
  // can't leak into the wrong session. See dispatchAuthzGatedAction.
  private sessionEpoch = 0

  private policyLock: Promise<void> = Promise.resolve()

  /**
   * In-flight 2FA-requiring operation, if any. We allow at most one at a time
   * so that an unresolved approval prompt can't be silently superseded by a
   * concurrent request — this single-flight guard ensures a pending approval
   * always applies to exactly the operation the user is approving, never a
   * later one racing the same approval channel.
   *
   * Cleared in a `finally` block on every authz-gated path, regardless of
   * outcome (success, error, abort).
   */
  private pendingAuthz: {
    info: PendingAuthz
    abort: AbortController
  } | null = null

  constructor(runtime?: IAgentRuntime) {
    super(runtime)

    if (runtime) this.runtime = runtime

    // Runner is created lazily in initialize() so we can read WAAP_CLI_USE_TSX
    // from runtime settings (character.json), not just process.env.
  }

  get capabilityDescription(): string {
    return 'WaaP wallet (2PC-MPC) — sign messages/typed data, send EVM & Sui transactions, manage policy & 2FA'
  }

  static async start(runtime: IAgentRuntime): Promise<WaapService> {
    const svc = new WaapService(runtime)
    await svc.initialize()

    return svc
  }

  /** Test helper — inject a custom runner (bypasses resolveBinary). */
  static async startWithRunner(
    runtime: IAgentRuntime,
    runner: CliRunner
  ): Promise<WaapService> {
    const svc = new WaapService(runtime)
    svc.runner = runner
    await svc.initialize()

    return svc
  }

  async stop(): Promise<void> {
    // Abort any in-flight 2FA-requiring op so we don't leak a CLI subprocess
    // past service shutdown.
    if (this.pendingAuthz) {
      this.pendingAuthz.abort.abort()
      this.pendingAuthz = null
    }
    this.ready = false
    this.initializing = false
    this.state = null
    this.runner = null
  }

  async initialize(): Promise<void> {
    // Mark mid-hydration so the provider can distinguish "still booting" from
    // "no session" while whoami runs. Cleared in the finally block below so
    // every exit path — success, no-session fallback, throw — resets it.
    this.initializing = true

    try {
      // Drop any in-flight 2FA-requiring op on session (re-)initialization.
      // initialize() is also called at the end of signup() and login(), so
      // re-authenticating implicitly invalidates anything left over from a
      // previous session.
      if (this.pendingAuthz) {
        this.pendingAuthz.abort.abort()
        this.pendingAuthz = null
      }

      // Identity is (re-)established here — invalidate any non-blocking 2FA
      // op captured under the prior epoch so its late completion is dropped.
      this.sessionEpoch++

      // Create the runner now that runtime settings are available.
      // WAAP_CLI_USE_TSX can come from character.json settings or env var.
      if (!this.runner) {
        const useTsx =
          this.getSetting('WAAP_CLI_USE_TSX') === '1' ||
          process.env.WAAP_CLI_USE_TSX === '1'

        this.runner = createCliRunner({ useTsx })
      }

      // Treat empty string the same as unset so the default agent-scoped path
      // wins. Otherwise an explicit `WAAP_CLI_SESSION_DIR=''` would propagate
      // through to the CLI subprocess and produce a relative `session.json`
      // path in the agent's cwd — almost certainly not what the operator meant.
      const explicit = this.getSetting('WAAP_CLI_SESSION_DIR')

      this.sessionDir =
        explicit && explicit.length > 0
          ? explicit
          : path.join(os.homedir(), '.eliza', this.runtime.agentId, 'waap')

      // 1. whoami — parse both EVM and Sui addresses. If there's no usable
      //    session but the operator configured WAAP_EMAIL / WAAP_PASSWORD,
      //    log in once with those and retry whoami — so a configured
      //    agent-owned wallet comes up authenticated without waiting for a
      //    chat-triggered WAAP_LOGIN. The credentials come from settings, so
      //    they never enter chat, conversation memory, or any model prompt.
      let evmAddress: string
      let suiAddress: string
      let triedAutoLogin = false

      for (;;) {
        try {
          const res = await this.runCli('whoami', [])

          // Support multiple field naming conventions from CLI versions
          evmAddress = String(
            res.evmAddress ?? res.evmWalletAddress ?? res.address ?? ''
          )
          suiAddress = String(res.suiAddress ?? res.suiWalletAddress ?? '')

          if (!evmAddress) {
            throw new WaapError('whoami returned no address', 'CLI_PROTOCOL')
          }

          break
        } catch (err) {
          const code = this.errCode(err)

          // Treat missing, expired, or corrupt sessions the same: drop to
          // unauthenticated mode so the user can sign up or log in via chat
          // instead of crashing the entire service registration.
          if (
            code === 'NO_SESSION' ||
            code === 'UNKNOWN' ||
            code === 'CLI_PROTOCOL'
          ) {
            const email = this.getSetting('WAAP_EMAIL')
            const password = this.getSetting('WAAP_PASSWORD')

            // Auto-login once from operator config. Call the CLI directly
            // (not this.login(), which would re-enter initialize()) and loop
            // back to whoami on success.
            if (!triedAutoLogin && email && password) {
              triedAutoLogin = true
              try {
                await this.runCli('login', [
                  '--email',
                  email,
                  '--password',
                  password
                ])
                continue
              } catch (loginErr) {
                console.info(
                  `[waap] auto-login with WAAP_EMAIL/WAAP_PASSWORD failed (${this.redactCliSecrets(
                    (loginErr as Error).message ?? 'unknown error'
                  )}) — use WAAP_LOGIN to authenticate`
                )
              }
            }

            this.ready = false
            const reason = (err as Error).message ?? 'unknown error'
            console.info(
              `[waap] session unavailable (${reason}) — use WAAP_SIGNUP or WAAP_LOGIN to authenticate`
            )

            return
          }

          throw this.wrapCliError(err)
        }
      }

      // 2. policy get
      const policyRes = await this.runCli('policy', ['get'])
      const policy = this.parsePolicy(policyRes)

      // 3. 2fa status — CLI emits { twoFactorMethod: "DISABLED"|"EMAIL"|... }
      const twofaRes = await this.runCli('2fa', ['status'])
      const method = this.authorizationKindToMethod(
        twofaRes.twoFactorMethod ?? twofaRes.method ?? 'disabled'
      )

      if (method === 'phone') {
        throw new WaapError(
          'phone 2FA is not supported by plugin-waap. ' +
            'Switch to telegram, email, or external_wallet via ' +
            '`waap-cli 2fa enable --telegram <chatId>`.',
          'PHONE_2FA_UNSUPPORTED'
        )
      }

      // 4. chainState from setting — supports "evm:1" or "sui:mainnet" format
      const defaultChain =
        this.getSetting('WAAP_DEFAULT_CHAIN') ??
        this.getSetting('WAAP_DEFAULT_CHAIN_ID') ??
        '1'

      const chainState = resolveChain(defaultChain)

      if (!chainState) {
        throw new WaapError(
          `Invalid WAAP_DEFAULT_CHAIN: ${defaultChain}`,
          'INVALID_PARAMS'
        )
      }

      this.state = { evmAddress, suiAddress, chainState, policy }
      this.ready = true

      // eslint-disable-next-line no-console
      console.info(
        `[waap] ready — evm=${evmAddress} sui=${suiAddress} chain=${
          chainState.canonical
        } method=${method} limit=${policy.dailySpendLimitUsd ?? 'unset'}`
      )
    } finally {
      this.initializing = false
    }
  }

  // ── State accessors ──
  getState(): WaapWalletState {
    if (!this.state) throw new WaapError('service not initialized', 'UNKNOWN')

    return this.state
  }

  getChainState(): WaapChainState {
    return this.getState().chainState
  }

  getChainFamily(): ChainFamily {
    return this.getState().chainState.family
  }

  getCanonicalChain(): ChainId {
    return this.getState().chainState.canonical
  }

  getPolicy(): WaapPolicy {
    return this.getState().policy
  }

  getAddress(): string {
    const s = this.getState()
    return s.chainState.family === 'sui' ? s.suiAddress : s.evmAddress
  }

  isReady(): boolean {
    return this.ready
  }

  /**
   * True while initialize() is in flight (whoami running). Distinct from
   * !isReady() which also covers the legitimate "no saved session" terminal
   * state. The provider uses this to show a "starting up" message instead of
   * a misleading "not logged in" during the 1–3 sec hydration window after
   * agent restart.
   */
  isInitializing(): boolean {
    return this.initializing
  }

  // ── Operations ──
  async signMessage(
    input: SignMessageInput,
    ctx?: ProgressContext
  ): Promise<{ signature: string; bytes?: string }> {
    return this.withAuthzGate(
      'sign-message',
      async (innerCtx, signal) => {
        const args = [
          '--message',
          input.message,
          '--chain',
          this.getCanonicalChain()
        ]
        const permToken = input.permissionToken ?? this.lookupPermissionToken()

        if (permToken) args.push('--permission-token', permToken)

        const res = await this.runCli('sign-message', args, innerCtx, signal)

        // Sui sign-message also returns `bytes` (base64 of the signed message);
        // EVM returns only the signature. Surface it when present for parity.
        return {
          signature: String(res.signature ?? ''),
          ...(res.bytes ? { bytes: String(res.bytes) } : {})
        }
      },
      ctx
    )
  }

  async signTypedData(
    input: SignTypedDataInput,
    ctx?: ProgressContext
  ): Promise<{ signature: string }> {
    if (this.getChainFamily() === 'sui') {
      throw new WaapError(
        'EIP-712 typed data signing is only available on EVM chains. Switch to an EVM chain first.',
        'INVALID_PARAMS'
      )
    }

    return this.withAuthzGate(
      'sign-typed-data',
      async (innerCtx, signal) => {
        // dev passes --chain (the wallet's active chain) for the EIP-712 flow;
        // keep it alongside our authz gate. The permission-token lookup still
        // prefers the typed data's own domain.chainId.
        const args = [
          '--data',
          JSON.stringify(input.data),
          '--chain',
          this.getCanonicalChain()
        ]
        // EIP-712 typed data carries its own chainId in `data.domain.chainId`.
        // Prefer that for the permission token lookup, then fall back to the
        // wallet's current chain.
        const tdChainId = (
          input.data as { domain?: { chainId?: number | string } }
        )?.domain?.chainId
        const tdChainIdNum =
          typeof tdChainId === 'number'
            ? tdChainId
            : typeof tdChainId === 'string'
            ? isNaN(Number(tdChainId))
              ? undefined
              : Number(tdChainId)
            : undefined
        const permToken =
          input.permissionToken ?? this.lookupPermissionToken(tdChainIdNum)

        if (permToken) args.push('--permission-token', permToken)

        const res = await this.runCli('sign-typed-data', args, innerCtx, signal)

        return { signature: String(res.signature ?? '') }
      },
      ctx
    )
  }

  /**
   * Look up a pre-issued permission token from settings/env for the given
   * chain id, falling back to the wallet's current EVM chain. Returns undefined
   * if no token is configured.
   */
  private lookupPermissionToken(chainId?: number): string | undefined {
    // No permission tokens on Sui
    if (this.state?.chainState.family === 'sui') return undefined

    const cid =
      chainId ??
      (this.state?.chainState.family === 'evm'
        ? this.state.chainState.chainId
        : undefined)

    if (cid === undefined) return undefined

    return this.getSetting(`WAAP_PERMISSION_TOKEN_${cid}`)
  }

  async sendTx(
    input: SendTxInput,
    ctx?: ProgressContext
  ): Promise<{ txHash?: string; from: string }> {
    if (!input.to || !input.value) {
      throw new WaapError('sendTx requires to + value', 'INVALID_PARAMS')
    }

    return this.withAuthzGate(
      'send-tx',
      async (innerCtx, signal) => {
        const activeChainState = this.getState().chainState
        // Honour explicit chain from extracted params; fall back to active chain.
        const chainState = input.chain
          ? resolveChain(input.chain) ?? activeChainState
          : input.chainId
          ? resolveChain(input.chainId) ?? activeChainState
          : activeChainState
        const args: string[] = [
          '--to',
          input.to!,
          '--value',
          input.value!,
          '--chain',
          chainState.canonical
        ]

        if (chainState.family === 'evm') {
          const rpcUrl = input.rpc ?? this.getSetting('WAAP_DEFAULT_RPC_URL')
          if (rpcUrl) args.push('--rpc', rpcUrl)
          if (input.data) args.push('--data', input.data)
          if (input.legacy) args.push('--legacy')
        }

        const permToken =
          input.permissionToken ??
          this.lookupPermissionToken(
            chainState.family === 'evm'
              ? (chainState as { chainId: number }).chainId
              : undefined
          )
        if (permToken) args.push('--permission-token', permToken)

        const res = await this.runCli('send-tx', args, innerCtx, signal)

        const txHash = res.txHash ? String(res.txHash) : undefined
        const from = res.from ? String(res.from) : this.getAddress()
        return { txHash, from }
      },
      ctx
    )
  }

  async getBalance(input?: GetBalanceInput): Promise<{
    balanceRaw: string
    balanceFormatted: string
    chainId: string
    address: string
  }> {
    const state = this.getState()

    // If the caller supplied a chainId, resolve it to a canonical chain string
    // so the CLI gets the right --chain flag. Fall back to the active chain.
    const chainState = input?.chainId
      ? resolveChain(input.chainId) ?? state.chainState
      : state.chainState
    const chain = chainState.canonical

    const args: string[] = ['--chain', chain]

    if (chainState.family === 'evm') {
      const rpcUrl = input?.rpc ?? this.getSetting('WAAP_DEFAULT_RPC_URL')
      if (rpcUrl) args.push('--rpc', rpcUrl)
    }

    const res = await this.runCli('balance', args)

    const address =
      chainState.family === 'sui'
        ? this.getState().suiAddress
        : this.getState().evmAddress

    return {
      balanceRaw: String(res.balance ?? '0'),
      balanceFormatted: String(res.balanceFormatted ?? '0'),
      chainId: chain,
      address
    }
  }

  async setPolicy(
    input: SetPolicyInput,
    ctx?: ProgressContext
  ): Promise<WaapPolicy> {
    const release = this.policyLock
    let resolve: () => void
    this.policyLock = new Promise<void>((r) => {
      resolve = r
    })

    await release

    try {
      if (input.dailySpendLimitUsd === undefined) {
        throw new WaapError(
          'setPolicy requires dailySpendLimitUsd',
          'INVALID_PARAMS'
        )
      }

      return await this.withAuthzGate(
        'set-policy',
        async (innerCtx, signal) => {
          const args = [
            'set',
            '--daily-spend-limit',
            String(input.dailySpendLimitUsd)
          ]
          await this.runCli('policy', args, innerCtx, signal)

          return await this.refreshPolicy(signal)
        },
        ctx
      )
    } finally {
      resolve!()
    }
  }

  async refreshPolicy(signal?: AbortSignal): Promise<WaapPolicy> {
    // Capture the session generation BEFORE the round-trip. A background
    // refresh (e.g. the one a non-blocking enable2fa/disable2fa runs after the
    // CLI returns) can outlive its session: the user may log out and into a
    // different account while `policy get` is in flight. Without this guard the
    // late write would stamp the PRIOR account's policy onto the NEW account's
    // state. The signal lets logout/cancel actually abort the round-trip.
    const epoch = this.sessionEpoch
    const res = await this.runCli('policy', ['get'], undefined, signal)
    const policy = this.parsePolicy(res)

    if (this.state && this.sessionEpoch === epoch) this.state.policy = policy

    return policy
  }

  async signup(
    email: string,
    password: string,
    name?: string
  ): Promise<{ address: string; suiAddress?: string }> {
    const args = ['--email', email, '--password', password]
    if (name) args.push('--name', name)

    const res = await this.runCli('signup', args)
    const address = String(
      res.evmWalletAddress ?? res.evmAddress ?? res.address ?? ''
    )
    const suiAddress =
      String(res.suiWalletAddress ?? res.suiAddress ?? '') || undefined

    if (!address) {
      throw new WaapError('signup returned no address', 'CLI_PROTOCOL')
    }

    // Re-initialize now that session exists
    await this.initialize()

    return { address, suiAddress }
  }

  async login(
    email: string,
    password: string
  ): Promise<{ address: string; suiAddress?: string }> {
    const res = await this.runCli('login', [
      '--email',
      email,
      '--password',
      password
    ])
    const address = String(
      res.evmWalletAddress ?? res.evmAddress ?? res.address ?? ''
    )
    const suiAddress =
      String(res.suiWalletAddress ?? res.suiAddress ?? '') || undefined

    if (!address) {
      throw new WaapError('login returned no address', 'CLI_PROTOCOL')
    }

    await this.initialize()

    return { address, suiAddress }
  }

  switchChain(input: string | number): void {
    if (!this.state) {
      throw new WaapError('service not initialized', 'UNKNOWN')
    }

    const resolved = resolveChain(input)

    if (!resolved) {
      throw new WaapError(`Unknown chain: ${input}`, 'INVALID_PARAMS')
    }

    if (resolved.family === 'sui' && !this.state.suiAddress) {
      throw new WaapError(
        'This account has no Sui address. The keyshare may predate Sui support.',
        'INVALID_PARAMS'
      )
    }

    this.state.chainState = resolved
  }

  // ── 2FA management ──
  async get2faStatus(): Promise<{ method: TwoFaMethod; value?: string }> {
    const res = await this.runCli('2fa', ['status'])
    // CLI emits { twoFactorMethod: "DISABLED"|"EMAIL"|..., rawPolicy: <authorization_method> }
    const method = this.authorizationKindToMethod(
      res.twoFactorMethod ?? res.method ?? 'disabled'
    )
    // The registered destination (email address / Telegram chat ID / phone /
    // hardware-wallet address[es]) lives inside the raw authorization_method
    // object — the CLI passes it through as `rawPolicy`. Surface it so callers
    // can show the user WHICH email/number/wallet is protecting the account,
    // instead of just the method name.
    const value = this.authorizationKindToValue(
      res.rawPolicy ?? res.authorization_method
    )

    return { method, value }
  }

  async enable2fa(
    input: Enable2faInput,
    ctx?: ProgressContext
  ): Promise<{ method: TwoFaMethod }> {
    const args: string[] = []

    switch (input.method) {
      case 'email':
        if (!input.email) {
          throw new WaapError(
            'email address is required for email 2FA',
            'INVALID_PARAMS'
          )
        }
        args.push('--email', input.email)
        break
      case 'phone':
        // Defensive: the action layer never offers phone (it's not in the
        // enable2fa schema), but a direct caller could. Refuse rather than
        // push --phone — enabling phone 2FA would brick the session, since
        // initialize() throws PHONE_2FA_UNSUPPORTED on a phone auth method.
        throw new WaapError(
          'phone 2FA is not supported by plugin-waap. Use email, telegram, or external_wallet instead.',
          'PHONE_2FA_UNSUPPORTED'
        )
      case 'telegram':
        if (!input.telegramChatId) {
          throw new WaapError(
            'telegram chat ID is required for telegram 2FA',
            'INVALID_PARAMS'
          )
        }
        args.push('--telegram', input.telegramChatId)
        break
      case 'external_wallet':
        if (!input.walletAddress) {
          throw new WaapError(
            'wallet address is required for external wallet 2FA',
            'INVALID_PARAMS'
          )
        }
        args.push('--wallet', input.walletAddress)
        break
      default:
        throw new WaapError(
          `unsupported 2FA method: ${input.method}`,
          'INVALID_PARAMS'
        )
    }

    return this.withAuthzGate(
      'enable-2fa',
      async (innerCtx, signal) => {
        await this.runCli('2fa', ['enable', ...args], innerCtx, signal)

        // Refresh policy to reflect new authorization method
        await this.refreshPolicy(signal)

        return { method: input.method }
      },
      ctx
    )
  }

  async disable2fa(ctx?: ProgressContext): Promise<void> {
    await this.withAuthzGate(
      'disable-2fa',
      async (innerCtx, signal) => {
        await this.runCli('2fa', ['disable'], innerCtx, signal)

        // Refresh policy to reflect disabled authorization
        await this.refreshPolicy(signal)
      },
      ctx
    )
  }

  // ── Session management ──
  async logout(): Promise<void> {
    // Drop any in-flight 2FA approval — once we've logged out, the session
    // it would have authorized is gone.
    if (this.pendingAuthz) {
      this.pendingAuthz.abort.abort()
      this.pendingAuthz = null
    }
    // Session is ending — invalidate any non-blocking 2FA op captured under
    // the current epoch so its late completion can't surface post-logout.
    this.sessionEpoch++
    await this.runCli('logout', [])
    this.ready = false
    this.state = null
  }

  /**
   * Monotonic session generation, bumped on logout() and every initialize().
   * A non-blocking 2FA-gated action captures this at dispatch and discards its
   * out-of-band completion if the value has since changed — see
   * dispatchAuthzGatedAction in actions/actionUtils.ts.
   */
  getSessionEpoch(): number {
    return this.sessionEpoch
  }

  // ── Sign-only (no broadcast) ──
  async signTx(
    input: SignTxInput,
    ctx?: ProgressContext
  ): Promise<{
    signedTx: string
    address: string
    signature?: string
    txBytes?: string
  }> {
    if (!input.to) {
      throw new WaapError('signTx requires a "to" address', 'INVALID_PARAMS')
    }

    return this.withAuthzGate(
      'sign-tx',
      async (innerCtx, signal) => {
        const activeChainState = this.getState().chainState
        const chainState = input.chainId
          ? resolveChain(input.chainId) ?? activeChainState
          : activeChainState
        const args: string[] = [
          '--to',
          input.to,
          '--chain',
          chainState.canonical
        ]

        if (input.value) args.push('--value', input.value)

        if (chainState.family === 'evm') {
          const rpcUrl = input.rpc ?? this.getSetting('WAAP_DEFAULT_RPC_URL')
          if (rpcUrl) args.push('--rpc', rpcUrl)
          if (input.data) args.push('--data', input.data)
          if (input.legacy) args.push('--legacy')
        }

        const permToken =
          input.permissionToken ??
          this.lookupPermissionToken(
            chainState.family === 'evm'
              ? (chainState as { chainId: number }).chainId
              : undefined
          )

        if (permToken) args.push('--permission-token', permToken)

        const res = await this.runCli('sign-tx', args, innerCtx, signal)

        // EVM sign-tx returns { signedTx }. Sui sign-tx returns
        // { signature, txBytes } and NO signedTx — surface those too so the
        // Sui result isn't dropped (the action renders whichever is present).
        return {
          signedTx: String(res.signedTx ?? ''),
          address: String(res.address ?? this.getAddress()),
          ...(res.signature ? { signature: String(res.signature) } : {}),
          ...(res.txBytes ? { txBytes: String(res.txBytes) } : {})
        }
      },
      ctx
    )
  }

  // ── Generic EIP-1193 request ──
  async request(input: RequestInput): Promise<{ data: unknown }> {
    if (this.getChainFamily() === 'sui') {
      throw new WaapError(
        'JSON-RPC requests are only available on EVM chains. Switch to an EVM chain first.',
        'INVALID_PARAMS'
      )
    }

    if (!input.method) {
      throw new WaapError('request requires a method name', 'INVALID_PARAMS')
    }

    const args: string[] = [input.method]

    if (input.params && input.params.length > 0) {
      args.push(JSON.stringify(input.params))
    }

    // request command uses --chain-id (numeric) not --chain (canonical)
    const chainState = this.getChainState()
    if (chainState.family === 'evm') {
      args.push('--chain-id', String(chainState.chainId))
    }

    const rpcUrl = input.rpc ?? this.getSetting('WAAP_DEFAULT_RPC_URL')
    if (rpcUrl) args.push('--rpc', rpcUrl)

    const res = await this.runCli('request', args)

    // The CLI emits `{ event: "result", result: <value> }` for the request
    // command (vs flat result objects for most other commands), so the runner's
    // result map exposes the RPC response under `result`, not `data`.
    return { data: res.result }
  }

  // ── Internals ──
  private getSetting(key: string): string | undefined {
    const fromRuntime = this.runtime?.getSetting?.(key)

    if (fromRuntime !== undefined && fromRuntime !== null)
      return String(fromRuntime)

    return process.env[key]
  }

  private async runCli(
    cmd: string,
    args: string[],
    ctx?: ProgressContext,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (!this.runner) {
      throw new WaapError(
        'CLI runner not initialized — call initialize() first',
        'UNKNOWN'
      )
    }

    try {
      const res = await this.runner.run({
        cmd,
        args,
        sessionDir: this.sessionDir,
        silkNodeEnv: this.getSetting('SILK_NODE_ENV') as
          | 'development'
          | 'production'
          | undefined,
        onEvent: ctx?.onEvent,
        signal
      })

      return res.result
    } catch (err) {
      throw this.wrapCliError(err)
    }
  }

  // ── Authz gating ──

  /** Returns the in-flight 2FA-requiring operation, or null. */
  getPendingAuthz(): PendingAuthz | null {
    return this.pendingAuthz ? { ...this.pendingAuthz.info } : null
  }

  /**
   * Cancel the in-flight 2FA-requiring operation, if any.
   *
   * Two layers of cleanup:
   *
   *   1. Aborting the CLI subprocess closes its connection to the backend, so
   *      even if the cached challenge lingers server-side no signature can be
   *      delivered (the backend has nowhere to send it).
   *
   *   2. Best-effort: spawn `waap-cli cancel --msg-hash X --authz-kind Y`,
   *      which atomically removes the cached challenge on the backend.
   *      Skipped if we don't yet know the payloadId or the method maps to a
   *      kind the backend doesn't accept.
   *
   * Returns the cancelled op's info, or null if nothing was pending.
   * Synchronous wrt local state — backend cleanup runs detached.
   */
  cancelPendingAuthz(): PendingAuthz | null {
    if (!this.pendingAuthz) return null
    const info = { ...this.pendingAuthz.info }

    // 1) Always abort the local subprocess first — closing the websocket is
    //    the load-bearing safety property. Backend cleanup is best-effort
    //    and must not block this.
    this.pendingAuthz.abort.abort()
    this.pendingAuthz = null

    // 2) Fire-and-forget the backend cancel if we have enough info.
    void this.tryBackendCancel(info)

    return info
  }

  /** Maps the plugin's TwoFaMethod to the backend's authz_kind string. */
  private toCancelAuthzKind(method?: TwoFaMethod): string | null {
    switch (method) {
      case 'email':
        return 'email_authz'
      case 'phone':
        return 'phone_authz'
      case 'telegram':
        return 'telegram_authz'
      case 'external_wallet':
        return 'external_wallet_authz'
      default:
        // 'disabled' or undefined — nothing to cancel on the backend.
        return null
    }
  }

  /**
   * Best-effort backend cleanup via `waap-cli cancel`. Failures are logged
   * but not surfaced — the local abort is the load-bearing safety property,
   * and the cached challenge will expire naturally if this fails.
   */
  private async tryBackendCancel(info: PendingAuthz): Promise<void> {
    const authzKind = this.toCancelAuthzKind(info.method)
    if (!authzKind) {
      // 2FA never started (no awaiting_2fa event) or method unsupported —
      // there's no cached challenge to cancel.
      return
    }
    if (!info.payloadId) {
      // No msg_hash known yet; the CLI rejects without it.
      return
    }

    // Normalize to 0x-prefixed: the CLI requires it.
    const msgHash = info.payloadId.startsWith('0x')
      ? info.payloadId
      : `0x${info.payloadId}`

    try {
      await this.runCli('cancel', [
        '--msg-hash',
        msgHash,
        '--authz-kind',
        authzKind
      ])
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[waap] backend cancel failed for ${authzKind} (${msgHash}): ${
          (err as Error).message
        } — local abort already applied; cached challenge will expire naturally.`
      )
    }
  }

  /**
   * Wraps an authz-requiring operation: refuses if one is already pending,
   * tracks the new one for the duration, and clears state on every exit path.
   * The returned ProgressContext is enriched so the `awaiting_2fa` event
   * populates the pending record's method/payloadId.
   */
  private async withAuthzGate<T>(
    kind: AuthzOp,
    fn: (ctx: ProgressContext, signal: AbortSignal) => Promise<T>,
    ctx?: ProgressContext
  ): Promise<T> {
    if (this.pendingAuthz) {
      const ageMs = Date.now() - this.pendingAuthz.info.startedAt
      const ageMin = Math.max(1, Math.round(ageMs / 60_000))
      const prev = this.pendingAuthz.info.kind
      throw new WaapError(
        `Cannot start a new ${kind} request — a previous ${prev} request is ` +
          `still awaiting 2FA approval (started ${ageMin} min ago). Approve ` +
          `it via the link sent to your 2FA channel, or cancel it (e.g. ` +
          `"cancel my pending 2FA") before starting a new request.`,
        'AUTHZ_PENDING'
      )
    }

    const abort = new AbortController()
    const slot = {
      info: { kind, startedAt: Date.now() } as PendingAuthz,
      abort
    }
    this.pendingAuthz = slot

    const wrappedCtx: ProgressContext = {
      onEvent: async (e) => {
        // Capture the payload id (msg_hash) needed for a backend cancel. The
        // `submitted` event carries the real id; the `awaiting_2fa` event may
        // carry an empty string (notably the 2-step enable's step-2 prompt), so
        // only let it SET the id when non-empty — never clobber a good id with ''.
        if (e.event === 'submitted' && e.payloadId) {
          slot.info.payloadId = e.payloadId
        }
        if (e.event === 'awaiting_2fa') {
          slot.info.method = e.method
          if (e.payloadId) slot.info.payloadId = e.payloadId
        }
        await ctx?.onEvent?.(e)
      }
    }

    try {
      return await fn(wrappedCtx, abort.signal)
    } finally {
      // Always clear — but only if this slot is still the current one.
      // (If cancelPendingAuthz cleared it, that already aborted the signal
      // and the awaited fn() rejected with CLI_ABORTED. Either way, no slot
      // leak.)
      if (this.pendingAuthz === slot) {
        this.pendingAuthz = null
      }
    }
  }

  private errCode(err: unknown): string | undefined {
    if (err && typeof err === 'object' && 'code' in err) {
      return String((err as { code: unknown }).code)
    }

    return undefined
  }

  private toWaapErrorCode(code: string | undefined): WaapErrorCode {
    const valid: Set<string> = new Set([
      'NO_SESSION',
      'CLI_NOT_FOUND',
      'CLI_VERSION_MISMATCH',
      'PHONE_2FA_UNSUPPORTED',
      'TWO_FA_TIMEOUT',
      'POLICY_REJECTED',
      'INSUFFICIENT_FUNDS',
      'INVALID_PARAMS',
      'NETWORK',
      'CLI_PROTOCOL',
      'CLI_HARD_TIMEOUT',
      'CLI_ABORTED',
      'AUTHZ_PENDING',
      'UNKNOWN'
    ])
    return code && valid.has(code) ? (code as WaapErrorCode) : 'UNKNOWN'
  }

  /**
   * Strip argv-style secret VALUES from a CLI error/stderr string before it can
   * reach user-facing text. We spawn the CLI with `--email <e> --password <p>`
   * (and sometimes `--permission-token <t>`); if the CLI ever echoes its argv
   * into a crash dump / usage line / stderr, those secrets would otherwise flow
   * through wrapCliError → the login/signup error callback → CHAT and persisted
   * conversation memory. Replace the value after any sensitive flag with `***`.
   */
  private redactCliSecrets(s: string): string {
    return s.replace(
      /(--(?:password|email|permission-token))(\s+|=)(\S+)/gi,
      '$1$2***'
    )
  }

  private wrapCliError(err: unknown): Error {
    if (err instanceof WaapError) return err

    if (err instanceof CliError) {
      const code = this.toWaapErrorCode(err.code)
      const message = this.redactCliSecrets(err.message)
      const msg = err.stderr
        ? `${message}\nstderr: ${this.redactCliSecrets(err.stderr).slice(
            0,
            500
          )}`
        : message

      return new WaapError(msg, code)
    }

    if (err && typeof err === 'object' && 'code' in err) {
      const raw = err as { code?: unknown; message?: unknown }
      const code = this.toWaapErrorCode(
        typeof raw.code === 'string' ? raw.code : undefined
      )

      return new WaapError(
        this.redactCliSecrets(String(raw.message ?? err)),
        code
      )
    }

    return new WaapError(
      this.redactCliSecrets(err instanceof Error ? err.message : String(err)),
      'UNKNOWN'
    )
  }

  private parsePolicy(res: Record<string, unknown>): WaapPolicy {
    const p = (res.policy ?? res) as Record<string, unknown>

    // CLI `policy get` emits camelCase keys (twoFactorMethod, dailySpendLimitUsd)
    // while the raw backend uses snake_case (authorization_method, daily_spend_limit_in_usd).
    // Support both formats for robustness.
    const rawMethod =
      p.authorization_method ?? p.twoFactorMethod ?? p.authorizationMethod
    const method = this.authorizationKindToMethod(rawMethod)

    const rawLimit =
      p.daily_spend_limit_in_usd ?? p.dailySpendLimitUsd ?? p.dailySpendLimit
    // Guard against NaN: an unexpected non-numeric, non-'not set' value (e.g.
    // 'unlimited') would otherwise become NaN and render as "$NaN/day". Treat
    // anything that doesn't parse to a finite number as "unset".
    const parsedLimit =
      rawLimit !== undefined && rawLimit !== 'not set'
        ? Number(rawLimit)
        : undefined
    const dailySpendLimitUsd = Number.isFinite(parsedLimit)
      ? (parsedLimit as number)
      : undefined

    const rawRisk = p.min_risk_for_2fauthz ?? p.minRiskFor2FA ?? p.minRiskFor2fa
    const minRiskFor2fa =
      rawRisk !== undefined && rawRisk !== 'not set'
        ? String(rawRisk)
        : undefined

    return {
      authorizationMethod: method,
      dailySpendLimitUsd,
      minRiskFor2fa
    }
  }

  private authorizationKindToMethod(kind: unknown): TwoFaMethod {
    if (!kind) return 'disabled'

    // Raw backend format: { Disabled: {} }, { Email: {} }, etc.
    if (typeof kind === 'object' && kind !== null) {
      if ('Disabled' in kind) return 'disabled'
      if ('Email' in kind) return 'email'
      if ('Telegram' in kind) return 'telegram'
      if ('Phone' in kind) return 'phone'
      if ('ExternalWallet' in kind) return 'external_wallet'
    }

    // CLI camelCase string format: "DISABLED", "EMAIL", "email", etc.
    if (typeof kind === 'string') {
      const lower = kind.toLowerCase()
      if (lower === 'disabled') return 'disabled'
      if (lower === 'email' || lower === 'email_authz') return 'email'
      if (lower === 'telegram' || lower === 'telegram_authz') return 'telegram'
      if (lower === 'phone' || lower === 'phone_authz') return 'phone'
      if (
        lower === 'external_wallet' ||
        lower === 'external_wallet_authz' ||
        lower === 'externalwallet'
      )
        return 'external_wallet'
    }

    // A NON-empty value that matches none of the known variants means the
    // backend returned a method shape this plugin doesn't understand. We still
    // fall back to 'disabled' (so callers have a valid TwoFaMethod), but make
    // it LOUD rather than silent — collapsing an unknown method to 'disabled'
    // drives the "2FA is DISABLED — anyone can move funds" warning, which would
    // be a false alarm. Operators need to see this to recognize a backend/SDK
    // drift instead of trusting a misleading "unprotected" message.
    // eslint-disable-next-line no-console
    console.warn(
      `[waap] unrecognized 2FA authorization_method shape — treating as 'disabled'. ` +
        `Raw value: ${JSON.stringify(kind)?.slice(0, 200)}. ` +
        `If 2FA is actually configured, re-check before assuming the wallet is unprotected.`
    )
    return 'disabled'
  }

  /**
   * Extract the registered 2FA destination from the raw `authorization_method`
   * object. The backend's `AuthorizationKind` is externally-tagged serde, so a
   * configured method serializes as a single-key object carrying its value:
   *   { "Email": "you@example.com" }       → "you@example.com"
   *   { "Telegram": "7381029636" }         → "7381029636"
   *   { "Phone": "+15551234567" }          → "+15551234567"
   *   { "ExternalWallet": ["0xabc", ...] } → "0xabc, ..."
   * `Disabled` (a unit variant → the bare string "Disabled") and any
   * unrecognized shape return undefined. Returns undefined rather than an
   * empty string so callers can cleanly omit the value when it's unknown.
   */
  private authorizationKindToValue(kind: unknown): string | undefined {
    if (!kind || typeof kind !== 'object') return undefined

    const k = kind as Record<string, unknown>
    const asString = (v: unknown): string | undefined =>
      typeof v === 'string' && v.length > 0 ? v : undefined

    if ('Email' in k) return asString(k.Email)
    if ('Telegram' in k) return asString(k.Telegram)
    if ('Phone' in k) return asString(k.Phone)
    if ('ExternalWallet' in k) {
      const arr = k.ExternalWallet
      if (Array.isArray(arr)) {
        const addrs = arr.filter(
          (a): a is string => typeof a === 'string' && a.length > 0
        )
        return addrs.length > 0 ? addrs.join(', ') : undefined
      }
    }

    return undefined
  }
}
