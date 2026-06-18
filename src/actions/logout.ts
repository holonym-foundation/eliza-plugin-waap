import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback
} from '@elizaos/core'

import {
  getWaapService,
  getWaapServiceRaw,
  rejectNoService,
  summarizeViemError
} from './actionUtils'

export const logoutAction: Action = {
  name: 'WAAP_LOGOUT',
  similes: ['SIGN_OUT', 'DISCONNECT_WALLET', 'CLEAR_SESSION'],
  description:
    'Log out of the WaaP wallet and clear the saved session. ONLY dispatch this action when the user has EXPLICITLY asked to log out (e.g. "log me out", "sign out", "disconnect my wallet", "clear my session"). Do NOT dispatch this in response to status questions like "am I logged in?" — answer those with plain text and offer logout as an option without invoking it. Do NOT dispatch speculatively or while asking the user for confirmation; wait for the user to confirm in their next message before listing this action. After logout the agent must sign up or log in again to use the wallet.',

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    // Stay available pre-login — handler emits "please log in first" via
    // rejectNoService(). Otherwise "log me out" silently no-ops.
    return !!getWaapServiceRaw(runtime)
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const svc = getWaapService(runtime)

    if (!svc) {
      return rejectNoService(callback)
    }

    try {
      await svc.logout()
      const text = 'Logged out successfully. Session cleared.'

      await callback?.({ text })

      return { success: true, text }
    } catch (err) {
      const error = err as Error
      // Route through summarizeViemError so unreachable-backend failures
      // get the shared multi-line network-error remediation. Logout normally
      // hits the auth server to invalidate the session — when that's down,
      // the operator should see the same diagnostic the other actions
      // surface, not an opaque "fetch failed".
      const text = `Logout failed: ${summarizeViemError(error.message)}`
      await callback?.({ text })

      return { success: false, text, error }
    }
  },

  examples: [
    [
      { name: '{{user}}', content: { text: 'Log out of my wallet' } },
      {
        name: '{{agent}}',
        content: {
          text: "I'll log you out and clear the session.",
          thought:
            "User wants to disconnect. I'll use WAAP_LOGOUT to clear the session.",
          actions: ['WAAP_LOGOUT']
        }
      }
    ],
    [
      { name: '{{user}}', content: { text: 'Disconnect my wallet' } },
      {
        name: '{{agent}}',
        content: {
          text: "I'll disconnect your wallet now.",
          thought: "User wants to sign out. I'll use WAAP_LOGOUT.",
          actions: ['WAAP_LOGOUT']
        }
      }
    ],
    // Negative example — DO NOT dispatch WAAP_LOGOUT in response to status
    // questions. The user asked whether they are logged in, not to be logged
    // out. Per the system prompt's ROUTING RULE, login-state questions
    // ALWAYS dispatch WAAP_WALLET_STATUS so the user sees the live state
    // from a fresh action card — `actions: []` would let the LLM guess from
    // conversation history, which empirically produced false "not logged in"
    // answers when the wallet was actually live.
    [
      { name: '{{user}}', content: { text: 'am I logged in?' } },
      {
        name: '{{agent}}',
        content: {
          text: 'Checking your wallet status — say so if you want me to log you out after.',
          thought:
            "Login-state question. The system prompt's ROUTING RULE says ALWAYS dispatch WAAP_WALLET_STATUS for these — never guess from conversation memory. Crucially, do NOT dispatch WAAP_LOGOUT here: the user asked whether they are logged in, not to be logged out. If they want to log out, they will say so in the next turn.",
          actions: ['WAAP_WALLET_STATUS']
        }
      }
    ],
    [
      { name: '{{user}}', content: { text: 'is my wallet connected?' } },
      {
        name: '{{agent}}',
        content: {
          text: 'Checking your wallet status — say so if you want me to disconnect after.',
          thought:
            'Connection-status question — same routing as "am I logged in?". Dispatch WAAP_WALLET_STATUS so the chat shows the live state. Do NOT speculatively dispatch WAAP_LOGOUT; the user has not asked to disconnect.',
          actions: ['WAAP_WALLET_STATUS']
        }
      }
    ]
  ]
}
