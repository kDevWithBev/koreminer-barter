# Koreminer KTA refund (canary route) server helpers. The boxes source this file only after checking its md5.
# Defining these functions changes nothing. Only the boxes stop, copy, run refund.mjs or start, and they say so.
# Never prints seed.txt, .env, the unit environment or /proc/*/environ. Never touches /opt/keelend.
# Uses grep -c (never grep -q) and no `! cmd`. Hold files are never created or edited here; the only file
# ever removed is the refund's own STOP ("refund in progress"), and only when the refund state is verified.
# Shared helpers (picks, efcount, procs, nodebin, timeok, stopnow, startcheck) are the Ops-reviewed
# rate-hold-lib.sh versions (0570fcef), trimmed to the old-code path.
D=/opt/koreminer; DI=/etc/systemd/system/koreminer.service.d; FC=$DI/fee.conf; CA=$DI/close-accrue.conf
S=/root/koreminer-refund-stage; BP=/root/koreminer-refund-backup; ST=/root/koreminer-refund-stoptime
NF=/root/koreminer-refund-runner-node; PV=/root/koreminer-refund-b2-preview
RUNTIME="run.mjs:7cb0524bf2bdb5503600850648f0313b pace.mjs:ab212d0b52a6e1df530b4e3caae118b5 pay.mjs:e9ed5a9eee093066cbfaa7e2e82f5ada share.mjs:4702e6f3a327abfea599c583a1bf0029 books.mjs:3180fa4fcc7729e86bb918014d7d09c5 chain.mjs:6213a1c079bccaa6e962b8a6fc269212 ledger.mjs:3cc178153ac5f8ddebd2ed28a5c039c5 base-credit.mjs:0a40a84cecf3ad5fe5572df7491b098e claim.mjs:d3b431001698bc0c8a9d091844d92002 links.mjs:8a01878324b4c29816e6d96578c23696"
NEW="refund.mjs:e359d571333711921c5ae3d5137a0b5b refund-drain.json:8b4b5de53e7ec13081a4f04da7b4f997"
KJ=$D/node_modules/@keetanetwork/keetanet-client; KFP=4ccd1d4637c00aec945a499492ed4fee
LEFT=""
fail0() { echo "$1"; echo "${X}_FAIL"; exit 1; }
md5of() { md5sum "$1" 2>/dev/null | cut -c1-32; }
vers() { local p d=${2:-$D}; for p in $1; do [ "$(md5of "$d/${p%%:*}")" = "${p#*:}" ] || { LEFT="${p%%:*} in $d is not the pinned version"; return 1; }; done; return 0; }
cnt() { printf '%s\n' "$1" | grep -cxE "$2" || true; }
envlist() { systemctl show -p Environment --value koreminer </dev/null | tr " " "\n" || true; }
efiles() { systemctl show -p EnvironmentFiles --value koreminer </dev/null | awk '{print $1}' || true; }
efcount() { local n=0 c f; for f in $(efiles); do f=${f#-}; [ -e "$f" ] || continue; [ -r "$f" ] || { n=$((n+1)); continue; }; c=$(grep -cE "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$f" || true); n=$((n + ${c:-0})); done; echo $n; }
picks() {
  local E n1 n0 nf ne
  E=$(envlist); n1=$(printf "%s\n" "$E" | grep -cx "PICKS_OFF=1" || true); n0=$(printf "%s\n" "$E" | grep -c "^PICKS_OFF=" || true)
  nf=$(grep -cx "Environment=PICKS_OFF=1" $FC 2>/dev/null || true); ne=$(efcount PICKS_OFF)
  [ "$n1 $n0 ${nf:-0} $ne" = "1 1 1 0" ] && return 0
  LEFT="PICKS_OFF=1 not confirmed (unit $n1 of $n0 lines, fee.conf ${nf:-0}, env files $ne)"; return 1
}
procs() { local r=0 q=0 p a; for p in /proc/[0-9]*; do while IFS= read -r -d "" a; do case "${a##*/}" in run.mjs) r=$((r+1)); break;; refund.mjs) q=$((q+1)); break;; esac; done 2>/dev/null < $p/cmdline || true; done; echo "$r $q"; }
# nodebin: the running runner's node (saved for later), or the saved path while the runner is stopped.
nodebin() { local mp n; mp=$(systemctl show -p MainPID --value koreminer </dev/null || true); n=""
  [ -n "$mp" ] && [ "$mp" != 0 ] && n=$(readlink -f /proc/$mp/exe 2>/dev/null || true)
  case "${n##*/}" in node*) echo "$n" > $NF; echo "$n"; return 0;; esac
  n=$(cat $NF 2>/dev/null || true); case "${n##*/}" in node*) [ -x "$n" ] && { echo "$n"; return 0; };; esac; echo none; }
# guard <live|stopped> via GM: picks off, no hold file, no refund.mjs, and 1 (live) or 0 (stopped) run.mjs.
guard() { local f r; LEFT=""
  picks || return 1
  for f in STOP HALT PAYHOLD FEEHOLD RATEHOLD payout-intent.json; do [ -e $D/$f ] && { LEFT="$f is present"; return 1; }; done
  r=$(procs); set -- $r
  [ "$2" = 0 ] || { LEFT="a refund.mjs process is alive"; return 1; }
  if [ "$GM" = live ]; then [ "$1" = 1 ] || { LEFT="$1 run.mjs processes, expected 1"; return 1; }
  else [ "$1" = 0 ] || { LEFT="$1 run.mjs process(es) alive while the runner should be stopped"; return 1; }; fi
  return 0; }
# timeok [send]: never 10 pm-5 am ET or 7-8:45 pm ET (the 00:00 UTC payout close). With "send": 5 am-5 pm ET only,
# so a paused runner is always back up long before the close.
timeok() { local h m; h=$(TZ=America/New_York date +%H); m=$(TZ=America/New_York date +%H%M)
  { [ "$h" -ge 22 ] || [ "$h" -lt 5 ]; } && fail0 "Quiet hours (10 pm to 5 am ET). Nothing changed."
  { [ "$m" -ge 1900 ] && [ "$m" -lt 2045 ]; } && fail0 "Close window (7 to 8:45 pm ET, the 8 pm payout close). Nothing changed."
  { [ "${1:-}" = send ] && [ "$h" -ge 17 ]; } && fail0 "Refund steps that pause the runner run 5 am to 5 pm ET only. Nothing changed."
  return 0; }
# orderok: the refund order rule. Last night's close shows "Close paid." and the CLOSE_ACCRUE flag is off.
orderok() { local n e
  n=$(journalctl -u koreminer --since "$(date -u +%Y-%m-%d) 00:00:00 UTC" --no-pager -o cat </dev/null | grep -cx 'Close paid\.' || true)
  [ "${n:-0}" -ge 1 ] || { LEFT="no 'Close paid.' line since 00:00 UTC today"; return 1; }
  [ -e $CA ] && { LEFT="close-accrue.conf is still there (run the CLOSE_ACCRUE flag-off box first)"; return 1; }
  e=$(envlist | grep -c '^CLOSE_ACCRUE=' || true); [ "${e:-0}" = 0 ] || { LEFT="CLOSE_ACCRUE is still set on the unit"; return 1; }
  return 0; }
# rstate: one word for the refund files (names and JSON fields only, never amounts of other files):
# EMPTY, B1_VERIFIED, B2_VERIFIED, or OPEN <reason>. Then "records <n>".
rstate() { $NODE -e '
const fs=require("fs"),R=process.argv[1]+"/refund",ex=p=>fs.existsSync(R+"/"+p);
const j=p=>{try{return JSON.parse(fs.readFileSync(R+"/"+p,"utf8"))}catch{return null}};
let recs=[];try{if(ex("wallets"))recs=fs.readdirSync(R+"/wallets").sort()}catch{recs=["?"]}
const out=w=>{console.log(w+" records "+recs.length);process.exit(0)};
if(ex("intent.json")||ex("done.json"))out("OPEN legacy-intent-or-done");
const st=b=>{if(!ex(b+"/intent.json"))return ex(b+"/done.json")||ex(b+"/verified.json")?"bad":"none";const i=j(b+"/intent.json"),d=j(b+"/done.json"),v=j(b+"/verified.json");if(!i||!Array.isArray(i.recipients))return "bad";if(!d||d.books!=="adjusted"||d.block!==i.block)return "not-finished";if(!v||v.block!==i.block)return "not-verified";return "verified"};
const keys=b=>j(b+"/intent.json").recipients.map(r=>r.key+".json");
const s1=st("b1"),s2=st("b2");
if(s1==="none"&&s2==="none")out(recs.length||ex("plan.json")?"OPEN records-or-plan-without-a-batch":"EMPTY");
if(s1!=="verified")out("OPEN batch-1-"+s1);
if(s2==="none")out(recs.join()===keys("b1").sort().join()?"B1_VERIFIED":"OPEN records-not-batch-1");
if(s2!=="verified")out("OPEN batch-2-"+s2);
out(recs.join()===[...keys("b1"),...keys("b2")].sort().join()?"B2_VERIFIED":"OPEN records-not-batches-1-2")' $D </dev/null 2>/dev/null || echo "OPEN unreadable records 0"; }
# runref <args>: run refund.mjs with the runner's node, print everything, set OUT and RC.
runref() { set +e; OUT=$(cd $D && timeout 900 $NODE refund.mjs "$@" </dev/null 2>&1); RC=$?; set -e; printf '%s\n' "$OUT"; echo "exit code: $RC"; }
# sendres: SR=sent (exit 0 + REFUND_SENT_OK + BOOKS_OK), refused (exit 2 + one REFUND_REFUSED, nothing else), else review.
sendres() { SR=review
  if [ "$RC" = 0 ] && [ "$(cnt "$OUT" 'REFUND_SENT_OK')" = 1 ] && [ "$(cnt "$OUT" 'BOOKS_OK')" = 1 ] && [ "$(cnt "$OUT" '(REFUND_(REFUSED|HOLD|NOT_LANDED|PENDING|VERIFY)|BOOKS_(MISMATCH|UNCONFIRMED)).*')" = 0 ]; then SR=sent; fi
  if [ "$RC" = 2 ] && [ "$(cnt "$OUT" 'REFUND_REFUSED: .*')" = 1 ] && [ "$(cnt "$OUT" '(REFUND_(LANDED|HOLD|NOT_LANDED|PENDING|SENT_OK)|BOOKS_).*')" = 0 ]; then SR=refused; fi
  return 0; }
# stopnow: plain start-again trap, stop, and start again if a payout began at the stop. Saves the stop time.
stopnow() {
  trap 'echo "interrupted: starting the runner again, unchanged"; systemctl start koreminer </dev/null; echo "${X}_FAIL"; exit 1' ERR HUP INT TERM
  date +%s > $ST; systemctl stop koreminer </dev/null; sleep 3
  local st; st=$(systemctl is-active koreminer </dev/null || true)
  [ "$st" = inactive ] || [ "$st" = failed ] || { trap - ERR HUP INT TERM; systemctl start koreminer </dev/null; fail0 "Runner did not stop (state $st). Started again, nothing changed. Send this to Forge."; }
  if [ -e $D/payout-intent.json ] || [ -e $D/PAYHOLD ]; then trap - ERR HUP INT TERM; systemctl start koreminer </dev/null; sleep 10; fail0 "A payout started just before the stop. Runner started again unchanged. Wait 2 minutes and run this box again."; fi
  trap - ERR HUP INT TERM; echo "runner stopped ($st)"; }
jl() { journalctl -u koreminer --since "$1 UTC" --no-pager -o cat </dev/null || true; }
nrest() { systemctl show -p NRestarts --value koreminer </dev/null || echo x; }
# startcheck: start once, wait for Runner up, 20 s warm-up, then check. Sets SC to ok or the reason.
startcheck() { local L U N0 c i; SC=""; T=$(date -u +"%Y-%m-%d %H:%M:%S"); N0=$(nrest)
  systemctl start koreminer </dev/null || true; U=0
  for i in $(seq 1 12); do sleep 5; U=$(jl "$T" | grep -c "^Runner up" || true); [ "$U" -ge 1 ] && break; done
  echo "runner started at $T UTC, Runner up lines $U"; [ "$U" -ge 1 ] || { SC="no Runner up line within 60 seconds"; return 0; }
  sleep 20; L=$(jl "$T")
  [ "$(systemctl is-active koreminer </dev/null || true)" = active ] || { SC="runner is not active"; return 0; }
  [ "$(nrest)" = "$N0" ] || { SC="runner restarted on its own"; return 0; }
  c=$(printf "%s\n" "$L" | grep -c "^Config fee cap .* Picks off\.$" || true); [ "$c" -ge 1 ] || { SC="config line does not end in Picks off."; return 0; }
  c=$(printf "%s\n" "$L" | grep -c "ALERT" || true); [ "$c" = 0 ] || { SC="$c ALERT line(s) since the start"; return 0; }
  for c in HALT PAYHOLD FEEHOLD RATEHOLD; do [ -e $D/$c ] && { SC="$c appeared"; return 0; }; done
  vers "$RUNTIME" || { SC="$LEFT"; return 0; }
  SC=ok; return 0; }
# restart: always restart after a refund pause unless something needs review (Bob, Oct 20: stay stopped only for
# a hold file, an unverified refund file or a second runner). Waits 7 minutes after the last quote or stop.
restart() { local s t w
  [ "$(systemctl is-active koreminer </dev/null || true)" = active ] && { echo "runner is already active"; return 0; }
  s=$(rstate); echo "refund state: $s"
  case "$s" in EMPTY*|B1_VERIFIED*|B2_VERIFIED*) ;; *) echo "STOPPED_FOR_REVIEW: refund state needs review ($s). Do not start the runner by hand. Send this whole output to Forge and KeeLend Ops."; return 1;; esac
  if [ -e $D/STOP ]; then
    if [ "${s%% *}" != EMPTY ] && [ "$(head -c 40 $D/STOP | tr -cd '[:print:]')" = "refund in progress" ] && [ "$(wc -c < $D/STOP)" = 19 ]; then rm -f $D/STOP; echo "removed the refund's own STOP (batches verified)"
    else echo "STOPPED_FOR_REVIEW: STOP is present and is not a verified refund's own STOP. Do not start the runner by hand. Send this to Forge."; return 1; fi
  fi
  GM=stopped; guard || { echo "STOPPED_FOR_REVIEW: $LEFT. Do not start the runner by hand. Send this whole output to Forge and KeeLend Ops."; return 1; }
  vers "$RUNTIME" || { echo "STOPPED_FOR_REVIEW: $LEFT. Send this to Forge."; return 1; }
  t=$(cat $ST 2>/dev/null || echo 0); [ "$(cnt "$t" '[0-9]+')" = 1 ] || t=0; w=$(( $(date +%s) - t ))
  [ "$w" -ge 420 ] || { echo "waiting $((420 - w)) s (7 minutes after the last stop or quote) before starting"; sleep $((420 - w)); }
  startcheck; [ "$SC" = ok ] || { echo "RUNNER_CHECK_FAILED: $SC. Do not start or stop it by hand. Send this whole output to Forge now."; return 1; }
  echo "RUNNER_STARTED: active on 7ee5308, picks off"; return 0; }
