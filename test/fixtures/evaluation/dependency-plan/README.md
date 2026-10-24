# Dependency planner fixture

The CLI reads one JSON value from stdin and writes one JSON value to stdout:
`{roots: string[], modules: {[id: string]: {requires?: string[]}}}` becomes
`{order: string[], blocked: string[]}`.

A requested root is blocked if its dependency closure contains a missing module or a cycle.
Only modules reachable from valid requested roots belong in the order. Emit dependencies before their
dependents, choosing the lexicographically smallest ready ID at each step. Deduplicate roots and dependencies;
sort blocked root IDs. Unrelated invalid modules must not affect a valid root.
Inputs contain nonempty ASCII module IDs and well-formed dependency arrays.

Run `node test.mjs`. Preserve this README, the public tests and the CLI interface.
