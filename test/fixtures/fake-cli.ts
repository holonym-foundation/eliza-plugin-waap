#!/usr/bin/env node
//
// Scripted NDJSON emitter used by cliRunner unit tests.
// Usage: tsx fake-cli.ts --scenario <name> [args...]

const args = process.argv.slice(2)
const scenarioIdx = args.indexOf('--scenario')
const scenario = scenarioIdx >= 0 ? args[scenarioIdx + 1] : 'happy'

function emit(event: string, payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ event, ...payload }) + '\n')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  switch (scenario) {
    case 'happy':
      emit('submitted', { payload_id: 'p1' })
      emit('result', { ok: true, signature: '0xdeadbeef', address: '0xabc' })
      process.exit(0)
      return

    case '2fa':
      emit('submitted', { payload_id: 'p1' })
      await sleep(10)
      emit('awaiting_2fa', {
        method: 'telegram',
        payload_id: 'p1',
        timeout_ms: 300000
      })
      await sleep(20)
      emit('approved', { payload_id: 'p1' })
      await sleep(10)
      emit('result', { ok: true, signature: '0xabc123', address: '0xabc' })
      process.exit(0)
      return

    case 'error':
      emit('submitted', { payload_id: 'p1' })
      emit('error', { message: 'Session expired', code: 'NO_SESSION' })
      process.exit(1)
      return

    case 'malformed':
      process.stdout.write('garbage line that is not json\n')
      emit('result', { ok: true, foo: 'bar' })
      process.exit(0)
      return

    case 'malformed-no-result':
      process.stdout.write('garbage\n')
      process.stdout.write('more garbage\n')
      process.exit(1)
      return

    case 'hang':
      await sleep(600_000)
      process.exit(0)
      return

    case 'slow':
      emit('submitted', { payload_id: 'p1' })
      await sleep(200)
      emit('result', { ok: true, signature: '0xslow' })
      process.exit(0)
      return

    case 'no-result':
      emit('submitted', { payload_id: 'p1' })
      process.exit(0)
      return

    case 'double-result':
      emit('result', { ok: true, first: true })
      emit('result', { ok: true, second: true })
      process.exit(0)
      return

    case 'stderr-noise':
      process.stderr.write('[wasm init] loading...\n')
      process.stderr.write('[wasm init] ready\n')
      emit('submitted', { payload_id: 'p1' })
      emit('result', { ok: true, signature: '0xnoisy' })
      process.exit(0)
      return

    case 'network-error':
      emit('error', { message: 'backend unreachable', code: 'NETWORK' })
      process.exit(1)
      return

    case 'policy-reject':
      emit('submitted', { payload_id: 'p1' })
      emit('error', {
        message: 'daily spend limit exceeded',
        code: 'POLICY_REJECTED'
      })
      process.exit(1)
      return

    case '2fa-timeout':
      emit('submitted', { payload_id: 'p1' })
      emit('awaiting_2fa', {
        method: 'telegram',
        payload_id: 'p1',
        timeout_ms: 300000
      })
      emit('error', {
        message: 'Timed out waiting for 2FA approval',
        code: 'TWO_FA_TIMEOUT'
      })
      process.exit(1)
      return

    case 'phase-events':
      // Exercise every phase stage and the metadata-carrying ones (tx_preview,
      // broadcasted, policy_engine_decision) so the cliRunner parser can be
      // verified to preserve every field.
      emit('phase', { stage: 'keyshare_loading' })
      emit('phase', { stage: 'keyshare_ready' })
      emit('phase', { stage: 'logging_in' })
      emit('phase', { stage: 'authenticated' })
      emit('phase', { stage: 'session_saved' })
      emit('phase', {
        stage: 'tx_preview',
        from: '0xfrom1234567890abcdef1234567890abcdef1234',
        to: '0xto1234567890abcdef1234567890abcdef1234',
        value: '0.5',
        chainId: 137,
        nonce: 7,
        gas: '21000',
        unit: 'MATIC'
      })
      emit('phase', {
        stage: 'signing_started',
        operation: 'spend_limit_update'
      })
      emit('phase', { stage: 'policy_engine_contacting' })
      emit('phase', {
        stage: 'policy_engine_decision',
        decision: 'WaitForAuthz'
      })
      emit('submitted', { payload_id: 'p1' })
      emit('phase', { stage: 'completing_signature' })
      emit('phase', { stage: 'signature_verified' })
      emit('phase', { stage: 'applying_to_policy_engine' })
      emit('phase', { stage: 'broadcasting', chainId: 137 })
      emit('phase', {
        stage: 'broadcasted',
        txHash: '0xabc123',
        chainId: 137
      })
      emit('result', { ok: true, txHash: '0xabc123' })
      process.exit(0)
      return

    default:
      process.stderr.write(`unknown scenario: ${scenario}\n`)
      process.exit(2)
  }
}

main().catch((err) => {
  process.stderr.write(`fake-cli error: ${err}\n`)
  process.exit(3)
})
