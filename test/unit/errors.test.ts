import { describe, it, expect } from 'vitest'
import { WaapError, type WaapErrorCode } from '../../src/errors'

describe('WaapError', () => {
  it('constructs with message and code', () => {
    const err = new WaapError('something broke', 'NO_SESSION')
    expect(err.message).toBe('something broke')
    expect(err.code).toBe('NO_SESSION')
    expect(err.name).toBe('WaapError')
    expect(err).toBeInstanceOf(Error)
  })

  it('accepts all documented codes', () => {
    const codes: WaapErrorCode[] = [
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
      'UNKNOWN'
    ]
    for (const code of codes) {
      const err = new WaapError('x', code)
      expect(err.code).toBe(code)
    }
  })

  it('is serializable to JSON', () => {
    const err = new WaapError('test', 'NETWORK')
    const serialized = JSON.parse(
      JSON.stringify({ message: err.message, code: err.code })
    )
    expect(serialized).toEqual({ message: 'test', code: 'NETWORK' })
  })
})
