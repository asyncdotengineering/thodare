# full-llm-loop

End-to-end demo of the LLM patch loop, run against `@thodare/api`
booted in-process on a temporary Postgres schema.

What it does:

1. Boots `@thodare/api` on a fresh schema.
2. Signs up a test user (auto-org hook creates the personal org).
3. Mints an API key.
4. Creates an empty workflow.
5. Sends a deliberately broken patch — observes `skipped_items[]`.
6. Sends the fix-up patch.
7. Runs the workflow, polls until completed, prints output.
8. Tears down the schema.

## Run

```sh
createdb wfkit_durable_test    # one-time
pnpm --filter @thodare-examples/full-llm-loop start
```

Verified output ends with:

```
✓ end-to-end LLM loop succeeded
```

This example is the executable form of the
[Build your first workflow](https://asyncdotengineering.github.io/thodare/tutorials/first-workflow/)
tutorial.
