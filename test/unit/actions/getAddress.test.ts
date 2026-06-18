// Tests the WAAP_GET_ADDRESS action: routes address questions through the
// action callback (real newlines render correctly) instead of letting the
// LLM compose a free-form REPLY (which emits `\n` as literal escape chars).

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { getAddressAction } from '../../../src/actions/getAddress'

function fakeService(stateOverrides: Partial<any> = {}) {
  return {
    isReady: () => true,
    getState: () => ({
      evmAddress: '0xevm',
      suiAddress: '0xsui',
      chainState: { family: 'evm', chainId: 1 },
      policy: { authorizationMethod: 'disabled' },
      ...stateOverrides
    })
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
    getService: () => opts.service ?? fakeService()
  } as any
}

const messageWithSource = () =>
  ({
    content: { text: "what's my address?", source: 'discord' },
    roomId: 'r',
    agentId: 'a'
  }) as any

const messageWithoutSource = () =>
  ({
    content: { text: "what's my address?" },
    roomId: 'r',
    agentId: 'a'
  }) as any

describe('getAddressAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('has WAAP_GET_ADDRESS name and address-question similes', () => {
    expect(getAddressAction.name).toBe('WAAP_GET_ADDRESS')
    expect(getAddressAction.similes).toContain('MY_ADDRESS')
    expect(getAddressAction.similes).toContain('WHAT_IS_MY_ADDRESS')
    expect(getAddressAction.similes).toContain('SHOW_ADDRESS')
  })

  it('validate() returns true even when service is not ready (handler emits "please log in first")', async () => {
    const runtime = fakeRuntime({
      service: { ...fakeService(), isReady: () => false }
    })
    expect(await getAddressAction.validate(runtime, messageWithSource())).toBe(
      true
    )
  })

  it('validate() returns false when service is not registered', async () => {
    const runtime = { getService: () => null } as any
    expect(await getAddressAction.validate(runtime, messageWithSource())).toBe(
      false
    )
  })

  it('not logged in: emits a usable action-card with sign-up / log-in instructions (does NOT short-circuit with a canned reject)', async () => {
    // Old behavior was rejectNoService → one-line "WaaP wallet is not logged
    // in" text and success=false. The LLM read that as "no point dispatching
    // this action when the provider already says not-logged-in" and started
    // answering address questions free-form. New behavior: a successful
    // action result with sign-up / log-in instructions, so the LLM keeps
    // dispatching this action regardless of login state.
    const runtime = fakeRuntime({
      service: { ...fakeService(), isReady: () => false }
    })
    const callback = vi.fn()
    const result = await getAddressAction.handler(
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

  it('not logged in + live channel ok: rich instructions stream via sendMessageToTarget; callback gets terse line', async () => {
    const sendMessageToTarget = vi.fn().mockResolvedValue(undefined)
    const runtime = fakeRuntime({
      sendMessageToTarget,
      service: { ...fakeService(), isReady: () => false }
    })
    const callback = vi.fn()
    await getAddressAction.handler(
      runtime,
      messageWithSource(),
      undefined,
      {},
      callback
    )
    const cbText = callback.mock.calls[0][0].text as string
    expect(cbText).not.toContain('\n')
    const liveText = sendMessageToTarget.mock.calls[0][1].text as string
    expect(liveText).toMatch(/sign up/i)
    expect(liveText).toMatch(/log in/i)
    expect(liveText).toContain('\n')
  })

  it('live channel ok: callback receives terse single-line text; rich multi-line goes via sendMessageToTarget', async () => {
    // The whole point of this action: when the live channel works, the
    // callback's stored text has no `\n` for the LLM to mangle in follow-ups.
    const sendMessageToTarget = vi.fn().mockResolvedValue(undefined)
    const runtime = fakeRuntime({ sendMessageToTarget })
    const callback = vi.fn()

    await getAddressAction.handler(
      runtime,
      messageWithSource(),
      undefined,
      {},
      callback
    )

    const cbText = callback.mock.calls[0][0].text as string
    expect(cbText).not.toContain('\n')
    expect(cbText).not.toContain('0xevm')
    expect(cbText).not.toContain('0xsui')

    const live = sendMessageToTarget.mock.calls[0]
    const liveText = live[1].text as string
    expect(liveText).toContain('0xevm')
    expect(liveText).toContain('0xsui')
    expect(liveText).toContain('\n')
    // Sanity check: real newlines, not the escaped two-char sequence
    expect(liveText).not.toContain('\\n')
  })

  it('live channel unavailable (no source): rich multi-line text falls back into the callback so the user still gets the addresses', async () => {
    // Hosts without a registered send handler (or messages without a `source`)
    // can't stream live messages — the action still has to surface the
    // addresses, so it inlines the rich text into callback as a fallback.
    const runtime = fakeRuntime({})
    const callback = vi.fn()

    await getAddressAction.handler(
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
    expect(cbText).not.toContain('\\n')
  })

  it('content payload always includes both address fields (LLM grounding)', async () => {
    const runtime = fakeRuntime({
      sendMessageToTarget: vi.fn().mockResolvedValue(undefined)
    })
    const callback = vi.fn()
    await getAddressAction.handler(
      runtime,
      messageWithSource(),
      undefined,
      {},
      callback
    )
    const content = callback.mock.calls[0][0].content
    expect(content).toMatchObject({ evmAddress: '0xevm', suiAddress: '0xsui' })
  })

  it('omits Sui line when the wallet has no Sui address', async () => {
    // EVM-only wallets (no Sui keypair derived) should still produce a
    // valid bullet list — just one bullet instead of two.
    const sendMessageToTarget = vi.fn().mockResolvedValue(undefined)
    const runtime = fakeRuntime({
      sendMessageToTarget,
      service: fakeService({ suiAddress: '' })
    })
    const callback = vi.fn()
    await getAddressAction.handler(
      runtime,
      messageWithSource(),
      undefined,
      {},
      callback
    )
    const liveText = sendMessageToTarget.mock.calls[0][1].text as string
    expect(liveText).toContain('0xevm')
    expect(liveText).not.toContain('Sui:')
  })
})
