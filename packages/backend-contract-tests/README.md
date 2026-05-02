# @thodare/backend-contract-tests

Parameterized vitest suite that every Thodare backend adapter must pass.

## Usage

```ts
import { runContractTests } from "@thodare/backend-contract-tests";
import { myAdapter } from "../src/index.js";

runContractTests(myAdapter);
```

37 test packs covering core, headless-builder, mode-specific, container
blocks, visibility, dynamic schemas, timezone, diff, and synchronous
block result contracts. Packs are gated by adapter capability flags.

See `research/backend-abstraction-proposal.md` §3.7 for the full pack
registry.
