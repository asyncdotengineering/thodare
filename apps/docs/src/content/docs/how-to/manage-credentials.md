---
title: Manage credentials
description: "How to create, reference, and delete credentials via the API."
---

## Goal

Store a secret so your connector can use it at run time without the
LLM ever seeing it.

## Step 1: set the master key

The operator sets the master key as a base64-encoded 32-byte value:

```sh
export THODARE_CREDENTIALS_MASTER_KEY="$(openssl rand -base64 32)"
```

Without this, the API boots but `/api/credentials` routes are not
mounted. If your deployment does not use credentials, you can skip it.

## Step 2: create a credential

```
POST /api/credentials
Content-Type: application/json
Authorization: Bearer thd_…

{
  "type": "api-key",
  "displayName": "Production Slack",
  "secret": { "apiKey": "xoxb-your-slack-bot-token" }
}
```

The response is `201 Created` with the credential row (id, type,
displayName, etc.). The secret is **not** echoed back.

Supported `type` values: `"oauth2"`, `"api-key"`, `"basic"`,
`"bot-token"`, `"custom"`, or a vendor-specific brand like
`"oauth2:slack"`. The `secret` field is a free-form JSON object — the
connector author decides its shape.

## Step 3: reference the credential from workflow JSON

In any block whose connector declares a `credential` binding, add
`credentialId` to `params`:

```json
{
  "ops": [
    {
      "operation_type": "add",
      "block_id": "slack-1",
      "type": "slack",
      "params": { "channel": "#alerts", "credentialId": "<id-from-step-2>" }
    }
  ]
}
```

At dispatch time, the runtime host resolves the credential and
injects it via `ctx.credential.secret`. The connector's `run()` never
sees the credentialId — it sees the decrypted secret.

## Step 4: delete a credential

```
DELETE /api/credentials/:id
Authorization: Bearer thd_…
```

Returns `204 No Content`. The row is soft-deleted (`deleted_at` set);
in-flight runs that already resolved the credential are unaffected.

---

**If this breaks for you:** revert your workflow JSON to a pre-credential
shape (remove `credentialId` from params), or downgrade
`@thodare/api@<prior-version>`. Credentials are an additive primitive — no
existing workflow shape changes.
