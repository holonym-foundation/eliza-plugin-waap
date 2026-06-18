// Tests WAAP_WALLET_STATUS — comprehensive snapshot routed through the action
// callback so the chat renders real newlines instead of letting the LLM
// compose a free-form REPLY (which emits `\n` as literal escape characters).

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { walletStatusAction } from '../../../src/actions/walletStatus'

function fakeServiceReady(stateOverrides: Partial<any> = {}) {
  return {
    isReady: () => true,
    getState: () => ({
      evmAddress: '0xevm',
      suiAddress: '0xsui',
      chainState: { family: 'evm', chainId: 1, canonical: 'evm:1' },
      policy: { authorizationMethod: 'email', dailySpendLimitUsd: 500 },
      ...stateOverrides
    }),
    getPendingAuthz: () => null
  }
}

function fakeRuntime(
  opts: {
    service?: any
    sendMessageToTarget?: any
  } = {}
) {
  return {
    agentId: 'test-agent',
    sendMessageToTarget: opts.sendMessageToTarget,
    getService: () => opts.service ?? fakeServiceReady()
  } as any
}

const messageWithSource = () =>
  ({ content: { text: 'status', source: 'discord' }, roomId: 'r' }) as any

const messageWithoutSource = () =>
  ({ content: { text: 'status' }, roomId: 'r' }) as any

describe('walletStatusAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('has WAAP_WALLET_STATUS name and status-question similes', () => {
    expect(walletStatusAction.name).toBe('WAAP_WALLET_STATUS')
    expect(walletStatusAction.similes).toContain('AM_I_LOGGED_IN')
    expect(walletStatusAction.similes).toContain('WALLET_SUMMARY')
    expect(walletStatusAction.similes).toContain('SHOW_EVERYTHING')
  })

  it('validate() returns true even pre-login (handler shows the not-logged-in state)', async () => {
    const runtime = fakeRuntime({
      service: {
        isReady: () => false,
        getState: () => ({}),
        getPendingAuthz: () => null
      }
    })
    expect(
      await walletStatusAction.validate(runtime, messageWithSource())
    ).toBe(true)
  })

  it('not logged in: emits the logged-out snapshot via callback (with sign-up / log-in instructions)', async () => {
    const runtime = fakeRuntime({
      service: {
        isReady: () => false,
        getState: () => ({}),
        getPendingAuthz: () => null
      }
    })
    const callback = vi.fn()
    const result = await walletStatusAction.handler(
      runtime,
      messageWithoutSource(),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    const cbText = callback.mock.calls[0][0].text as string
    expect(cbText).toMatch(/not logged in/i)
    expect(cbText).toMatch(/sign up|log in/i)
    expect(callback.mock.calls[0][0].content).toMatchObject({ loggedIn: false })
  })

  it('logged in + live channel ok: callback gets terse line; rich snapshot via sendMessageToTarget', async () => {
    const sendMessageToTarget = vi.fn().mockResolvedValue(undefined)
    const runtime = fakeRuntime({ sendMessageToTarget })
    const callback = vi.fn()
    await walletStatusAction.handler(
      runtime,
      messageWithSource(),
      undefined,
      {},
      callback
    )

    const cbText = callback.mock.calls[0][0].text as string
    expect(cbText).not.toContain('\n')
    expect(cbText).not.toContain('0xevm')

    const liveText = sendMessageToTarget.mock.calls[0][1].text as string
    expect(liveText).toContain('logged in')
    expect(liveText).toContain('0xevm')
    expect(liveText).toContain('0xsui')
    expect(liveText).toContain('evm:1')
    expect(liveText).toContain('email')
    expect(liveText).toContain('$500/day')
    expect(liveText).toContain('\n')
    expect(liveText).not.toContain('\\n')
  })

  it('logged in + live channel unavailable: rich snapshot falls into callback', async () => {
    const runtime = fakeRuntime({})
    const callback = vi.fn()
    await walletStatusAction.handler(
      runtime,
      messageWithoutSource(),
      undefined,
      {},
      callback
    )
    const cbText = callback.mock.calls[0][0].text as string
    expect(cbText).toContain('0xevm')
    expect(cbText).toContain('0xsui')
    expect(cbText).toContain('\n')
  })

  it('content payload always includes structured wallet fields', async () => {
    const runtime = fakeRuntime({
      sendMessageToTarget: vi.fn().mockResolvedValue(undefined)
    })
    const callback = vi.fn()
    await walletStatusAction.handler(
      runtime,
      messageWithSource(),
      undefined,
      {},
      callback
    )
    const content = callback.mock.calls[0][0].content
    expect(content).toMatchObject({
      loggedIn: true,
      evmAddress: '0xevm',
      suiAddress: '0xsui',
      chain: 'evm:1',
      twoFaMethod: 'email',
      dailySpendLimitUsd: 500
    })
  })

  it('surfaces a pending 2FA approval when one is in flight', async () => {
    const sendMessageToTarget = vi.fn().mockResolvedValue(undefined)
    const runtime = fakeRuntime({
      sendMessageToTarget,
      service: {
        ...fakeServiceReady(),
        getPendingAuthz: () => ({
          kind: 'send-tx',
          method: 'telegram',
          startedAt: Date.now() - 90_000
        })
      }
    })
    const callback = vi.fn()
    await walletStatusAction.handler(
      runtime,
      messageWithSource(),
      undefined,
      {},
      callback
    )
    const liveText = sendMessageToTarget.mock.calls[0][1].text as string
    expect(liveText).toMatch(/Pending 2FA: send-tx/)
    expect(liveText).toMatch(/telegram/)
  })

  it('rejects when service is not registered', async () => {
    const runtime = { getService: () => null } as any
    const callback = vi.fn()
    const result = await walletStatusAction.handler(
      runtime,
      messageWithSource(),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('not logged in')
      })
    )
  })
})
