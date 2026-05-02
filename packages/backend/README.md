# @thodare/backend

Backend abstraction contract for Thodare — pure types, zero runtime.

This package provides the TypeScript interface that every Thodare
backend adapter must implement: `ThodareBackend`, `Storage`, `Queue`,
`Streamer`, `BackendCapabilities`, branded `SpecVersion`, and Zod
schemas for events / payloads / run handles.

Adapters (`@thodare/backend-openworkflow-pg`,
`@thodare/backend-cloudflare`, etc.) import the types from here and
implement the contract. The companion package
`@thodare/backend-contract-tests` exports a parameterized vitest suite
that every adapter must pass.

See `research/backend-abstraction-proposal.md` §3 for the full surface.
