# Recorded runs

Two live runs on 22 October 2026, through Meterless Nightshift, on sample hospital stock built on real FDA-listed products and real FDA data. These are the runs that `samples/monday-morning/` replays in sample mode.

| | Run 1 | Run 2 (after the buyer saved "Never use Hikma") |
|---|---|---|
| Trace | `run-20261022140048-103304.jsonl` | `run-20261022142635-dedb55.jsonl` |
| Result (order list, evidence, trace) | `run-20261022140048-103304.result.json` | `run-20261022142635-dedb55.result.json` |
| Risk board (one Zetaris query, 45 items) | 1.1 s | 1.0 s |
| Items that had to be checked / checked | 18 / 18 | 18 / 20 (the planner added heparin and bupivacaine) |
| Evidence records in the run | 626 | 729 |
| Critic send-backs / approvals / blocks | 2 / 18 / 0 | 2 / 20 / 0 |
| Writer lines that passed the code check | 18 of 18 | 20 of 20 |
| Buyer rule applied | none | 5 times (Hikma removed before ranking) |
| Model calls in the trace answered through Nightshift (with a Meterless receipt) | 35 | 47 |
| Model calls answered by NVIDIA directly after Nightshift gave up | 11 | 5 |

Each trace line has the agent, action, input and output summaries, evidence ids, critic verdict, retry count and, for model calls, the model that answered, its Meterless receipt id and latency. `"provider": "nvidia"` with `fallback_from` marks a call that Nightshift cut off (its upstream limit is about 90 seconds and it always runs Nemotron with reasoning on) and that the app then sent to NVIDIA directly; see the README, "Sponsor technology".

The NDC directory sources had already been registered in Zetaris earlier that day, so in these runs the source scout reused them (`reuse_zetaris_source`). A run on a day with no listing registers them fresh (`register_zetaris_source`).
