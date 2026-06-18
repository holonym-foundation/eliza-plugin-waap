import { z } from 'zod'

/** Accepts either an EVM address (0x + 40 hex) or a Sui address (0x + 64 hex). */
const anyAddress = z
  .string()
  .regex(
    /^0x[0-9a-fA-F]{40}$|^0x[0-9a-fA-F]{64}$/,
    'must be a 0x-prefixed 40-char (EVM) or 64-char (Sui) hex address'
  )

const hexData = z
  .string()
  .regex(/^0x[0-9a-fA-F]*$/, 'must be a 0x-prefixed hex string')

const chainIdSchema = z.number().int().positive()

/**
 * Chat-supplied RPC URL. `.url()` alone accepts any scheme (file:, ftp:, ws:,
 * data:, …); restrict to http(s) so a chat/LLM-supplied value can't point the
 * signing/balance subprocess at a non-HTTP scheme. (Blocking private/loopback
 * hosts for SSRF is intentionally NOT done here — local dev nodes at
 * 127.0.0.1:8545 are a legitimate use; that hardening belongs behind an
 * operator allowlist.)
 */
const rpcUrl = z
  .string()
  .url()
  .refine((v) => /^https?:\/\//i.test(v), 'RPC URL must use http or https')

/**
 * Popular email providers we'll typo-check against. Anything not on this list
 * passes through without correction — we only want to catch obvious slips on
 * domains a user is overwhelmingly likely to have meant.
 */
const COMMON_EMAIL_DOMAINS = [
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'icloud.com',
  'protonmail.com',
  'proton.me',
  'aol.com',
  'live.com',
  'me.com'
] as const

/** Single-character Levenshtein-style distance, capped at 2. */
function smallEditDistance(a: string, b: string): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > 2) return 3

  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0)
  )

  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }

  return dp[m][n]
}

/**
 * Returns the canonical domain if the input looks like a typo of a popular
 * provider (edit distance 1 or 2), or null otherwise. Exact matches return
 * null too — only flag when there's a correction to suggest.
 */
export function suggestEmailDomain(domain: string): string | null {
  const d = domain.toLowerCase()
  if ((COMMON_EMAIL_DOMAINS as readonly string[]).includes(d)) return null

  for (const candidate of COMMON_EMAIL_DOMAINS) {
    const dist = smallEditDistance(d, candidate)
    if (dist > 0 && dist <= 2) return candidate
  }

  return null
}

const emailWithTypoCheck = z
  .string()
  .email()
  .superRefine((value, ctx) => {
    const at = value.lastIndexOf('@')
    if (at < 0) return // .email() already rejected this

    const domain = value.slice(at + 1)
    const suggestion = suggestEmailDomain(domain)
    if (suggestion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `email domain "${domain}" looks like a typo — did you mean "${suggestion}"?`
      })
    }
  })

export const sendTxSchema = z.object({
  to: anyAddress,
  value: z
    .string()
    .regex(
      /^\d*\.?\d+$/,
      'value must be a non-negative decimal number (ETH units)'
    ),
  chainId: chainIdSchema.optional(),
  rpc: rpcUrl.optional(),
  data: hexData.optional(),
  legacy: z.boolean().optional()
  // NOTE: no `permissionToken` here on purpose. A permission token is a
  // spend-without-2FA bearer capability; it must NOT be acceptable from free
  // chat / the LLM extractor. The service sources it only from operator
  // settings via lookupPermissionToken(). (zod strips any unknown key, so a
  // prompt-injected `permissionToken` is dropped before it reaches the CLI.)
})
export type SendTxParams = z.infer<typeof sendTxSchema>

export const signMessageSchema = z.object({
  message: z.string().min(1).max(65536)
  // No `permissionToken` from chat — see sendTxSchema note.
})
export type SignMessageParams = z.infer<typeof signMessageSchema>

export const signTypedDataSchema = z.object({
  data: z
    .object({
      types: z.record(z.any()),
      domain: z.record(z.any()),
      primaryType: z.string(),
      message: z.record(z.any())
    })
    .refine(
      (d) => JSON.stringify(d).length <= 1_048_576,
      'EIP-712 data exceeds 1MB limit'
    )
  // No `permissionToken` from chat — see sendTxSchema note.
})
export type SignTypedDataParams = z.infer<typeof signTypedDataSchema>

// Balance queries accept Sui as well as EVM, so chainId here is broader than
// the numeric-only chainIdSchema used by EVM-only actions: it can be a number
// (137, 8453), a canonical chain string ('evm:1', 'sui:mainnet'), or a bare
// chain name ('sui', 'polygon'). Validation against the actual chain set is
// done by resolveChain() at the service layer.
const balanceChainIdSchema = z.union([
  z.number().int().positive(),
  z.string().min(1)
])
export const getBalanceSchema = z.object({
  chainId: balanceChainIdSchema.optional(),
  rpc: rpcUrl.optional()
})
export type GetBalanceParams = z.infer<typeof getBalanceSchema>

export const setPolicySchema = z.object({
  dailySpendLimitUsd: z
    .number()
    .nonnegative()
    .max(10_000, 'daily spend limit must be ≤ $10,000')
})
export type SetPolicyParams = z.infer<typeof setPolicySchema>

export const signupSchema = z.object({
  email: emailWithTypoCheck,
  password: z.string().min(8),
  name: z.string().optional()
})
export type SignupParams = z.infer<typeof signupSchema>

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
})
export type LoginParams = z.infer<typeof loginSchema>

export const switchChainSchema = z.object({
  chain: z.union([z.string().min(1), z.number().positive()])
})
export type SwitchChainParams = z.infer<typeof switchChainSchema>

// NOTE: `phone` is intentionally NOT an enable-able method. The plugin cannot
// manage phone 2FA — WaapService.initialize() rejects a phone authorization
// method with PHONE_2FA_UNSUPPORTED, so enabling it would brick the session on
// the next login/restart. We keep `phone` on the READ side (TwoFaMethod,
// status rendering) so an account that set phone 2FA elsewhere can still be
// reported, but we never offer it as a target here.
export const enable2faSchema = z
  .object({
    method: z.enum(['email', 'telegram', 'external_wallet']),
    email: emailWithTypoCheck.optional(),
    telegramChatId: z.string().min(1).optional(),
    walletAddress: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a valid EVM address')
      .optional()
  })
  .refine(
    (d) => {
      if (d.method === 'email') return !!d.email
      if (d.method === 'telegram') return !!d.telegramChatId
      if (d.method === 'external_wallet') return !!d.walletAddress
      return false
    },
    {
      message:
        'Missing required field for the chosen 2FA method (email address, telegram chat ID, or wallet address)'
    }
  )
export type Enable2faParams = z.infer<typeof enable2faSchema>

export const signTxSchema = z.object({
  to: anyAddress,
  value: z
    .string()
    .regex(
      /^\d*\.?\d+$/,
      'value must be a non-negative decimal number (ETH units)'
    )
    .optional(),
  chainId: chainIdSchema.optional(),
  rpc: rpcUrl.optional(),
  data: hexData.optional(),
  legacy: z.boolean().optional()
  // NOTE: no `permissionToken` here on purpose. A permission token is a
  // spend-without-2FA bearer capability; it must NOT be acceptable from free
  // chat / the LLM extractor. The service sources it only from operator
  // settings via lookupPermissionToken(). (zod strips any unknown key, so a
  // prompt-injected `permissionToken` is dropped before it reaches the CLI.)
})
export type SignTxParams = z.infer<typeof signTxSchema>

export const requestSchema = z.object({
  // Anchored to the JSON-RPC method grammar (letter-led, alphanumeric +
  // underscore — e.g. `eth_blockNumber`). This is also an argv-injection
  // guard: `method` is passed to the CLI as a BARE POSITIONAL, so a value like
  // `--rpc` would otherwise be parsed as a flag. The regex forbids a leading
  // dash, closing that vector. (`params` is always JSON.stringified, so it can
  // never start with `-`.)
  method: z
    .string()
    .regex(
      /^[a-zA-Z][a-zA-Z0-9_]*$/,
      'invalid JSON-RPC method name (letters, digits, underscore; must start with a letter)'
    ),
  params: z.array(z.unknown()).optional(),
  chainId: chainIdSchema.optional(),
  rpc: rpcUrl.optional()
})
export type RequestParams = z.infer<typeof requestSchema>

export type ExtractResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

/**
 * Convert Zod validation errors into a single human-friendly sentence.
 * e.g. "password: must be at least 8 characters; email: invalid email"
 */
function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      const field = i.path.length > 0 ? `${i.path.join('.')}: ` : ''
      return `${field}${i.message}`
    })
    .join('; ')
}

import {
  composePromptFromState,
  parseJSONObjectFromText,
  ModelType
} from '@elizaos/core'
import type { IAgentRuntime, Memory, State } from '@elizaos/core'

// ─────────────────────────────────────────────────────────────────────────────
// LLM-driven extractors
// ─────────────────────────────────────────────────────────────────────────────
//
// Pattern: composePromptFromState({state, template}) → runtime.useModel(
// ModelType.TEXT_SMALL, {prompt}) → parseJSONObjectFromText(text) → zod.safeParse.
//
// This is the canonical Eliza 1.x extraction pattern documented in the official
// ElizaOS docs at:
//   - https://github.com/elizaos/docs/blob/main/plugins/migration.mdx
//   - https://github.com/elizaos/docs/blob/main/plugins/patterns.mdx
//   - https://github.com/elizaos/docs/blob/main/plugin-registry/bootstrap/testing-guide.mdx
//
// The reference plugin-agentkit (elizaos-plugins/plugin-agentkit) uses an older
// regex-based pattern in its `enhanceParametersForTool` helper. Both work — the
// LLM pattern is the current Eliza recommendation and handles natural-language
// inputs more robustly. We test the LLM extractors via mocked runtime.useModel
// per the official testing guide (see test/unit/paramExtractionLLM.test.ts).
//
// Two exceptions extract from the message text WITHOUT calling the model:
//   - extractSignTypedDataParams: EIP-712 structured data is too complex for a
//     reliable LLM round-trip, so it scans the outermost JSON blob.
//   - extractLoginParams / extractSignupParams: the message carries the user's
//     password. Routing it through runtime.useModel sends the raw credential to
//     an external provider, whose moderation intermittently refuses
//     credential-shaped prompts — making login non-deterministically fail. We
//     parse email + password with parseCredentialsFromText so credentials never
//     leave the machine. See test/unit/bareTokenCredentials.test.ts.

/**
 * Run the small text model with `prompt`, then attempt to parse a JSON object
 * out of its response using Eliza's `parseJSONObjectFromText` (which handles
 * fenced ```json blocks as well as bare objects).
 */
async function runLlmJson(
  runtime: IAgentRuntime,
  prompt: string
): Promise<Record<string, unknown> | null> {
  const raw = await runtime.useModel(ModelType.TEXT_SMALL, { prompt })
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw)

  return parseJSONObjectFromText(text)
}

async function getState(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined
): Promise<State> {
  if (state) return state

  const composed = await (
    runtime as unknown as {
      composeState?: (m: Memory) => Promise<State>
    }
  ).composeState?.(message)

  return composed ?? ({ values: {}, data: {}, text: '' } as unknown as State)
}

const SEND_TX_TEMPLATE = `Extract transaction parameters EXACTLY as the user provided them. Do NOT modify addresses, amounts, or any values.

Required fields:
- to: the recipient address exactly as the user typed it
- value: the amount exactly as the user typed it (ETH units for EVM, MIST for Sui)
- chainId: numeric chain ID if the user names an EVM chain. Common mappings:
  - ethereum/mainnet/eth -> 1, polygon/matic -> 137, base -> 8453,
    arbitrum -> 42161, optimism -> 10, bsc/binance -> 56

Optional fields:
- rpc: an RPC URL only if the user explicitly specified one
- data: 0x-prefixed hex calldata only if the user explicitly provided contract data (EVM only)
- legacy: boolean, true only if the user mentioned "legacy" or "type 0" tx (EVM only)

Respond with ONLY a JSON object. No prose, no code fences.

Examples:

User: "Send 0.01 ETH to 0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead on Polygon"
Output: {"to":"0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead","value":"0.01","chainId":137}

User: "Transfer 5 ETH on Base to 0xabcabcabcabcabcabcabcabcabcabcabcabcabca"
Output: {"to":"0xabcabcabcabcabcabcabcabcabcabcabcabcabca","value":"5","chainId":8453}

Recent message:
{{recentMessages}}

Output:
`

const SIGN_MESSAGE_TEMPLATE = `Extract the message the user wants to sign from their most recent request.

Rules:
- If the message is wrapped in single or double quotes, strip the surrounding quotes.
- If it is a 0x-prefixed hex string, preserve it exactly as-is.
- Otherwise return the literal text.

Respond with ONLY a JSON object: {"message": "<text>"}. No prose, no code fences.

Examples:

User: 'Sign "hello world"'
Output: {"message":"hello world"}

User: "please sign 0xdeadbeef"
Output: {"message":"0xdeadbeef"}

Recent message:
{{recentMessages}}

Output:
`

const GET_BALANCE_TEMPLATE = `Extract optional balance-query parameters from the user's most recent message.

Fields (all optional):
- chainId: identifies which chain to query.
  - For EVM chains, return the numeric ID:
    ethereum/mainnet/eth -> 1, polygon/matic -> 137, base -> 8453,
    arbitrum -> 42161, optimism -> 10, bsc/binance -> 56
  - For Sui, return the string "sui:mainnet" (or "sui:testnet" / "sui:devnet"
    if the user explicitly names that network).
- rpc: an RPC URL if explicitly specified.

Only set chainId when the user clearly names a chain. If the user just says
"what's my balance" with no chain, return {}.

The balance is always for the wallet's own address — external address queries
are not supported.

Respond with ONLY a JSON object. Use {} if nothing was specified. No prose, no code fences.

Examples:

User: "what's my balance"
Output: {}

User: "check my balance on base"
Output: {"chainId":8453}

User: "what's my Sui balance"
Output: {"chainId":"sui:mainnet"}

User: "balance on sui testnet"
Output: {"chainId":"sui:testnet"}

User: "how much ETH do I have on polygon"
Output: {"chainId":137}

Recent message:
{{recentMessages}}

Output:
`

const SET_POLICY_TEMPLATE = `Extract a daily spend limit (in USD) EXACTLY as the user specified. Do NOT clamp, round, or adjust the number.

Field:
- dailySpendLimitUsd: the number the user provided.

Convert "k"/"K" to thousands (e.g. "2k" -> 2000). Strip "$", commas, and the word "dollars".
If the user says "50000", return 50000 — do NOT change it.

Respond with ONLY a JSON object: {"dailySpendLimitUsd": <number>}. No prose, no code fences.

Examples:

User: "set my daily limit to $500"
Output: {"dailySpendLimitUsd":500}

User: "raise the limit to 2k"
Output: {"dailySpendLimitUsd":2000}

Recent message:
{{recentMessages}}

Output:
`

const SEND_TX_SUI_TEMPLATE = `Extract Sui transaction parameters EXACTLY as the user provided them. Do NOT modify addresses or amounts.

Required fields:
- to: the recipient address exactly as the user typed it
- value: the amount in MIST as an integer string. If the user says SUI, convert to MIST (1 SUI = 1,000,000,000 MIST). If they say MIST, use the number directly.

Do NOT include chainId — it is not used for Sui transactions.

Respond with ONLY a JSON object. No prose, no code fences.

Examples:

User: "Send 1 SUI to 0x7f8e9d1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
Output: {"to":"0x7f8e9d1234567890abcdef1234567890abcdef1234567890abcdef1234567890","value":"1000000000"}

User: "Transfer 500000000 MIST to 0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab"
Output: {"to":"0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab","value":"500000000"}

Recent message:
{{recentMessages}}

Output:
`

export async function extractSendTxParams(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  chainState: { family: 'evm' | 'sui' }
): Promise<ExtractResult<SendTxParams>> {
  try {
    const currentState = await getState(runtime, message, state)
    const template =
      chainState.family === 'sui' ? SEND_TX_SUI_TEMPLATE : SEND_TX_TEMPLATE
    const prompt = composePromptFromState({
      state: currentState,
      template
    })
    const obj = await runLlmJson(runtime, prompt)

    if (!obj)
      return { ok: false, error: 'LLM did not return a parseable JSON object' }

    const parsed = sendTxSchema.safeParse(obj)

    if (!parsed.success)
      return { ok: false, error: formatZodError(parsed.error) }

    return { ok: true, value: parsed.data }
  } catch (err) {
    return {
      ok: false,
      error: `LLM extraction failed: ${(err as Error).message}`
    }
  }
}

export async function extractSignMessageParams(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined
): Promise<ExtractResult<SignMessageParams>> {
  try {
    const currentState = await getState(runtime, message, state)
    const prompt = composePromptFromState({
      state: currentState,
      template: SIGN_MESSAGE_TEMPLATE
    })
    const obj = await runLlmJson(runtime, prompt)

    if (!obj)
      return { ok: false, error: 'LLM did not return a parseable JSON object' }

    const parsed = signMessageSchema.safeParse(obj)

    if (!parsed.success)
      return { ok: false, error: formatZodError(parsed.error) }

    return { ok: true, value: parsed.data }
  } catch (err) {
    return {
      ok: false,
      error: `LLM extraction failed: ${(err as Error).message}`
    }
  }
}

function findOutermostJson(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null

  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }

  return null
}

/**
 * EIP-712 typed data is too complex/structured to reliably round-trip through
 * an LLM, so we use a bracket-depth scanner to extract the outermost JSON
 * object from the user's message text, JSON.parse it, and validate
 * against the EIP-712 shape via zod.
 */
export async function extractSignTypedDataParams(
  _runtime: IAgentRuntime,
  message: Memory,
  _state: State | undefined
): Promise<ExtractResult<SignTypedDataParams>> {
  const text = message.content?.text ?? ''
  const jsonStr = findOutermostJson(text)

  if (!jsonStr) {
    return {
      ok: false,
      error:
        'No JSON object found in the message. Paste the EIP-712 typed data as a JSON blob.'
    }
  }

  try {
    const parsed = JSON.parse(jsonStr)
    const result = signTypedDataSchema.safeParse({ data: parsed })

    if (!result.success) {
      return {
        ok: false,
        error: `Invalid EIP-712 shape: ${formatZodError(result.error)}`
      }
    }

    return { ok: true, value: result.data }
  } catch (err) {
    return {
      ok: false,
      error: `Failed to parse JSON: ${(err as Error).message}`
    }
  }
}

export async function extractGetBalanceParams(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined
): Promise<ExtractResult<GetBalanceParams>> {
  try {
    const currentState = await getState(runtime, message, state)
    const prompt = composePromptFromState({
      state: currentState,
      template: GET_BALANCE_TEMPLATE
    })
    const obj = await runLlmJson(runtime, prompt)

    if (!obj) return { ok: true, value: {} }

    const parsed = getBalanceSchema.safeParse(obj)

    if (!parsed.success)
      return { ok: false, error: formatZodError(parsed.error) }

    return { ok: true, value: parsed.data }
  } catch (err) {
    return {
      ok: false,
      error: `LLM extraction failed: ${(err as Error).message}`
    }
  }
}

export async function extractSetPolicyParams(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined
): Promise<ExtractResult<SetPolicyParams>> {
  try {
    const currentState = await getState(runtime, message, state)
    const prompt = composePromptFromState({
      state: currentState,
      template: SET_POLICY_TEMPLATE
    })
    const obj = await runLlmJson(runtime, prompt)

    if (!obj)
      return { ok: false, error: 'LLM did not return a parseable JSON object' }

    const parsed = setPolicySchema.safeParse(obj)

    if (!parsed.success)
      return { ok: false, error: formatZodError(parsed.error) }

    return { ok: true, value: parsed.data }
  } catch (err) {
    return {
      ok: false,
      error: `LLM extraction failed: ${(err as Error).message}`
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Credential extraction (deterministic — never calls the model)
// ─────────────────────────────────────────────────────────────────────────────
//
// Login/signup are the only actions whose message contains the user's password.
// We parse email + password from the message text directly so the raw
// credential never reaches an external model. See the note above runLlmJson.

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/

// Filler tokens that wrap credentials in natural phrasing. None is ever treated
// as the password. Compared case-insensitively against a punctuation-stripped
// token. "password"/"pass"/"pwd" are here so the bare-token fallback skips them;
// the explicit-keyword branch matches them separately and takes the next token.
const CREDENTIAL_STOPWORDS = new Set([
  'login',
  'log',
  'signin',
  'sign',
  'in',
  'on',
  'signup',
  'register',
  'create',
  'make',
  'new',
  'wallet',
  'account',
  'with',
  'using',
  'use',
  'email',
  'address',
  'and',
  'my',
  'the',
  'a',
  'an',
  'to',
  'as',
  'me',
  'up',
  'please',
  'i',
  'want',
  'would',
  'like',
  'for',
  'is',
  'of',
  'name',
  'named',
  'called',
  'call',
  'password',
  'pass',
  'pwd',
  'credentials',
  // Conversational filler so a bare "can you log me in with email X" (no
  // password) does not fabricate one of these words as the password — it must
  // fall through to operator config (WAAP_EMAIL / WAAP_PASSWORD) instead.
  'can',
  'could',
  'you',
  'your',
  'help',
  'hey',
  'hi',
  'there',
  'just',
  'get',
  'got',
  'do',
  'this',
  'that',
  'it'
])

interface ParsedCredentials {
  email: string
  password: string
  name?: string
}

/**
 * Read a setting (character secret / env var) as a trimmed non-empty string,
 * else undefined. Mirrors WaapService.getSetting: runtime settings win, then
 * process.env. Used so login/signup can source credentials from operator
 * config (WAAP_EMAIL / WAAP_PASSWORD) instead of chat — for an agent-owned
 * wallet the password then never enters the message stream, memory, or any
 * model prompt. See docs/003 (P1).
 */
function settingStr(runtime: IAgentRuntime, key: string): string | undefined {
  const v = runtime.getSetting?.(key)
  const raw = v !== undefined && v !== null ? String(v) : process.env[key]
  const trimmed = raw?.trim()

  return trimmed ? trimmed : undefined
}

/** Lowercased token with leading/trailing punctuation removed (for matching). */
function normalizeToken(token: string): string {
  return token.replace(/^[^\w@]+|[^\w@]+$/g, '').toLowerCase()
}

/**
 * Pull email + password (+ optional display name for signup) out of the raw
 * message text. Returns null if no email or no password can be found, leaving
 * the caller to surface a "provide email and password" message.
 *
 * The password is taken VERBATIM — never stripped or altered — because the
 * backend compares it byte-for-byte. We only ever drop the email token and
 * known filler words; whatever single non-filler token remains is the password.
 */
function parseCredentialsFromText(
  text: string,
  opts: { wantName?: boolean } = {}
): ParsedCredentials | null {
  const emailMatch = text.match(EMAIL_RE)
  if (!emailMatch || emailMatch.index === undefined) return null

  const email = emailMatch[0].replace(/[.,;:!?]+$/, '')

  // Remove the email occurrence so it can't be mistaken for the password.
  const rest =
    text.slice(0, emailMatch.index) +
    ' ' +
    text.slice(emailMatch.index + emailMatch[0].length)

  // Optional display name (signup only): "as Bob", "named Bob", "name is Bob".
  let name: string | undefined
  if (opts.wantName) {
    const nameMatch = rest.match(
      /\b(?:as|named|called|name(?:\s+is)?)\s+([A-Za-z][\w'-]*)/i
    )
    const candidate = nameMatch?.[1]
    if (candidate && !CREDENTIAL_STOPWORDS.has(candidate.toLowerCase())) {
      name = candidate
    }
  }

  // Explicit "password <value>" (also "pass:", "pwd =", "password is X") wins.
  let password: string | undefined
  const keyword = rest.match(
    /\bp(?:ass(?:word)?|wd)\b(?:\s+(?:is|of|to|for))?[:=\s]+(\S+)/i
  )
  if (keyword) {
    password = keyword[1]
  } else {
    // Bare-token form: whatever non-filler token is left is the password.
    // Prefer the longest, since a password is typically longer than any stray
    // word the user left in.
    const candidates = rest
      .split(/\s+/)
      .filter((t) => {
        const n = normalizeToken(t)
        return (
          n.length > 0 &&
          !CREDENTIAL_STOPWORDS.has(n) &&
          n !== name?.toLowerCase()
        )
      })
      .sort((a, b) => b.length - a.length)
    password = candidates[0]
  }

  if (!password) return null

  return { email, password, ...(name ? { name } : {}) }
}

const SWITCH_CHAIN_TEMPLATE = `Extract the target chain from the user's most recent message.

Field:
- chain: either a chain name (string), numeric chain ID, or a namespaced chain identifier.

Common EVM chain names: ethereum, mainnet, polygon, matic, base, arbitrum, optimism, bsc, binance, sepolia, avalanche, avax.
Sui networks: sui, sui:mainnet, sui:testnet, sui:devnet.

Respond with ONLY a JSON object. No prose, no code fences.

Examples:

User: "Switch to Polygon"
Output: {"chain":"polygon"}

User: "Use chain 42161"
Output: {"chain":42161}

User: "Change to Base network"
Output: {"chain":"base"}

User: "Switch to Sui"
Output: {"chain":"sui"}

User: "Use Sui testnet"
Output: {"chain":"sui:testnet"}

Recent message:
{{recentMessages}}

Output:
`

const ENABLE_2FA_TEMPLATE = `Extract the 2FA setup details from the user's most recent message.

Fields:
- method: one of "email", "telegram", or "external_wallet"
- email: the email address (required if method is "email")
- telegramChatId: the Telegram chat ID (required if method is "telegram")
- walletAddress: the EVM wallet address (required if method is "external_wallet")

Only include the field relevant to the chosen method.

If the user asks to enable 2FA but does NOT include the required value (no email, no chat ID, no wallet address), return an empty object {}. Do NOT guess or fabricate a value — the action layer will detect the missing field and ask the user.

Respond with ONLY a JSON object. No prose, no code fences.

Examples:

User: "Enable 2FA with my email agent@example.com"
Output: {"method":"email","email":"agent@example.com"}

User: "Set up telegram 2FA with chat ID 7381029636"
Output: {"method":"telegram","telegramChatId":"7381029636"}

User: "Enable 2FA with my hardware wallet 0x1234567890abcdef1234567890abcdef12345678"
Output: {"method":"external_wallet","walletAddress":"0x1234567890abcdef1234567890abcdef12345678"}

User: "Enable 2FA"
Output: {}

User: "Set up 2FA via email"
Output: {"method":"email"}

Recent message:
{{recentMessages}}

Output:
`

export async function extractEnable2faParams(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined
): Promise<ExtractResult<Enable2faParams>> {
  try {
    const currentState = await getState(runtime, message, state)
    const prompt = composePromptFromState({
      state: currentState,
      template: ENABLE_2FA_TEMPLATE
    })
    const obj = await runLlmJson(runtime, prompt)

    if (!obj)
      return { ok: false, error: 'LLM did not return a parseable JSON object' }

    const parsed = enable2faSchema.safeParse(obj)

    if (!parsed.success)
      return { ok: false, error: formatZodError(parsed.error) }

    return { ok: true, value: parsed.data }
  } catch (err) {
    return {
      ok: false,
      error: `LLM extraction failed: ${(err as Error).message}`
    }
  }
}

export async function extractSignupParams(
  runtime: IAgentRuntime,
  message: Memory,
  _state: State | undefined
): Promise<ExtractResult<SignupParams>> {
  const fromText = parseCredentialsFromText(message.content?.text ?? '', {
    wantName: true
  })

  // Message credentials win; otherwise fall back to operator config so an
  // agent-owned wallet can sign up from a bare "create a wallet" without the
  // password ever entering chat. parseCredentialsFromText returns null unless
  // BOTH fields are present, so we never mix a message email with a config
  // password.
  const email = fromText?.email ?? settingStr(runtime, 'WAAP_EMAIL')
  const password = fromText?.password ?? settingStr(runtime, 'WAAP_PASSWORD')
  const name = fromText?.name ?? settingStr(runtime, 'WAAP_NAME')

  if (!email || !password)
    return {
      ok: false,
      error:
        'No email and password found. Include them (e.g. "signup you@example.com yourpassword"), or set WAAP_EMAIL and WAAP_PASSWORD in the agent settings.'
    }

  const parsed = signupSchema.safeParse({
    email,
    password,
    ...(name ? { name } : {})
  })

  if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) }

  return { ok: true, value: parsed.data }
}

export async function extractLoginParams(
  runtime: IAgentRuntime,
  message: Memory,
  _state: State | undefined
): Promise<ExtractResult<LoginParams>> {
  const fromText = parseCredentialsFromText(message.content?.text ?? '')

  // Message credentials win; otherwise fall back to operator config
  // (WAAP_EMAIL / WAAP_PASSWORD) so the user can just say "log in" and the
  // password is sourced from settings — never from chat/memory/the model.
  const email = fromText?.email ?? settingStr(runtime, 'WAAP_EMAIL')
  const password = fromText?.password ?? settingStr(runtime, 'WAAP_PASSWORD')

  if (!email || !password)
    return {
      ok: false,
      error:
        'No email and password found. Include them (e.g. "login you@example.com yourpassword"), or set WAAP_EMAIL and WAAP_PASSWORD in the agent settings.'
    }

  const parsed = loginSchema.safeParse({ email, password })

  if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) }

  return { ok: true, value: parsed.data }
}

export async function extractSwitchChainParams(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined
): Promise<ExtractResult<SwitchChainParams>> {
  try {
    const currentState = await getState(runtime, message, state)
    const prompt = composePromptFromState({
      state: currentState,
      template: SWITCH_CHAIN_TEMPLATE
    })
    const obj = await runLlmJson(runtime, prompt)

    if (!obj)
      return { ok: false, error: 'LLM did not return a parseable JSON object' }

    const parsed = switchChainSchema.safeParse(obj)

    if (!parsed.success)
      return { ok: false, error: formatZodError(parsed.error) }

    return { ok: true, value: parsed.data }
  } catch (err) {
    return {
      ok: false,
      error: `LLM extraction failed: ${(err as Error).message}`
    }
  }
}

// ── sign-tx ──

const SIGN_TX_TEMPLATE = `Extract transaction parameters EXACTLY as the user provided them. Do NOT modify addresses, amounts, or any values.
This is for SIGNING a transaction without broadcasting it.

Fields:
- to: the recipient address exactly as the user typed it (required)
- value: the amount exactly as the user typed it (optional, default "0")
- chainId: numeric chain ID if the user names an EVM chain (optional, EVM only)
- data: 0x-prefixed hex calldata only if the user explicitly provided it (optional, EVM only)
- legacy: boolean, true only if the user mentioned "legacy" or "type 0" tx (optional, EVM only)

Respond with ONLY a JSON object. No prose, no code fences.

Examples:

User: "Sign a transaction to 0x1234567890abcdef1234567890abcdef12345678 for 0.5 ETH on chain 137"
Output: {"to":"0x1234567890abcdef1234567890abcdef12345678","value":"0.5","chainId":137}

User: "Sign a transfer of 1000000000 MIST to 0x7f8e9d1234567890abcdef1234567890abcdef1234567890abcdef1234567890 on Sui"
Output: {"to":"0x7f8e9d1234567890abcdef1234567890abcdef1234567890abcdef1234567890","value":"1000000000"}

Recent message:
{{recentMessages}}

Output:
`

export async function extractSignTxParams(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined
): Promise<ExtractResult<SignTxParams>> {
  try {
    const currentState = await getState(runtime, message, state)
    const prompt = composePromptFromState({
      state: currentState,
      template: SIGN_TX_TEMPLATE
    })
    const obj = await runLlmJson(runtime, prompt)

    if (!obj)
      return { ok: false, error: 'LLM did not return a parseable JSON object' }

    const parsed = signTxSchema.safeParse(obj)

    if (!parsed.success)
      return { ok: false, error: formatZodError(parsed.error) }

    return { ok: true, value: parsed.data }
  } catch (err) {
    return {
      ok: false,
      error: `LLM extraction failed: ${(err as Error).message}`
    }
  }
}

// ── request ──

const REQUEST_TEMPLATE = `Extract the EIP-1193 JSON-RPC request from the user's most recent message.

Fields:
- method: the RPC method name (required, e.g. "eth_blockNumber", "eth_getTransactionReceipt", "eth_call")
- params: array of parameters for the method (optional)
- chainId: numeric chain ID to use (optional)

Respond with ONLY a JSON object. No prose, no code fences.

Examples:

User: "Get the current block number"
Output: {"method":"eth_blockNumber"}

User: "Get the transaction receipt for 0xabc123..."
Output: {"method":"eth_getTransactionReceipt","params":["0xabc123..."]}

User: "What's the latest block on Polygon?"
Output: {"method":"eth_blockNumber","chainId":137}

Recent message:
{{recentMessages}}

Output:
`

export async function extractRequestParams(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined
): Promise<ExtractResult<RequestParams>> {
  try {
    const currentState = await getState(runtime, message, state)
    const prompt = composePromptFromState({
      state: currentState,
      template: REQUEST_TEMPLATE
    })
    const obj = await runLlmJson(runtime, prompt)

    if (!obj)
      return { ok: false, error: 'LLM did not return a parseable JSON object' }

    const parsed = requestSchema.safeParse(obj)

    if (!parsed.success)
      return { ok: false, error: formatZodError(parsed.error) }

    return { ok: true, value: parsed.data }
  } catch (err) {
    return {
      ok: false,
      error: `LLM extraction failed: ${(err as Error).message}`
    }
  }
}
