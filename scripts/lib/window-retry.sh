# shellcheck shell=bash
#
# Retry for the "Close … window" steps in .github/workflows/ (#1441, PR #1462).
#
# Some deploy jobs open a "firewall window": a temporary rule in Azure that
# lets this runner reach a storage account or a Function App. An always() step
# closes it afterwards. That close step must not give up on the first error,
# because two errors are expected now and then:
#
# - 409 Conflict. When a step is stopped by its time limit in the middle of an
#   `az` update, Azure keeps working on the request it already received.
#   Resource Manager lets only one update to a resource run at a time and
#   answers the next one with 409 until the first is done, so the close step's
#   first update can be refused for a short while. Storage names this error
#   StorageAccountOperationInProgress.
#   https://learn.microsoft.com/azure/azure-resource-manager/management/overview#resolve-concurrent-operations
#   https://learn.microsoft.com/rest/api/storagerp/srp_error_codes_update_storage_account
# - A read that fails once (a network blip, a throttled call).
#
# GitHub runs a `run:` step with `bash -e`, which stops the step at the first
# failing command, so one refused update or one failed read would skip the
# removal below it and leave the window open. A close step therefore turns
# `-e` off, sources this file, and runs each Azure call through window_retry.
# https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
#
# Sourced, not run: `. scripts/lib/window-retry.sh`. scripts/ci-workflow-steps.test.mjs
# runs every close step against a stand-in `az` to hold this behaviour.

# window_retry "<pauses in seconds>" <command> [args...]
#
# Runs the command. If it fails, waits the first pause and runs it again, then
# the second pause, and so on: one try more than there are pauses. Returns 0 on
# the first success, or the last exit code once the pauses are used up. The
# command's own output is passed through untouched (so `x=$(window_retry ...)`
# captures only what the command printed); the retry messages go to stderr.
window_retry() {
  local pauses=$1 attempt=1 status pause
  shift
  local tries=$(($(wc -w <<<"$pauses") + 1))
  for pause in $pauses ''; do
    "$@" && return 0
    status=$?
    if [ -z "$pause" ]; then
      echo "::warning::'$1' failed ${tries} times (last exit code ${status}); giving up on it" >&2
      return "$status"
    fi
    echo "'$1' failed (exit code ${status}) on try ${attempt} of ${tries}; trying again in ${pause} s" >&2
    attempt=$((attempt + 1))
    sleep "$pause"
  done
}
