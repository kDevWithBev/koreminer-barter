# KORE barter call, dry run

This folder does not mine, does not pay, and does not hold a key. `BARTER_LIVE` is false. The engine only writes a public JSON file.

A night takes intents between 8:15 and 8:55 PM ET, a balance snapshot at 8:55, and the house quote. One price clears at 9:00 PM ET. Confirms run until 9:10. Run it by hand:

```bash
npm test
npm run barter:sim -- --night 2026-10-16 --lookup fixtures/lookup-2026-10-16.json --intents fixtures/intents-2026-10-16.json
```

There is no timer in this branch. The shaft runner is a different program and is not imported here.

## Ladder history

The ladder keeps its own streak. The dry run reads the public lookup and appends one night under `data/history/`. The first run writes `seed.json` and treats that streak as the starting count. A missed night is bridged by an unused shield. It does not write `books.json`, `lookup.json`, or anything under `/opt/koreminer`.

On the server, keep `/opt/koreminer-barter/data/history`. Update the code with `git fetch` and `checkout`. Do not delete the folder.

The dry run can also run itself. `koreminer-barter-dryrun.timer` fires at 00:05 UTC and again at 01:05 UTC. It runs `bin/sim.mjs --nightly` for the night that just closed. If the public lookup was published before that close, it waits. The 01:05 run is the payout-delay fallback. It does not touch the runner.

## Player card

`public/barter/card.html` reads the public lookup, the public ladder, and the latest call. It matches a wallet in the browser and shows the short name. It does not send, sign, or store a key. The last wallet stays in the browser's own storage.
