# Koreminer pit v1 runbook notes

## A PAYHOLD from "shaft head not agreed" (Ops R-1 gate, Sage N-4)
The runner holds a void (and refuses a fresh live seed, Sage N-1) unless every representative the client knows reports the
shaft head block the history walk saw. One rep that is down, slow or behind is enough to hold every void. That is the
intended fail-closed behavior: the hold never sends.

Before anyone clears the hold (removing /opt/koreminer/PAYHOLD is Trey's call, by a reviewed box only):
1. Read the alert line in pit-alerts.log: it names the walk's head and each rep's answer (first 8 hex, `error` or `none`).
2. Wait at least 30 minutes and check again: a rep that was only behind catches up, and the next pass then voids on its own.
3. If one rep still answers `error` or `none`, it is down. Check the rep's status with the Keeta network (status page or
   channel) and do not clear the hold while it is down: a down rep may be the one that has the paid block.
4. If a rep reports a different head than the others, compare it on a block explorer for the shaft
   (ADDR.intake in pit.mjs) by hash. If the other head is NEWER than the walk's head, the walk missed shaft rows: do not
   clear; send everything to Forge and Sage (a payout may already be on chain).
5. Clear only when every rep agrees on the same head and that head is the newest shaft block on the explorer. Then the
   next pass re-runs every gate itself; clearing the hold never skips a check.
Never edit pit-state.json, intents or pit-sends.json by hand to get past this hold.

## A representative that is down or slow (Ops review3 F5)
Each head check asks every rep the client knows (4 on SDK 0.18.7). The SDK retries an unreachable rep for about 13 s per
call before it gives up, so one rep outage makes each pass about 13 s slower per check, and then:
- at settle time, every void waits as a PAYOUT_WAIT_HISTORY hold or PAYHOLD (see above): payouts pause, nothing is sent twice;
- at a fresh LIVE start (first start, or a re-seed after a rollback, Ops F1 / Sage N-1), the runner refuses with a HALT
  ("shaft head not agreed ...; refusing to seed"). The WED box does NOT roll back over a HALT: it stops the runner, keeps
  HALT, and prints STOPPED_FOR_REVIEW. Send that output to Forge; Forge sends a reviewed recovery box once the
  rep is back (box WR refuses while HALT is there). The runner stays stopped until then; nothing is sent while stopped.
This is the intended fail-closed behavior. A rep outage pauses payouts; it never re-pays. Wait for the rep to come back and
follow the steps above before anything is cleared. Never delete HALT unless its cause is fixed.
