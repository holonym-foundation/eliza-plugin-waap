---
'@human.tech/plugin-waap': patch
---

Correctness and security hardening:

- Correct the plugin/package name to `@human.tech/plugin-waap`.
- Harden credential parsing: capture the password after `to`/`for` connectors
  and ignore filler words so a message without a password no longer fabricates
  one (and the operator-config fallback engages).
- Reject wrong-length recipient addresses and fractional Sui MIST before any
  send/sign operation.
- Restrict `WAAP_REQUEST` to a read-only JSON-RPC method allowlist so it can no
  longer be used to bypass the dedicated, 2FA-gated send/sign actions.
- Reject EIP-712 typed data whose `domain.chainId` differs from the wallet's
  active chain, and surface the signed type + verifying contract.
