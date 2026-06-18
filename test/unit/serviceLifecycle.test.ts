/**
 * Service lifecycle integration tests.
 *
 * These test the REAL WaapService + action handlers together — no mocking of
 * service state. They reproduce the exact bugs found during webapp testing:
 *
 *   1. Stale session → service crash → plugin fails to register
 *   2. Service not ready → action runs anyway → "service not initialized"
 *   3. getBalance() with null state → confusing "non-EVM wallets" error
 *   4. Login → initialize → state populated → actions work
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import type { CliRunner, CliRunOptions, CliResult } from '../../src/cliRunner'
import { WaapService } from '../../src/services/WaapService'
import { getBalanceAction } from '../../src/actions/getBalance'
import { signMessageAction } from '../../src/actions/signMessage'
import { sendTxAction } from '../../src/actions/sendTx'
import { signupAction } from '../../src/actions/signup'
import { loginAction } from '../../src/actions/login'
import { switchChainAction } from '../../src/actions/switchChain'
import { logoutAction } from '../../src/actions/logout'
import { setPolicyAction } from '../../src/actions/setPolicy'
import { twoFaStatusAction } from '../../src/actions/twoFaStatus'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Builds a runtime that uses a REAL WaapService instance (not a mock). */
function realRuntime(svc: WaapService) {
  return {
    agentId: 'test-agent',
    getSetting: (_k: string) => undefined,
    getService: (_t: any) => svc
  } as any
}

const msg = (text: string) =>
  ({ content: { text }, userId: 'u', roomId: 'r', agentId: 'a' }) as any

/** Creates a scripted CLI runner. Each call pops the next response. */
function scriptedRunner(
  responses: Array<{
    cmd: string
    result?: Record<string, unknown>
    error?: Error
  }>
): CliRunner {
  let idx = 0
  return {
    async run(opts: CliRunOptions): Promise<CliResult> {
      const next = responses[idx++]
      if (!next)
        throw new Error(
          `No scripted response for cmd=${opts.cmd} (call ${idx})`
        )
      if (next.error) throw next.error
      return { ok: true, result: next.result ?? {} }
    },
    async resolveBinary() {
      return '/fake/waap-cli'
    }
  }
}

function fakeRuntime(settings: Record<string, string> = {}) {
  return {
    agentId: 'test-agent',
    getSetting: (key: string) => settings[key],
    getService: vi.fn()
  } as any
}

const FAKE_SUI_ADDR = '0x' + 'cd'.repeat(32)

/** Standard init responses: whoami + policy get + 2fa status */
const INIT_RESPONSES = [
  {
    cmd: 'whoami',
    result: { evmAddress: '0xabc123', suiAddress: FAKE_SUI_ADDR }
  },
  {
    cmd: 'policy',
    result: { policy: { authorization_method: { Disabled: null } } }
  },
  { cmd: '2fa', result: { method: 'disabled' } }
]

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Bug: stale/expired session should not crash service', () => {
  it('400 Bad Request from whoami → graceful unauthenticated mode, not crash', async () => {
    const runner = scriptedRunner([
      {
        cmd: 'whoami',
        error: Object.assign(
          new Error('Failed to fetch keyshare (400): Bad Request'),
          {
            code: 'UNKNOWN'
          }
        )
      }
    ])

    // This previously threw and crashed service registration
    const svc = await WaapService.startWithRunner(fakeRuntime(), runner)

    expect(svc.isReady()).toBe(false)
  })

  it('CLI_PROTOCOL error from whoami → graceful unauthenticated mode', async () => {
    const runner = scriptedRunner([
      {
        cmd: 'whoami',
        error: Object.assign(new Error('unexpected JSON'), {
          code: 'CLI_PROTOCOL'
        })
      }
    ])

    const svc = await WaapService.startWithRunner(fakeRuntime(), runner)
    expect(svc.isReady()).toBe(false)
  })

  it('generic UNKNOWN error from whoami → graceful unauthenticated mode', async () => {
    const runner = scriptedRunner([
      {
        cmd: 'whoami',
        error: Object.assign(new Error('connection refused'), {
          code: 'UNKNOWN'
        })
      }
    ])

    const svc = await WaapService.startWithRunner(fakeRuntime(), runner)
    expect(svc.isReady()).toBe(false)
  })
})

describe('Bug: actions on unauthenticated service should say "please log in"', () => {
  let svc: WaapService
  let runtime: any

  // Set up a service that started in unauthenticated mode (stale session)
  beforeAll(async () => {
    const runner = scriptedRunner([
      {
        cmd: 'whoami',
        error: Object.assign(new Error('expired'), { code: 'NO_SESSION' })
      }
    ])
    svc = await WaapService.startWithRunner(fakeRuntime(), runner)
    runtime = realRuntime(svc)
  })

  it('service is not ready', () => {
    expect(svc.isReady()).toBe(false)
  })

  it('getBalance validate returns true even on unauthenticated service (handler emits friendly "not logged in")', async () => {
    expect(await getBalanceAction.validate(runtime, msg('balance'))).toBe(true)
  })

  it('getBalance handler emits a usable not-logged-in action card (success=true with sign-up / log-in instructions, NOT a canned reject)', async () => {
    // New behavior: returns success=true with `loggedIn: false` so the LLM
    // keeps choosing this action over NONE on follow-up balance questions.
    const cb = vi.fn()
    const result = await getBalanceAction.handler(
      runtime,
      msg('balance'),
      undefined,
      {},
      cb
    )
    expect(result).toMatchObject({ success: true })
    expect((result as any).data).toMatchObject({ loggedIn: false })
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('not logged in')
      })
    )
  })

  it('signMessage validate returns true even on unauthenticated service', async () => {
    expect(await signMessageAction.validate(runtime, msg('sign hello'))).toBe(
      true
    )
  })

  it('signMessage handler returns friendly "not logged in" message', async () => {
    const cb = vi.fn()
    const result = await signMessageAction.handler(
      runtime,
      msg('sign hello'),
      undefined,
      {},
      cb
    )
    expect(result).toMatchObject({ success: false })
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('not logged in')
      })
    )
  })

  it('sendTx validate returns true even on unauthenticated service', async () => {
    expect(await sendTxAction.validate(runtime, msg('send 1 ETH'))).toBe(true)
  })

  it('switchChain validate returns true even on unauthenticated service', async () => {
    expect(
      await switchChainAction.validate(runtime, msg('switch to polygon'))
    ).toBe(true)
  })

  it('switchChain handler returns friendly "not logged in" message', async () => {
    const cb = vi.fn()
    const result = await switchChainAction.handler(
      runtime,
      msg('switch to polygon'),
      undefined,
      {},
      cb
    )
    expect(result).toMatchObject({ success: false })
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('not logged in')
      })
    )
  })

  it('setPolicy validate returns true even on unauthenticated service', async () => {
    expect(await setPolicyAction.validate(runtime, msg('set limit'))).toBe(true)
  })

  it('2faStatus validate returns true even on unauthenticated service', async () => {
    expect(await twoFaStatusAction.validate(runtime, msg('2fa status'))).toBe(
      true
    )
  })

  it('logout validate returns true even on unauthenticated service', async () => {
    expect(await logoutAction.validate(runtime, msg('logout'))).toBe(true)
  })

  it('signup validate returns true (available when NOT logged in)', async () => {
    expect(await signupAction.validate(runtime, msg('sign up'))).toBe(true)
  })

  it('login validate returns true (available when NOT logged in)', async () => {
    expect(await loginAction.validate(runtime, msg('log in'))).toBe(true)
  })
})

describe('Bug: login → initialize → actions work', () => {
  it('full flow: unauthenticated → login → balance works', async () => {
    let callIdx = 0
    const responses = [
      // 1. initialize: whoami fails (no session)
      {
        cmd: 'whoami',
        error: Object.assign(new Error('No session'), { code: 'NO_SESSION' })
      },
      // 2. login succeeds
      { cmd: 'login', result: { address: '0xnewaddr' } },
      // 3. re-initialize after login: whoami succeeds
      {
        cmd: 'whoami',
        result: { evmAddress: '0xnewaddr', suiAddress: FAKE_SUI_ADDR }
      },
      {
        cmd: 'policy',
        result: { policy: { authorization_method: { Disabled: null } } }
      },
      { cmd: '2fa', result: { method: 'disabled' } },
      // 4. balance query
      {
        cmd: 'balance',
        result: {
          balance: '0xde0b6b3a7640000',
          balanceFormatted: '1',
          address: '0xnewaddr',
          chainId: 1
        }
      }
    ]

    const runner: CliRunner = {
      async run(opts: CliRunOptions): Promise<CliResult> {
        const next = responses[callIdx++]
        if (!next)
          throw new Error(`No response for call ${callIdx}: ${opts.cmd}`)
        if (next.error) throw next.error
        return { ok: true, result: next.result ?? {} }
      },
      async resolveBinary() {
        return '/fake'
      }
    }

    // Start in unauthenticated mode
    const svc = await WaapService.startWithRunner(fakeRuntime(), runner)
    expect(svc.isReady()).toBe(false)

    // Login
    await svc.login('test@test.com', 'password123')
    expect(svc.isReady()).toBe(true)
    expect(svc.getAddress()).toBe('0xnewaddr')

    // Balance now works
    const result = await svc.getBalance()
    expect(result.balanceRaw).toBe('0xde0b6b3a7640000')
    expect(result.chainId).toBe('evm:1')
  })

  it('full flow: unauthenticated → signup → switchChain → balance works', async () => {
    let callIdx = 0
    const responses = [
      // 1. initialize: whoami fails
      {
        cmd: 'whoami',
        error: Object.assign(new Error('No session'), { code: 'NO_SESSION' })
      },
      // 2. signup succeeds
      { cmd: 'signup', result: { address: '0xsigned' } },
      // 3. re-initialize after signup
      {
        cmd: 'whoami',
        result: { evmAddress: '0xsigned', suiAddress: FAKE_SUI_ADDR }
      },
      {
        cmd: 'policy',
        result: { policy: { authorization_method: { Disabled: null } } }
      },
      { cmd: '2fa', result: { method: 'disabled' } },
      // 4. balance on polygon after switchChain
      {
        cmd: 'balance',
        result: {
          balance: '0x0',
          balanceFormatted: '0',
          address: '0xsigned',
          chainId: 137
        }
      }
    ]

    const runner: CliRunner = {
      async run(opts: CliRunOptions): Promise<CliResult> {
        const next = responses[callIdx++]
        if (!next)
          throw new Error(`No response for call ${callIdx}: ${opts.cmd}`)
        if (next.error) throw next.error
        return { ok: true, result: next.result ?? {} }
      },
      async resolveBinary() {
        return '/fake'
      }
    }

    const svc = await WaapService.startWithRunner(fakeRuntime(), runner)
    expect(svc.isReady()).toBe(false)

    await svc.signup('test@test.com', 'password123', 'Test')
    expect(svc.isReady()).toBe(true)

    svc.switchChain(137)
    expect(svc.getChainState()).toMatchObject({ family: 'evm', chainId: 137 })

    const result = await svc.getBalance()
    expect(result.chainId).toBe('evm:137')
  })
})

describe('Bug: logout clears state correctly', () => {
  it('logout → isReady false → read-only actions emit a usable not-logged-in card (no reject)', async () => {
    const responses = [...INIT_RESPONSES, { cmd: 'logout', result: {} }]

    const svc = await WaapService.startWithRunner(
      fakeRuntime(),
      scriptedRunner(responses)
    )
    expect(svc.isReady()).toBe(true)

    await svc.logout()
    expect(svc.isReady()).toBe(false)

    // After the not-logged-in handler refactor, getBalance no longer rejects.
    // It returns success=true with `loggedIn: false` so the LLM keeps the
    // action in its dispatch set instead of falling back to NONE.
    const runtime = realRuntime(svc)
    const cb = vi.fn()
    const result = await getBalanceAction.handler(
      runtime,
      msg('balance'),
      undefined,
      {},
      cb
    )
    expect(result).toMatchObject({ success: true })
    expect((result as any).data).toMatchObject({ loggedIn: false })
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('not logged in')
      })
    )
  })
})

describe('Bug: getBalance with no state should not say "non-EVM wallets"', () => {
  it('getBalance defaults to chain 1 when state is null', async () => {
    // This is a defensive test — getBalance should never be called when state
    // is null in normal flow because getWaapService gates on isReady.
    // But if ElizaOS bypasses validate, this should not throw "non-EVM wallets".
    const responses = [
      {
        cmd: 'whoami',
        error: Object.assign(new Error('No session'), { code: 'NO_SESSION' })
      }
    ]
    const svc = await WaapService.startWithRunner(
      fakeRuntime(),
      scriptedRunner(responses)
    )

    // state is null, but getBalance should not throw "non-EVM" error
    // It will throw "service not initialized" from getAddress() since
    // we can't look up the wallet address without state — but NOT "non-EVM"
    await expect(svc.getBalance()).rejects.toThrow()
    try {
      await svc.getBalance()
    } catch (err: any) {
      expect(err.message).not.toContain('non-EVM')
    }
  })
})

describe('getWaapService vs getWaapServiceRaw', () => {
  it('getWaapService returns null when service is not ready', async () => {
    const runner = scriptedRunner([
      {
        cmd: 'whoami',
        error: Object.assign(new Error('No session'), { code: 'NO_SESSION' })
      }
    ])
    const svc = await WaapService.startWithRunner(fakeRuntime(), runner)
    const runtime = realRuntime(svc)

    // Import the actual functions
    const { getWaapService, getWaapServiceRaw } = await import(
      '../../src/actions/actionUtils'
    )

    expect(getWaapService(runtime)).toBeNull()
    expect(getWaapServiceRaw(runtime)).toBe(svc)
  })

  it('getWaapService returns service when ready', async () => {
    const svc = await WaapService.startWithRunner(
      fakeRuntime(),
      scriptedRunner(INIT_RESPONSES)
    )
    const runtime = realRuntime(svc)

    const { getWaapService, getWaapServiceRaw } = await import(
      '../../src/actions/actionUtils'
    )

    expect(getWaapService(runtime)).toBe(svc)
    expect(getWaapServiceRaw(runtime)).toBe(svc)
  })
})

describe('Sui lifecycle: login → switch to Sui → getBalance', () => {
  it('full flow: login → switchChain(sui:mainnet) → getBalance returns SUI balance', async () => {
    let callIdx = 0
    const responses = [
      // 1. initialize: whoami fails
      {
        cmd: 'whoami',
        error: Object.assign(new Error('No session'), { code: 'NO_SESSION' })
      },
      // 2. login succeeds
      { cmd: 'login', result: { address: '0xnewaddr' } },
      // 3. re-initialize after login
      {
        cmd: 'whoami',
        result: { evmAddress: '0xnewaddr', suiAddress: FAKE_SUI_ADDR }
      },
      {
        cmd: 'policy',
        result: { policy: { authorization_method: { Disabled: null } } }
      },
      { cmd: '2fa', result: { method: 'disabled' } },
      // 4. balance on Sui
      {
        cmd: 'balance',
        result: {
          balance: '1000000000',
          balanceFormatted: '1',
          address: FAKE_SUI_ADDR,
          chainId: 'sui:mainnet'
        }
      }
    ]

    const runner: CliRunner = {
      async run(opts: CliRunOptions): Promise<CliResult> {
        const next = responses[callIdx++]
        if (!next)
          throw new Error(`No response for call ${callIdx}: ${opts.cmd}`)
        if (next.error) throw next.error
        return { ok: true, result: next.result ?? {} }
      },
      async resolveBinary() {
        return '/fake'
      }
    }

    const svc = await WaapService.startWithRunner(fakeRuntime(), runner)
    expect(svc.isReady()).toBe(false)

    await svc.login('test@test.com', 'password123')
    expect(svc.isReady()).toBe(true)

    // Switch to Sui
    svc.switchChain('sui:mainnet')
    expect(svc.getChainState()).toMatchObject({
      family: 'sui',
      network: 'mainnet'
    })
    expect(svc.getChainFamily()).toBe('sui')
    expect(svc.getAddress()).toBe(FAKE_SUI_ADDR)

    // Balance on Sui
    const result = await svc.getBalance()
    expect(result.balanceRaw).toBe('1000000000')
    expect(result.balanceFormatted).toBe('1')
    expect(result.chainId).toBe('sui:mainnet')
    expect(result.address).toBe(FAKE_SUI_ADDR)
  })
})
