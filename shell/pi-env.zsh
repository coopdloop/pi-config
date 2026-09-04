# pi environment — source this from ~/.zshrc:
#   source ~/.pi/shell/pi-env.zsh
#
# Two jobs:
#   1. Give pi an OpenRouter key so the attest-ai gateway is optional, without
#      copying the secret into a second file.
#   2. Only enable pi-phoenix tracing when a Phoenix collector is actually up,
#      so pi doesn't error at startup when it isn't.

# ── OpenRouter key ───────────────────────────────────────────────────────────
# Reuse the key the attest-ai gateway already uses; it stays in one place.
: "${ATTEST_AI_ENV_FILE:=$HOME/Development/attest-ai/infra/.env}"

__pi_load_openrouter_key() {
	[[ -n "$OPENROUTER_API_KEY" ]] && return 0
	[[ -r "$ATTEST_AI_ENV_FILE" ]] || return 0

	local value
	value="$(sed -n 's/^OPENROUTER_API_KEY=//p' "$ATTEST_AI_ENV_FILE" | head -1)"
	value="${value%\"}"; value="${value#\"}"
	value="${value%\'}"; value="${value#\'}"
	[[ -n "$value" ]] && export OPENROUTER_API_KEY="$value"
}
__pi_load_openrouter_key

# ── Phoenix tracing ──────────────────────────────────────────────────────────
# pi-phoenix throws an AggregateError at session start when the collector is
# unreachable. Probe it per launch instead of leaving tracing on or off for good.
# Set PI_PHOENIX_ENABLE yourself to bypass the probe.
pi() {
	local endpoint="${PHOENIX_COLLECTOR_ENDPOINT:-http://localhost:6006}"
	local hostport="${endpoint#*://}"
	hostport="${hostport%%/*}"
	local host="${hostport%%:*}"
	local port="${hostport##*:}"
	[[ "$port" == "$host" ]] && port=6006

	if [[ -z "$PI_PHOENIX_ENABLE" ]] && ! nc -z -w 1 "$host" "$port" >/dev/null 2>&1; then
		PI_PHOENIX_ENABLE=0 command pi "$@"
	else
		command pi "$@"
	fi
}
