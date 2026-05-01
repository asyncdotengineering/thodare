---
title: Quickstart
description: "From cold start to a workflow that runs, in three commands."
---

This is the fastest path to a running Thodare. Five minutes from `npm
install` to a workflow you can curl.

## Prerequisites

- **Node 22+** (`fetch`, `node:sqlite` are built-in).
- **Postgres** reachable locally — the engine's source of truth.
- A boot of `@thodare/api` somewhere your terminal can reach.

If you don't have an API instance running yet, see
[Reference example](/thodare/start/reference-example/) for a 30-line
TypeScript file that boots one in your repo. Then come back here.

## 1. Install the CLI

```sh
npm install -g @thodare/cli
# or
pnpm add -g @thodare/cli
```

## 2. Sign in (or sign up)

```sh
thodare login --api http://localhost:3000
# → Email: you@example.com
# → Password: ********
# → Signed up as you@example.com
# → Active org: you-7f2k (org_xxxx)
# → API key: thd_… (saved to ~/.thodare/credentials.json)
```

The CLI runs the full bootstrap in one shot: sign in or sign up →
ensure your account has an organization (auto-creates one if not) →
set it active → mint an API key → save credentials.

If the database is empty (fresh deploy), `thodare login` won't work —
nobody can sign up because there's no admin route by default. Use the
[bootstrap admin link](/thodare/how-to/bootstrap-admin/) instead.

## 3. Verify

```sh
thodare whoami
# you@example.com
# org: you-7f2k (org_xxxx)
# api: http://localhost:3000

curl -H "Authorization: Bearer $(thodare token)" \
     http://localhost:3000/api/connectors?detail=summary | jq
```

You should see the connector catalog — that's what your LLM will read
from its system prompt.

## 4. Create a workflow

```sh
URL=http://localhost:3000
H="Authorization: Bearer $(thodare token)"

WF=$(curl -sX POST "$URL/api/workflows" -H "$H" -H 'content-type: application/json' -d '{}')
WFID=$(echo "$WF" | jq -r .id)
VER=$(echo "$WF" | jq -r .version)
```

## 5. Patch it (intentionally broken — to see how feedback works)

```sh
curl -sX POST "$URL/api/workflows/$WFID/operations" \
  -H "$H" -H "If-Match: $VER" -H 'content-type: application/json' \
  -d '{"ops":[
    {"operation_type":"add","block_id":"trg","type":"trigger_webhook","params":{}},
    {"operation_type":"add","block_id":"g","type":"slak","params":{"channel":"#sales","text":"hi"}}
  ]}' | jq '{ok, version, summary, skipped_items}'
```

The response's `skipped_items[]` tells the LLM exactly what's wrong
(typo: `slak` → `slack`). This is the load-bearing primitive — see
[The patch loop](/thodare/explanation/patch-loop/).

## 6. Fix and run

```sh
VER=$(curl -s "$URL/api/workflows/$WFID" -H "$H" | jq .version)

curl -sX POST "$URL/api/workflows/$WFID/operations" \
  -H "$H" -H "If-Match: $VER" -H 'content-type: application/json' \
  -d '{"ops":[
    {"operation_type":"add","block_id":"g","type":"slack","params":{"channel":"#sales","text":"hi"}},
    {"operation_type":"connect","block_id":"trg","target_block_id":"g"}
  ]}' >/dev/null

RUN=$(curl -sX POST "$URL/api/workflows/$WFID/run" -H "$H" -H 'content-type: application/json' \
  -d '{"input":{"hello":"world"}}')
RUNID=$(echo "$RUN" | jq -r .runId)

while true; do
  STATE=$(curl -s "$URL/api/runs/$RUNID" -H "$H" | jq -r .state)
  echo "state=$STATE"
  [ "$STATE" = "completed" ] || [ "$STATE" = "failed" ] && break
  sleep 0.5
done

curl -s "$URL/api/runs/$RUNID" -H "$H" | jq .output
```

Done. You patched, ran, and read the output of a durable workflow.

## What just happened

- `thodare login` collapsed sign-up + org + key into one command.
- The first patch had a typo; `skipped_items[]` carried the structured
  rejection — feedable directly to an LLM.
- The fix-up patch landed cleanly because the LLM had structured
  feedback, not just a 400.
- Dispatch packed the workflow JSON into the run input (so a later
  patch wouldn't disturb the run) and the durable runtime took over.

## Next

- [Build your first workflow](/thodare/tutorials/first-workflow/) — same flow, with TypeScript.
- [Define a connector](/thodare/how-to/define-connector/) — the building block.
- [The patch loop](/thodare/explanation/patch-loop/) — why skip-don't-reject works.
