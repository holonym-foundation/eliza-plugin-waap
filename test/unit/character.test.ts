// Pins the WaaP example character.json system prompt against silent regressions.
//
// We deliberately keep the system prompt SLIM. Each rule below corresponds to
// a specific empirically-observed LLM failure mode that the slim wording
// guards against. The matching detailed examples / few-shots that previously
// lived inline are now in:
//   - per-action `description` and `examples` (when to dispatch, how to narrate)
//   - deterministic parsing in paramExtraction (login/signup credentials are
//     parsed from the message text directly, not via the model)
// If any of those layers regresses, the bug we observed comes back even with
// the system prompt intact — so the bareTokenCredentials.test.ts file pins
// those layers separately.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const characterPath = resolve(__dirname, '../../character.json')
const character = JSON.parse(readFileSync(characterPath, 'utf-8'))
const system = character.system as string

describe('character.json system prompt (slim form)', () => {
  it('declares the GROUNDING CONTRACT (the only rule that cannot live in action descriptions)', () => {
    // Applies to free-form REPLYs too, not just action dispatches — so it
    // can't be pushed into per-action descriptions like the others.
    expect(system).toMatch(/GROUNDING CONTRACT/)
    expect(system).toMatch(/waapWallet/)
    // Forbids paraphrasing returned values (was empirically broken when the
    // LLM "helpfully" re-checksummed addresses).
    expect(system).toMatch(/character-for-character/)
  })

  it('declares the SYMMETRIC trust rule for login state (pins the empirical bug where LLM said "not logged in" while addresses showed up)', () => {
    // Empirical failure: user typed "am I logged in?" → LLM said "not
    // logged in" free-form; next turn "what's my address?" dispatched
    // WAAP_GET_ADDRESS and returned the addresses (proving the wallet WAS
    // logged in). The rule needs to forbid hallucinations BOTH ways.
    expect(system).toMatch(/trust it BOTH WAYS/i)
    expect(system).toMatch(
      /Conversation history is NOT a source of truth for current login state/i
    )
    expect(system).toMatch(/ALWAYS dispatch WAAP_WALLET_STATUS/i)
  })

  it('declares a CREDENTIAL RULE that refuses bare affirmatives', () => {
    // The narrow piece of the credential contract that has to live system-
    // wide: "yes" alone shouldn't dispatch login. Format-specific examples
    // (bare-token, etc.) live in the action examples + LLM templates.
    expect(system).toMatch(/CREDENTIAL RULE/)
    expect(system).toMatch(/bare affirmative/i)
    expect(system).toMatch(/yes/i)
  })

  it('declares a NARRATION RULE forbidding predictive REPLY copy', () => {
    expect(system).toMatch(/NARRATION RULE/)
    expect(system).toMatch(/non-predictive/i)
  })

  it('declares a ROUTING RULE that forces dispatch over NONE / free-form / conversation-memory shortcuts', () => {
    // Closes three documented escape hatches:
    //   1. NONE — empty bubble, no useful content
    //   2. Free-form REPLY from provider context — mangles \n, hallucinates
    //   3. "I already answered earlier" — stale across login/chain/policy changes
    expect(system).toMatch(/ROUTING RULE/)
    expect(system).toMatch(/never pick NONE/i)
    expect(system).toMatch(/never compose the answer free-form/i)
    expect(system).toMatch(/never rely on what an earlier turn said/i)
    // Each read-only action MUST be named so the LLM has the dispatch target
    // explicit (vs. having to infer from descriptions).
    expect(system).toMatch(/WAAP_GET_ADDRESS/)
    expect(system).toMatch(/WAAP_WALLET_STATUS/)
    expect(system).toMatch(/WAAP_GET_CHAIN/)
    expect(system).toMatch(/WAAP_LIST_CHAINS/)
    expect(system).toMatch(/WAAP_GET_BALANCE/)
    expect(system).toMatch(/WAAP_2FA_STATUS/)
    expect(system).toMatch(/WAAP_GET_POLICY/)
  })

  it('does NOT declare a FORMATTING CONTRACT (action routing covers it)', () => {
    // If the literal-`\n` bug returns, the right fix is a tighter routing
    // rule or a missing read-only action — not bringing back a formatting
    // contract that duplicates work already done by action callbacks.
    expect(system).not.toMatch(/FORMATTING CONTRACT/)
  })

  it('does NOT declare a NARRATION EXCEPTION block (each 2FA action carries its own narration requirement)', () => {
    // Both enable2fa.ts and disable2fa.ts already include the 5-minute
    // pre-narration requirement in their description. The system-level
    // duplicate was redundant.
    expect(system).not.toMatch(/NARRATION EXCEPTION FOR 2FA-MANAGEMENT/)
  })

  it('the system prompt stays under ~5 KB so it does not crowd out per-action descriptions in context', () => {
    // Soft budget: the original bloated prompt was ~6,300 chars. With the
    // explicit per-action ROUTING RULE bullets, the prompt sits ~4.3 KB.
    // Cap at 5 KB so future creep is still caught.
    expect(system.length).toBeLessThan(5000)
  })

  it('the system prompt is multi-paragraph (parsed JSON `\\n` becomes real newlines)', () => {
    const doubleNewlines = (system.match(/\n\n/g) ?? []).length
    expect(doubleNewlines).toBeGreaterThanOrEqual(3)
  })

  it('lists @human.tech/plugin-waap in plugins', () => {
    expect(character.plugins).toContain('@human.tech/plugin-waap')
  })
})
