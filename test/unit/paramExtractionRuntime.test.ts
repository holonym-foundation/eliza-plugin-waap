import { describe, it, expect } from 'vitest'
import { extractSignTypedDataParams } from '../../src/actions/paramExtraction'

describe('extractSignTypedDataParams (regex-based, no LLM)', () => {
  it('extracts a valid EIP-712 JSON blob from message text', async () => {
    const message = {
      content: {
        text: `Please sign this: {"types":{"EIP712Domain":[{"name":"name","type":"string"}],"Mail":[{"name":"contents","type":"string"}]},"domain":{"name":"test"},"primaryType":"Mail","message":{"contents":"hi"}}`
      }
    } as any
    const result = await extractSignTypedDataParams(
      {} as any,
      message,
      undefined
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.value.data as any).primaryType).toBe('Mail')
    }
  })

  it('returns error when no JSON in message', async () => {
    const message = { content: { text: 'sign something' } } as any
    const result = await extractSignTypedDataParams(
      {} as any,
      message,
      undefined
    )
    expect(result.ok).toBe(false)
  })

  it('returns error when JSON is malformed', async () => {
    const message = { content: { text: 'sign this {not valid json}' } } as any
    const result = await extractSignTypedDataParams(
      {} as any,
      message,
      undefined
    )
    expect(result.ok).toBe(false)
  })

  it('returns error when JSON does not match EIP-712 shape', async () => {
    const message = { content: { text: 'sign this {"foo": "bar"}' } } as any
    const result = await extractSignTypedDataParams(
      {} as any,
      message,
      undefined
    )
    expect(result.ok).toBe(false)
  })
})
