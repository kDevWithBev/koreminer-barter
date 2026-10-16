# KORE barter call, dry run

This folder does not mine, does not pay, and does not hold a key. `BARTER_LIVE` is false. The engine only writes a public JSON file.

A night takes intents between 8:15 and 8:55 PM ET, a balance snapshot at 8:55, and the house quote. One price clears at 9:00 PM ET. Confirms run until 9:10. Run it by hand:

```bash
npm test
npm run barter:sim -- --night 2026-10-16 --lookup fixtures/lookup-2026-10-16.json --intents fixtures/intents-2026-10-16.json
```

There is no timer in this branch. The shaft runner is a different program and is not imported here.
