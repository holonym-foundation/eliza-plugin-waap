// Pins the bare-token credential contract: when the user types
// "<email> <password>" or "<email> <password> login" or "login <email>
// <password>" — without the literal "password" keyword — the agent must
// still dispatch WAAP_LOGIN / WAAP_SIGNUP and extract the credentials.
//
// Two layers have to agree for that to work end-to-end:
//
//   1. The action's `examples` + character.json CREDENTIAL RULE — these drive
//      the LLM's decision to *dispatch* WAAP_LOGIN / WAAP_SIGNUP at all.
//   2. extractLoginParams / extractSignupParams — these parse email + password
//      from the message text *deterministically* (regex, no model call), so the
//      raw password never reaches an external model. (Routing it through the
//      model is risky: OpenAI moderation intermittently refuses
//      credential-shaped prompts, making login non-deterministically fail.)

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { loginAction } from '../../src/actions/login'
import { signupAction } from '../../src/actions/signup'
import {
  extractLoginParams,
  extractSignupParams
} from '../../src/actions/paramExtraction'

const characterPath = resolve(__dirname, '../../character.json')
const character = JSON.parse(readFileSync(characterPath, 'utf-8'))
const system = character.system as string

function flattenExamples(action: typeof loginAction): string {
  // Each example is a 2-tuple [user, agent]. Stringify both sides so we can
  // grep for the bare-token format and the dispatch action together.
  return JSON.stringify(action.examples ?? [])
}

describe('bare-token credential format — dispatch layers must surface it', () => {
  it('character.json CREDENTIAL RULE delegates format details to the action descriptions', () => {
    // After the slim rewrite, character.json no longer carries the format
    // examples — those live in the action descriptions and examples (covered
    // by the action-example pin below). The system-wide rule still has to
    // refuse bare affirmatives and explicitly mention the bare-token format so
    // the LLM doesn't fall back on "needs the word 'password'" reasoning.
    expect(system).toMatch(/CREDENTIAL RULE/)
    expect(system).toMatch(/bare affirmative/i)
    expect(system).toMatch(/bare-token/i)
  })

  it('login action examples include bare-token positive cases', () => {
    const flat = flattenExamples(loginAction)
    // The exact user message that triggered the bug — pin it here so future
    // edits can't silently drop it.
    expect(flat).toContain('agent@example.com bareToken123 login')
    // Any-prefix bare format ("login <email> <password>") must also dispatch
    expect(flat).toContain('login alice@example.com MySecure123')
    // And both bare-token examples must dispatch WAAP_LOGIN, not REPLY
    expect(flat.match(/WAAP_LOGIN/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  it('signup action examples include bare-token positive cases', () => {
    const flat = flattenExamples(signupAction)
    expect(flat).toContain('alice@example.com MySecure123 signup')
    expect(flat).toContain('signup alice@example.com MySecure123')
    expect(flat.match(/WAAP_SIGNUP/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })
})

describe('credential extraction is deterministic — never calls the model', () => {
  // The model spy is the security assertion: if these ever start calling
  // runtime.useModel, the raw password is leaving the machine again.
  function fakeRuntime() {
    return {
      useModel: vi.fn(async () => '{}'),
      composeState: vi.fn(async () => ({ values: {}, data: {}, text: '' })),
      getSetting: () => undefined
    } as any
  }

  const fakeMessage = (text: string) =>
    ({ content: { text }, userId: 'u', roomId: 'r', agentId: 'a' } as any)

  it('login — bare-token "<email> <password> login" (the exact bug repro)', async () => {
    const runtime = fakeRuntime()
    const result = await extractLoginParams(
      runtime,
      fakeMessage('agent@example.com bareToken123 login'),
      undefined
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.email).toBe('agent@example.com')
      expect(result.value.password).toBe('bareToken123')
    }
    expect(runtime.useModel).not.toHaveBeenCalled()
  })

  it('login — bare-token "login <email> <password>"', async () => {
    const runtime = fakeRuntime()
    const result = await extractLoginParams(
      runtime,
      fakeMessage('login alice@example.com MySecure123'),
      undefined
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.email).toBe('alice@example.com')
      expect(result.value.password).toBe('MySecure123')
    }
    expect(runtime.useModel).not.toHaveBeenCalled()
  })

  it('login — keyword form "...email X and password Y"', async () => {
    const runtime = fakeRuntime()
    const result = await extractLoginParams(
      runtime,
      fakeMessage(
        'Log in with email alice@example.com and password MySecure123'
      ),
      undefined
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.email).toBe('alice@example.com')
      expect(result.value.password).toBe('MySecure123')
    }
  })

  it('login — "password is <value>" phrasing', async () => {
    const runtime = fakeRuntime()
    const result = await extractLoginParams(
      runtime,
      fakeMessage('my email is alice@example.com and my password is Secret12'),
      undefined
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.password).toBe('Secret12')
  })

  it('login — password is preserved verbatim, including special characters', async () => {
    const runtime = fakeRuntime()
    const result = await extractLoginParams(
      runtime,
      fakeMessage('login alice@example.com P@ssw0rd!#$'),
      undefined
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.password).toBe('P@ssw0rd!#$')
  })

  // "password to/for X" must capture the value, not the connector word.
  it('login — "set password to <value>" captures the value, not "to"', async () => {
    const runtime = fakeRuntime()
    const result = await extractLoginParams(
      runtime,
      fakeMessage('set password to mypass for a@b.com'),
      undefined
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.password).toBe('mypass')
  })

  it('login — "password for <value>" captures the value, not "for"', async () => {
    const runtime = fakeRuntime()
    const result = await extractLoginParams(
      runtime,
      fakeMessage('login a@b.com password for hunter9'),
      undefined
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.password).toBe('hunter9')
  })

  // a message with an email but NO password must NOT fabricate a filler
  // word as the password — it must fall through (here: no config → not ok).
  it('login — "can you log me in with email X" does not invent a password', async () => {
    const runtime = fakeRuntime()
    const result = await extractLoginParams(
      runtime,
      fakeMessage('can you log me in with email a@b.com'),
      undefined
    )
    expect(result.ok).toBe(false)
  })

  it('signup — bare-token "<email> <password> signup"', async () => {
    const runtime = fakeRuntime()
    const result = await extractSignupParams(
      runtime,
      fakeMessage('alice@example.com MySecure123 signup'),
      undefined
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.email).toBe('alice@example.com')
      expect(result.value.password).toBe('MySecure123')
    }
    expect(runtime.useModel).not.toHaveBeenCalled()
  })

  it('signup — bare-token "signup <email> <password>"', async () => {
    const runtime = fakeRuntime()
    const result = await extractSignupParams(
      runtime,
      fakeMessage('signup alice@example.com MySecure123'),
      undefined
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.password).toBe('MySecure123')
  })

  it('signup — optional display name via "as <Name>"', async () => {
    const runtime = fakeRuntime()
    const result = await extractSignupParams(
      runtime,
      fakeMessage(
        'Sign me up as Bob with bob@test.com password hunter2hunter2'
      ),
      undefined
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.email).toBe('bob@test.com')
      expect(result.value.password).toBe('hunter2hunter2')
      expect(result.value.name).toBe('Bob')
    }
  })

  it('missing email → ok:false with a helpful message (no model call)', async () => {
    const runtime = fakeRuntime()
    const result = await extractLoginParams(
      runtime,
      fakeMessage('I want to log in please'),
      undefined
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/email and password/i)
    expect(runtime.useModel).not.toHaveBeenCalled()
  })

  it('email but no password → ok:false', async () => {
    const runtime = fakeRuntime()
    const result = await extractLoginParams(
      runtime,
      fakeMessage('login alice@example.com'),
      undefined
    )
    expect(result.ok).toBe(false)
  })

  it('signup enforces the 8-char password minimum from the schema', async () => {
    const runtime = fakeRuntime()
    const result = await extractSignupParams(
      runtime,
      fakeMessage('signup alice@example.com short'),
      undefined
    )
    expect(result.ok).toBe(false)
  })
})

describe('settings-based credentials (agent-owned wallet) — no password in chat', () => {
  // The agent's wallet credentials live in operator settings (env / character
  // secrets), NEVER in the message. A bare "log in" must resolve to those, and
  // the password must never reach the model (settingStr reads settings, no
  // useModel). This is the 1.7.2 fix for docs/003 P1.
  function fakeRuntime(settings: Record<string, string | undefined>) {
    return {
      useModel: vi.fn(async () => '{}'),
      composeState: vi.fn(async () => ({ values: {}, data: {}, text: '' })),
      getSetting: (k: string) => settings[k]
    } as any
  }

  const fakeMessage = (text: string) =>
    ({ content: { text }, userId: 'u', roomId: 'r', agentId: 'a' } as any)

  const CONFIG = {
    WAAP_EMAIL: 'agent@waap.xyz',
    WAAP_PASSWORD: 'OperatorConfigured123',
    WAAP_NAME: 'Agent Wallet'
  }

  it('login: bare "log in" uses WAAP_EMAIL/WAAP_PASSWORD; password never goes to the model', async () => {
    const runtime = fakeRuntime(CONFIG)
    const result = await extractLoginParams(
      runtime,
      fakeMessage('log in'),
      undefined
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.email).toBe('agent@waap.xyz')
      expect(result.value.password).toBe('OperatorConfigured123')
    }
    expect(runtime.useModel).not.toHaveBeenCalled()
  })

  it('signup: bare "create a wallet" uses configured credentials (incl. WAAP_NAME)', async () => {
    const runtime = fakeRuntime(CONFIG)
    const result = await extractSignupParams(
      runtime,
      fakeMessage('create a wallet for me'),
      undefined
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.email).toBe('agent@waap.xyz')
      expect(result.value.password).toBe('OperatorConfigured123')
      expect(result.value.name).toBe('Agent Wallet')
    }
    expect(runtime.useModel).not.toHaveBeenCalled()
  })

  it('message credentials take precedence over configured settings', async () => {
    const runtime = fakeRuntime(CONFIG)
    const result = await extractLoginParams(
      runtime,
      fakeMessage('login someone@else.com TheirOwnPassword9'),
      undefined
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.email).toBe('someone@else.com')
      expect(result.value.password).toBe('TheirOwnPassword9')
    }
  })

  it('no message creds AND no settings → ok:false, error names the settings keys', async () => {
    const runtime = fakeRuntime({})
    const result = await extractLoginParams(
      runtime,
      fakeMessage('log in'),
      undefined
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/WAAP_EMAIL/)
  })

  it('blank/whitespace settings are treated as unset', async () => {
    const runtime = fakeRuntime({ WAAP_EMAIL: '   ', WAAP_PASSWORD: '' })
    const result = await extractLoginParams(
      runtime,
      fakeMessage('log in'),
      undefined
    )
    expect(result.ok).toBe(false)
  })
})
