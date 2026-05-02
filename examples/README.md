# Examples

Runnable examples for Thodare. Each is a separate workspace package
(`@thodare-examples/<name>`) so dependencies stay isolated.

| Example | What it shows |
|---|---|
| [`hello-connector`](./hello-connector/) | The minimum: 2 connectors, 1 workflow, in-memory execution. ~30 LoC. |

For the end-to-end LLM patch loop against a fully-authed `@thodare/api`,
see [`packages/api/tests/02.patch-endpoint.test.ts`](../packages/api/tests/02.patch-endpoint.test.ts) — the executable
spec for the skip-don't-reject contract, with the canonical bootstrap
+ org + API-key flow.

## Run any example

```sh
pnpm --filter @thodare-examples/<name> start
```

The HTTP examples assume Postgres at
`postgresql://localhost:5432/wfkit_durable_test` (override via
`WFKIT_DURABLE_PG_URL`). `createdb wfkit_durable_test` once, then
anything else in `examples/` works.

## Adding an example

1. `mkdir examples/your-thing && cd $_`
2. `package.json` with `name: "@thodare-examples/your-thing"`,
   `private: true`, workspace deps for whatever Thodare packages it
   demonstrates.
3. `index.ts` — keep it focused, single purpose.
4. `README.md` — what it shows, how to run, link back to the docs page
   it accompanies.

Every example should run in <30 seconds and print one clear "it
worked" line.
