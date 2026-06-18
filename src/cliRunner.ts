import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { createInterface } from 'node:readline'

// ── Public types ───────────────────────────────────────────────────────────

import type { TwoFaMethod } from './types'
export type { TwoFaMethod }

/**
 * Normalize the `method` field on awaiting_2fa events to the plugin's
 * canonical TwoFaMethod set. The CLI backend emits authz-flow
 * variants like `email_authz` / `telegram_authz` (the `_authz` suffix marks
 * "approval-via-channel"); collapse those onto the channel name itself so
 * downstream rendering hits the right METHOD_COPY entry. Returns undefined
 * for unknown values so the caller can fall back to `'disabled'`.
 */
function normalize2faMethod(raw: unknown): TwoFaMethod | undefined {
  if (typeof raw !== 'string') return undefined
  // The CLI emits these four authz-flow variants.
  if (raw === 'email_authz') return 'email'
  if (raw === 'telegram_authz') return 'telegram'
  if (raw === 'external_wallet_authz') return 'external_wallet'
  if (raw === 'phone_authz') return 'phone'
  if (
    raw === 'email' ||
    raw === 'telegram' ||
    raw === 'external_wallet' ||
    raw === 'phone' ||
    raw === 'disabled'
  ) {
    return raw
  }
  return undefined
}

/**
 * Stages emitted by the CLI's `--json` `phase` event. Each maps 1:1 to a
 * logger.info line in the CLI's human mode (verified at the emit() call
 * sites in waap-cli's source). Plugin renders these so agent chat shows
 * the same progress the CLI terminal does.
 */
export type CliPhaseStage =
  | 'keyshare_loading'
  | 'keyshare_ready'
  | 'keyshare_recovering'
  | 'signing_started'
  | 'policy_engine_contacting'
  | 'policy_engine_decision'
  | 'completing_signature'
  | 'signature_verified'
  | 'applying_to_policy_engine'
  | 'tx_preview'
  | 'broadcasting'
  | 'broadcasted'
  | 'account_creating'
  | 'account_created'
  | 'session_saved'
  | 'logging_in'
  | 'authenticated'

export type CliEvent =
  | { event: 'submitted'; payloadId: string }
  | {
      event: 'awaiting_2fa'
      method: TwoFaMethod
      payloadId: string
      timeoutMs: number
      /** Confirmation URL for external_wallet 2FA — only present when method is external_wallet_authz. */
      confirmUrl?: string
    }
  | { event: 'approved'; payloadId: string }
  | {
      event: 'phase'
      stage: CliPhaseStage
      /** Decision string when stage === 'policy_engine_decision' (e.g. 'WaitForAuthz', 'Done', 'Reject'). */
      decision?: string
      /** Operation context when stage === 'signing_started' (e.g. 'spend_limit_update'). */
      operation?: string
      /** tx_preview fields */
      from?: string
      to?: string
      value?: string
      chainId?: number
      nonce?: number
      gas?: string
      unit?: string
      /** broadcasting / broadcasted fields */
      chain?: string
      txHash?: string
    }
  | { event: 'result'; ok: true; [k: string]: unknown }
  | { event: 'error'; message: string; code?: string }

export interface CliRunOptions {
  cmd: string
  args: string[]
  sessionDir: string
  silkNodeEnv?: 'development' | 'production'
  hardTimeoutMs?: number
  onEvent?: (e: CliEvent) => void | Promise<void>
  signal?: AbortSignal
}

export interface CliResult {
  ok: true
  result: Record<string, unknown>
}

export class CliError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly stderr?: string,
    public readonly exitCode?: number
  ) {
    super(message)
    this.name = 'CliError'
  }
}

export interface CliRunner {
  run(opts: CliRunOptions): Promise<CliResult>
  resolveBinary(): Promise<string>
}

export interface CliRunnerConfig {
  binaryPath?: string
  /** For tests: spawn the binary via `npx tsx` so .ts fixtures can run directly. */
  useTsx?: boolean
}

// ── Implementation ─────────────────────────────────────────────────────────

const DEFAULT_HARD_TIMEOUT_MS = 360_000

/**
 * Build the environment for the waap-cli child process. Least-privilege
 * defense-in-depth: the wallet CLI needs the wallet stack's env (PATH, HOME,
 * NODE_*, SILK_*, WAAP_*, etc.) but has NO reason to see the host agent's
 * LLM / cloud-provider API keys. Strip a curated denylist of those so a bug
 * (or a future compromised transitive dep) inside the CLI can't read them.
 *
 * Denylist, not allowlist: an allowlist would risk dropping an env var the
 * CLI legitimately needs and silently breaking signing. We only remove keys
 * that are unambiguously NOT part of the wallet stack.
 */
const SENSITIVE_HOST_ENV_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GROQ_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
  'TOGETHER_API_KEY',
  'XAI_API_KEY',
  'MISTRAL_API_KEY',
  'COHERE_API_KEY',
  'HUGGINGFACE_API_KEY',
  'ELEVENLABS_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN'
] as const

function buildChildEnv(
  sessionDir: string,
  silkNodeEnv: string
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const key of SENSITIVE_HOST_ENV_KEYS) delete env[key]
  env.WAAP_CLI_SESSION_DIR = sessionDir
  env.SILK_NODE_ENV = silkNodeEnv
  return env
}

export function createCliRunner(config: CliRunnerConfig = {}): CliRunner {
  // In some local development setups the waap-cli's plain `tsc` build doesn't
  // run standalone on Node 24+ due to ESM directory-import resolution in a
  // transitive dependency. Setting WAAP_CLI_USE_TSX=1 tells the runner to
  // spawn via `tsx` instead of bare `node`, which handles those imports. The
  // published npm package ships a tsup-bundled binary without this issue, so
  // this flag is only needed for that local-development case.
  const useTsx = config.useTsx ?? process.env.WAAP_CLI_USE_TSX === '1'

  return new CliRunnerImpl({ ...config, useTsx })
}

class CliRunnerImpl implements CliRunner {
  constructor(private readonly config: CliRunnerConfig) {}

  async resolveBinary(): Promise<string> {
    if (this.config.binaryPath) {
      if (!fs.existsSync(this.config.binaryPath)) {
        throw new CliError(
          `waap-cli binary not found at ${this.config.binaryPath}`,
          'CLI_NOT_FOUND'
        )
      }

      return this.config.binaryPath
    }

    const envBinary = process.env.WAAP_CLI_BINARY

    if (envBinary && fs.existsSync(envBinary)) return envBinary

    // Try multiple createRequire anchors so this works in both CJS-bundled
    // and ESM contexts. The crucial property: at least one anchor must be
    // INSIDE node_modules/@human.tech/plugin-waap/dist/ so createRequire walks
    // up the install tree and finds the sibling @human.tech/waap-cli package.
    //
    // Order:
    //   1. import.meta.url  — ESM bundle: real URL string of the dist .js file
    //   2. __filename       — CJS bundle: real path of the dist .cjs file
    //   3. process.cwd()/package.json — last-resort: resolve from caller's cwd
    //                          (only works if cwd has node_modules above it)
    //
    // Without (1) or (2), we'd be stuck with cwd-only resolution, which breaks
    // when the agent runs from a directory that doesn't have node_modules above.
    //
    // For exotic setups where none work, set WAAP_CLI_BINARY explicitly.
    const candidates: string[] = []

    // import.meta.url is a real URL string in ESM, "" in tsup CJS bundle
    if (typeof import.meta !== 'undefined' && import.meta.url) {
      candidates.push(import.meta.url)
    }

    // __filename is provided by Node's CJS module wrapper as a function-scope
    // local. tsup leaves bare __filename references intact in CJS output, so
    // it resolves to the dist .cjs file's real on-disk path — which is INSIDE
    // node_modules of wherever the plugin is installed. createRequire from
    // there walks up to find the sibling @human.tech/waap-cli package reliably.
    // In ESM, Node sets __filename to undefined; the typeof guard handles both.
    if (typeof __filename === 'string') candidates.push(__filename)

    candidates.push(path.join(process.cwd(), 'package.json'))

    for (const anchor of candidates) {
      try {
        const req = createRequire(anchor)
        const pkgPath = req.resolve('@human.tech/waap-cli/package.json')
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
        const binRel =
          typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['waap-cli']

        if (binRel) {
          const resolved = path.resolve(path.dirname(pkgPath), binRel)

          if (fs.existsSync(resolved)) return resolved
        }
      } catch {
        // try next anchor
      }
    }

    throw new CliError(
      'waap-cli binary not found. Install @human.tech/waap-cli or set WAAP_CLI_BINARY env var.',
      'CLI_NOT_FOUND'
    )
  }

  async run(opts: CliRunOptions): Promise<CliResult> {
    const binary = await this.resolveBinary()
    const hardTimeoutMs = opts.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS

    let command: string
    let spawnArgs: string[]

    if (this.config.useTsx) {
      // Resolve tsx from this package's node_modules. Use the same multi-anchor
      // approach as resolveBinary() so this works in both ESM and CJS bundles.
      const tsxAnchors: string[] = []

      if (typeof import.meta !== 'undefined' && import.meta.url) {
        tsxAnchors.push(import.meta.url)
      }

      if (typeof __filename === 'string') tsxAnchors.push(__filename)

      tsxAnchors.push(path.join(process.cwd(), 'package.json'))

      let tsxBin = 'tsx' // fallback to PATH

      for (const anchor of tsxAnchors) {
        try {
          const req = createRequire(anchor)
          const tsxPkgPath = req.resolve('tsx/package.json')
          const tsxPkg = JSON.parse(fs.readFileSync(tsxPkgPath, 'utf-8'))
          const binRel =
            typeof tsxPkg.bin === 'string' ? tsxPkg.bin : tsxPkg.bin?.tsx

          if (binRel) {
            tsxBin = path.resolve(path.dirname(tsxPkgPath), binRel)
            break
          }
        } catch {
          // try next anchor
        }
      }

      // Use 'node' from PATH, not process.execPath which may be Bun
      // (ElizaOS runs under Bun but tsx requires Node).
      command = 'node'
      spawnArgs = [tsxBin, binary, '--json', opts.cmd, ...opts.args]
    } else {
      command = 'node'
      spawnArgs = [binary, '--json', opts.cmd, ...opts.args]
    }

    const child = spawn(command, spawnArgs, {
      env: buildChildEnv(
        opts.sessionDir,
        opts.silkNodeEnv ?? process.env.SILK_NODE_ENV ?? 'production'
      ),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    })

    return new Promise<CliResult>((resolve, reject) => {
      let resultEvent: Record<string, unknown> | null = null
      let errorEvent: { message: string; code?: string } | null = null
      let stderrBuffer = ''
      let killed = false
      let settled = false

      const settleReject = (err: CliError) => {
        if (settled) return

        settled = true
        clearTimeout(hardTimer)
        opts.signal?.removeEventListener('abort', abortHandler)

        try {
          child.kill('SIGTERM')
        } catch {
          /* noop */
        }

        reject(err)
      }
      const settleResolve = (val: CliResult) => {
        if (settled) return

        settled = true
        clearTimeout(hardTimer)
        opts.signal?.removeEventListener('abort', abortHandler)
        resolve(val)
      }

      const hardTimer = setTimeout(() => {
        killed = true
        settleReject(
          new CliError('CLI hard timeout exceeded', 'CLI_HARD_TIMEOUT')
        )

        setTimeout(() => {
          if (!child.killed) {
            try {
              child.kill('SIGKILL')
            } catch {
              /* noop */
            }
          }
        }, 5000)
      }, hardTimeoutMs)

      const abortHandler = () => {
        killed = true
        settleReject(new CliError('CLI aborted by caller', 'CLI_ABORTED'))

        setTimeout(() => {
          if (!child.killed) {
            try {
              child.kill('SIGKILL')
            } catch {
              /* noop */
            }
          }
        }, 2000)
      }
      opts.signal?.addEventListener('abort', abortHandler)

      const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity })

      rl.on('line', (line) => {
        if (settled) return

        if (!line.trim()) return

        let parsed: Record<string, unknown>

        try {
          parsed = JSON.parse(line)
        } catch {
          return
        }

        const eventName = parsed.event

        if (typeof eventName !== 'string') return

        if (eventName === 'result') {
          if (resultEvent !== null) {
            settleReject(
              new CliError('CLI emitted multiple result events', 'CLI_PROTOCOL')
            )

            return
          }

          const { event: _e, ...rest } = parsed
          resultEvent = rest

          return
        }

        if (eventName === 'error') {
          errorEvent = {
            message: String(parsed.message ?? 'unknown CLI error'),
            code: typeof parsed.code === 'string' ? parsed.code : undefined
          }

          // Settle NOW rather than waiting for `close`. A CLI that reports an
          // error event but doesn't promptly exit (e.g. a lingering websocket)
          // would otherwise pin this op until the 6-min hard timeout — masking
          // the already-known error and holding the single-flight authz gate.
          // An error event is terminal; settleReject kills the child and the
          // `close`/`error` handlers no-op via the `settled` guard.
          settleReject(
            new CliError(
              errorEvent.message,
              errorEvent.code,
              stderrBuffer,
              undefined
            )
          )

          return
        }

        if (eventName === 'submitted') {
          void opts
            .onEvent?.({
              event: 'submitted',
              payloadId: String(parsed.payload_id ?? '')
            })
            ?.catch?.(() => {})
        } else if (eventName === 'awaiting_2fa') {
          void opts
            .onEvent?.({
              event: 'awaiting_2fa',
              method: normalize2faMethod(parsed.method) ?? 'disabled',
              payloadId: String(parsed.payload_id ?? ''),
              timeoutMs: Number(parsed.timeout_ms ?? 300_000),
              ...(typeof parsed.confirm_url === 'string'
                ? { confirmUrl: parsed.confirm_url }
                : {})
            })
            ?.catch?.(() => {})
        } else if (eventName === 'approved') {
          void opts
            .onEvent?.({
              event: 'approved',
              payloadId: String(parsed.payload_id ?? '')
            })
            ?.catch?.(() => {})
        } else if (eventName === 'phase') {
          // Mid-flow progress phases — keyshare load, policy-engine contact,
          // signing rounds, broadcast, etc. Mirror the CLI's human-mode
          // logger.info output so agent chat doesn't show a long silent gap
          // between submitted and awaiting_2fa/result.
          const stage = parsed.stage
          const knownStages: ReadonlySet<string> = new Set([
            'keyshare_loading',
            'keyshare_ready',
            'keyshare_recovering',
            'signing_started',
            'policy_engine_contacting',
            'policy_engine_decision',
            'completing_signature',
            'signature_verified',
            'applying_to_policy_engine',
            'tx_preview',
            'broadcasting',
            'broadcasted',
            'account_creating',
            'account_created',
            'session_saved',
            'logging_in',
            'authenticated'
          ])
          if (typeof stage === 'string' && knownStages.has(stage)) {
            void opts
              .onEvent?.({
                event: 'phase',
                stage: stage as CliPhaseStage,
                ...(typeof parsed.decision === 'string'
                  ? { decision: parsed.decision }
                  : {}),
                ...(typeof parsed.operation === 'string'
                  ? { operation: parsed.operation }
                  : {}),
                // tx_preview fields
                ...(typeof parsed.from === 'string'
                  ? { from: parsed.from }
                  : {}),
                ...(typeof parsed.to === 'string' ? { to: parsed.to } : {}),
                ...(typeof parsed.value === 'string'
                  ? { value: parsed.value }
                  : {}),
                ...(typeof parsed.chainId === 'number'
                  ? { chainId: parsed.chainId }
                  : {}),
                ...(typeof parsed.nonce === 'number'
                  ? { nonce: parsed.nonce }
                  : {}),
                ...(typeof parsed.gas === 'string' ? { gas: parsed.gas } : {}),
                ...(typeof parsed.unit === 'string'
                  ? { unit: parsed.unit }
                  : {}),
                // broadcasting / broadcasted fields
                ...(typeof parsed.chain === 'string'
                  ? { chain: parsed.chain }
                  : {}),
                ...(typeof parsed.txHash === 'string'
                  ? { txHash: parsed.txHash }
                  : {})
              })
              ?.catch?.(() => {})
          }
        }
      })

      child.stderr!.on('data', (chunk) => {
        if (stderrBuffer.length < 8192) {
          stderrBuffer += chunk.toString().slice(0, 8192 - stderrBuffer.length)
        }
      })

      child.on('close', (exitCode) => {
        if (settled) return

        if (killed) return

        if (errorEvent) {
          settleReject(
            new CliError(
              errorEvent.message,
              errorEvent.code,
              stderrBuffer,
              exitCode ?? undefined
            )
          )

          return
        }

        if (exitCode !== 0) {
          settleReject(
            new CliError(
              `waap-cli exited with code ${exitCode}`,
              'CLI_PROTOCOL',
              stderrBuffer,
              exitCode ?? undefined
            )
          )

          return
        }

        if (!resultEvent) {
          settleReject(
            new CliError(
              'waap-cli exited 0 without emitting a result event',
              'CLI_PROTOCOL',
              stderrBuffer,
              exitCode ?? undefined
            )
          )

          return
        }

        settleResolve({ ok: true, result: resultEvent })
      })

      child.on('error', (err) => {
        if (settled) return

        settleReject(new CliError(err.message, 'CLI_NOT_FOUND'))
      })
    })
  }
}
