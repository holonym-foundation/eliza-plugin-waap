// Pins the contract: "negative examples in DESTRUCTIVE actions must still
// dispatch the matching READ-ONLY action — never `actions: []`."
//
// Background: the system prompt's ROUTING RULE says ANY wallet-fact question
// must dispatch the matching read-only WAAP_* action. Earlier negative
// examples in destructive actions (logout, switchChain, setPolicy) used
// `actions: []` to mean "don't dispatch THIS destructive action for status
// questions." But the LLM reads "actions: []" as "dispatch nothing", which
// directly contradicts the ROUTING RULE and the matching read-only action's
// own positive example. The right shape for these negatives is to dispatch
// the read-only action that IS the correct route — the destructive action's
// example then teaches "for status questions, route to the read-only action,
// NOT this destructive one." That keeps the LLM's training signal coherent.
//
// If this test fails, do NOT revert to `actions: []` — fix the example to
// dispatch the read-only action listed in the expected-action column.

import { describe, expect, it } from 'vitest'

import { logoutAction } from '../../src/actions/logout'
import { setPolicyAction } from '../../src/actions/setPolicy'
import { switchChainAction } from '../../src/actions/switchChain'

type AnyAction = {
  examples?: Array<
    Array<{
      name: string
      content: { text: string; actions?: string[] }
    }>
  >
}

function findExampleByUserText(
  action: AnyAction,
  userTextSubstring: string
):
  | {
      userText: string
      agentText: string
      agentActions: string[]
    }
  | undefined {
  for (const conv of action.examples ?? []) {
    const user = conv.find((m) => m.name === '{{user}}')
    const agent = conv.find((m) => m.name === '{{agent}}')
    if (!user || !agent) continue
    if (
      user.content.text.toLowerCase().includes(userTextSubstring.toLowerCase())
    ) {
      return {
        userText: user.content.text,
        agentText: agent.content.text,
        agentActions: agent.content.actions ?? []
      }
    }
  }
  return undefined
}

describe('Negative examples in mutating actions still dispatch the matching read-only action', () => {
  // Each row: [destructive action, the user-text substring that uniquely
  // identifies the negative example in its `examples` array, the read-only
  // action that the agent SHOULD dispatch instead].
  // Cast to AnyAction at the row level — @elizaos/core's ActionExample types
  // `content.text` as optional, but our examples always supply it. The local
  // AnyAction shape is tighter on purpose so the example-walker doesn't have
  // to defend against undefined text on every iteration.
  const CASES: Array<[AnyAction, string, string, string]> = [
    [
      logoutAction as AnyAction,
      'am I logged in',
      'WAAP_LOGOUT',
      'WAAP_WALLET_STATUS'
    ],
    [
      logoutAction as AnyAction,
      'wallet connected',
      'WAAP_LOGOUT',
      'WAAP_WALLET_STATUS'
    ],
    [
      switchChainAction as AnyAction,
      'what chain am I on',
      'WAAP_SWITCH_CHAIN',
      'WAAP_GET_CHAIN'
    ],
    // "spend limit" alone matches both the positive ("set my daily spend
    // limit to $500") and negative examples — narrow with the question
    // marker so we deterministically pick the read-only-routing pin.
    [
      setPolicyAction as AnyAction,
      'what is my spend limit?',
      'WAAP_SET_POLICY',
      'WAAP_GET_POLICY'
    ]
  ]

  it.each(CASES)(
    '%s\'s negative example for "%s" routes to %s',
    (action, substr, destructive, expectedReadOnly) => {
      const ex = findExampleByUserText(action, substr)
      expect(
        ex,
        `Could not find a negative example whose user text contains "${substr}" in ${destructive}'s examples — the test pin needs updating, or the example was removed.`
      ).toBeDefined()

      const actions = ex!.agentActions
      // MUST NOT be empty — that's the bug this test guards against.
      expect(
        actions.length,
        `${destructive}'s negative example for "${substr}" has actions: [] — the LLM reads this as "do nothing", which contradicts the ROUTING RULE. Replace with actions: ['${expectedReadOnly}'] so the example teaches "route to the read-only action, NOT this destructive one."`
      ).toBeGreaterThan(0)

      // MUST NOT include the destructive action itself.
      expect(
        actions,
        `${destructive}'s negative example for "${substr}" must not list itself as the dispatched action — that defeats the purpose of being a negative example.`
      ).not.toContain(destructive)

      // MUST dispatch the matching read-only action.
      expect(
        actions,
        `${destructive}'s negative example for "${substr}" should dispatch ${expectedReadOnly} (the read-only action that IS the correct route for that question).`
      ).toContain(expectedReadOnly)
    }
  )
})
