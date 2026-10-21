# Koreminer fix/rate-hold server helpers. The STEP boxes source this file only after checking its md5.
# Defining these functions changes nothing. Only the boxes stop, copy or start, and they say so.
# Never prints seed.txt, .env, the unit environment or /proc/*/environ. Never touches /opt/keelend.
# Uses grep -c (never grep -q). A hold file is never created, edited or removed here.
D=/opt/koreminer; DI=/etc/systemd/system/koreminer.service.d; FC=$DI/fee.conf
S=/root/koreminer-rate-stage; BP=/root/koreminer-rate-backup
OLD="run.mjs:7cb0524bf2bdb5503600850648f0313b pace.mjs:ab212d0b52a6e1df530b4e3caae118b5"
REST="pay.mjs:e9ed5a9eee093066cbfaa7e2e82f5ada share.mjs:4702e6f3a327abfea599c583a1bf0029 books.mjs:3180fa4fcc7729e86bb918014d7d09c5 chain.mjs:6213a1c079bccaa6e962b8a6fc269212 ledger.mjs:3cc178153ac5f8ddebd2ed28a5c039c5 base-credit.mjs:0a40a84cecf3ad5fe5572df7491b098e claim.mjs:d3b431001698bc0c8a9d091844d92002 links.mjs:8a01878324b4c29816e6d96578c23696"
LEFT=""
fail0() { echo "$1"; echo "${X}_FAIL"; exit 1; }
md5of() { md5sum "$1" 2>/dev/null | cut -c1-32; }
# vers <list> [dir]: 0 when every name:md5 in the list matches the files in dir (default /opt/koreminer).
vers() { local p d=${2:-$D}; for p in $1; do [ "$(md5of "$d/${p%%:*}")" = "${p#*:}" ] || return 1; done; return 0; }
envlist() { systemctl show -p Environment --value koreminer </dev/null | tr " " "\n" || true; }
efiles() { systemctl show -p EnvironmentFiles --value koreminer </dev/null | awk '{print $1}' || true; }
efcount() { local n=0 c f; for f in $(efiles); do f=${f#-}; [ -e "$f" ] || continue; [ -r "$f" ] || { n=$((n+1)); continue; }; c=$(grep -cE "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$f" || true); n=$((n + ${c:-0})); done; echo $n; }
# picks <0|1>: PICKS_OFF=<v> exactly once in the unit and in fee.conf, never in an env file.
picks() {
  local E n1 n0 nf ne
  E=$(envlist); n1=$(printf "%s\n" "$E" | grep -cx "PICKS_OFF=$1" || true); n0=$(printf "%s\n" "$E" | grep -c "^PICKS_OFF=" || true)
  nf=$(grep -cx "Environment=PICKS_OFF=$1" $FC 2>/dev/null || true); ne=$(efcount PICKS_OFF)
  [ "$n1 $n0 ${nf:-0} $ne" = "1 1 1 0" ] && return 0
  echo "PICKS_OFF=$1 not confirmed (unit $n1 of $n0 lines, fee.conf ${nf:-0}, env files $ne)"; return 1
}
holds() { local h="" f; for f in STOP HALT PAYHOLD FEEHOLD RATEHOLD payout-intent.json refund/intent.json refund/done.json; do [ -e $D/$f ] && h="$h $f"; done; echo "$h"; }
# procs: "<run.mjs count> <refund.mjs count> <run.mjs pids>" from /proc/*/cmdline (argument names only).
procs() { local r=0 q=0 ids="" p a; for p in /proc/[0-9]*; do while IFS= read -r -d "" a; do case "${a##*/}" in run.mjs) r=$((r+1)); ids="$ids${ids:+,}${p##*/}"; break;; refund.mjs) q=$((q+1)); break;; esac; done 2>/dev/null < $p/cmdline || true; done; echo "$r $q ${ids:-none}"; }
nodebin() { local mp n; mp=$(systemctl show -p MainPID --value koreminer </dev/null || true); n=""; [ -n "$mp" ] && [ "$mp" != 0 ] && n=$(readlink -f /proc/$mp/exe 2>/dev/null || true); case "${n##*/}" in node*) echo "$n";; *) echo none;; esac; }
# confok: fee.conf has each ceiling line exactly once (PICKS_OFF is checked by picks), and the unit restarts
# only on failure (STOP, HALT and a clean stop exit 0; Restart=always would loop them).
unitfacts() { local k; for k in Restart RestartUSec StartLimitBurst; do printf "%s=%s " $k "$(systemctl show -p $k --value koreminer </dev/null || true)"; done; echo; }
confok() { local l c
  [ "$(systemctl show -p Restart --value koreminer </dev/null)" = on-failure ] || { LEFT="unit Restart is not on-failure"; echo "$LEFT"; return 1; }
  for l in FEE_CAP_PER_BUNDLE_KTA=0.05 MAX_BLOCKS_PER_HOUR=60 PAYOUT_FEE_CAP_KTA=0.05 PAYOUT_FEE_BUDGET_KTA_PER_DAY=0.5; do c=$(grep -cx "Environment=$l" $FC 2>/dev/null || true); [ "${c:-0}" = 1 ] || { echo "fee.conf line Environment=$l found ${c:-0} times"; return 1; }; done; return 0; }
mainpid() { systemctl show -p MainPID --value koreminer </dev/null || echo 0; }
nrest() { systemctl show -p NRestarts --value koreminer </dev/null || echo x; }
# guard <live|stopped>: picks off, no hold or refund file, and the right runner processes.
guard() {
  local h r; LEFT=""
  picks 1 >/dev/null || { LEFT="PICKS_OFF=1 cannot be confirmed (missing, duplicated, or set in an env file)"; return 1; }
  h=$(holds); [ -z "$h" ] || { LEFT="present:$h"; return 1; }
  r=$(procs); set -- $r
  [ "$2" = 0 ] || { LEFT="refund.mjs is running"; return 1; }
  if [ "$GM" = live ]; then [ "$1" = 1 ] && [ "$3" = "$(mainpid)" ] || { LEFT="run.mjs pids $3, expected exactly MainPID $(mainpid)"; return 1; }
  else [ "$1" = 0 ] || { LEFT="$1 run.mjs process(es) already alive ($3)"; return 1; }; fi
  return 0
}
# timeok: not in quiet hours (10 pm to 5 am ET) and not in the close window (7 to 8:45 pm ET, as the doc says).
timeok() {
  local h m; h=$(TZ=America/New_York date +%H); m=$(TZ=America/New_York date +%H%M)
  { [ "$h" -ge 22 ] || [ "$h" -lt 5 ]; } && fail0 "Quiet hours (10 pm to 5 am ET). Nothing changed."
  { [ "$m" -ge 1900 ] && [ "$m" -lt 2045 ]; } && fail0 "Close window (7 to 8:45 pm ET, now $(TZ=America/New_York date +%H:%M)). Nothing changed. Run it after 8:45 pm ET or tomorrow."
  return 0
}
jl() { journalctl -u koreminer --since "$1 UTC" --no-pager -o cat </dev/null || true; }
waitup() { local i u=0; for i in $(seq 1 12); do sleep 5; u=$(jl "$1" | grep -c "^Runner up" || true); [ "$u" -ge 1 ] && break; done; echo "$u"; }
claimok() { local j; j=$(curl -s -m 5 http://127.0.0.1:8791/health </dev/null 2>/dev/null || true); [ "$(printf "%s" "$j" | grep -c '"ok":true' || true)" = 1 ]; }
# health: koreminer.com/health.json counts only if updated after the start ($HS). Up to 4 reads 30 s apart (Ops I-1).
health() {
  local i J HW
  for i in 1 2 3 4; do
    J=$(curl -fsS --max-time 10 "https://koreminer.com/health.json?t=$(date +%s)" </dev/null 2>/dev/null || true)
    HW=$(printf "%s" "$J" | ${NODE:-node} -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.apps.koreminer.runner.alive===true?"alive":"notalive")+" "+(Math.floor(Date.parse(j.updated)/1000)||0))}catch{console.log("unreadable 0")}})' 2>/dev/null || echo "unreadable 0")
    set -- $HW
    if [ "$1" != unreadable ] && [ "$2" -gt "$HS" ]; then echo "$1 fresh"; return 0; fi
    [ "$i" -lt 4 ] && sleep 30
  done
  echo "${1:-unreadable} stale"
}
# status.json: print state and reason only (it holds no secrets by design). "stale" unless written at or after
# this start (T0, set by startcheck), so a file left by an earlier run never passes.
stat1() { local m; m=$(stat -c %Y $D/status.json 2>/dev/null || echo 0); [ "${m:-0}" -ge "${T0:-9999999999}" ] || { echo "stale (not written since this start)"; return 0; }; ${NODE:-node} -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(s.state+" | "+s.reason+" | blocks last hour "+s.blocksLastHour+" of "+s.limit)}catch{console.log("none")}' $D/status.json 2>/dev/null || echo none; }
# stopnow: plain start-again trap, stop, and refuse if a payout started at the stop.
stopnow() {
  trap 'echo "interrupted: starting the runner again, unchanged"; systemctl start koreminer </dev/null; echo "${X}_FAIL"; exit 1' ERR HUP INT TERM
  systemctl stop koreminer </dev/null; sleep 3
  local st; st=$(systemctl is-active koreminer </dev/null || true)
  [ "$st" = inactive ] || [ "$st" = failed ] || { trap - ERR HUP INT TERM; systemctl start koreminer </dev/null; fail0 "Runner did not stop (state $st). Started again, nothing changed. Send this to Forge."; }
  if [ -e $D/payout-intent.json ] || [ -e $D/PAYHOLD ]; then trap - ERR HUP INT TERM; systemctl start koreminer </dev/null; sleep 10; fail0 "A payout started just before the stop. Runner started again unchanged ($(systemctl is-active koreminer </dev/null || true)). Wait 2 minutes and run this box again."; fi
  echo "runner stopped ($st)"
}
# startcheck <new|old> <Picks off|Picks on> [fee]:  start once, wait for Runner up, warm-up, then check (with fee, an ALERT or FEEHOLD is left to the box). Sets SC to ok or to the reason it is not ok. Call it directly, not in $(...).
startcheck() {
  local L U N0 c; SC=""
  T=$(date -u +"%Y-%m-%d %H:%M:%S"); HS=$(date -u -d "$T UTC" +%s)  # T, HS and T0 stay set for the box
  T0=$(date +%s); systemctl start koreminer </dev/null; N0=$(nrest); U=$(waitup "$T")
  echo "runner started at $T UTC, Runner up lines $U, restart count $N0"
  [ "$U" -ge 1 ] || { SC="no Runner up line within 60 seconds"; return 0; }
  echo "warm-up 20 seconds"; sleep 20
  L=$(jl "$T")
  systemctl is-active --quiet koreminer </dev/null || { SC="runner is not active"; return 0; }
  [ "$(nrest)" = "$N0" ] || { SC="runner restarted on its own"; return 0; }
  c=$(printf "%s\n" "$L" | grep -c "^Config fee cap 0\.05000 KTA\. Payout fee cap 0\.05000 KTA\. .* $2\.$" || true); [ "$c" -ge 1 ] || { SC="config line does not show the 0.05 caps and $2."; return 0; }
  c=$(printf "%s\n" "$L" | grep -c "Hard limits 0\.05000 KTA a block, 60 ledger blocks an hour" || true)
  if [ "$1" = new ]; then [ "$c" -ge 1 ] || { SC="config line has no hard limits"; return 0; }; else [ "$c" = 0 ] || { SC="old code still prints hard limits"; return 0; }; fi
  c=$(printf "%s\n" "$L" | grep -c "^Runner up.*KORE send is armed\.$" || true); [ "$c" -ge 1 ] || { SC="Runner up line does not say KORE send is armed"; return 0; }
  c=$(printf "%s\n" "$L" | grep -c "ALERT" || true); [ "$c" = 0 ] || [ "${3:-}" = fee ] || { SC="$c ALERT line(s) since the start"; return 0; }
  for c in HALT PAYHOLD RATEHOLD $([ "${3:-}" = fee ] || echo FEEHOLD); do [ -e $D/$c ] && { SC="$c appeared"; return 0; }; done
  claimok || echo "note: claim service /health is not ok. The claim service is separate and this change does not touch it; send this to Forge."
  printf "%s\n" "$L" | grep -E "^Config fee cap|^Runner up|^Picks off|^Fee check|^SKIP|^Paused|ALERT" | cut -c1-230 | tail -n 5 || true
  SC=ok
}
# rb: STEP3 auto-rollback to 7ee5308 (set +e). Copies only when the unit really stopped and no STOP, RATEHOLD or
# FEEHOLD is present: the rate-hold version honours those files and the old code would not, so it is kept.
rb() {
  local st f; trap - ERR HUP INT TERM; set +e; echo "something failed, putting 7ee5308 back (state, books and hold files are not touched)"
  systemctl stop koreminer </dev/null; sleep 3; st=$(systemctl is-active koreminer </dev/null)
  [ "$st" = inactive ] || [ "$st" = failed ] || { echo "RUNNER_CHECK_FAILED: the runner did not stop (state $st), so nothing was put back. Do not start or stop it by hand. Send this whole output to Forge and KeeLend Ops now."; echo ${X}_FAIL; exit 1; }
  for f in STOP RATEHOLD FEEHOLD; do [ -e $D/$f ] && { echo "STOPPED_FOR_REVIEW: $f is present, so the rate-hold version was kept (it honours $f, the old code would not) and the runner was not started. Do not start it by hand. Send this whole output to Forge and KeeLend Ops now."; echo ${X}_FAIL; exit 1; }; done
  cp -p $B/run.mjs $B/pace.mjs $D/
  vers "$OLD" || { echo "STOPPED_FOR_REVIEW: run.mjs or pace.mjs is not 7ee5308 after the restore, so the runner was not started. Do not start it by hand. Send this whole output to Forge and KeeLend Ops now."; echo ${X}_FAIL; exit 1; }
  GM=stopped; guard || { echo "STOPPED_FOR_REVIEW: $LEFT. Files are back on 7ee5308 but the runner was not started. Do not start it by hand. Send this whole output to Forge and KeeLend Ops now."; echo ROLLED_BACK_TO_7EE5308; echo ${X}_FAIL; exit 1; }
  startcheck old "Picks off"; echo "runner on 7ee5308: $(systemctl is-active koreminer </dev/null), check: $SC"
  [ "$SC" = ok ] || echo "RUNNER_CHECK_FAILED: $SC. Do not start or stop it by hand. Send this whole output to Forge now."
  echo ROLLED_BACK_TO_7EE5308; echo ${X}_FAIL; exit 1
}
