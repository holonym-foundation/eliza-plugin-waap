# @human.tech/plugin-waap

## 0.1.2

### Patch Changes

- Updated dependencies [56703c0df]
  - @human.tech/waap-cli@1.0.2

## 0.1.1

### Patch Changes

- Updated dependencies [92e548fe7]
  - @human.tech/waap-cli@1.0.1

## 0.1.0

### Minor Changes

- 9fc16050a: Initial release of `@human.tech/plugin-waap` — ElizaOS plugin wrapping `@human.tech/waap-cli` as a wallet provider for ElizaOS agents.

  **Features:**

  - 5 actions: `WAAP_SEND_TX`, `WAAP_SIGN_MESSAGE`, `WAAP_SIGN_TYPED_DATA`, `WAAP_GET_BALANCE`, `WAAP_SET_POLICY`
  - `waapWalletProvider` injects wallet address, chain, 2FA method, and daily spend limit into agent context
  - `WaapService` Eliza 1.x singleton (`ServiceType.WALLET`) managing per-agent sessions
  - 2FA approval flows surfaced to the user via Eliza callback (telegram, email, external_wallet)
  - Trust-gated financial actions via `@elizaos/plugin-trust` `componentDefaults` (all signing/sending actions disabled by default)
  - No password handling; no private key exposure (2-of-2 MPC via WaaP)
  - Per-agent session isolation via `WAAP_CLI_SESSION_DIR`

  **v1 scope:**

  - EVM only (Sui support deferred to a later release)
  - LLM-driven param extractors are currently stubs — production agents need to call the underlying `WaapService` methods directly until v1.1 lands the real `composeContext` integration
  - Targets `@human.tech/waap-cli ^0.1.5` initially (will bump to `^0.2.0` when the prereq CLI changes are published)

  **Tests:** 98 unit tests covering CliRunner, WaapService, all 5 actions, provider, and shared utilities.

### Patch Changes

- Updated dependencies [9fc16050a]
- Updated dependencies [9fc16050a]
- Updated dependencies [30d093fe6]
  - @human.tech/waap-cli@1.0.0
