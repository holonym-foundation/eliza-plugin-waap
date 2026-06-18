import { describe, it, expect, vi, beforeEach } from 'vitest'

import { enable2faAction } from '../../../src/actions/enable2fa'
import { extractEnable2faParams } from '../../../src/actions/paramExtraction'

vi.mock('../../../src/actions/paramExtraction', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/actions/paramExtraction')
  >('../../../src/actions/paramExtraction')
  return {
    ...actual,
    extractEnable2faParams: vi.fn()
  }
})

function fakeRuntime(svcOverrides: Partial<any> = {}) {
  return {
    agentId: 'test-agent',
    getSetting: (_k: string) => undefined,
    sendMessageToTarget: vi.fn().mockResolvedValue(undefined),
    getService: (_t: any) => ({
      isReady: () => true,
      getSessionEpoch: () => 1,
      getAddress: () => '0xabc',
      getChainFamily: () => 'evm',
      get2faStatus: vi.fn().mockResolvedValue({ method: 'disabled' }),
      enable2fa: vi
        .fn()
        .mockImplementation(async (input: any) => ({ method: input.method })),
      ...svcOverrides
    })
  } as any
}

const fakeMessage = (text: string) =>
  ({
    content: { text, source: 'discord' },
    userId: 'u',
    roomId: 'r',
    agentId: 'a'
  }) as any

/** Resolve queued microtasks so background live-channel deliveries can run. */
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('enable2faAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('has WAAP_ENABLE_2FA name and expected similes', () => {
    expect(enable2faAction.name).toBe('WAAP_ENABLE_2FA')
    expect(enable2faAction.similes).toContain('SETUP_2FA')
    expect(enable2faAction.similes).toContain('ENABLE_TWO_FACTOR')
  })

  // ─── method × value pairings (CLI parity) ────────────────────────────────

  it('email method: dispatches with email field', async () => {
    ;(extractEnable2faParams as any).mockResolvedValue({
      ok: true,
      value: { method: 'email', email: 'agent@example.com' }
    })
    const enable2fa = vi.fn().mockResolvedValue({ method: 'email' as const })
    const runtime = fakeRuntime({ enable2fa })
    const callback = vi.fn()

    const result = await enable2faAction.handler(
      runtime,
      fakeMessage('enable 2FA via email agent@example.com'),
      undefined,
      {},
      callback
    )

    expect(result).toMatchObject({ success: true })
    expect(enable2fa).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'email',
        email: 'agent@example.com'
      }),
      expect.any(Object)
    )
  })

  it('telegram method: dispatches with telegramChatId field', async () => {
    ;(extractEnable2faParams as any).mockResolvedValue({
      ok: true,
      value: { method: 'telegram', telegramChatId: '7381029636' }
    })
    const enable2fa = vi.fn().mockResolvedValue({ method: 'telegram' as const })
    const runtime = fakeRuntime({ enable2fa })
    const callback = vi.fn()

    const result = await enable2faAction.handler(
      runtime,
      fakeMessage('set up telegram 2FA with chat ID 7381029636'),
      undefined,
      {},
      callback
    )

    expect(result).toMatchObject({ success: true })
    expect(enable2fa).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'telegram',
        telegramChatId: '7381029636'
      }),
      expect.any(Object)
    )
  })

  it('external_wallet method: dispatches with walletAddress field', async () => {
    const addr = '0xabcdef0123456789abcdef0123456789abcdef01'
    ;(extractEnable2faParams as any).mockResolvedValue({
      ok: true,
      value: { method: 'external_wallet', walletAddress: addr }
    })
    const enable2fa = vi
      .fn()
      .mockResolvedValue({ method: 'external_wallet' as const })
    const runtime = fakeRuntime({ enable2fa })
    const callback = vi.fn()

    const result = await enable2faAction.handler(
      runtime,
      fakeMessage(`use my hardware wallet ${addr} for 2FA`),
      undefined,
      {},
      callback
    )

    expect(result).toMatchObject({ success: true })
    expect(enable2fa).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'external_wallet',
        walletAddress: addr
      }),
      expect.any(Object)
    )
  })

  // ─── ask-and-wait when credential is missing (no dispatch) ───────────────

  it('method without value: re-asks for the credential and does NOT dispatch the service call', async () => {
    ;(extractEnable2faParams as any).mockResolvedValue({
      ok: false,
      error: 'Missing required field for the chosen 2FA method (email)'
    })
    const enable2fa = vi.fn()
    const runtime = fakeRuntime({ enable2fa })
    const callback = vi.fn()

    const result = await enable2faAction.handler(
      runtime,
      fakeMessage('enable 2FA via email'),
      undefined,
      {},
      callback
    )

    expect(result).toMatchObject({ success: false })
    expect(enable2fa).not.toHaveBeenCalled()

    // Friendly re-ask for the email — not the raw zod message.
    const reply = String(callback.mock.calls[0][0]?.text ?? '')
    expect(reply).toMatch(/email address/i)
    expect(reply).not.toContain('zod')
    expect(reply).not.toContain('refine')
  })

  it('no method and no value: re-asks for the supported methods (phone is not offered)', async () => {
    ;(extractEnable2faParams as any).mockResolvedValue({
      ok: false,
      // schema's enum check fails — no method-specific keyword in the message.
      error: 'Required: method must be one of email, telegram, external_wallet'
    })
    const runtime = fakeRuntime()
    const callback = vi.fn()

    const result = await enable2faAction.handler(
      runtime,
      fakeMessage('enable 2FA'),
      undefined,
      {},
      callback
    )

    expect(result).toMatchObject({ success: false })
    const reply = String(callback.mock.calls[0][0]?.text ?? '')
    expect(reply).toMatch(/email/i)
    expect(reply).toMatch(/telegram/i)
    expect(reply).toMatch(/wallet/i)
    // Phone is NOT a supported method — the re-ask must not offer it.
    expect(reply).not.toMatch(/phone/i)
  })

  // ─── failure path: service throws ────────────────────────────────────────

  it('service failure: callback contains a friendly error summary', async () => {
    ;(extractEnable2faParams as any).mockResolvedValue({
      ok: true,
      value: { method: 'email', email: 'agent@example.com' }
    })
    const enable2fa = vi
      .fn()
      .mockRejectedValue(new Error('Timed out waiting for 2FA approval'))
    const runtime = fakeRuntime({ enable2fa })
    const callback = vi.fn()

    const result = await enable2faAction.handler(
      runtime,
      fakeMessage('enable 2FA via email agent@example.com'),
      undefined,
      {},
      callback
    )

    expect(result).toMatchObject({ success: false })
    const text = String((result as any).text ?? '')
    expect(text).toContain('❌ Failed to enable 2FA via Email')
    expect(text).toContain('Timed out')
  })

  // ─── blocking authz + session guard ──────────────────────────────

  it('non-blocking: returns a self-contained instruction the moment the approval prompt is out', async () => {
    ;(extractEnable2faParams as any).mockResolvedValue({
      ok: true,
      value: { method: 'email', email: 'agent@example.com' }
    })

    // enable2fa emits awaiting_2fa (approval prompt) then stays pending —
    // mirroring the real CLI waiting on its WebSocket for the user to approve.
    let finishOp!: () => void
    const enable2fa = vi
      .fn()
      .mockImplementation(async (input: any, progress: any) => {
        await progress.onEvent({
          event: 'awaiting_2fa',
          method: 'email',
          payloadId: 'p1',
          timeoutMs: 300_000
        })
        return new Promise((resolve) => {
          finishOp = () => resolve({ method: input.method })
        })
      })
    const runtime = fakeRuntime({ enable2fa })
    const callback = vi.fn()

    // Returns immediately even though the op is still pending.
    const result = await enable2faAction.handler(
      runtime,
      fakeMessage('enable 2FA via email agent@example.com'),
      undefined,
      {},
      callback
    )

    expect(result).toMatchObject({ success: true, data: { pending: true } })
    // The instruction names the channel AND how to confirm — self-contained,
    // because it's the only message guaranteed to reach the web UI.
    const cbText = String(callback.mock.calls[0][0]?.text ?? '')
    expect(cbText).toMatch(/email inbox/i)
    expect(cbText).toMatch(/is 2FA on/i)

    finishOp()
    await flush()
  })

  it('session guard: a completion landing after a session change is NOT delivered to the live channel', async () => {
    ;(extractEnable2faParams as any).mockResolvedValue({
      ok: true,
      value: { method: 'email', email: 'agent@example.com' }
    })

    let epoch = 1
    let finishOp!: () => void
    const enable2fa = vi
      .fn()
      .mockImplementation(async (input: any, progress: any) => {
        await progress.onEvent({
          event: 'awaiting_2fa',
          method: 'email',
          payloadId: 'p1',
          timeoutMs: 300_000
        })
        return new Promise((resolve) => {
          finishOp = () => resolve({ method: input.method })
        })
      })
    const runtime = fakeRuntime({ enable2fa, getSessionEpoch: () => epoch })
    const callback = vi.fn()

    await enable2faAction.handler(
      runtime,
      fakeMessage('enable 2FA via email agent@example.com'),
      undefined,
      {},
      callback
    )

    epoch = 2 // logout / re-login while the approval was outstanding
    finishOp()
    await flush()

    const liveTexts = runtime.sendMessageToTarget.mock.calls.map(
      (c: any[]) => c[1].text
    )
    expect(liveTexts.some((t: string) => /2FA enabled/.test(t))).toBe(false)
  })

  it('abort before any prompt (CLI_ABORTED): stays silent — no stray failure message', async () => {
    ;(extractEnable2faParams as any).mockResolvedValue({
      ok: true,
      value: { method: 'email', email: 'agent@example.com' }
    })

    const enable2fa = vi.fn().mockRejectedValue(
      Object.assign(new Error('CLI aborted by caller'), {
        code: 'CLI_ABORTED'
      })
    )
    const runtime = fakeRuntime({ enable2fa })
    const callback = vi.fn()

    const result = await enable2faAction.handler(
      runtime,
      fakeMessage('enable 2FA via email agent@example.com'),
      undefined,
      {},
      callback
    )

    expect(result).toMatchObject({ success: false, data: { aborted: true } })
    expect(callback).not.toHaveBeenCalled()
  })
})
