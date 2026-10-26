# Koreminer pit v1 LIVE upgrade helpers: installed TEST pit (85a63bf) -> this commit in LIVE mode, pitDay1 2026-10-29.
# Boxes U2 and UR source this file only after checking its md5. Defining these functions changes nothing.
# Reuses pit-lib.sh (md5-checked here) and through it the Ops-reviewed refund-lib.sh.
# Never prints seed.txt, .env, the unit environment or /proc/*/environ. Never touches /opt/keelend or nginx.
# Never creates, edits or removes HALT, PAYHOLD or STOP. SEND stays off: arming it is a later, separate box.
LS=/root/koreminer-pit-live-stage
[ "$(md5sum < $LS/ops/pit-lib.sh 2>/dev/null | cut -c1-32)" = 3ccad2d67dec475fb73d09151c6be456 ] || { echo "Pit helper missing or changed. Nothing changed."; echo "${X}_FAIL"; exit 1; }
. $LS/ops/pit-lib.sh
G=$LS
OLDPIT="run.mjs:a4d4c2f0495307205c04d6f8feae04d2 chain.mjs:1510fedee83ff403323c07573340c42f pit.mjs:0279f83880035455843b90f832171e87 pit-run.mjs:308cce651cdddc2cde69146ae58e4569 ladder.mjs:85da517098a7444dfc73401ce9369a96 fixtures/streak-snapshot-20261026T003137Z.json:47a2d78b84ab72c80bb4f21d763adff1"
TCFG="pit-config.json:020642ae76945d4eb83ef56ccf2b94f3"
LCFGS="ops/pit-config.live-wednesday.json:78d7621ec597883446f801e971eead12 ops/pit-init.live-wednesday:b145e85981a0cbdc376c28d2409ec3c8"
LCFGD="pit-config.json:78d7621ec597883446f801e971eead12"; LINIT="pit-init:b145e85981a0cbdc376c28d2409ec3c8"
LST="pit-state.json pit-state.json.bak pit-sends.json pit-alerts.log pit-days.csv pit-burns.csv pit-lookup.json pit-ladder.json pit-init.used"
WEB="lookup.json barter/ladder.json"
# upback <B>: copy what the upgrade changes into B: chain.mjs, pit-run.mjs, the TEST config, SEND, the two public files.
upback() { local b=$1 f; mkdir -m700 -p $b/web; cp -p $D/chain.mjs $D/pit-run.mjs $D/pit-config.json $b/; [ -e $D/SEND ] && cp -p $D/SEND $b/SEND
  for f in $WEB; do if [ -e $W/$f ]; then cp -p $W/$f $b/web/${f##*/}; else touch $b/web/no-${f##*/}; fi; done
  echo "send $(sendst)" > $b/README; return 0; }
# upin: new code, the LIVE config and the LIVE pit-init in, each by temp + mv. SEND stays off. Runner must be stopped.
upin() { local f p; rm -f $D/SEND
  for f in chain.mjs:chain.mjs pit-run.mjs:pit-run.mjs ops/pit-config.live-wednesday.json:pit-config.json ops/pit-init.live-wednesday:pit-init; do
    p=$D/${f#*:}; cp $G/${f%%:*} $p.new; chown --reference=$D/books.mjs $p.new; chmod 644 $p.new; mv -f $p.new $p; done
  vers "$PIT $LCFGD $LINIT" || return 1; [ "$(sendst)" = absent ] || { LEFT="SEND still there"; return 1; }; return 0; }
# upout <B>: back to the TEST pit (85a63bf): live state files to B/live-state, old code, TEST config, SEND and the
# public files back. pit-test/ is never touched by the upgrade, so the TEST pit picks up where it stopped.
upout() { local b=$1 f; mkdir -m700 -p $b/live-state; rm -f $D/pit-init
  for f in $LST; do [ -e $D/$f ] && mv -f $D/$f $b/live-state/; done
  for f in chain.mjs pit-run.mjs pit-config.json; do cpin $b/$f $D/$f -p; done; [ -e $b/SEND ] && cpin $b/SEND $D/SEND -p
  for f in $WEB; do if [ -e $b/web/${f##*/} ]; then cpin $b/web/${f##*/} $W/$f -p; elif [ -e $b/web/no-${f##*/} ]; then rm -f $W/$f; fi; done
  vers "$OLDPIT $TCFG" || return 1
  [ "$(n $D/pit-init $D/pit-state.json $D/*.new $W/*.new $W/barter/*.new)" = 0 ] || { LEFT="pit-init, a live pit-state.json or a .new file still there"; return 1; }; return 0; }
# livestart: 7 min after the stop, start once, wait for the LIVE pit start line, then the first pass (pit-lookup.json in
# /opt/koreminer) as the warm-up, 20 s more, then check. Any Retry or TEST line fails it. Sets PS to ok or the reason.
livestart() { local t w i U L; PS=""; t=$(cat $ST 2>/dev/null || echo 0); [ "$(cnt "$t" '[0-9]+')" = 1 ] || t=0; w=$(( $(date +%s) - t ))
  [ "$w" -ge 420 ] || { echo "waiting $((420 - w)) s (7 minutes after the stop) before starting"; sleep $((420 - w)); }
  T=$(date -u +"%Y-%m-%d %H:%M:%S"); N0=$(nrest); systemctl start koreminer </dev/null || true; U=0
  for i in $(seq 1 18); do sleep 5; U=$(jl "$T" | c "^Pit runner up\. .*Pit day 1 2026-10-29\. KORE send is off\.$"); [ "$U" -ge 1 ] && break; done
  echo "runner started at $T UTC, live pit start lines $U"; [ "$U" = 1 ] || { PS="no LIVE pit start line within 90 seconds"; return 0; }
  for i in $(seq 1 36); do [ -e $D/pit-lookup.json ] && break; [ "$(jl "$T" | c "Retry\.")" = 0 ] || break; sleep 5; done
  L=$(jl "$T"); [ "$(printf "%s\n" "$L" | c "Retry\.")" = 0 ] || { printf "%s\n" "$L" | grep "Retry\." | head -2 | cut -c1-200; PS="Retry line before the first pass"; return 0; }
  [ -e $D/pit-lookup.json ] || { PS="no first pass (pit-lookup.json) within 180 seconds"; return 0; }
  sleep 20; L=$(jl "$T")
  [ "$(systemctl is-active koreminer </dev/null || true)" = active ] || { PS="runner is not active"; return 0; }
  [ "$(nrest)" = "$N0" ] || { PS="runner restarted on its own"; return 0; }
  [ "$(procs)" = "1 0" ] || { PS="run.mjs/refund.mjs processes $(procs), expected 1 0"; return 0; }
  [ "$(holds)" = 0 ] || { PS="HALT or PAYHOLD appeared"; return 0; }
  [ "$(printf "%s\n" "$L" | c "HALT\|KORE sends wait\|ALERT\|^TEST \|Retry\.")" = 0 ] || { PS="HALT, hold, ALERT, TEST or Retry line since the start"; return 0; }
  [ "$(printf "%s\n" "$L" | c "^Pit state seeded from the ladder snapshot\. Start 2026-10-29T00:00:00.000Z\. pit-init consumed\.$")" = 1 ] || { PS="no live pit seeded line"; return 0; }
  [ "$(n $D/pit-init $D/pit-init.used $D/pit-state.json)" = 2 ] && [ ! -e $D/pit-init ] || { PS="pit-init not consumed or no pit-state.json"; return 0; }
  [ "$(sendst)" = absent ] || { PS="SEND is back"; return 0; }; vers "$PIT $LCFGD" || { PS="$LEFT"; return 0; }; PS=ok; return 0; }
# teststart: start the TEST pit again after upout (no seeded line: its state is kept). Sets PS to ok or the reason.
teststart() { local t w i U L; PS=""; t=$(cat $ST 2>/dev/null || echo 0); [ "$(cnt "$t" '[0-9]+')" = 1 ] || t=0; w=$(( $(date +%s) - t ))
  [ "$w" -ge 420 ] || { echo "waiting $((420 - w)) s (7 minutes after the stop) before starting"; sleep $((420 - w)); }
  T=$(date -u +"%Y-%m-%d %H:%M:%S"); N0=$(nrest); systemctl start koreminer </dev/null || true; U=0
  for i in $(seq 1 18); do sleep 5; U=$(jl "$T" | c "^TEST Pit runner up\. .*TEST MODE: nothing is published\.$"); [ "$U" -ge 1 ] && break; done
  echo "runner started at $T UTC, TEST pit start lines $U"; [ "$U" = 1 ] || { PS="no TEST pit start line within 90 seconds"; return 0; }
  sleep 20; L=$(jl "$T")
  [ "$(systemctl is-active koreminer </dev/null || true)" = active ] || { PS="runner is not active"; return 0; }
  [ "$(nrest)" = "$N0" ] || { PS="runner restarted on its own"; return 0; }
  [ "$(procs)" = "1 0" ] && [ "$(holds)" = 0 ] || { PS="processes $(procs) or a HALT/PAYHOLD"; return 0; }
  [ "$(printf "%s\n" "$L" | c "HALT\|ALERT\|Retry\.\|seeded")" = 0 ] || { PS="HALT, ALERT, Retry or seeded line since the start"; return 0; }
  vers "$OLDPIT $TCFG" || { PS="$LEFT"; return 0; }; PS=ok; return 0; }
