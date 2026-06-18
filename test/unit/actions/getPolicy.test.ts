// Tests WAAP_GET_POLICY — spending limit + 2FA gate routed through the
// action callback (so the LLM can't guess a stale limit from history).

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { getPolicyAction } from '../../../src/actions/getPolicy'

function fakeService(over: Partial<any> = {}) {
  return {
    isReady: () => true,
    getPolicy: () => ({
      authorizationMethod: 'email',
      dailySpendLimitUsd: 500
    }),
    ...over
  }
}

const message = (text = 'limit') =>
  ({ content: { text, source: 'discord' }, roomId: 'r' }) as any

const messageNoSource = (text = 'limit') =>
  ({ content: { text }, roomId: 'r' }) as any

const runtime = (svc: any, sendMessageToTarget?: any) =>
  ({
    agentId: 'test-agent',
    sendMessageToTarget,
    getService: () => svc
  }) as any

describe('getPolicyAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('has WAAP_GET_POLICY name and policy/limit similes', () => {
    expect(getPolicyAction.name).toBe('WAAP_GET_POLICY')
    expect(getPolicyAction.similes).toContain('MY_LIMIT')
    expect(getPolicyAction.similes).toContain('SPENDING_LIMIT')
    expect(getPolicyAction.similes).toContain('DAILY_LIMIT')
  })

  it('validate() returns true even when service is not ready', async () => {
    expect(
      await getPolicyAction.validate(
        runtime(fakeService({ isReady: () => false })),
        message()
      )
    ).toBe(true)
  })

  it('not logged in: emits sign-up / log-in instructions (success=true)', async () => {
    const callback = vi.fn()
    const result = await getPolicyAction.handler(
      runtime(fakeService({ isReady: () => false })),
      messageNoSource(),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: true })
    expect((result as any).data).toMatchObject({ loggedIn: false })
    const cbText = callback.mock.calls[0][0].text as string
    expect(cbText).toMatch(/not logged in/i)
    expect(cbText).toMatch(/sign up|log in/i)
  })

  it('logged in + live channel ok: callback gets terse line; rich policy via sendMessageToTarget', async () => {
    const sendMessageToTarget = vi.fn().mockResolvedValue(undefined)
    const callback = vi.fn()
    await getPolicyAction.handler(
      runtime(fakeService(), sendMessageToTarget),
      message(),
      undefined,
      {},
      callback
    )
    const cbText = callback.mock.calls[0][0].text as string
    expect(cbText).not.toContain('\n')
    expect(cbText).not.toContain('500')

    const liveText = sendMessageToTarget.mock.calls[0][1].text as string
    expect(liveText).toContain('$500/day')
    expect(liveText).toContain('email')
    expect(liveText).toContain('\n')
  })

  it('logged in + no live channel: rich policy falls into callback', async () => {
    const callback = vi.fn()
    await getPolicyAction.handler(
      runtime(fakeService()),
      messageNoSource(),
      undefined,
      {},
      callback
    )
    const cbText = callback.mock.calls[0][0].text as string
    expect(cbText).toContain('$500/day')
    expect(cbText).toContain('email')
    expect(cbText).toContain('\n')
  })

  it('limit unset: text reads "not set" instead of $0', async () => {
    const sendMessageToTarget = vi.fn().mockResolvedValue(undefined)
    const callback = vi.fn()
    await getPolicyAction.handler(
      runtime(
        fakeService({
          getPolicy: () => ({
            authorizationMethod: 'disabled',
            dailySpendLimitUsd: null
          })
        }),
        sendMessageToTarget
      ),
      message(),
      undefined,
      {},
      callback
    )
    const liveText = sendMessageToTarget.mock.calls[0][1].text as string
    expect(liveText).toContain('not set')
    expect(liveText).not.toContain('$null')
    expect(liveText).not.toContain('$0/day')
  })

  it('content payload includes structured policy fields', async () => {
    const callback = vi.fn()
    await getPolicyAction.handler(
      runtime(fakeService(), vi.fn().mockResolvedValue(undefined)),
      message(),
      undefined,
      {},
      callback
    )
    expect(callback.mock.calls[0][0].content).toMatchObject({
      dailySpendLimitUsd: 500,
      authorizationMethod: 'email'
    })
  })

  it('renders minRiskFor2FA (parity with CLI `policy get`) — value when set, "not set" otherwise', async () => {
    // With a value
    const cb1 = vi.fn()
    const send1 = vi.fn().mockResolvedValue(undefined)
    await getPolicyAction.handler(
      runtime(
        fakeService({
          getPolicy: () => ({
            authorizationMethod: 'email',
            dailySpendLimitUsd: 500,
            minRiskFor2fa: 'HighWarn'
          })
        }),
        send1
      ),
      message(),
      undefined,
      {},
      cb1
    )
    const live1 = send1.mock.calls[0][1].text
    expect(live1).toContain('Min. risk for 2FA: HighWarn')
    expect(cb1.mock.calls[0][0].content).toMatchObject({
      minRiskFor2fa: 'HighWarn'
    })

    // Without a value → "not set", and content carries null (not dropped)
    const cb2 = vi.fn()
    const send2 = vi.fn().mockResolvedValue(undefined)
    await getPolicyAction.handler(
      runtime(fakeService(), send2),
      message(),
      undefined,
      {},
      cb2
    )
    expect(send2.mock.calls[0][1].text).toContain('Min. risk for 2FA: not set')
    expect(cb2.mock.calls[0][0].content).toHaveProperty('minRiskFor2fa', null)
  })

  it('rejects when service is not registered', async () => {
    const callback = vi.fn()
    const result = await getPolicyAction.handler(
      { getService: () => null } as any,
      messageNoSource(),
      undefined,
      {},
      callback
    )
    expect(result).toMatchObject({ success: false })
  })
})
