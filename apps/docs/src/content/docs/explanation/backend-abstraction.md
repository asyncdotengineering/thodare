---
title: The Backend abstraction
description: "Why the Backend abstraction is the load-bearing contract of the v1 release."
---

The Backend abstraction is the central architectural contract of Thodare
v1. It defines a TypeScript interface that every durable-execution
substrate must implement, so the same workflow JSON and the same
skip-don't-reject EditOp surface runs on Postgres, Cloudflare
Workflows, Vercel, AWS, or your laptop — without changing a single
line of your workflow definition.

## One substrate, two consumers

The abstraction serves two consumers from a single contract:

1. **The LLM** — patches workflow JSON via `EditOp[]` (skip-don't-reject) and reads back run output. The Backend abstraction makes the durability layer pluggable so the LLM-feedable surface stays constant across substrates.

2. **The developer building a visual workflow product** — an n8n-class or ActivePieces-class application consumes Thodare's HTTP API as the durable backend, with live subscriptions, step I/O inspection, resume-from-step, and credential-at-rest, all provided by the Backend they chose.

Both consumers depend on the same `ThodareBackend` interface. The Backend abstraction is what makes that possible.

## Why two packages

The abstraction ships as two packages by design:

- **`@thodare/backend`** — pure TypeScript types, branded constants, and Zod schemas. No runtime code, no implementations. Anchors the contract at the type level so every adapter can import and implement it.

- **`@thodare/backend-contract-tests`** — a parameterized vitest suite (`runContractTests(backend, options?)`). 37 test packs cover core correctness, capability-gated features, mode-specific behavior, container blocks, visibility rules, timezone-aware waits, diff endpoints, and synchronous block results. Every adapter must pass this suite. The suite is the cross-adapter parity gate.

The contract is anchored in both forms — types AND executable assertions — so no adapter can drift from the specification.

## Three load-bearing primitives preserved

The Backend abstraction does not redesign the v0 bets. It preserves them:

1. **Skip-don't-reject** — the patch endpoint never rejects a batch on first bad op. Structured skip reasons are feedable directly back to the LLM. The abstraction enforces this at the contract level.

2. **Pin-at-run-start** — the workflow JSON is packed into the run input at dispatch time. In-flight runs use the version they started with, even if the workflow is patched mid-run. Every Backend must honor this.

3. **One generic runtime workflow** — each Backend registers exactly one orchestrator entrypoint that dynamically walks the workflow JSON. No per-workflow registration, no runtime redeployment.

## Where it ships next

Phase 1 ships types and contract tests only — no adapter implementations. Phase 2 lands the Credential primitive (AES-256-GCM at rest, multi-tenant credential vault). Phase 3 extracts openworkflow as the first concrete adapter (`@thodare/backend-openworkflow-pg` + `@thodare/backend-openworkflow-sqlite`), and every adapter thereafter passes the same contract suite.

For the full interface surface, see [`research/backend-abstraction-proposal.md` §3](https://github.com/asyncdotengineering/thodare/blob/main/research/backend-abstraction-proposal.md). For adapter-specific capability matrices and pricing math, see each adapter's README.
