#!/usr/bin/env bash
# Create an OpenShell provider holding a Claude setup-token, for agent groups on
# OpenShell credentials (NANOCLAW_OPENSHELL_CREDENTIALS). Run it yourself in a
# terminal: the token is read hidden from the keyboard and goes straight to
# OpenShell, never onto a command line, into shell history, or to a coding agent.
#
#   bash scripts/openshell-claude-provider.sh [provider-name]   # default: lab-claude
set -euo pipefail

name="${1:-lab-claude}"
root="$(cd "$(dirname "$0")/.." && pwd)"
profile="$root/docs/openshell/nanoclaw-claude.yaml"

[ -t 0 ] || { echo "Run this in an interactive terminal (it reads the token from the keyboard)." >&2; exit 1; }
openshell profile lint -f "$profile" >/dev/null
openshell profile get nanoclaw-claude >/dev/null 2>&1 || openshell profile import -f "$profile"
if openshell provider get "$name" >/dev/null 2>&1; then
  echo "A provider named $name already exists. Delete it first: openshell provider delete $name" >&2
  exit 1
fi

printf 'Paste the Claude setup-token (sk-ant-oat..., input hidden), then press Enter: '
IFS= read -rs CLAUDE_CODE_OAUTH_TOKEN
echo
case "$CLAUDE_CODE_OAUTH_TOKEN" in
  sk-ant-oat*) ;;
  *) unset CLAUDE_CODE_OAUTH_TOKEN; echo "That doesn't look like a setup-token (sk-ant-oat...). Nothing created." >&2; exit 1 ;;
esac
export CLAUDE_CODE_OAUTH_TOKEN
openshell provider create --name "$name" --type nanoclaw-claude --credential CLAUDE_CODE_OAUTH_TOKEN
unset CLAUDE_CODE_OAUTH_TOKEN
echo "Provider $name created. Next: NANOCLAW_OPENSHELL_CREDENTIALS=<group-id>:$name in .env, then restart."
