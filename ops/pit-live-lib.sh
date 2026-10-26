# Koreminer pit v1 upgrade helpers v2 (Trey's Oct 26 plan): Tue Oct 27 morning, the installed TEST pit (85a63bf) gets this
# commit's code, still in TEST; Wed Oct 28 morning the same code switches TEST -> LIVE, pitDay1 2026-10-29, SEND still off.
# Boxes TUE, TR, WED and WR source this file only after checking its md5, with C (this commit) and LM (this file's md5) set.
# Defining these functions changes nothing. Reuses the Ops-reviewed refund-lib.sh and, after stage, this commit's pit-lib.sh.
# Never prints seed.txt, .env, the unit environment or /proc/*/environ. Never touches /opt/keelend or nginx.
# Never creates, edits or removes HALT, PAYHOLD or STOP. SEND stays off: arming it is a later, separate box.
RL=/root/koreminer-refund-stage/refund-lib.sh
[ "$(md5sum < $RL 2>/dev/null | cut -c1-32)" = 75dd45a226d73808c7674ff64caa7ada ] || { echo "Refund helper missing or changed. Nothing changed."; echo "${X}_FAIL"; exit 1; }
. $RL
LS=/root/koreminer-pit-up-stage; LP=$LS.part; U=https://raw.githubusercontent.com/kDevWithBev/koreminer-barter/${C:-none}
PL=fd5f2fcb7cfa63188e60176e0640fba4
F="ops/pit-lib.sh:$PL run.mjs:a4d4c2f0495307205c04d6f8feae04d2 chain.mjs:37972d0a752122c200efa3a450335911 pit.mjs:0279f83880035455843b90f832171e87 pit-run.mjs:a9158da3453c38ff7fbee39687190bc1 ladder.mjs:85da517098a7444dfc73401ce9369a96 fixtures/streak-snapshot-20261026T003137Z.json:47a2d78b84ab72c80bb4f21d763adff1 ops/pit-config.test-tuesday.json:020642ae76945d4eb83ef56ccf2b94f3 ops/pit-init.test-tuesday:a4e8b9816666ac49a127fbfbf59fd7eb ops/pit-config.live-wednesday.json:78d7621ec597883446f801e971eead12 ops/pit-init.live-wednesday:b145e85981a0cbdc376c28d2409ec3c8 sdk-contract.mjs:ebeded36312f9c4abcfd865ad470c987 ops/pit-preflight.mjs:d81da0c619cc6087c482ba9d6e1f575f"
OLDPIT="run.mjs:a4d4c2f0495307205c04d6f8feae04d2 chain.mjs:1510fedee83ff403323c07573340c42f pit.mjs:0279f83880035455843b90f832171e87 pit-run.mjs:308cce651cdddc2cde69146ae58e4569 ladder.mjs:85da517098a7444dfc73401ce9369a96 fixtures/streak-snapshot-20261026T003137Z.json:47a2d78b84ab72c80bb4f21d763adff1"
TCFG="pit-config.json:020642ae76945d4eb83ef56ccf2b94f3"
LCFGS="ops/pit-config.live-wednesday.json:78d7621ec597883446f801e971eead12 ops/pit-init.live-wednesday:b145e85981a0cbdc376c28d2409ec3c8"
LCFGD="pit-config.json:78d7621ec597883446f801e971eead12"; LINIT="pit-init:b145e85981a0cbdc376c28d2409ec3c8"
LST="pit-state.json pit-state.json.bak pit-sends.json pit-alerts.log pit-days.csv pit-burns.csv pit-lookup.json pit-ladder.json pit-init.used"
WEB="lookup.json barter/ladder.json"
c() { grep -c "$@" || true; }
# bad: count stop lines on stdin: HALT, a hold, Retry, or a runner ALERT. Not the legacy fee back-off line ("ALERT Fee ... Backing
# off.", seen before) and not the pit's own ALERT_* alert-log lines (modeled TEST-close alerts), per Ops review3 section 6.
bad() { grep -v "^ALERT Fee [0-9.]* KTA is over the [0-9.]* KTA cap\. Backing off\.$" | c "^\(TEST \)\?\(HALT\|KORE sends wait\)\.\|^ALERT \|Retry\." ; }
# sok <dir>: the 14 files of this commit with their md5s (this helper against LM), and nothing else but PREFLIGHT_OK.
sok() { local p; [ "$(md5sum < $1/ops/pit-live-lib.sh 2>/dev/null | cut -c1-32)" = "${LM:-x}" ] || return 1
  for p in $F; do [ "$(md5sum < $1/${p%%:*} 2>/dev/null | cut -c1-32)" = "${p#*:}" ] || return 1; done; [ "$(find $1 -type f ! -name PREFLIGHT_OK | wc -l)" = 14 ]; }
# pf <dir>: the read-only preflight (no seed, no signer, no sends, temp folder only) on this node and SDK. Sets R.
pf() { local O; O=$(cd /tmp && env -i PATH=/usr/bin:/bin timeout 280 $NODE $1/ops/pit-preflight.mjs $1 $D 2>&1 || true); printf "%s\n" "$O" | tail -7 | cut -c1-300
  R=$(printf "%s\n" "$O" | tail -1); printf "%s\n" "$R" | grep -Eqx "PREFLIGHT_OK pass_ms=[0-9]+"; }
# stage: download this commit to LP, check md5s, parse, preflight, then mv LP to LS. A good LS is reused (preflight again).
# Only ever writes LP and LS. Sets LEFT on failure.
stage() { local p f; NODE=$(nodebin); [ "$NODE" != none ] || { LEFT="no runner node path"; return 1; }
  if [ -e $LS ]; then sok $LS || { LEFT="$LS is there but not this stage"; return 1; }
    pf $LS || { LEFT="preflight failed (above)"; return 1; }; printf "%s\n" "$R" > $LS/PREFLIGHT_OK; echo "stage: $LS reused, $R"; return 0; fi
  rm -rf $LP; mkdir -m700 $LP
  for p in ops/pit-live-lib.sh:x $F; do f=${p%%:*}; mkdir -p $LP/$(dirname $f)
    curl -fsSL --max-time 30 "$U/$f" -o $LP/$f </dev/null || { LEFT="download of $f failed (is ${C:0:7} pushed?)"; rm -rf $LP; return 1; }; done
  sok $LP || { LEFT="a staged file did not come out right"; rm -rf $LP; return 1; }
  for f in run.mjs chain.mjs pit.mjs pit-run.mjs ladder.mjs sdk-contract.mjs ops/pit-preflight.mjs; do $NODE --check $LP/$f || { LEFT="$f does not parse"; rm -rf $LP; return 1; }; done
  bash -n $LP/ops/pit-lib.sh && bash -n $LP/ops/pit-live-lib.sh || { LEFT="a helper does not parse"; rm -rf $LP; return 1; }
  pf $LP || { LEFT="preflight failed (above)"; rm -rf $LP; return 1; }
  printf "%s\n" "$R" > $LP/PREFLIGHT_OK; mv $LP $LS; echo "stage: $LS (14 files, md5s match, code parses, $R)"; return 0; }
# load: source this commit's pit-lib.sh from the stage (md5-checked), then point G at the stage.
load() { [ "$(md5sum < $LS/ops/pit-lib.sh 2>/dev/null | cut -c1-32)" = $PL ] || { echo "Staged pit helper changed. Nothing changed."; echo "${X}_FAIL"; exit 1; }
  . $LS/ops/pit-lib.sh; G=$LS; }
# tback <B>: what TUE changes: chain.mjs, pit-run.mjs, the TEST config, SEND if any, and a full copy of pit-test/.
tback() { local b=$1; mkdir -m700 -p $b; cp -p $D/chain.mjs $D/pit-run.mjs $D/pit-config.json $b/; [ -e $D/SEND ] && cp -p $D/SEND $b/SEND
  cp -a $PT $b/pit-test; echo "send $(sendst) tue" > $b/README; return 0; }
# tin: the two new code files in by temp + mv. The TEST config, pit-test/ and SEND (absent) are not touched.
tin() { local f; for f in chain.mjs pit-run.mjs; do cp $G/$f $D/$f.new && chown --reference=$D/books.mjs $D/$f.new && chmod 644 $D/$f.new && mv -f $D/$f.new $D/$f || { LEFT="copy of $f failed"; return 1; }; done
  vers "$PIT $TCFG" || return 1; [ "$(sendst)" = absent ] || { LEFT="SEND is there"; return 1; }; return 0; }
# tout <B>: back to 85a63bf TEST: pit-test/ as it was at the backup (the new code's copy moves to B/pit-test-new), old code.
tout() { local b=$1 f; [ -d $b/pit-test ] || { LEFT="no pit-test copy in $b"; return 1; }
  if [ -e $PT ]; then rm -rf $b/pit-test-new; mv $PT $b/pit-test-new; fi; cp -a $b/pit-test $PT
  for f in chain.mjs pit-run.mjs; do cpin $b/$f $D/$f -p; done; [ -e $b/SEND ] && cpin $b/SEND $D/SEND -p
  vers "$OLDPIT $TCFG" || return 1; [ "$(n $D/*.new)" = 0 ] || { LEFT="a .new file is still there"; return 1; }; return 0; }
# upback <B>: what WED changes: the TEST config, SEND if any, the two public files.
upback() { local b=$1 f; mkdir -m700 -p $b/web; cp -p $D/pit-config.json $b/; [ -e $D/SEND ] && cp -p $D/SEND $b/SEND
  for f in $WEB; do if [ -e $W/$f ]; then cp -p $W/$f $b/web/${f##*/}; else touch $b/web/no-${f##*/}; fi; done
  echo "send $(sendst) wed" > $b/README; return 0; }
# win: the LIVE config and the LIVE pit-init in, by temp + mv. Code is already this commit. Runner must be stopped.
win() { local f p; rm -f $D/SEND
  for f in ops/pit-config.live-wednesday.json:pit-config.json ops/pit-init.live-wednesday:pit-init; do
    p=$D/${f#*:}; cp $G/${f%%:*} $p.new && chown --reference=$D/books.mjs $p.new && chmod 644 $p.new && mv -f $p.new $p || { LEFT="copy of ${f#*:} failed"; return 1; }; done
  vers "$PIT $LCFGD $LINIT" || return 1; [ "$(sendst)" = absent ] || { LEFT="SEND still there"; return 1; }; return 0; }
# wout <B>: back to TEST on the same code: live state files to B/live-state, TEST config, SEND and the public files back.
wout() { local b=$1 f; mkdir -m700 -p $b/live-state; rm -f $D/pit-init
  for f in $LST; do [ -e $D/$f ] && mv -f $D/$f $b/live-state/; done; for f in $D/pit-*.tmp; do [ -e $f ] && mv -f $f $b/live-state/; done
  cpin $b/pit-config.json $D/pit-config.json -p; [ -e $b/SEND ] && cpin $b/SEND $D/SEND -p
  for f in $WEB; do if [ -e $b/web/${f##*/} ]; then cpin $b/web/${f##*/} $W/$f -p; elif [ -e $b/web/no-${f##*/} ]; then rm -f $W/$f; fi; done
  vers "$PIT $TCFG" || return 1
  [ "$(n $D/pit-init $D/pit-state.json $D/*.new $W/*.new $W/barter/*.new)" = 0 ] || { LEFT="pit-init, a live pit-state.json or a .new file still there"; return 1; }; return 0; }
# ustart <test|live> <md5 list>: 7 min after the stop, start once, wait for the pit start line, then for a first pass after
# the start (pit-lookup.json rewritten) as the warm-up (up to 180 s), 20 s more, then check. Any Retry line fails it at
# once. A LIVE start must log one seeded line for 2026-10-29 and no TEST line; a TEST start keeps its state (no seeded line).
# Sets PS to ok or the reason.
ustart() { local m=$1 v=$2 t w i u L f s; PS=""; t=$(cat $ST 2>/dev/null || echo 0); [ "$(cnt "$t" '[0-9]+')" = 1 ] || t=0; w=$(( $(date +%s) - t ))
  if [ $m = live ]; then f=$D/pit-lookup.json; u="^Pit runner up\. .*Pit day 1 2026-10-29\. KORE send is off\.$"; s="^Pit state seeded from the ladder snapshot\. Start 2026-10-29T00:00:00.000Z\. pit-init consumed\.$"
  else f=$PT/pit-lookup.json; u="^TEST Pit runner up\. .*Pit day 1 2026-10-27\. TEST MODE: nothing is published\.$"; s="seeded"; fi
  [ "$w" -ge 420 ] || { echo "waiting $((420 - w)) s (7 minutes after the stop) before starting"; sleep $((420 - w)); }
  T=$(date -u +"%Y-%m-%d %H:%M:%S"); t=$(date +%s); N0=$(nrest); systemctl start koreminer </dev/null || true; U=0
  for i in $(seq 1 18); do sleep 5; U=$(jl "$T" | c "$u"); [ "$U" -ge 1 ] && break; done
  echo "runner started at $T UTC, $m pit start lines $U"; [ "$U" = 1 ] || { PS="no $m pit start line within 90 seconds"; return 0; }
  for i in $(seq 1 36); do [ "$(stat -c %Y $f 2>/dev/null || echo 0)" -ge $t ] && break; [ "$(jl "$T" | c "Retry\.")" = 0 ] || break; sleep 5; done
  L=$(jl "$T"); [ "$(printf "%s\n" "$L" | c "Retry\.")" = 0 ] || { printf "%s\n" "$L" | grep "Retry\." | head -2 | cut -c1-200; PS="Retry line before the first pass"; return 0; }
  [ "$(stat -c %Y $f 2>/dev/null || echo 0)" -ge $t ] || { PS="no first pass ($f) within 180 seconds"; return 0; }
  sleep 20; L=$(jl "$T")
  [ "$(systemctl is-active koreminer </dev/null || true)" = active ] || { PS="runner is not active"; return 0; }
  [ "$(nrest)" = "$N0" ] || { PS="runner restarted on its own"; return 0; }
  [ "$(procs)" = "1 0" ] || { PS="run.mjs/refund.mjs processes $(procs), expected 1 0"; return 0; }
  [ "$(holds)" = 0 ] || { PS="HALT or PAYHOLD appeared"; return 0; }
  [ "$(printf "%s\n" "$L" | bad)" = 0 ] || { PS="HALT, hold, ALERT or Retry line since the start"; return 0; }
  if [ $m = live ]; then [ "$(printf "%s\n" "$L" | c "^TEST ")" = 0 ] || { PS="TEST line in LIVE mode"; return 0; }
    [ "$(printf "%s\n" "$L" | c "$s")" = 1 ] || { PS="no live pit seeded line"; return 0; }
    [ "$(n $D/pit-init $D/pit-init.used $D/pit-state.json)" = 2 ] && [ ! -e $D/pit-init ] || { PS="pit-init not consumed or no pit-state.json"; return 0; }
  else [ "$(printf "%s\n" "$L" | c "$s")" = 0 ] && [ -e $PT/pit-state.json ] || { PS="TEST pit seeded again or no pit-test state"; return 0; }; fi
  [ "$(sendst)" = absent ] || { PS="SEND is back"; return 0; }; vers "$v" || { PS="$LEFT"; return 0; }; PS=ok; return 0; }
# rbstop: stop for a rollback (if running) and check no runner is left. Sets LEFT.
rbstop() { case "$(systemctl is-active koreminer </dev/null || true)" in inactive|failed) ;; *) systemctl stop koreminer </dev/null; date +%s > $ST; sleep 3;; esac
  [ "$(procs)" = "0 0" ] || { LEFT="a runner is still alive ($(procs))"; return 1; }; return 0; }
