export type WaapErrorCode =
  | 'NO_SESSION'
  | 'CLI_NOT_FOUND'
  | 'CLI_VERSION_MISMATCH' // defined for forward compatibility; not actively emitted in v1
  | 'PHONE_2FA_UNSUPPORTED'
  | 'TWO_FA_TIMEOUT'
  | 'POLICY_REJECTED'
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_PARAMS'
  | 'NETWORK'
  | 'CLI_PROTOCOL'
  | 'CLI_HARD_TIMEOUT'
  | 'CLI_ABORTED' // emitted by CliRunner when an AbortSignal cancels mid-flight
  | 'AUTHZ_PENDING' // refused because another 2FA-requiring op is still in flight
  | 'UNKNOWN'

export class WaapError extends Error {
  constructor(
    message: string,
    public readonly code: WaapErrorCode
  ) {
    super(message)
    this.name = 'WaapError'
  }
}
