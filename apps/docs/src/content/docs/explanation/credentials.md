---
title: The Credential primitive
description: "How Thodare secures secrets — per-org encryption, id-only references, and the LLM boundary."
---

Credentials are how Thodare keeps secrets out of the LLM's hands.
Workflow JSON references them by id only — the actual secret never
appears in workflow JSON, API responses, logs, or error messages.

## Why this exists

Without a credential primitive, every `defineConnector()` that calls
an external API would need its secret in the workflow JSON. The LLM
would see it, the patch endpoint would echo it, and any log line
would leak it. Headless-substrate applications (n8n-class,
ActivePieces-class, Sim-class) can't be built on that model.

The credential primitive gives connectors exactly one thing: a
`credentialId` in the block's params. The secret lives in Postgres,
AES-256-GCM-encrypted, and is only decrypted when a run dispatches.

## Encrypt-at-rest model

- **Master key** — a 32-byte key, provided by the operator via
  `THODARE_CREDENTIALS_MASTER_KEY` (base64) or
  `credentialsMasterKey` in `createControlPlaneApi()`.
- **Per-org key derivation** — HKDF-SHA256 with salt = UTF-8
  organization id and info = `"thodare-credential-v1"`. Each
  organization gets its own AES-256 key, even though there's one
  master key. Compromising one org's key does not compromise another.
- **AES-256-GCM** — random 12-byte IV per encrypt operation.
  Ciphertext + auth tag stored as binary `bytea`.
- **Authentication tag** is verified on decrypt. Tampered blobs throw.

The API's `WorkflowStore.getDecrypted()` is the only method that
produces a plaintext secret. It is callable only by the runtime
host — no HTTP route can reach it. No "reveal" endpoint exists.

## Wire-format guarantee

The LLM references a credential by `credentialId` in a block's
`params`. Example:

```json
{
  "id": "slack-1",
  "type": "slack",
  "params": { "channel": "#alerts", "credentialId": "slack-prod" }
}
```

At dispatch time, the runtime host resolves `slack-prod` to a
`ResolvedCredential` and injects it into `ToolContext.credential`.
The connector's `run()` receives `ctx.credential.secret` — the
actual secret material — without the workflow JSON ever carrying
it.

If the credential is not found, the block fails with
`credential_not_found`. If the credential type does not match the
connector's declared `credential.type`, it fails with
`credential_type_mismatch`.

## Operational caveats

- **Master-key rotation is not automatic.** Existing `encrypted_secret`
  blobs are bound to the master key in effect at encrypt time. Rotating
  `THODARE_CREDENTIALS_MASTER_KEY` does NOT re-encrypt prior rows —
  decrypts will fail with the new key. A migration path
  (re-encrypt-on-read or batch re-encrypt) is a v1.1 follow-up.
- **Boot policy.** If neither `opts.credentialsMasterKey` nor the env
  var is set, the `/api/credentials` route is not mounted (deployments
  that don't use credentials do not need to provide a key). If a key
  is provided but is the wrong length, the API fails fast at boot.

## Related

- [Manage credentials](/how-to/manage-credentials) — step-by-step guide.
- [The patch loop](/explanation/patch-loop) — how `hidden()` and
  credential protection interact.
