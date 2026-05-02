# Thodare use cases

> Concrete product shapes that Thodare is designed to be the substrate for. Authored 2026-05-02 alongside the World abstraction proposal. **Not a customer list** — these are *categories of products* a developer could build on top of Thodare.

The pattern these share: **the product IS the user-defined workflow engine.** A marketer at the customer's company drags steps onto a canvas; the system runs them durably, conditionally, multi-channel, over weeks.

## The use cases

| File | Product class | Real-world examples | What it stresses in Thodare |
|---|---|---|---|
| [`notification-platform.md`](./notification-platform.md) | Multi-channel notification SaaS | OneSignal, Pushwoosh, Iterable | High-throughput trigger ingestion, long durable sleeps, audience-as-fanout, multi-channel orchestration |
| [`sales-funnel-platform.md`](./sales-funnel-platform.md) | Sales funnel + landing-page automation | ClickFunnels, GoHighLevel, Systeme.io | HTTP triggers from page views + form submits, conditional routing, cart-abandonment waits, payment branching |
| [`marketing-automation.md`](./marketing-automation.md) | Behavior-triggered marketing journeys | Klaviyo, Customer.io, Iterable, Braze | Customer-journey loops, segment iteration, predictive blocks, deep drop-off observability |
| [`_common-patterns.md`](./_common-patterns.md) | Patterns shared across all three | — | The Thodare extensions these use cases motivate (container blocks, timezone-aware waits, A/B-as-branch, fan-out-from-segment) |

## Why these use cases matter for the proposal

The World abstraction proposal (`research/world-abstraction-proposal.md`) frames Thodare as having **two consumers, one substrate**:

1. The LLM patches workflow JSON via `EditOp[]`.
2. The **developer building a visual workflow product** consumes Thodare's HTTP API as the durable backend.

Consumer #2 is the load-bearing one for sustainable adoption. These use cases make consumer #2 concrete: the developer building OneSignal-class / ClickFunnels-class / Klaviyo-class products. If Thodare's primitives + API surface can carry those products end-to-end, the substrate story is real.

Each use case is structured the same way:

1. **The product premise** — one paragraph, what the product does
2. **Why it's workflow-shaped** — the load-bearing argument
3. **The founder's POV** — what they define, what they don't have to build
4. **The end user's POV** — what the marketer sees in the canvas
5. **Deployment recommendation** — which World, why
6. **What Thodare provides vs. what the founder builds**
7. **Open gaps** — what's missing in Thodare today that this use case needs

## Reading order

Read [`notification-platform.md`](./notification-platform.md) first — it's the simplest workflow shape (linear drip with branches) and stresses the most Thodare features. Then [`marketing-automation.md`](./marketing-automation.md) for the most complex (full customer-journey graphs). [`sales-funnel-platform.md`](./sales-funnel-platform.md) is in between — interesting because the workflow IS the page-serving runtime, not just background automation. Read [`_common-patterns.md`](./_common-patterns.md) last for the cross-cutting view.

## Cross-references

- `research/world-abstraction-proposal.md` — the substrate that powers all three use cases
- `research/developer-blueprint.md` §4 (Persona D) — the visual-builder founder pattern these use cases instantiate
- `research/code-reviews/visual-builder-substrates.md` — n8n / ActivePieces / Sim Studio analysis that informs which Thodare gaps these use cases also need closed
