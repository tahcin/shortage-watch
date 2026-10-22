# Meterless H-MEM reference implementation (vendored)

`src/` and `conformance/` are copied unchanged from the Meterless open-source repository,
https://github.com/Meterless/Meterless (paths `engines/hmem/reference/src` and `engines/hmem/conformance`),
fetched on 2026-10-22. Licensed under the Apache License 2.0 (see `LICENSE`). Copyright Meterless.

Shortage Watch uses it as its memory engine: buyer decisions are stored with provenance, ranked and
re-injected into the agents' context on later runs, and every change is written to the H-MEM trust ledger.
Our integration code lives in `src/memory/` of this repository. Run the conformance suite with
`npm run hmem:conformance`.
