import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback
} from '@elizaos/core'

import {
  emitLiveText,
  formatNetworkError,
  getWaapServiceRaw,
  isNetworkError,
  rejectNoService
} from './actionUtils'
import { extractLoginParams } from './paramExtraction'

export const loginAction: Action = {
  name: 'WAAP_LOGIN',
  similes: ['SIGN_IN', 'CONNECT_WALLET'],
  description:
    'Log in to an existing WaaP wallet account. Credentials come from the message (email + password) OR, for an agent-owned wallet, from agent settings (WAAP_EMAIL / WAAP_PASSWORD) when the operator has configured them. Dispatch whenever the user asks to log in or connect their wallet: if neither the message nor settings carry credentials, the action replies asking for them — so you do not need credentials in the message to dispatch. When you dispatch WAAP_LOGIN, do NOT also ask the user for their email or password in your reply — the action resolves credentials itself and asks only if none are available.',

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    const svc = getWaapServiceRaw(runtime)

    return !!svc && !svc.isReady()
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const svc = getWaapServiceRaw(runtime)

    if (!svc) {
      return rejectNoService(callback)
    }

    const params = await extractLoginParams(runtime, message, state)

    if (!params.ok) {
      const text = `Invalid login details: ${params.error}`
      await callback?.({ text })

      return { success: false, text, error: new Error(text) }
    }

    const emailLabel = params.value.email

    try {
      const result = await svc.login(params.value.email, params.value.password)
      // Build the success text from an array so each line is a real string
      // entry joined by a real `\n` character — easier for the LLM to relay
      // back without converting newlines into the literal two-character `\n`.
      // Layout matches the signup success banner for consistency.
      const lines = [
        `🎉 Logged in as ${emailLabel}.`,
        `- EVM address: ${result.address}`
      ]
      if (result.suiAddress) lines.push(`- Sui address: ${result.suiAddress}`)

      // After login, the service has refreshed policy state. Surface the 2FA
      // method explicitly so the user knows whether the wallet is protected
      // before any signing operation. We read from the same in-memory state
      // the waapWallet provider serves, so this is grounded. Wrap the read
      // in a try — if the state shape is unexpected (e.g. a partial mock or
      // an unexpected backend shape), the login itself still succeeded and
      // shouldn't be reported as failed; we simply omit the 2FA line.
      let policyMethod: string | undefined
      try {
        policyMethod = svc.getState().policy.authorizationMethod
      } catch {
        policyMethod = undefined
      }
      if (policyMethod === 'disabled') {
        lines.push(
          '',
          '⚠️  2FA is currently DISABLED on this account — anyone with the password can move funds.',
          '   Say `enable 2FA via email your-email@example.com` (or pick Telegram / external wallet) to require approval before signing.'
        )
      } else if (policyMethod) {
        lines.push(`- 2FA method: ${policyMethod}`)
      }

      const richText = lines.join('\n')

      // Only include twoFa* fields when we actually read the policy method;
      // otherwise emitting `twoFaEnabled: true` from `undefined !== 'disabled'`
      // would be a false-positive ground truth.
      const policyContent =
        policyMethod !== undefined
          ? {
              twoFaEnabled: policyMethod !== 'disabled',
              twoFaMethod: policyMethod
            }
          : {}

      // Push the multi-line bubble verbatim via the live channel; falls back
      // to inlining it in the callback when the host has no live-message
      // handler. The terse callback text is what the LLM sees in conversation
      // memory — keeping it free of `\n` prevents downstream re-narration
      // from leaking the escape sequence as literal characters.
      const liveOk = await emitLiveText(runtime, message, richText)
      const callbackText = liveOk ? `Logged in as ${emailLabel}.` : richText

      await callback?.({
        text: callbackText,
        content: {
          address: result.address,
          suiAddress: result.suiAddress,
          ...policyContent
        }
      })

      return {
        success: true,
        text: callbackText,
        data: {
          address: result.address,
          suiAddress: result.suiAddress,
          ...policyContent
        }
      }
    } catch (err) {
      const error = err as Error
      // The backend returns a single generic 401 for both "wrong password"
      // and "no such account" so it can't leak which case it was. Detect
      // that 401 and suggest signing up — the user may simply not have an
      // account yet. Otherwise surface the raw error.
      const looksLikeAuthFailure =
        /(401|invalid email or password|invalid credentials|unauthorized)/i.test(
          error.message
        )

      let text: string
      if (looksLikeAuthFailure) {
        text =
          `Couldn't log in as ${emailLabel} — the email and password didn't match an existing account. ` +
          `If you haven't signed up yet, say \`create a new account with email ${emailLabel} and password your-password\`. ` +
          `Otherwise double-check the credentials and try again.`
      } else if (isNetworkError(error.message)) {
        // Same diagnostic every action surfaces for unreachable-backend
        // failures — `formatNetworkError` lives in actionUtils so the
        // remediation stays consistent across login/signup/sendTx/etc.
        text = `Login failed for ${emailLabel}.\n\n${formatNetworkError(
          error.message
        )}`
      } else {
        text = `Login failed for ${emailLabel}: ${error.message}`
      }

      await callback?.({ text })

      return { success: false, text, error }
    }
  },

  examples: [
    [
      {
        name: '{{user}}',
        content: {
          text: 'Log in with email test@example.com and password mySecurePass123'
        }
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll log you into your WaaP wallet now.",
          thought:
            "User wants to log into their existing WaaP wallet. I'll use WAAP_LOGIN with the provided credentials.",
          actions: ['WAAP_LOGIN']
        }
      }
    ],
    // Bare-token format: an email + a non-email word, with or without a `login`
    // verb, counts as both credentials. The user often skips the "password"
    // keyword — refusing to dispatch in that case is just friction.
    [
      {
        name: '{{user}}',
        content: { text: 'agent@example.com bareToken123 login' }
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Logging you in now.',
          thought:
            "Bare-token credentials: the email is the @-containing token and the password is the other non-verb token. WAAP_LOGIN's extractor handles this format directly.",
          actions: ['WAAP_LOGIN']
        }
      }
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'login alice@example.com MySecure123' }
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Logging you in now.',
          thought:
            'Verb + email + password (no keywords). Both credentials are present, so dispatch WAAP_LOGIN.',
          actions: ['WAAP_LOGIN']
        }
      }
    ],
    [
      { name: '{{user}}', content: { text: 'Connect my wallet' } },
      {
        name: '{{agent}}',
        content: {
          text: 'Logging you into your WaaP wallet now.',
          thought:
            "User wants to connect their wallet but didn't include credentials. For an agent-owned wallet the credentials may be configured in settings (WAAP_EMAIL / WAAP_PASSWORD), so I dispatch WAAP_LOGIN — its extractor uses message credentials if present, otherwise the configured ones, and asks for them if neither is available.",
          actions: ['WAAP_LOGIN']
        }
      }
    ]
  ]
}
