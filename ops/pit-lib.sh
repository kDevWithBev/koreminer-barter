# Koreminer pit v1 install helpers (TEST mode). The pit boxes source this file only after checking its md5.
# Defining these functions changes nothing. Only boxes 3 and R3 stop, copy or start, and they say so.
# Reuses the Ops-reviewed refund-lib.sh (75dd45a2): procs, nodebin, timeok, stopnow, guard, rstate, restart, jl, nrest.
# Never prints seed.txt, .env, the unit environment or /proc/*/environ. Never touches /opt/keelend or nginx.
# Never creates, edits or removes HALT, PAYHOLD or STOP. SEND is only moved to the backup and put back.
RL=/root/koreminer-refund-stage/refund-lib.sh
[ "$(md5sum < $RL 2>/dev/null | cut -c1-32)" = 75dd45a226d73808c7674ff64caa7ada ] || { echo "Refund helper missing or changed. Nothing changed."; echo "${X}_FAIL"; exit 1; }
. $RL
G=/root/koreminer-pit-stage; W=/var/www/koreminer; PT=$D/pit-test; TS="EXIT HUP INT TERM"
PIT="run.mjs:a4d4c2f0495307205c04d6f8feae04d2 chain.mjs:1510fedee83ff403323c07573340c42f pit.mjs:0279f83880035455843b90f832171e87 pit-run.mjs:308cce651cdddc2cde69146ae58e4569 ladder.mjs:85da517098a7444dfc73401ce9369a96 fixtures/streak-snapshot-20261026T003137Z.json:47a2d78b84ab72c80bb4f21d763adff1"
CARD="site/card.js:6ff807ea0aa873b87506405c95fed2de"
CFGS="ops/pit-config.test-tuesday.json:020642ae76945d4eb83ef56ccf2b94f3 ops/pit-init.test-tuesday:a4e8b9816666ac49a127fbfbf59fd7eb"
CFGD="pit-config.json:020642ae76945d4eb83ef56ccf2b94f3"; INIT="pit-init:a4e8b9816666ac49a127fbfbf59fd7eb"
OLDF="run.mjs:7cb0524bf2bdb5503600850648f0313b chain.mjs:6213a1c079bccaa6e962b8a6fc269212"
ADD="pit.mjs pit-run.mjs ladder.mjs fixtures/streak-snapshot-20261026T003137Z.json"
c() { grep -c "$@" || true; }
n() { ls -d "$@" 2>/dev/null | wc -l || true; }
holds() { n $D/HALT $D/PAYHOLD $PT/HALT $PT/PAYHOLD; }
sendst() { [ -e $D/SEND ] || { echo absent; return 0; }; [ "$(head -c 8 $D/SEND | tr -d " \n\r")" = on ] && echo on || echo other; }
# pitback <B>: copy what box 3 changes into B (run.mjs, chain.mjs, SEND, card.js). Never the seed, .env or state files.
pitback() { local b=$1; mkdir -m700 -p $b; cp -p $D/run.mjs $D/chain.mjs $b/; [ -e $D/SEND ] && cp -p $D/SEND $b/SEND
  [ -e $W/card.js ] && cp -p $W/card.js $b/card.js; [ -d $D/fixtures ] || touch $b/made-fixtures
  echo "send $(sendst)" > $b/README; return 0; }
# pitin <B>: SEND off, pit files and the TEST config in. Runner must be stopped.
pitin() { local b=$1 p f; rm -f $D/SEND; mkdir -p $D/fixtures; chown --reference=$D/books.mjs $D/fixtures
  for p in $PIT; do f=${p%%:*}; cp $G/$f $D/$f; chown --reference=$D/books.mjs $D/$f; chmod 644 $D/$f; done
  cp $G/ops/pit-config.test-tuesday.json $D/pit-config.json; cp $G/ops/pit-init.test-tuesday $D/pit-init
  chown --reference=$D/books.mjs $D/pit-config.json $D/pit-init; chmod 644 $D/pit-config.json $D/pit-init
  vers "$PIT $CFGD $INIT" || return 1; [ "$(sendst)" = absent ] || { LEFT="SEND still there"; return 1; }; return 0; }
# pitout <B>: back to 7ee5308: pit-config.json and an unused pit-init out, the added code out, old files and SEND back.
pitout() { local b=$1 f; rm -f $D/pit-config.json $D/pit-init; for f in $ADD; do rm -f $D/$f; done
  [ -e $b/made-fixtures ] && { rmdir $D/fixtures 2>/dev/null || true; }; cp -p $b/run.mjs $b/chain.mjs $D/
  [ -e $b/SEND ] && cp -p $b/SEND $D/SEND; vers "$RUNTIME" || return 1
  [ "$(n $D/pit-config.json $D/pit-init)" = 0 ] || { LEFT="pit-config.json or pit-init still there"; return 1; }; return 0; }
# pitprobe: load the new code with no env and check the installed config. Prints "probe test 2026-10-27 2026-10-26".
pitprobe() { (cd /tmp && env -i PATH=/usr/bin:/bin timeout 60 $NODE --input-type=module -e "await import(\"$D/run.mjs\");const p=await import(\"$D/pit-run.mjs\");const c=p.readConfig(\"$D\");console.log(\"probe\",c.test?\"test\":\"live\",c.pitDay1,c.ladderLast)" 2>&1 || true); }
# pitstart: 7 min after the stop, start once, wait for the TEST pit start line, then the first pass (pit-lookup.json)
# as the warm-up (up to 180 s: box 2b's preflight pass must be 60 s or less), 20 s more, then check. Any TEST Retry line
# fails it at once. Sets PS to ok or the reason.
pitstart() { local t w i U L; PS=""; t=$(cat $ST 2>/dev/null || echo 0); [ "$(cnt "$t" '[0-9]+')" = 1 ] || t=0; w=$(( $(date +%s) - t ))
  [ "$w" -ge 420 ] || { echo "waiting $((420 - w)) s (7 minutes after the stop) before starting"; sleep $((420 - w)); }
  T=$(date -u +"%Y-%m-%d %H:%M:%S"); N0=$(nrest); systemctl start koreminer </dev/null || true; U=0
  for i in $(seq 1 18); do sleep 5; U=$(jl "$T" | c "^TEST Pit runner up\. .*TEST MODE: nothing is published\.$"); [ "$U" -ge 1 ] && break; done
  echo "runner started at $T UTC, pit start lines $U"; [ "$U" = 1 ] || { PS="no TEST pit start line within 90 seconds"; return 0; }
  for i in $(seq 1 36); do [ -e $PT/pit-lookup.json ] && break; [ "$(jl "$T" | c "^TEST Retry\.")" = 0 ] || break; sleep 5; done
  L=$(jl "$T"); [ "$(printf "%s\n" "$L" | c "^TEST Retry\.")" = 0 ] || { printf "%s\n" "$L" | grep "^TEST Retry\." | head -2; PS="TEST Retry line before the first pass"; return 0; }
  [ -e $PT/pit-lookup.json ] || { PS="no first pass (pit-test/pit-lookup.json) within 180 seconds"; return 0; }
  sleep 20; L=$(jl "$T")
  [ "$(systemctl is-active koreminer </dev/null || true)" = active ] || { PS="runner is not active"; return 0; }
  [ "$(nrest)" = "$N0" ] || { PS="runner restarted on its own"; return 0; }
  [ "$(procs)" = "1 0" ] || { PS="run.mjs/refund.mjs processes $(procs), expected 1 0"; return 0; }
  [ "$(holds)" = 0 ] || { PS="HALT or PAYHOLD appeared"; return 0; }
  [ "$(printf "%s\n" "$L" | c "HALT\|KORE sends wait\|ALERT")" = 0 ] || { PS="HALT, hold or ALERT line since the start"; return 0; }
  [ "$(printf "%s\n" "$L" | c "^TEST Pit state seeded from the ladder snapshot\. Start 2026-10-27T00:00:00.000Z\. pit-init consumed\.$")" = 1 ] || { PS="no pit seeded line"; return 0; }
  [ "$(n $D/pit-init $PT/pit-init.used $PT/pit-state.json)" = 2 ] && [ ! -e $D/pit-init ] || { PS="pit-init not consumed or no pit-state.json"; return 0; }
  [ "$(sendst)" = absent ] || { PS="SEND is back"; return 0; }; vers "$PIT $CFGD" || { PS="$LEFT"; return 0; }
  [ "$(printf "%s\n" "$L" | c "^TEST Retry\.")" = 0 ] || { PS="TEST Retry line since the start"; return 0; }; PS=ok; return 0; }
