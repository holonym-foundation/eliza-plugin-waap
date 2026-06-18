// Tests the three-state startup machine on WaapService and the provider's
// "starting up" branch. Without this distinction, the 1–3 sec window during
// which `whoami` runs after agent restart appears as `!isReady()` — the
// provider then falsely tells the LLM the user is "not logged in", even when
// there's a valid session on disk.

import { describe, it, expect, vi } from 'vitest'

import { WaapService } from '../../src/services/WaapService'
import { waapWalletProvider } from '../../src/provider'
import type { CliRunner, CliRunOptions, CliResult } from '../../src/cliRunner'

function fakeRuntime() {
  return {
    agentId: 'test-agent',
    getSetting: () => undefined,
    getService: vi.fn()
  } as any
}

const FAKE_SUI = '0x' + 'cd'.repeat(32)

const INIT_OK = [
  {
    cmd: 'whoami',
    result: { evmAddress: '0xabc', suiAddress: FAKE_SUI }
  },
  {
    cmd: 'policy',
    result: { policy: { authorization_method: { Disabled: null } } }
  },
  { cmd: '2fa', result: { method: 'disabled' } }
]

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
      return '/fake'
    }
  }
}

describe('WaapService three-state startup machine', () => {
  it('initial state (before initialize completes): isInitializing=true, isReady=false', () => {
    const svc = new WaapService(fakeRuntime())
    expect(svc.isInitializing()).toBe(true)
    expect(svc.isReady()).toBe(false)
  })

  it('after successful initialize: isInitializing=false, isReady=true', async () => {
    const svc = await WaapService.startWithRunner(
      fakeRuntime(),
      scriptedRunner(INIT_OK)
    )
    expect(svc.isInitializing()).toBe(false)
    expect(svc.isReady()).toBe(true)
  })

  it('after no-session fallback (whoami fails NO_SESSION): isInitializing=false, isReady=false', async () => {
    // Distinct from the still-booting state — whoami completed and confirmed
    // there is no saved session, so the LLM can correctly say "not logged in".
    const svc = await WaapService.startWithRunner(
      fakeRuntime(),
      scriptedRunner([
        {
          cmd: 'whoami',
          error: Object.assign(new Error('No session'), { code: 'NO_SESSION' })
        }
      ])
    )
    expect(svc.isInitializing()).toBe(false)
    expect(svc.isReady()).toBe(false)
  })

  it('after a non-recoverable initialize error: isInitializing=false (finally clause runs)', async () => {
    // PHONE_2FA_UNSUPPORTED is one of the error codes that re-throws past the
    // graceful-fallback branch. The `finally` must still flip `initializing`
    // off — otherwise a permanent "starting up" lie sticks for the lifetime
    // of the service.
    const svc = new WaapService(fakeRuntime())
    svc['runner'] = scriptedRunner([
      // whoami succeeds
      {
        cmd: 'whoami',
        result: { evmAddress: '0xabc', suiAddress: FAKE_SUI }
      },
      // policy succeeds
      {
        cmd: 'policy',
        result: { policy: { authorization_method: { Disabled: null } } }
      },
      // 2fa returns phone — triggers PHONE_2FA_UNSUPPORTED throw
      { cmd: '2fa', result: { method: 'phone' } }
    ]) as any

    await expect(svc.initialize()).rejects.toThrow(/phone 2FA is not supported/)
    expect(svc.isInitializing()).toBe(false)
  })

  it('after stop(): isInitializing=false, isReady=false', async () => {
    const svc = await WaapService.startWithRunner(
      fakeRuntime(),
      scriptedRunner(INIT_OK)
    )
    await svc.stop()
    expect(svc.isInitializing()).toBe(false)
    expect(svc.isReady()).toBe(false)
  })
})

describe('waapWalletProvider three-branch routing', () => {
  function runtimeWith(svc: any) {
    return {
      agentId: 'test-agent',
      getService: () => svc
    } as any
  }

  it('initializing=true → returns "starting up" context, NOT "not logged in"', async () => {
    const fakeSvc = {
      isInitializing: () => true,
      isReady: () => false
    }
    const out: any = await waapWalletProvider.get(
      runtimeWith(fakeSvc),
      {} as any,
      {} as any
    )
    expect(out.text).toContain('starting up')
    expect(out.text).not.toContain('not logged in')
    expect(out.values).toMatchObject({
      waapInitializing: true,
      waapLoggedIn: false
    })
  })

  it('initializing=false, ready=false → returns "not logged in" context', async () => {
    const fakeSvc = {
      isInitializing: () => false,
      isReady: () => false
    }
    const out: any = await waapWalletProvider.get(
      runtimeWith(fakeSvc),
      {} as any,
      {} as any
    )
    expect(out.text).toContain('not logged in')
    expect(out.values).toMatchObject({
      waapInitializing: false,
      waapLoggedIn: false
    })
  })

  it('ready=true → returns full wallet snapshot with addresses', async () => {
    const fakeSvc = {
      isInitializing: () => false,
      isReady: () => true,
      getState: () => ({
        evmAddress: '0xevm',
        suiAddress: '0xsui',
        chainState: { family: 'evm', chainId: 1, canonical: 'evm:1' },
        policy: { authorizationMethod: 'disabled', dailySpendLimitUsd: null }
      }),
      getPendingAuthz: () => null
    }
    const out: any = await waapWalletProvider.get(
      runtimeWith(fakeSvc),
      {} as any,
      {} as any
    )
    expect(out.text).toContain('logged in')
    expect(out.text).toContain('0xevm')
    expect(out.text).toContain('0xsui')
    expect(out.values.waapLoggedIn).toBe(true)
  })

  it('service not registered at all → returns "not logged in" context (no isInitializing call)', async () => {
    // svc is undefined; provider must not crash and must treat absent service
    // the same as not-logged-in (NOT as "starting up", which would be a lie).
    const out: any = await waapWalletProvider.get(
      runtimeWith(undefined),
      {} as any,
      {} as any
    )
    expect(out.text).toContain('not logged in')
    expect(out.values.waapLoggedIn).toBe(false)
  })
})
