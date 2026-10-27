# Recorded runs

Two runs on sample hospital stock built on real FDA-listed products and real FDA data. These are the runs that `samples/monday-morning/` replays in sample mode (`SAMPLE_MODE=true npm start`, no credentials).

| | Run 1 | Run 2 (after the buyer saved "Never use Hikma") |
|---|---|---|
| Trace | `run-20261027064940-208823.jsonl` | `run-20261027064943-22ec01.jsonl` |
| Result (order list, evidence, trace) | `run-20261027064940-208823.result.json` | `run-20261027064943-22ec01.result.json` |
| Live investigation trace (22 Oct) | `run-20261022152757-91ecad.jsonl` | |
| Risk board (one Zetaris query, 45 items) | 0.9 s | replayed |
| Items that had to be checked / checked | 18 / 18 | 18 / 18 |
| Evidence records | 752 | 756 |
| Critic send-backs / approvals / blocks | 4 / 18 / 0 | 4 / 18 / 0 |
| Zetaris sources the scout registered at run time | 6 (morphine, sodium bicarbonate, lidocaine, midazolam, atropine, dextrose) | reused |
| Buyer rule applied | none | Hikma removed before ranking for atropine (now Somerset only), lidocaine and midazolam; famotidine flagged because Hikma is its current supplier |

## How these runs were made

**Run 1** ran live on 22 October 2026, 20:57 IST: Zetaris on a Windows laptop (Docker), Meterless Nightshift on a Mac, Nemotron through Nightshift. Every Zetaris query, every model reply and the scout's six run-time registrations were recorded. The run completed the whole investigation (`run-20261022152757-91ecad.jsonl`: risk board, planner, investigator, scout, substitution, critic, and 16 of 18 Writer lines), then the process stopped before the last two Writer lines.

On 27 October the laptop running Zetaris was no longer available, so the recording was completed in **fill mode** (`SAMPLE_FILL=true`, see `src/sample.ts`): every recorded Zetaris answer and model reply is replayed through the real agent code, and only the model calls that were never recorded are made live through Nightshift and recorded. Zetaris answers are never invented: a Zetaris request that was not recorded fails. The two traces above are replays of the completed recording (mode `sample`); each model call's line keeps the provider, model and Meterless receipt it was answered with.

**Run 2** was made the same way on 27 October: the buyer saved "Never use Hikma", and the agents ran again. Its Zetaris requests are the same statements as run 1's, so their recorded answers from the live Zetaris instance were replayed; its model calls (new prompts, because the buyer's rule changed what the agents see) went live through Nightshift. It is limited to the 18 items that had to be checked, so it asks Zetaris only what was recorded. Its as-of date is set 30 minutes after run 1, so its day counts match the data.

## Model calls

Each trace line for a model call names the model that answered, the provider, the Meterless receipt id and the latency. `"provider": "nvidia"` with `fallback_from` marks a call that Nightshift could not finish (it cuts upstream calls off after about 90 seconds and always runs Nemotron with reasoning on) and that the app then sent once to NVIDIA directly. Across the recording, 118 model calls: 95 answered through Nightshift with a Meterless receipt (60 by Nemotron 3 Ultra, 35 by Nemotron 3.5 Lightning) and 23 by NVIDIA directly after Nightshift gave up. Run 1 logs 49 and 16, run 2 logs 59 and 6.

## Data-quality warning in run 1

The scout's lidocaine listing returned exactly 1,000 products, openFDA's per-request limit, so its trace line is marked `needs_revision` ("may be incomplete"). The substitute check for lidocaine still ran on what was returned.
