// Static routing-coverage audit: for every realistic user question, verify
// that the expected WAAP_* action's metadata (similes ∪ description ∪
// examples) contains a recognisable signal. We can't LLM-test what an actual
// model dispatches, but we CAN guarantee that the matching action surfaces
// terms the LLM should pattern-match against.
//
// When a regression appears (LLM picks NONE for a phrasing it shouldn't),
// add the phrasing here with the keyword that would have routed it.
// Failing this test means: either the right action isn't surfacing the
// keyword, or the question shouldn't dispatch (in which case mark it as a
// `noDispatch` case).

import { describe, it, expect } from 'vitest'

import { cancel2faAction } from '../../src/actions/cancel2fa'
import { disable2faAction } from '../../src/actions/disable2fa'
import { enable2faAction } from '../../src/actions/enable2fa'
import { getAddressAction } from '../../src/actions/getAddress'
import { getBalanceAction } from '../../src/actions/getBalance'
import { getChainAction } from '../../src/actions/getChain'
import { getPolicyAction } from '../../src/actions/getPolicy'
import { listChainsAction } from '../../src/actions/listChains'
import { loginAction } from '../../src/actions/login'
import { logoutAction } from '../../src/actions/logout'
import { requestAction } from '../../src/actions/request'
import { sendTxAction } from '../../src/actions/sendTx'
import { setPolicyAction } from '../../src/actions/setPolicy'
import { signMessageAction } from '../../src/actions/signMessage'
import { signTxAction } from '../../src/actions/signTx'
import { signTypedDataAction } from '../../src/actions/signTypedData'
import { signupAction } from '../../src/actions/signup'
import { switchChainAction } from '../../src/actions/switchChain'
import { twoFaStatusAction } from '../../src/actions/twoFaStatus'
import { walletStatusAction } from '../../src/actions/walletStatus'

const ACTIONS = {
  WAAP_GET_ADDRESS: getAddressAction,
  WAAP_GET_BALANCE: getBalanceAction,
  WAAP_GET_CHAIN: getChainAction,
  WAAP_GET_POLICY: getPolicyAction,
  WAAP_WALLET_STATUS: walletStatusAction,
  WAAP_2FA_STATUS: twoFaStatusAction,
  WAAP_LIST_CHAINS: listChainsAction,
  WAAP_LOGIN: loginAction,
  WAAP_SIGNUP: signupAction,
  WAAP_LOGOUT: logoutAction,
  WAAP_SWITCH_CHAIN: switchChainAction,
  WAAP_SEND_TX: sendTxAction,
  WAAP_SIGN_TX: signTxAction,
  WAAP_SIGN_MESSAGE: signMessageAction,
  WAAP_SIGN_TYPED_DATA: signTypedDataAction,
  WAAP_SET_POLICY: setPolicyAction,
  WAAP_ENABLE_2FA: enable2faAction,
  WAAP_DISABLE_2FA: disable2faAction,
  WAAP_CANCEL_2FA: cancel2faAction,
  WAAP_REQUEST: requestAction
} as const

type ActionName = keyof typeof ACTIONS

function actionKeywordCorpus(name: ActionName): string {
  // Flattens everything the LLM "sees" for this action — name, similes,
  // description, and examples — into one lowercased blob. Case-insensitive
  // because action similes are SCREAMING_SNAKE_CASE while user messages
  // and example user prompts are lowercase prose.
  const a = ACTIONS[name] as any
  const parts: string[] = [
    String(a.name ?? ''),
    ...(a.similes ?? []),
    String(a.description ?? ''),
    JSON.stringify(a.examples ?? [])
  ]
  return parts.join('\n').toLowerCase()
}

// ── Coverage matrix ─────────────────────────────────────────────────────────
//
// Each row: [user phrasing, expected action, keyword that must be present in
// that action's corpus]. The keyword can be a simile fragment, description
// term, or example user-message verbatim — whatever surfaces in the action's
// metadata.

const DISPATCH_CASES: Array<[string, ActionName, string]> = [
  // ── Address questions ────────────────────────────────────────────────────
  ["what's my address?", 'WAAP_GET_ADDRESS', 'my_address'],
  ['my wallet address', 'WAAP_GET_ADDRESS', 'wallet_address'],
  ['show me my addresses', 'WAAP_GET_ADDRESS', 'show_address'],
  ['my EVM address', 'WAAP_GET_ADDRESS', 'evm_address'],
  ['my Sui address', 'WAAP_GET_ADDRESS', 'sui_address'],
  ["where's my wallet?", 'WAAP_GET_ADDRESS', 'where_is_my_wallet'],

  // ── Wallet status / "am I logged in?" ────────────────────────────────────
  ['am I logged in?', 'WAAP_WALLET_STATUS', 'am_i_logged_in'],
  ['wallet status', 'WAAP_WALLET_STATUS', 'wallet_status'],
  ['wallet info', 'WAAP_WALLET_STATUS', 'wallet_info'],
  ['wallet summary', 'WAAP_WALLET_STATUS', 'wallet_summary'],
  ['show me everything', 'WAAP_WALLET_STATUS', 'show_everything'],
  ['who am I?', 'WAAP_WALLET_STATUS', 'who_am_i'],
  ['my wallet', 'WAAP_WALLET_STATUS', 'my_wallet'],
  ['do I have any pending 2FA?', 'WAAP_WALLET_STATUS', 'pending_2fa'],
  ["what's my policy?", 'WAAP_WALLET_STATUS', 'my_policy'],

  // ── Balance ──────────────────────────────────────────────────────────────
  ["what's my balance?", 'WAAP_GET_BALANCE', 'check_balance'],
  ['how much do I have?', 'WAAP_GET_BALANCE', 'how_much'],
  ['my balance', 'WAAP_GET_BALANCE', 'my_balance'],
  ['do I have funds?', 'WAAP_GET_BALANCE', 'do_i_have_funds'],
  ['my ETH balance', 'WAAP_GET_BALANCE', 'eth_balance'],
  ['my SUI balance', 'WAAP_GET_BALANCE', 'sui_balance'],
  ['check my balance on Polygon', 'WAAP_GET_BALANCE', 'check_balance'],

  // ── 2FA status ───────────────────────────────────────────────────────────
  ['is 2FA on?', 'WAAP_2FA_STATUS', 'is_2fa_enabled'],
  ['do I have 2FA?', 'WAAP_2FA_STATUS', 'do_i_have_2fa'],
  ["what's my 2FA method?", 'WAAP_2FA_STATUS', 'my_2fa_method'],
  ['check my 2FA', 'WAAP_2FA_STATUS', 'check_2fa'],

  // ── Active chain (single-line — but routed through an action so the LLM never guesses) ──
  ['what chain am I on?', 'WAAP_GET_CHAIN', 'what_chain'],
  ['active chain', 'WAAP_GET_CHAIN', 'active_chain'],
  ['my chain', 'WAAP_GET_CHAIN', 'my_chain'],
  ['current network', 'WAAP_GET_CHAIN', 'current_network'],

  // ── Spending policy / daily limit (single-line — routed through action) ──
  ["what's my limit?", 'WAAP_GET_POLICY', 'my_limit'],
  ["what's my daily spend limit?", 'WAAP_GET_POLICY', 'daily_limit'],
  ['my spend cap', 'WAAP_GET_POLICY', 'spend_cap'],
  ['show my policy', 'WAAP_GET_POLICY', 'show_policy'],
  [
    'how much can I send per day?',
    'WAAP_GET_POLICY',
    'how much can I send per day'
  ],

  // ── Supported chains (different from active chain) ───────────────────────
  ['what chains do you support?', 'WAAP_LIST_CHAINS', 'supported_chains'],
  ['which networks do you support?', 'WAAP_LIST_CHAINS', 'supported_networks'],
  ['list networks', 'WAAP_LIST_CHAINS', 'list_networks'],
  ['available chains', 'WAAP_LIST_CHAINS', 'available_chains'],

  // ── Auth: signup / login / logout ────────────────────────────────────────
  ['log me in', 'WAAP_LOGIN', 'sign_in'],
  ['log in with email a@b.com password X', 'WAAP_LOGIN', 'log in with email'],
  ['a@b.com X login', 'WAAP_LOGIN', 'bareToken123'], // bare-token format pinned in examples
  ['sign me up', 'WAAP_SIGNUP', 'create_wallet'],
  ['create an account', 'WAAP_SIGNUP', 'create_account'],
  ['register', 'WAAP_SIGNUP', 'register'],
  ['log me out', 'WAAP_LOGOUT', 'sign_out'],
  ['disconnect', 'WAAP_LOGOUT', 'disconnect_wallet'],

  // ── Chain switch ─────────────────────────────────────────────────────────
  ['switch to Polygon', 'WAAP_SWITCH_CHAIN', 'change_chain'],
  ['use Sui mainnet', 'WAAP_SWITCH_CHAIN', 'use_network'],

  // ── Mutations (destructive) ──────────────────────────────────────────────
  ['send 0.1 ETH to 0xabc...', 'WAAP_SEND_TX', 'send_transaction'],
  ['transfer 1 USDC', 'WAAP_SEND_TX', 'transfer'],
  ["sign 'hello'", 'WAAP_SIGN_MESSAGE', 'sign_message'],
  ["personal_sign 'hello'", 'WAAP_SIGN_MESSAGE', 'personal_sign'],
  ['sign typed data {...}', 'WAAP_SIGN_TYPED_DATA', 'sign_typed_data'],
  ['EIP-712 sign', 'WAAP_SIGN_TYPED_DATA', 'eip712_sign'],
  ["sign tx but don't broadcast", 'WAAP_SIGN_TX', 'sign_without_broadcast'],

  // ── Policy ───────────────────────────────────────────────────────────────
  ['set my daily limit to $500', 'WAAP_SET_POLICY', 'set_spend_limit'],
  ['raise my spend cap', 'WAAP_SET_POLICY', 'change_daily_limit'],

  // ── 2FA management ───────────────────────────────────────────────────────
  ['enable 2FA via email a@b.com', 'WAAP_ENABLE_2FA', 'setup_2fa'],
  ['set up Telegram 2FA', 'WAAP_ENABLE_2FA', 'set_up_2fa'],
  ['disable 2FA', 'WAAP_DISABLE_2FA', 'disable_two_factor'],
  ['turn off 2FA', 'WAAP_DISABLE_2FA', 'turn_off_2fa'],
  ['cancel my pending 2FA', 'WAAP_CANCEL_2FA', 'cancel_pending_2fa'],
  ['abort that approval', 'WAAP_CANCEL_2FA', 'abort_2fa'],

  // ── RPC ──────────────────────────────────────────────────────────────────
  ['what is the current block number?', 'WAAP_REQUEST', 'eth_blocknumber'],
  ['call eth_gasPrice', 'WAAP_REQUEST', 'rpc_request']
]

// Phrasings that MUST NOT dispatch any wallet action — they are off-topic,
// pure capability questions, or facts the plugin doesn't track. We don't
// pin the dispatch target; we pin that the action descriptions don't
// accidentally claim coverage of these.
const NO_DISPATCH_CASES: Array<[string, string]> = [
  // Capability / help questions — answered free-form; no specific keyword to pin.
  ['what can you do?', 'capability'],
  ['hi', 'greeting'],
  ['hello', 'greeting'],
  // Facts the plugin doesn't track — must be in the GROUNDING CONTRACT
  // "not tracked" list (verified separately below).
  ["what's my email?", 'untracked-email'],
  ['my recent transactions', 'untracked-history'],
  ["what's the price of ETH in USD?", 'untracked-price']
]

describe('Question routing coverage — every realistic phrasing routes to its action', () => {
  it.each(DISPATCH_CASES)(
    '"%s" → %s (signal: "%s")',
    (phrasing, expectedAction, keyword) => {
      const corpus = actionKeywordCorpus(expectedAction)
      const lower = keyword.toLowerCase()
      // The keyword must appear somewhere in the action's name + similes +
      // description + examples. If this fails: either add a simile, expand
      // the description, or add a positive example covering the phrasing.
      expect(
        corpus.includes(lower),
        `"${phrasing}" should be covered by ${expectedAction} via keyword "${keyword}", but the action's metadata does not contain it. Add it as a simile (preferred), in the description, or as a positive example.`
      ).toBe(true)
    }
  )
})

describe('Untracked-fact questions are explicitly grounded as "we do not have this"', () => {
  // The GROUNDING CONTRACT enumerates which facts the plugin can never
  // answer. Pin the explicit mention so the agent never confabulates them.
  // Loaded inline to avoid pulling in the character.test.ts setup twice.
  const character = JSON.parse(
    require('node:fs').readFileSync(
      require('node:path').resolve(__dirname, '../../character.json'),
      'utf-8'
    )
  )
  const system: string = character.system

  it('mentions email is not stored', () => {
    expect(system).toMatch(/email[^.]*never stored|email[^.]*not stored/i)
  })

  it('mentions transaction history is not tracked', () => {
    expect(system).toMatch(/transaction history/i)
  })

  it('mentions prices / USD conversions are not provided', () => {
    expect(system).toMatch(/prices|USD conversion/i)
  })

  it.each(NO_DISPATCH_CASES)(
    '"%s" (%s) — no action falsely claims to handle this',
    (phrasing) => {
      // Sanity check: no action's similes contains a phrase from the
      // off-topic list. If one does, we've over-promised coverage.
      const offending: string[] = []
      for (const name of Object.keys(ACTIONS) as ActionName[]) {
        const similes = ((ACTIONS[name] as any).similes ?? []) as string[]
        const hits = similes.filter(
          (s) =>
            s.toLowerCase().includes('weather') ||
            s.toLowerCase().includes('price') ||
            s.toLowerCase().includes('history') ||
            s.toLowerCase() === 'help'
        )
        if (hits.length) offending.push(`${name}: ${hits.join(', ')}`)
      }
      expect(
        offending,
        `Some action falsely claims to cover "${phrasing}". Remove the over-broad similes: ${offending.join(
          ' | '
        )}`
      ).toEqual([])
    }
  )
})

describe('Read-only actions stay available pre-login (no silent no-op)', () => {
  // All five read-only actions must validate to true even when the service
  // is not ready. The handler is responsible for the not-logged-in branch.
  const READ_ONLY: ActionName[] = [
    'WAAP_GET_ADDRESS',
    'WAAP_GET_BALANCE',
    'WAAP_GET_CHAIN',
    'WAAP_GET_POLICY',
    'WAAP_WALLET_STATUS',
    'WAAP_2FA_STATUS',
    'WAAP_LIST_CHAINS'
  ]

  it.each(READ_ONLY)('%s validates pre-login', async (name) => {
    const runtime = {
      getService: () => ({ isReady: () => false })
    } as any
    const message = { content: { text: 'test' } } as any
    const ok = await ACTIONS[name].validate(runtime, message)
    expect(ok).toBe(true)
  })
})

describe('No two actions claim the same simile (prevents LLM disambiguation chaos)', () => {
  it('every simile is unique across the action set', () => {
    const seen = new Map<string, string>()
    const conflicts: string[] = []
    for (const name of Object.keys(ACTIONS) as ActionName[]) {
      const similes = ((ACTIONS[name] as any).similes ?? []) as string[]
      for (const s of similes) {
        const key = s.toLowerCase()
        const owner = seen.get(key)
        if (owner && owner !== name) {
          conflicts.push(`${s} owned by both ${owner} and ${name}`)
        } else {
          seen.set(key, name)
        }
      }
    }
    expect(conflicts).toEqual([])
  })
})
