import { describe, it, expect, vi } from 'vitest'
import type { CliRunner, CliRunOptions, CliResult } from '../../src/cliRunner'
import { CliError } from '../../src/cliRunner'
import { WaapService } from '../../src/services/WaapService'

function fakeRuntime(overrides: Partial<any> = {}) {
  const settings: Record<string, string> = overrides.settings || {}
  return {
    agentId: 'test-agent-abc',
    getSetting: (key: string) => settings[key] ?? undefined,
    getService: vi.fn(),
    ...overrides
  } as any
}

function mockRunner(
  scripted: Array<{
    cmd: string
    result?: Record<string, unknown>
    error?: Error
  }>,
  recordCalls?: Array<{ cmd: string; args: string[] }>
): CliRunner {
  let callIdx = 0
  return {
    async run(opts: CliRunOptions): Promise<CliResult> {
      recordCalls?.push({ cmd: opts.cmd, args: [...opts.args] })
      const next = scripted[callIdx++]
      if (!next)
        throw new Error(
          `No scripted response for cmd=${opts.cmd} (call ${callIdx})`
        )
      if (next.error) throw next.error
      return { ok: true, result: next.result ?? {} }
    },
    async resolveBinary() {
      return '/fake/waap-cli'
    }
  }
}

describe('WaapService.start() initialization sequence', () => {
  it('calls whoami → policy get → 2fa status in order', async () => {
    const calls: string[] = []
    const runner: CliRunner = {
      async run(opts) {
        calls.push(opts.cmd)
        if (opts.cmd === 'whoami') {
          return {
            ok: true,
            result: { evmAddress: '0xabc', suiAddress: '0xsui' }
          }
        }
        if (opts.cmd === 'policy' && opts.args[0] === 'get') {
          return {
            ok: true,
            result: {
              policy: {
                authorization_method: { Disabled: null },
                daily_spend_limit_in_usd: 500
              }
            }
          }
        }
        if (opts.cmd === '2fa' && opts.args[0] === 'status') {
          return { ok: true, result: { method: 'disabled' } }
        }
        throw new Error(`unexpected cmd: ${opts.cmd}`)
      },
      async resolveBinary() {
        return '/fake'
      }
    }

    const runtime = fakeRuntime({ settings: { WAAP_DEFAULT_CHAIN_ID: '1' } })
    const svc = await WaapService.startWithRunner(runtime, runner)

    expect(calls).toEqual(['whoami', 'policy', '2fa'])
    expect(svc.isReady()).toBe(true)
    expect(svc.getAddress()).toBe('0xabc')
  })

  it('sets ready=false when whoami fails with NO_SESSION (unauthenticated mode)', async () => {
    const runner: CliRunner = {
      async run() {
        const err: any = new Error('No session')
        err.code = 'NO_SESSION'
        err.name = 'CliError'
        throw err
      },
      async resolveBinary() {
        return '/fake'
      }
    }
    const svc = await WaapService.startWithRunner(fakeRuntime(), runner)
    expect(svc.isReady()).toBe(false)
  })

  it('auto-logs in at boot from WAAP_EMAIL/WAAP_PASSWORD, then becomes ready', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    let whoamiCount = 0
    const runner: CliRunner = {
      async run(opts) {
        calls.push({ cmd: opts.cmd, args: [...opts.args] })
        if (opts.cmd === 'whoami') {
          whoamiCount++
          // No session on the first whoami; a session exists only after login.
          if (whoamiCount === 1) {
            const err: any = new Error('No session')
            err.code = 'NO_SESSION'
            err.name = 'CliError'
            throw err
          }
          return {
            ok: true,
            result: { evmAddress: '0xabc', suiAddress: '0xsui' }
          }
        }
        if (opts.cmd === 'login')
          return { ok: true, result: { evmWalletAddress: '0xabc' } }
        if (opts.cmd === 'policy')
          return {
            ok: true,
            result: {
              policy: {
                authorization_method: { Disabled: null },
                daily_spend_limit_in_usd: 500
              }
            }
          }
        if (opts.cmd === '2fa')
          return { ok: true, result: { method: 'disabled' } }
        throw new Error(`unexpected cmd: ${opts.cmd}`)
      },
      async resolveBinary() {
        return '/fake'
      }
    }
    const runtime = fakeRuntime({
      settings: { WAAP_EMAIL: 'agent@waap.xyz', WAAP_PASSWORD: 'OperatorPw123' }
    })
    const svc = await WaapService.startWithRunner(runtime, runner)

    expect(svc.isReady()).toBe(true)
    expect(svc.getAddress()).toBe('0xabc')
    // login was invoked with the configured credentials, and whoami retried
    const login = calls.find((c) => c.cmd === 'login')
    expect(login?.args).toEqual([
      '--email',
      'agent@waap.xyz',
      '--password',
      'OperatorPw123'
    ])
    expect(calls.map((c) => c.cmd)).toEqual([
      'whoami',
      'login',
      'whoami',
      'policy',
      '2fa'
    ])
  })

  it('does NOT auto-login when WAAP_EMAIL/WAAP_PASSWORD are unset (stays unauthenticated)', async () => {
    const calls: string[] = []
    const runner: CliRunner = {
      async run(opts) {
        calls.push(opts.cmd)
        const err: any = new Error('No session')
        err.code = 'NO_SESSION'
        err.name = 'CliError'
        throw err
      },
      async resolveBinary() {
        return '/fake'
      }
    }
    const svc = await WaapService.startWithRunner(fakeRuntime(), runner)
    expect(svc.isReady()).toBe(false)
    expect(calls).toEqual(['whoami']) // no login attempt
  })

  it('stays unauthenticated (no retry loop) if the configured auto-login fails', async () => {
    const calls: string[] = []
    const runner: CliRunner = {
      async run(opts) {
        calls.push(opts.cmd)
        if (opts.cmd === 'whoami') {
          const err: any = new Error('No session')
          err.code = 'NO_SESSION'
          err.name = 'CliError'
          throw err
        }
        if (opts.cmd === 'login') {
          const err: any = new Error('Login failed (401): Invalid credentials')
          err.code = 'UNAUTHORIZED'
          err.name = 'CliError'
          throw err
        }
        throw new Error(`unexpected cmd: ${opts.cmd}`)
      },
      async resolveBinary() {
        return '/fake'
      }
    }
    const runtime = fakeRuntime({
      settings: { WAAP_EMAIL: 'a@b.com', WAAP_PASSWORD: 'wrongpass' }
    })
    const svc = await WaapService.startWithRunner(runtime, runner)
    expect(svc.isReady()).toBe(false)
    expect(calls).toEqual(['whoami', 'login']) // tried once, gave up
  })

  it('throws PHONE_2FA_UNSUPPORTED when 2fa status returns phone', async () => {
    const runner = mockRunner([
      { cmd: 'whoami', result: { evmAddress: '0xabc', suiAddress: '0xsui' } },
      {
        cmd: 'policy',
        result: {
          policy: {
            authorization_method: { Phone: 'xxx' },
            daily_spend_limit_in_usd: 0
          }
        }
      },
      { cmd: '2fa', result: { method: 'phone' } }
    ])
    await expect(
      WaapService.startWithRunner(fakeRuntime(), runner)
    ).rejects.toMatchObject({ code: 'PHONE_2FA_UNSUPPORTED' })
  })

  it('derives chainState from WAAP_DEFAULT_CHAIN_ID setting', async () => {
    const runner = mockRunner([
      { cmd: 'whoami', result: { evmAddress: '0xabc', suiAddress: '0xsui' } },
      {
        cmd: 'policy',
        result: { policy: { authorization_method: { Disabled: null } } }
      },
      { cmd: '2fa', result: { method: 'disabled' } }
    ])
    const runtime = fakeRuntime({ settings: { WAAP_DEFAULT_CHAIN_ID: '137' } })
    const svc = await WaapService.startWithRunner(runtime, runner)

    const state = svc.getChainState()
    expect(state.family).toBe('evm')
    if (state.family === 'evm') {
      expect(state.chainId).toBe(137)
      expect(state.canonical).toBe('evm:137')
    }
  })

  it('defaults chain to 1 (Ethereum mainnet) when WAAP_DEFAULT_CHAIN_ID unset', async () => {
    const runner = mockRunner([
      { cmd: 'whoami', result: { evmAddress: '0xabc', suiAddress: '0xsui' } },
      {
        cmd: 'policy',
        result: { policy: { authorization_method: { Disabled: null } } }
      },
      { cmd: '2fa', result: { method: 'disabled' } }
    ])
    const svc = await WaapService.startWithRunner(fakeRuntime(), runner)
    const state = svc.getChainState()
    if (state.family === 'evm') {
      expect(state.chainId).toBe(1)
      expect(state.canonical).toBe('evm:1')
    }
  })

  it('caches policy in getPolicy()', async () => {
    const runner = mockRunner([
      { cmd: 'whoami', result: { evmAddress: '0xabc', suiAddress: '0xsui' } },
      {
        cmd: 'policy',
        result: {
          policy: {
            authorization_method: { Telegram: '123' },
            daily_spend_limit_in_usd: 1000,
            min_risk_for_2fauthz: 'HighWarn'
          }
        }
      },
      { cmd: '2fa', result: { method: 'telegram' } }
    ])
    const svc = await WaapService.startWithRunner(fakeRuntime(), runner)
    const policy = svc.getPolicy()
    expect(policy.authorizationMethod).toBe('telegram')
    expect(policy.dailySpendLimitUsd).toBe(1000)
  })
})

describe('WaapService operations', () => {
  async function setupReadyService(
    extraCalls: Array<any> = [],
    recordCalls?: Array<{ cmd: string; args: string[] }>
  ) {
    const calls = [
      { cmd: 'whoami', result: { evmAddress: '0xabc', suiAddress: '0xsui' } },
      {
        cmd: 'policy',
        result: { policy: { authorization_method: { Disabled: null } } }
      },
      { cmd: '2fa', result: { method: 'disabled' } },
      ...extraCalls
    ]
    const runner = mockRunner(calls, recordCalls)
    return WaapService.startWithRunner(fakeRuntime(), runner)
  }

  it('signMessage() returns signature from CLI result', async () => {
    const svc = await setupReadyService([
      { cmd: 'sign-message', result: { signature: '0xdead', address: '0xabc' } }
    ])
    const result = await svc.signMessage({ message: 'hi' })
    expect(result.signature).toBe('0xdead')
  })

  it('getSessionEpoch() bumps on logout (so non-blocking 2FA completions are invalidated)', async () => {
    const svc = await setupReadyService([{ cmd: 'logout', result: {} }])
    const before = svc.getSessionEpoch()
    await svc.logout()
    expect(svc.getSessionEpoch()).toBeGreaterThan(before)
  })

  it('getSessionEpoch() bumps on re-initialization (login/signup path)', async () => {
    const svc = await setupReadyService([
      { cmd: 'whoami', result: { evmAddress: '0xabc', suiAddress: '0xsui' } },
      {
        cmd: 'policy',
        result: { policy: { authorization_method: { Disabled: null } } }
      },
      { cmd: '2fa', result: { method: 'disabled' } }
    ])
    const before = svc.getSessionEpoch()
    // initialize() runs at the tail of login()/signup(); call it directly to
    // assert the epoch advances on identity (re-)establishment.
    await svc.initialize()
    expect(svc.getSessionEpoch()).toBeGreaterThan(before)
  })

  it('get2faStatus() returns the registered destination from rawPolicy (email)', async () => {
    const svc = await setupReadyService([
      {
        cmd: '2fa',
        result: {
          twoFactorMethod: 'EMAIL',
          rawPolicy: { Email: 'agent@example.com' }
        }
      }
    ])
    const status = await svc.get2faStatus()
    expect(status).toEqual({ method: 'email', value: 'agent@example.com' })
  })

  it('get2faStatus() joins multiple external-wallet signers, and omits value when disabled', async () => {
    const svc = await setupReadyService([
      {
        cmd: '2fa',
        result: {
          twoFactorMethod: 'EXTERNAL_WALLET',
          rawPolicy: { ExternalWallet: ['0xaaa', '0xbbb'] }
        }
      },
      {
        cmd: '2fa',
        result: { twoFactorMethod: 'DISABLED', rawPolicy: 'Disabled' }
      }
    ])
    const ext = await svc.get2faStatus()
    expect(ext).toEqual({
      method: 'external_wallet',
      value: '0xaaa, 0xbbb'
    })
    const disabled = await svc.get2faStatus()
    expect(disabled).toEqual({ method: 'disabled', value: undefined })
  })

  it('sendTx() propagates events through onEvent callback', async () => {
    const events: any[] = []
    const runner: CliRunner = {
      async run(opts) {
        if (opts.cmd === 'whoami')
          return {
            ok: true,
            result: { evmAddress: '0xabc', suiAddress: '0xsui' }
          }
        if (opts.cmd === 'policy')
          return {
            ok: true,
            result: { policy: { authorization_method: { Disabled: null } } }
          }
        if (opts.cmd === '2fa')
          return { ok: true, result: { method: 'disabled' } }
        if (opts.cmd === 'send-tx') {
          opts.onEvent?.({ event: 'submitted', payloadId: 'p1' })
          opts.onEvent?.({
            event: 'awaiting_2fa',
            method: 'telegram',
            payloadId: 'p1',
            timeoutMs: 300_000
          })
          opts.onEvent?.({ event: 'approved', payloadId: 'p1' })
          return { ok: true, result: { txHash: '0xtx', from: '0xabc' } }
        }
        throw new Error(`unexpected cmd: ${opts.cmd}`)
      },
      async resolveBinary() {
        return '/fake'
      }
    }
    const svc = await WaapService.startWithRunner(fakeRuntime(), runner)
    const result = await svc.sendTx(
      { to: '0xdead', value: '0.01', chainId: 1, rpc: 'https://rpc' },
      { onEvent: (e) => events.push(e) }
    )
    expect(events.map((e) => e.event)).toEqual([
      'submitted',
      'awaiting_2fa',
      'approved'
    ])
    expect(result.txHash).toBe('0xtx')
  })

  it('sendTx() validates input: requires to + value', async () => {
    const svc = await setupReadyService()
    await expect(svc.sendTx({ to: '0xdead' } as any)).rejects.toMatchObject({
      code: 'INVALID_PARAMS'
    })
  })

  it('setPolicy() refreshes cache after success', async () => {
    const calls: { cmd: string; args: string[] }[] = []
    const svc = await setupReadyService(
      [
        {
          cmd: 'policy',
          result: {
            policy: {
              authorization_method: { Disabled: null },
              daily_spend_limit_in_usd: 2000
            }
          }
        },
        {
          cmd: 'policy',
          result: {
            policy: {
              authorization_method: { Disabled: null },
              daily_spend_limit_in_usd: 2000
            }
          }
        }
      ],
      calls
    )
    await svc.setPolicy({ dailySpendLimitUsd: 2000 })
    expect(svc.getPolicy().dailySpendLimitUsd).toBe(2000)

    // Verify set was called before get (skip the init 'policy get' call)
    const policyCalls = calls.filter((c) => c.cmd === 'policy')
    expect(policyCalls.length).toBeGreaterThanOrEqual(3)
    // policyCalls[0] is the init 'policy get'
    expect(policyCalls[0].args[0]).toBe('get')
    // policyCalls[1] is setPolicy's 'policy set'
    expect(policyCalls[1].args[0]).toBe('set')
    // policyCalls[2] is the refreshPolicy 'policy get'
    expect(policyCalls[2].args[0]).toBe('get')
  })
})

describe('WaapService Sui integration', () => {
  const DUAL_INIT = [
    {
      cmd: 'whoami',
      result: { evmAddress: '0xevm', suiAddress: '0xsui' }
    },
    {
      cmd: 'policy',
      result: { policy: { authorization_method: { Disabled: null } } }
    },
    { cmd: '2fa', result: { method: 'disabled' } }
  ]

  it('parses evmAddress + suiAddress from whoami', async () => {
    const svc = await WaapService.startWithRunner(
      fakeRuntime(),
      mockRunner(DUAL_INIT)
    )
    expect(svc.getState().evmAddress).toBe('0xevm')
    expect(svc.getState().suiAddress).toBe('0xsui')
  })

  it('getAddress() returns evmAddress when chain family is evm', async () => {
    const svc = await WaapService.startWithRunner(
      fakeRuntime(),
      mockRunner(DUAL_INIT)
    )
    expect(svc.getAddress()).toBe('0xevm')
  })

  it('getAddress() returns suiAddress when chain family is sui', async () => {
    const svc = await WaapService.startWithRunner(
      fakeRuntime(),
      mockRunner(DUAL_INIT)
    )
    svc.switchChain('sui')
    expect(svc.getAddress()).toBe('0xsui')
  })

  it('switchChain() accepts Sui network strings', async () => {
    const svc = await WaapService.startWithRunner(
      fakeRuntime(),
      mockRunner(DUAL_INIT)
    )
    svc.switchChain('sui:testnet')
    expect(svc.getChainState()).toEqual({
      family: 'sui',
      network: 'testnet',
      canonical: 'sui:testnet'
    })
  })

  it('switchChain() accepts EVM chain names', async () => {
    const svc = await WaapService.startWithRunner(
      fakeRuntime(),
      mockRunner(DUAL_INIT)
    )
    svc.switchChain('polygon')
    expect(svc.getChainState()).toEqual({
      family: 'evm',
      chainId: 137,
      canonical: 'evm:137'
    })
  })

  it('signTypedData() rejects on Sui chain', async () => {
    const svc = await WaapService.startWithRunner(
      fakeRuntime(),
      mockRunner(DUAL_INIT)
    )
    svc.switchChain('sui')
    await expect(svc.signTypedData({ data: {} as any })).rejects.toThrow(
      'EVM chains'
    )
  })

  it('request() rejects on Sui chain', async () => {
    const svc = await WaapService.startWithRunner(
      fakeRuntime(),
      mockRunner(DUAL_INIT)
    )
    svc.switchChain('sui')
    await expect(svc.request({ method: 'eth_blockNumber' })).rejects.toThrow(
      'EVM chains'
    )
  })

  it('authz gate: rejects a second authz-requiring op while one is in flight', async () => {
    // Regression: previously two send-tx flows could race the same email
    // approval link, producing the "stale 2FA executes against wrong address"
    // bug. The gate now refuses the second request with AUTHZ_PENDING.
    let inflightCli: {
      resolve: (v: any) => void
      reject: (e: any) => void
    } | null = null

    const runner: CliRunner = {
      async run(opts) {
        if (opts.cmd === 'whoami') {
          return {
            ok: true,
            result: { evmAddress: '0xevm', suiAddress: '0xsui' }
          }
        }
        if (opts.cmd === 'policy' && opts.args[0] === 'get') {
          return {
            ok: true,
            result: { policy: { authorization_method: { Disabled: null } } }
          }
        }
        if (opts.cmd === '2fa' && opts.args[0] === 'status') {
          return { ok: true, result: { method: 'disabled' } }
        }
        if (opts.cmd === 'send-tx') {
          // Block forever — simulates awaiting 2FA approval that never arrives
          return new Promise((resolve, reject) => {
            inflightCli = { resolve, reject }
          })
        }
        throw new Error(`unexpected: ${opts.cmd}`)
      },
      async resolveBinary() {
        return '/fake'
      }
    }

    const svc = await WaapService.startWithRunner(fakeRuntime(), runner)

    // First send-tx — kicks off an in-flight authz that never resolves
    const first = svc.sendTx({
      to: '0x0000000000000000000000000000000000000001',
      value: '0.01'
    })

    // Yield so the gate sets pendingAuthz before we check
    await Promise.resolve()
    expect(svc.getPendingAuthz()?.kind).toBe('send-tx')

    // Second send-tx must be refused with AUTHZ_PENDING
    await expect(
      svc.sendTx({
        to: '0x0000000000000000000000000000000000000002',
        value: '0.02'
      })
    ).rejects.toMatchObject({ code: 'AUTHZ_PENDING' })

    // Other authz-requiring ops also refused
    await expect(svc.signMessage({ message: 'hi' })).rejects.toMatchObject({
      code: 'AUTHZ_PENDING'
    })

    // Read-only ops still work — they don't go through the gate
    expect(svc.getChainState().canonical).toBe('evm:1')

    // Resolve the first call so we don't leak a pending promise
    inflightCli!.resolve({
      ok: true,
      result: { txHash: '0xdead', from: '0xevm' }
    })
    await first
    expect(svc.getPendingAuthz()).toBeNull()
  })

  it('authz gate: clears pending state when an authz op fails', async () => {
    const runner = mockRunner([
      ...DUAL_INIT,
      { cmd: 'send-tx', error: new Error('insufficient funds') }
    ])
    const svc = await WaapService.startWithRunner(fakeRuntime(), runner)

    await expect(
      svc.sendTx({
        to: '0x0000000000000000000000000000000000000001',
        value: '0.01'
      })
    ).rejects.toThrow()

    // Failure path must still clear the slot — otherwise users would be stuck
    expect(svc.getPendingAuthz()).toBeNull()
  })

  it('cancelPendingAuthz(): aborts the in-flight CLI and clears state', async () => {
    let receivedSignal: AbortSignal | undefined
    const runner: CliRunner = {
      async run(opts) {
        if (opts.cmd === 'whoami') {
          return {
            ok: true,
            result: { evmAddress: '0xevm', suiAddress: '0xsui' }
          }
        }
        if (opts.cmd === 'policy' && opts.args[0] === 'get') {
          return {
            ok: true,
            result: { policy: { authorization_method: { Disabled: null } } }
          }
        }
        if (opts.cmd === '2fa' && opts.args[0] === 'status') {
          return { ok: true, result: { method: 'disabled' } }
        }
        if (opts.cmd === 'send-tx') {
          receivedSignal = opts.signal
          return new Promise((_resolve, reject) => {
            opts.signal?.addEventListener('abort', () => {
              const err: any = new Error('CLI aborted by caller')
              err.code = 'CLI_ABORTED'
              err.name = 'CliError'
              reject(err)
            })
          })
        }
        throw new Error(`unexpected: ${opts.cmd}`)
      },
      async resolveBinary() {
        return '/fake'
      }
    }

    const svc = await WaapService.startWithRunner(fakeRuntime(), runner)

    const inFlight = svc.sendTx({
      to: '0x0000000000000000000000000000000000000001',
      value: '0.01'
    })

    await Promise.resolve()
    expect(svc.getPendingAuthz()?.kind).toBe('send-tx')
    expect(receivedSignal).toBeDefined()
    expect(receivedSignal!.aborted).toBe(false)

    const cancelled = svc.cancelPendingAuthz()
    expect(cancelled?.kind).toBe('send-tx')
    expect(receivedSignal!.aborted).toBe(true)
    expect(svc.getPendingAuthz()).toBeNull()

    // The in-flight promise should now reject with the abort error
    await expect(inFlight).rejects.toThrow()

    // After cancellation a new authz op is allowed again
    expect(svc.getPendingAuthz()).toBeNull()
  })

  it('cancelPendingAuthz(): is a no-op when nothing is in flight', async () => {
    const svc = await WaapService.startWithRunner(
      fakeRuntime(),
      mockRunner(DUAL_INIT)
    )
    expect(svc.cancelPendingAuthz()).toBeNull()
    expect(svc.getPendingAuthz()).toBeNull()
  })

  it('initialize() drops any in-flight pendingAuthz (covers re-initialization on session restart)', async () => {
    // Fresh runner that lets us start a long-running send-tx, then re-initialize.
    let inflight: { reject: (e: any) => void } | null = null
    const initCalls: string[] = []
    const runner: CliRunner = {
      async run(opts) {
        initCalls.push(opts.cmd)
        if (opts.cmd === 'whoami') {
          return {
            ok: true,
            result: { evmAddress: '0xevm', suiAddress: '0xsui' }
          }
        }
        if (opts.cmd === 'policy' && opts.args[0] === 'get') {
          return {
            ok: true,
            result: { policy: { authorization_method: { Disabled: null } } }
          }
        }
        if (opts.cmd === '2fa' && opts.args[0] === 'status') {
          return { ok: true, result: { method: 'disabled' } }
        }
        if (opts.cmd === 'send-tx') {
          return new Promise((_resolve, reject) => {
            inflight = { reject }
            opts.signal?.addEventListener('abort', () => {
              const err: any = new Error('CLI aborted by caller')
              err.code = 'CLI_ABORTED'
              err.name = 'CliError'
              reject(err)
            })
          })
        }
        throw new Error(`unexpected: ${opts.cmd}`)
      },
      async resolveBinary() {
        return '/fake'
      }
    }
    const svc = await WaapService.startWithRunner(fakeRuntime(), runner)

    // Kick off a send-tx that will hang waiting for 2FA approval.
    const inFlight = svc
      .sendTx({
        to: '0x0000000000000000000000000000000000000001',
        value: '0.01'
      })
      .catch(() => undefined) // we expect this to reject when re-init aborts
    await Promise.resolve()
    expect(svc.getPendingAuthz()?.kind).toBe('send-tx')

    // Simulate a session restart by re-running initialize() (this is what
    // login() / signup() do internally on a fresh session).
    await svc.initialize()

    // Pending slot must be cleared, the in-flight subprocess aborted.
    expect(svc.getPendingAuthz()).toBeNull()
    await inFlight
    // Sanity: initialize() ran the standard whoami/policy/2fa probe twice,
    // once for the original start and once for the restart.
    expect(initCalls.filter((c) => c === 'whoami').length).toBe(2)
    // Avoid unused-var warning for `inflight` in the no-abort path.
    void inflight
  })

  it('cancelPendingAuthz(): also fires `waap-cli cancel` when payloadId + method are known', async () => {
    // After awaiting_2fa, we have both msg_hash (payloadId) and method, so
    // the plugin should atomically remove the cached challenge on the backend
    // — defense in depth on top of aborting the local subprocess.
    const cancelCalls: { args: string[] }[] = []

    const runner: CliRunner = {
      async run(opts) {
        if (opts.cmd === 'whoami') {
          return {
            ok: true,
            result: { evmAddress: '0xevm', suiAddress: '0xsui' }
          }
        }
        if (opts.cmd === 'policy' && opts.args[0] === 'get') {
          return {
            ok: true,
            result: { policy: { authorization_method: { Disabled: null } } }
          }
        }
        if (opts.cmd === '2fa' && opts.args[0] === 'status') {
          return { ok: true, result: { method: 'disabled' } }
        }
        if (opts.cmd === 'send-tx') {
          // Emit awaiting_2fa so the slot picks up payloadId + method
          await opts.onEvent?.({
            event: 'awaiting_2fa',
            method: 'email',
            payloadId:
              '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
            timeoutMs: 300_000
          })
          return new Promise((_resolve, reject) => {
            opts.signal?.addEventListener('abort', () => {
              const err: any = new Error('CLI aborted by caller')
              err.code = 'CLI_ABORTED'
              err.name = 'CliError'
              reject(err)
            })
          })
        }
        if (opts.cmd === 'cancel') {
          cancelCalls.push({ args: [...opts.args] })
          return { ok: true, result: { cancelled: true } }
        }
        throw new Error(`unexpected: ${opts.cmd}`)
      },
      async resolveBinary() {
        return '/fake'
      }
    }

    const svc = await WaapService.startWithRunner(fakeRuntime(), runner)
    const inFlight = svc.sendTx({
      to: '0x0000000000000000000000000000000000000001',
      value: '0.01'
    })

    // Wait until the awaiting_2fa event has been dispatched so the slot has
    // payloadId + method populated. Two microtask flushes are enough.
    await Promise.resolve()
    await Promise.resolve()
    expect(svc.getPendingAuthz()?.payloadId).toBeDefined()

    svc.cancelPendingAuthz()
    await expect(inFlight).rejects.toThrow()

    // Wait for the detached backend cancel to settle.
    await new Promise((r) => setTimeout(r, 0))

    expect(cancelCalls).toHaveLength(1)
    expect(cancelCalls[0].args).toEqual([
      '--msg-hash',
      '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      '--authz-kind',
      'email_authz'
    ])
  })

  it('cancelPendingAuthz(): skips backend cancel if no payloadId yet (awaiting_2fa never fired)', async () => {
    // Pre-2FA cancel — e.g. user aborts during initial submission. There's
    // no msg_hash to delete, so we should NOT spawn `waap-cli cancel`.
    const cancelCalls: string[] = []

    const runner: CliRunner = {
      async run(opts) {
        if (opts.cmd === 'whoami') {
          return {
            ok: true,
            result: { evmAddress: '0xevm', suiAddress: '0xsui' }
          }
        }
        if (opts.cmd === 'policy' && opts.args[0] === 'get') {
          return {
            ok: true,
            result: { policy: { authorization_method: { Disabled: null } } }
          }
        }
        if (opts.cmd === '2fa' && opts.args[0] === 'status') {
          return { ok: true, result: { method: 'disabled' } }
        }
        if (opts.cmd === 'send-tx') {
          // No awaiting_2fa event emitted — slot stays method/payloadId-less
          return new Promise((_resolve, reject) => {
            opts.signal?.addEventListener('abort', () => {
              const err: any = new Error('CLI aborted by caller')
              err.code = 'CLI_ABORTED'
              err.name = 'CliError'
              reject(err)
            })
          })
        }
        if (opts.cmd === 'cancel') {
          cancelCalls.push(opts.cmd)
          return { ok: true, result: {} }
        }
        throw new Error(`unexpected: ${opts.cmd}`)
      },
      async resolveBinary() {
        return '/fake'
      }
    }

    const svc = await WaapService.startWithRunner(fakeRuntime(), runner)
    const inFlight = svc.sendTx({
      to: '0x0000000000000000000000000000000000000001',
      value: '0.01'
    })

    await Promise.resolve()
    svc.cancelPendingAuthz()
    await expect(inFlight).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 0))

    expect(cancelCalls).toHaveLength(0)
  })

  it('request() returns the RPC result emitted by the CLI under `result`', async () => {
    // Regression: the CLI emits `{ event: "result", result: <value> }` for the
    // request command, not `{ data: <value> }`. WaapService.request() must
    // surface that value under .data so callers (and the WAAP_REQUEST action)
    // see the actual RPC return — not undefined.
    const svc = await WaapService.startWithRunner(
      fakeRuntime(),
      mockRunner([
        ...DUAL_INIT,
        { cmd: 'request', result: { result: '0x140dc6f' } }
      ])
    )

    const out = await svc.request({ method: 'eth_blockNumber' })
    expect(out).toEqual({ data: '0x140dc6f' })
  })

  it('passes --chain flag on signMessage CLI call', async () => {
    const calls: { cmd: string; args: string[] }[] = []
    const svc = await WaapService.startWithRunner(
      fakeRuntime(),
      mockRunner(
        [...DUAL_INIT, { cmd: 'sign-message', result: { signature: '0xsig' } }],
        calls
      )
    )
    await svc.signMessage({ message: 'hello' })
    const signCall = calls.find((c) => c.cmd === 'sign-message')
    expect(signCall!.args).toContain('--chain')
    expect(signCall!.args).toContain('evm:1')
  })

  it('getBalance() on Sui chain uses --chain sui:mainnet', async () => {
    const calls: { cmd: string; args: string[] }[] = []
    const svc = await WaapService.startWithRunner(
      fakeRuntime(),
      mockRunner(
        [
          ...DUAL_INIT,
          {
            cmd: 'balance',
            result: {
              balance: '1000000000',
              balanceFormatted: '1.0',
              address: '0xsui',
              chainId: 'sui:mainnet'
            }
          }
        ],
        calls
      )
    )
    svc.switchChain('sui')
    const result = await svc.getBalance()
    const balanceCall = calls.find((c) => c.cmd === 'balance')
    expect(balanceCall!.args).toContain('--chain')
    expect(balanceCall!.args).toContain('sui:mainnet')
    expect(result.balanceRaw).toBe('1000000000')
  })
})

describe('WaapService — audit fixes', () => {
  const DEAD = '0x000000000000000000000000000000000000dEaD'

  const initCalls = [
    { cmd: 'whoami', result: { evmAddress: '0xabc', suiAddress: '0xsui' } },
    {
      cmd: 'policy',
      result: { policy: { authorization_method: { Disabled: null } } }
    },
    { cmd: '2fa', result: { method: 'disabled' } }
  ]

  it('sendTx honors an input.chain override AND forwards the per-chain permission token (fund-routing gaps)', async () => {
    const recorded: Array<{ cmd: string; args: string[] }> = []
    const runner = mockRunner(
      [
        ...initCalls,
        { cmd: 'send-tx', result: { txHash: '0xtx', from: '0xabc' } }
      ],
      recorded
    )
    // Active chain is evm:1; we send on evm:137 and have a token configured for 137.
    const runtime = fakeRuntime({
      settings: {
        WAAP_DEFAULT_CHAIN_ID: '1',
        WAAP_PERMISSION_TOKEN_137: 'perm-137'
      }
    })
    const svc = await WaapService.startWithRunner(runtime, runner)

    await svc.sendTx({ to: DEAD, value: '0.1', chain: 'evm:137' })

    const send = recorded.find((c) => c.cmd === 'send-tx')!
    // Override honored — NOT the active evm:1.
    expect(send.args[send.args.indexOf('--chain') + 1]).toBe('evm:137')
    // Permission token looked up for the OVERRIDE chain (137), not the active one.
    const tokIdx = send.args.indexOf('--permission-token')
    expect(tokIdx).toBeGreaterThan(-1)
    expect(send.args[tokIdx + 1]).toBe('perm-137')
  })

  it('does NOT forward a permission token when none is configured for the chain', async () => {
    const recorded: Array<{ cmd: string; args: string[] }> = []
    const runner = mockRunner(
      [
        ...initCalls,
        { cmd: 'send-tx', result: { txHash: '0xtx', from: '0xabc' } }
      ],
      recorded
    )
    const runtime = fakeRuntime({ settings: { WAAP_DEFAULT_CHAIN_ID: '1' } })
    const svc = await WaapService.startWithRunner(runtime, runner)

    await svc.sendTx({ to: DEAD, value: '0.1' })

    const send = recorded.find((c) => c.cmd === 'send-tx')!
    expect(send.args).not.toContain('--permission-token')
  })

  it('enable2fa(phone) is refused with PHONE_2FA_UNSUPPORTED (never reaches the CLI)', async () => {
    const recorded: Array<{ cmd: string; args: string[] }> = []
    const runner = mockRunner([...initCalls], recorded)
    const svc = await WaapService.startWithRunner(fakeRuntime(), runner)

    await expect(
      svc.enable2fa({ method: 'phone' as any })
    ).rejects.toMatchObject({ code: 'PHONE_2FA_UNSUPPORTED' })
    // The reject happens before any CLI dispatch — no `2fa enable` call.
    expect(
      recorded.some((c) => c.cmd === '2fa' && c.args[0] === 'enable')
    ).toBe(false)
  })

  it('M4: parsePolicy treats a non-numeric limit as unset (no $NaN)', async () => {
    const runner = mockRunner([
      { cmd: 'whoami', result: { evmAddress: '0xabc', suiAddress: '0xsui' } },
      {
        cmd: 'policy',
        result: {
          policy: {
            authorization_method: { Disabled: null },
            daily_spend_limit_in_usd: 'unlimited'
          }
        }
      },
      { cmd: '2fa', result: { method: 'disabled' } }
    ])
    const svc = await WaapService.startWithRunner(fakeRuntime(), runner)
    expect(svc.getPolicy().dailySpendLimitUsd).toBeUndefined()
  })

  it('H2: a CLI error echoing --password is redacted before it can reach chat', async () => {
    const runner: CliRunner = {
      async resolveBinary() {
        return '/fake'
      },
      async run(opts) {
        // whoami fails as NO_SESSION so initialize() drops to not-ready cleanly.
        if (opts.cmd === 'whoami') {
          throw new CliError('No session found', 'NO_SESSION')
        }
        if (opts.cmd === 'login') {
          throw new CliError(
            'usage: login --email a@b.com --password hunter2trustno1',
            'UNKNOWN',
            'argv: login --email a@b.com --password hunter2trustno1',
            1
          )
        }
        throw new Error(`unexpected cmd: ${opts.cmd}`)
      }
    }
    const svc = await WaapService.startWithRunner(fakeRuntime(), runner)

    await expect(svc.login('a@b.com', 'hunter2trustno1')).rejects.toMatchObject(
      {}
    )
    const err = await svc.login('a@b.com', 'hunter2trustno1').catch((e) => e)
    expect(String(err.message)).not.toContain('hunter2trustno1')
    expect(String(err.message)).toContain('***')
  })

  it('H1: refreshPolicy does not resurrect/overwrite state after the session ended mid-round-trip', async () => {
    let svc!: WaapService
    let policyGets = 0
    const runner: CliRunner = {
      async resolveBinary() {
        return '/fake'
      },
      async run(opts) {
        if (opts.cmd === 'whoami')
          return {
            ok: true,
            result: { evmAddress: '0xabc', suiAddress: '0xsui' }
          }
        if (opts.cmd === 'policy') {
          policyGets++
          // The 2nd `policy get` is our explicit refreshPolicy() call: simulate
          // a logout landing while it is in flight.
          if (policyGets === 2) await svc.logout()
          return {
            ok: true,
            result: {
              policy: {
                authorization_method: { Email: 'a@b.com' },
                daily_spend_limit_in_usd: 999
              }
            }
          }
        }
        if (opts.cmd === '2fa')
          return { ok: true, result: { method: 'disabled' } }
        if (opts.cmd === 'logout')
          return { ok: true, result: { loggedOut: true } }
        throw new Error(`unexpected cmd: ${opts.cmd}`)
      }
    }
    svc = await WaapService.startWithRunner(fakeRuntime(), runner)

    await svc.refreshPolicy()

    // logout() tore the session down; the late refresh must NOT have written
    // policy back into a logged-out service.
    expect(svc.isReady()).toBe(false)
    expect(() => svc.getState()).toThrow()
  })
})
