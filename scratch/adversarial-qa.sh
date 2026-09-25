#!/usr/bin/env bash
# Adversarial QA pass against a running server.
#
#   PORT=3999 bash scratch/adversarial-qa.sh
#
# Every case asserts an expected status. Prints PASS/FAIL per case and a
# summary. Never prints a credential value.
set -u
cd "$(dirname "$0")/.." || exit 1

B="http://127.0.0.1:${PORT:-3999}"
PASS=0; FAIL=0; SKIP=0
declare -a FAILURES=()

hdr() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# expect <label> <expected-codes,csv> <actual>
expect() {
  local label="$1" want="$2" got="$3"
  if [[ ",$want," == *",$got,"* ]]; then
    PASS=$((PASS+1)); printf '  PASS  %-56s %s\n' "$label" "$got"
  else
    FAIL=$((FAIL+1)); FAILURES+=("$label (want $want, got $got)")
    printf '  \033[31mFAIL\033[0m  %-56s %s (want %s)\n' "$label" "$got" "$want"
  fi
}

code() { curl -s -m 12 -o /dev/null -w '%{http_code}' "$@"; }

login() {
  curl -s -m 20 -X POST -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" "$B/api/v1/auth/login" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).token||'')}catch(e){console.log('')}})"
}

SVC=$(grep '^API_KEY=' .env | cut -d= -f2)
SUPER=$(login "${QA_SUPER_EMAIL:-admin.win@ticketx.local}" "${QA_SUPER_PASS:?set QA_SUPER_PASS}")
SCOPED=$(login "${QA_SCOPED_EMAIL:-admin.good@ticketx.local}" "${QA_SCOPED_PASS:?set QA_SCOPED_PASS}")

[ -z "$SUPER" ] && { echo "could not obtain a super_admin token; aborting"; exit 2; }
[ -z "$SCOPED" ] && { echo "could not obtain a scoped token; aborting"; exit 2; }

AUTH_S=(-H "Authorization: Bearer $SUPER")
AUTH_C=(-H "Authorization: Bearer $SCOPED")
AUTH_K=(-H "Authorization: Bearer $SVC")

# ---------------------------------------------------------------- AUTH
hdr "AUTH"
expect "anonymous API"                    401 "$(code "$B/api/admin/tickets?projectId=1")"
expect "invalid bearer"                   401 "$(code -H 'Authorization: Bearer WRONG' "$B/api/admin/tickets?projectId=1")"
expect "malformed bearer (no scheme)"     401 "$(code -H "Authorization: $SUPER" "$B/api/admin/tickets?projectId=1")"
expect "empty bearer"                     401 "$(code -H 'Authorization: Bearer ' "$B/api/admin/tickets?projectId=1")"
# An expired token: same signature algorithm, exp in the past.
EXPIRED=$(node -e '
const {createHmac}=require("crypto");
const s=process.env.SS, b64=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
const h=b64({alg:"HS256",typ:"JWT"});
const p=b64({kind:"operator",subject:"10",role:"super_admin",orgId:null,projectIds:null,
             iat:Math.floor(Date.now()/1000)-7200,exp:Math.floor(Date.now()/1000)-3600,jti:"x"});
console.log(`${h}.${p}.`+createHmac("sha256",s).update(`${h}.${p}`).digest("base64url"));
' 2>/dev/null) SS=$(grep '^SESSION_SECRET=' .env | cut -d= -f2)
EXPIRED=$(SS=$(grep '^SESSION_SECRET=' .env | cut -d= -f2) node -e '
const {createHmac}=require("crypto");
const s=process.env.SS, b64=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
const h=b64({alg:"HS256",typ:"JWT"});
const p=b64({kind:"operator",subject:"10",role:"super_admin",orgId:null,projectIds:null,
             iat:Math.floor(Date.now()/1000)-7200,exp:Math.floor(Date.now()/1000)-3600,jti:"x"});
console.log(`${h}.${p}.`+createHmac("sha256",s).update(`${h}.${p}`).digest("base64url"));
')
expect "expired bearer"                   401 "$(code -H "Authorization: Bearer $EXPIRED" "$B/api/admin/tickets?projectId=1")"
expect "valid admin"                      200 "$(code "${AUTH_S[@]}" "$B/api/admin/tickets?projectId=1")"
expect "valid service credential"         200 "$(code "${AUTH_K[@]}" "$B/traces")"
# Privilege escalation: edit the payload to claim super_admin, keep the sig.
FORGED=$(node -e '
const t=process.argv[1].split(".");
const p=JSON.parse(Buffer.from(t[1],"base64url").toString());
p.role="super_admin";p.orgId=null;p.projectIds=null;
console.log(t[0]+"."+Buffer.from(JSON.stringify(p)).toString("base64url")+"."+t[2]);
' "$SCOPED")
expect "privilege escalation via payload"  401 "$(code -H "Authorization: Bearer $FORGED" "$B/api/admin/tickets?projectId=101")"
expect "human credential on service route" 403 "$(code "${AUTH_S[@]}" -X POST -H 'Content-Type: application/json' -d '{}' "$B/api/v1/internal/tickets/promote")"

# -------------------------------------------------------------- TENANT
hdr "TENANT"
expect "project A -> project A (own)"     200 "$(code "${AUTH_C[@]}" "$B/api/admin/tickets?projectId=1")"
expect "project A -> project B (foreign)" 403 "$(code "${AUTH_C[@]}" "$B/api/admin/tickets?projectId=101")"
expect "org A -> org B conversations"     403 "$(code "${AUTH_C[@]}" "$B/api/admin/conversations?projectId=101")"
expect "projectId=all (scoped, bounded)"  200 "$(code "${AUTH_C[@]}" "$B/api/admin/tickets?projectId=all")"
expect "projectId=all (super)"            200 "$(code "${AUTH_S[@]}" "$B/api/admin/tickets?projectId=all")"
expect "missing projectId"                200 "$(code "${AUTH_C[@]}" "$B/api/admin/tickets")"
for bad in abc -1 0 null undefined '1;DROP%20TABLE' '1%20OR%201=1'; do
  expect "malformed projectId=$bad"       400 "$(code "${AUTH_C[@]}" "$B/api/admin/tickets?projectId=$bad")"
done
expect "nonexistent project (scoped)"     403 "$(code "${AUTH_C[@]}" "$B/api/admin/tickets?projectId=999999")"
expect "x-org-id header escalation"       403 "$(code "${AUTH_C[@]}" -H 'x-org-id: org_excise' "$B/api/v1/internal/projects/101/git-repositories")"
expect "x-project-id header escalation"   403 "$(code "${AUTH_C[@]}" -H 'x-project-id: 101' "$B/api/admin/tickets?projectId=101")"

hdr "TENANT — timing (unauthorized vs nonexistent must be indistinguishable)"
t_foreign=$(curl -s -m 12 -o /dev/null -w '%{time_total}' "${AUTH_C[@]}" "$B/api/admin/tickets?projectId=101")
t_absent=$(curl -s -m 12 -o /dev/null -w '%{time_total}' "${AUTH_C[@]}" "$B/api/admin/tickets?projectId=999999")
c_foreign=$(code "${AUTH_C[@]}" "$B/api/admin/tickets?projectId=101")
c_absent=$(code "${AUTH_C[@]}" "$B/api/admin/tickets?projectId=999999")
expect "same status for real-foreign vs absent" "$c_foreign" "$c_absent"
printf '  INFO  timing: foreign=%ss absent=%ss (both refused before any lookup)\n' "$t_foreign" "$t_absent"

# ------------------------------------------------------------ INTERNAL
hdr "INTERNAL API"
for ep in tickets/promote conversations/search notifications/sms conversations/takeover; do
  expect "anon    /internal/$ep"          401 "$(code "$B/api/v1/internal/$ep")"
  expect "human   /internal/$ep"          403 "$(code "${AUTH_S[@]}" "$B/api/v1/internal/$ep")"
done
expect "service /internal/conversations/search" 200,400 "$(code "${AUTH_K[@]}" "$B/api/v1/internal/conversations/search?identityId=x&projectId=1")"

# ---------------------------------------------------------- CONVERSATION
hdr "CONVERSATION INTEGRITY"
expect "ticket without conversationId"    400 "$(code "${AUTH_K[@]}" -X POST -H 'Content-Type: application/json' -d '{"subject":"qa"}' "$B/api/v1/internal/tickets")"
expect "ticket, nonexistent conversation" 404 "$(code "${AUTH_K[@]}" -X POST -H 'Content-Type: application/json' -d '{"conversationId":"99999999","subject":"qa"}' "$B/api/v1/internal/tickets")"
expect "search by identity, no project"   400 "$(code "${AUTH_K[@]}" "$B/api/v1/internal/conversations/search?identityId=Uqa")"
expect "search unknown promptx id"        200 "$(code "${AUTH_K[@]}" "$B/api/v1/internal/conversations/search?identityId=convo_nope")"

# ---------------------------------------------------------------- CORS
hdr "CORS"
expect "preflight from unlisted origin"   403 "$(code -X OPTIONS -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST' "$B/api/admin/tickets")"
expect "preflight from allowed origin"    204 "$(code -X OPTIONS -H 'Origin: http://localhost:5173' -H 'Access-Control-Request-Method: POST' "$B/api/admin/tickets")"
acao=$(curl -s -m 12 -D - -o /dev/null -H 'Origin: https://evil.example' "$B/health" | grep -ci 'access-control-allow-origin' || true)
expect "no ACAO header for evil origin"   0 "$acao"

# ------------------------------------------------------------- ERRORS
hdr "ERROR HANDLING"
body=$(curl -s -m 12 "${AUTH_S[@]}" "$B/api/admin/conversations/abc/messages?projectId=1")
if echo "$body" | grep -qiE '"code":"[0-9A-Z]{5}"|at Object\.|node_modules'; then
  FAIL=$((FAIL+1)); FAILURES+=("raw DB error or stack leaked"); printf '  \033[31mFAIL\033[0m  raw DB error or stack leaked\n'
else
  PASS=$((PASS+1)); printf '  PASS  %-56s\n' "no pg code / stack in error body"
fi

# ------------------------------------------------------------ SUMMARY
hdr "SUMMARY"
printf '  PASS=%s  FAIL=%s  SKIP=%s\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -gt 0 ]; then
  printf '\n  Failures:\n'
  printf '   - %s\n' "${FAILURES[@]}"
  exit 1
fi
exit 0
