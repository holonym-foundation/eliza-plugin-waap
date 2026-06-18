import { describe, it, expect, vi } from 'vitest'
import {
  extractSendTxParams,
  extractSignMessageParams,
  extractGetBalanceParams,
  extractSetPolicyParams
} from '../../src/actions/paramExtraction'
import type { Memory, State } from '@elizaos/core'

/**
 * Direct unit tests for the 4 LLM-driven extractors. We mock runtime.useModel
 * to return canned strings and assert each extractor handles happy-path and
 * malformed-LLM-output cases. The regex-based extractSignTypedDataParams has
 * its own deterministic tests in paramExtractionRuntime.test.ts.
 */

function createMockRuntime(useModelResponse: string | object | Error) {
  const useModel = vi.fn().mockImplementation(async () => {
    if (useModelResponse instanceof Error) throw useModelResponse
    return useModelResponse
  })
  return {
    useModel,
    composeState: vi.fn().mockResolvedValue({ values: {}, data: {}, text: '' }),
    getSetting: () => undefined
  } as any
}

const fakeMessage = (text: string): Memory =>
  ({
    content: { text },
    userId: 'user-1',
    roomId: 'room-1',
    agentId: 'test-agent'
  }) as any

const fakeState = (): State => ({ values: {}, data: {}, text: '' }) as any

// ── extractSendTxParams ──

describe('extractSendTxParams (LLM-driven)', () => {
  const evmChain = { family: 'evm' as const }

  it('happy path: LLM returns valid JSON, extractor returns parsed params', async () => {
    const runtime = createMockRuntime(
      JSON.stringify({
        to: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
        value: '0.01',
        chainId: 137
      })
    )
    const result = await extractSendTxParams(
      runtime,
      fakeMessage('Send 0.01 ETH to 0xdead... on Polygon'),
      fakeState(),
      evmChain
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.to).toBe('0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead')
      expect(result.value.chainId).toBe(137)
      expect(result.value.value).toBe('0.01')
    }
    expect(runtime.useModel).toHaveBeenCalledTimes(1)
  })

  it('bad LLM output: returns { ok: false, error }', async () => {
    const runtime = createMockRuntime('this is not json at all')
    const result = await extractSendTxParams(
      runtime,
      fakeMessage('send something somewhere'),
      fakeState(),
      evmChain
    )
    expect(result.ok).toBe(false)
  })

  it('accepts Sui chain and uses Sui template', async () => {
    const suiAddr = '0x' + 'ab'.repeat(32)
    const runtime = createMockRuntime(
      JSON.stringify({ to: suiAddr, value: '1000000000', chainId: 1 })
    )
    const result = await extractSendTxParams(
      runtime,
      fakeMessage('Send 1 SUI to ' + suiAddr),
      fakeState(),
      { family: 'sui' as const }
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.to).toBe(suiAddr)
      expect(result.value.value).toBe('1000000000')
    }
  })
})

// ── extractSignMessageParams ──

describe('extractSignMessageParams (LLM-driven)', () => {
  it('happy path: extracts message text', async () => {
    const runtime = createMockRuntime(
      JSON.stringify({ message: 'hello world' })
    )
    const result = await extractSignMessageParams(
      runtime,
      fakeMessage('Sign the message "hello world"'),
      fakeState()
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.message).toBe('hello world')
  })

  it('happy path: extracts hex message', async () => {
    const runtime = createMockRuntime(
      JSON.stringify({ message: '0x48656c6c6f' })
    )
    const result = await extractSignMessageParams(
      runtime,
      fakeMessage('Sign 0x48656c6c6f'),
      fakeState()
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.message).toBe('0x48656c6c6f')
  })

  it('bad LLM output: returns error', async () => {
    const runtime = createMockRuntime('garbage')
    const result = await extractSignMessageParams(
      runtime,
      fakeMessage('sign something'),
      fakeState()
    )
    expect(result.ok).toBe(false)
  })
})

// ── extractGetBalanceParams ──

describe('extractGetBalanceParams (LLM-driven)', () => {
  it('happy path: empty {} (use wallet defaults)', async () => {
    const runtime = createMockRuntime(JSON.stringify({}))
    const result = await extractGetBalanceParams(
      runtime,
      fakeMessage("what's my balance?"),
      fakeState()
    )
    expect(result.ok).toBe(true)
  })

  it('happy path: extracts chainId', async () => {
    const runtime = createMockRuntime(
      JSON.stringify({
        chainId: 8453
      })
    )
    const result = await extractGetBalanceParams(
      runtime,
      fakeMessage('check my balance on Base'),
      fakeState()
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.chainId).toBe(8453)
    }
  })

  it('bad LLM output: extractor treats unparseable as ok with empty defaults', async () => {
    const runtime = createMockRuntime('not json')
    const result = await extractGetBalanceParams(
      runtime,
      fakeMessage('balance'),
      fakeState()
    )
    // Per implementation, getBalance returns { ok: true, value: {} } when
    // parseJSONObjectFromText fails to find an object.
    expect(runtime.useModel).toHaveBeenCalled()
    expect(result.ok).toBe(true)
  })
})

// ── extractSetPolicyParams ──

describe('extractSetPolicyParams (LLM-driven)', () => {
  it('happy path: extracts dailySpendLimitUsd', async () => {
    const runtime = createMockRuntime(
      JSON.stringify({ dailySpendLimitUsd: 500 })
    )
    const result = await extractSetPolicyParams(
      runtime,
      fakeMessage('Set my daily spend limit to $500'),
      fakeState()
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.dailySpendLimitUsd).toBe(500)
  })

  it('rejects out-of-range limit (over 10000)', async () => {
    const runtime = createMockRuntime(
      JSON.stringify({ dailySpendLimitUsd: 50000 })
    )
    const result = await extractSetPolicyParams(
      runtime,
      fakeMessage('raise my limit to $50,000'),
      fakeState()
    )
    expect(result.ok).toBe(false)
  })

  it('rejects negative limit', async () => {
    const runtime = createMockRuntime(
      JSON.stringify({ dailySpendLimitUsd: -100 })
    )
    const result = await extractSetPolicyParams(
      runtime,
      fakeMessage('-100 dollar limit'),
      fakeState()
    )
    expect(result.ok).toBe(false)
  })
})
