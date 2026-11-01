#!/usr/bin/env bash
# A stand-in for `az`, used by ci-workflow-steps.test.mjs (section 3c) to run the
# workflows' firewall-window close steps without Azure. It keeps the rules in files
# under $AZ_STATE, logs every call to $AZ_STATE/calls, and fails a kind of call while
# $AZ_STATE/fail-<kind> holds a number above zero.
S="$AZ_STATE"
printf '%s\n' "$*" >> "$S/calls"
verb="$1 $2 $3 $4"
query="" ip="" rule="" scm=false
while [ $# -gt 0 ]; do
  case "$1" in
    --query) query=$2; shift ;;
    --ip-address) ip=$2; shift ;;
    --rule-name) rule=$2; shift ;;
    --scm-site) scm=$2; shift ;;
  esac
  shift
done
case "$verb" in
  "storage account show "*) case "$query" in provisioningState) kind=sa-state ;; *) kind=sa-read ;; esac ;;
  "storage account update "*) kind=sa-update ;;
  "storage account network-rule list") kind=sa-list ;;
  "storage account network-rule remove") kind=sa-remove ;;
  "functionapp config access-restriction show") kind=ar-show ;;
  "functionapp config access-restriction remove") kind=ar-remove ;;
  *) echo "the stand-in az does not know: $verb" >&2; exit 99 ;;
esac
if [ -s "$S/fail-$kind" ] && [ "$(cat "$S/fail-$kind")" -gt 0 ]; then
  echo $(( $(cat "$S/fail-$kind") - 1 )) > "$S/fail-$kind"
  echo "ERROR: (Conflict) stand-in failure for $kind" >&2
  exit 1
fi
count() { grep -cx -- "$1" "$2" || true; }
prefixed() { grep -c -- "^$1" "$2" || true; }
case "$kind" in
  sa-state) echo Succeeded ;;
  sa-read) cat "$S/sa-default" ;;
  sa-update) echo Deny > "$S/sa-default" ;;
  sa-list) count "$(sed -n "s/.*ipAddressOrRange=='\([^']*\)'.*/\1/p" <<<"$query")" "$S/sa-rules" ;;
  sa-remove) grep -vx -- "$ip" "$S/sa-rules" > "$S/tmp"; mv "$S/tmp" "$S/sa-rules" ;;
  ar-show)
    case "$query" in
      scmIpSecurityRestrictionsDefaultAction) cat "$S/scm-default" ;;
      *"scmIpSecurityRestrictions[?name=="*) count "$(sed -n "s/.*name=='\([^']*\)'.*/\1/p" <<<"$query")" "$S/scm-rules" ;;
      *"scmIpSecurityRestrictions[?starts_with"*) prefixed "$(sed -n "s/.*name, '\([^']*\)'.*/\1/p" <<<"$query")" "$S/scm-rules" ;;
      *"ipSecurityRestrictions[?name=="*) count "$(sed -n "s/.*name=='\([^']*\)'.*/\1/p" <<<"$query")" "$S/site-rules" ;;
      *"ipSecurityRestrictions[?starts_with"*) prefixed "$(sed -n "s/.*name, '\([^']*\)'.*/\1/p" <<<"$query")" "$S/site-rules" ;;
      *) echo "the stand-in az does not know the query: $query" >&2; exit 99 ;;
    esac ;;
  ar-remove)
    list="$S/site-rules"; [ "$scm" = true ] && list="$S/scm-rules"
    if ! grep -qx -- "$rule" "$list"; then echo "ERROR: No rule found with the specified criteria" >&2; exit 1; fi
    grep -vx -- "$rule" "$list" > "$S/tmp"; mv "$S/tmp" "$list" ;;
  *) echo "the stand-in az does not know: $kind" >&2; exit 99 ;;
esac
