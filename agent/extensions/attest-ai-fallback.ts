/**
 * attest-ai Gateway Fallback
 *
 * The `attest-ai` provider is a LiteLLM gateway on localhost that proxies to
 * OpenRouter, so its catalog ids are just OpenRouter ids with a `openrouter/`
 * route prefix (`attest-ai/openrouter/qwen/qwen3.8-flash` <-> `openrouter/qwen/qwen3.8-flash`).
 * That makes the two interchangeable whenever the gateway is down.
 *
 * Behavior:
 *   - At session start, if the active model is on the gateway and the gateway
 *     is unreachable, switch to the same model direct on OpenRouter.
 *   - Mid-session, if a request fails with a connectivity/5xx error from the
 *     gateway, confirm the gateway is down and switch, then ask the user to resend.
 *   - `/gateway [status|direct|gateway]` to inspect or switch by hand.
 *
 * Requires OpenRouter credentials (`/login openrouter` or $OPENROUTER_API_KEY).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GATEWAY_PROVIDER = "attest-ai";
const DIRECT_PROVIDER = "openrouter";

/** LiteLLM route prefix the gateway prepends to OpenRouter model ids. */
const ROUTE_PREFIX = "openrouter/";

const HEALTH_URL = process.env.ATTEST_AI_HEALTH_URL ?? "http://localhost:8080/health";
const HEALTH_TIMEOUT_MS = Number(process.env.ATTEST_AI_HEALTH_TIMEOUT_MS ?? 2000);

/**
 * Errors that mean the gateway itself failed, not the upstream model. Rate
 * limits and context-overflow errors are deliberately excluded: pi has its own
 * handling for those and switching providers would paper over them.
 */
const GATEWAY_DOWN = /\b(fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|socket hang up|network error|connection (error|refused|closed)|502|503|504|bad gateway|service unavailable|gateway time-?out)\b/i;

const directIdOf = (gatewayModelId: string) =>
	gatewayModelId.startsWith(ROUTE_PREFIX) ? gatewayModelId.slice(ROUTE_PREFIX.length) : undefined;

const gatewayIdOf = (directModelId: string) => `${ROUTE_PREFIX}${directModelId}`;

async function gatewayReachable(): Promise<boolean> {
	try {
		const response = await fetch(HEALTH_URL, {
			method: "GET",
			signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
		});
		return response.ok;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	/** Print mode has no UI to notify into; fall back to stderr so the switch is still visible. */
	function report(ctx: any, message: string, level: "info" | "warning" | "error") {
		if (ctx.hasUI) {
			ctx.ui.notify(message, level);
			return;
		}
		console.error(`[attest-ai-fallback] ${message}`);
	}

	/** Swap the active model between the gateway and direct OpenRouter. Returns a status line. */
	async function switchTo(target: "direct" | "gateway", ctx: any): Promise<string> {
		const current = ctx.model;
		if (!current) return "No active model.";

		const from = target === "direct" ? GATEWAY_PROVIDER : DIRECT_PROVIDER;
		const to = target === "direct" ? DIRECT_PROVIDER : GATEWAY_PROVIDER;

		if (current.provider === to) return `Already on ${to} (${current.id}).`;
		if (current.provider !== from) {
			return `Active model is ${current.provider}/${current.id}, not a ${from} model.`;
		}

		const targetId = target === "direct" ? directIdOf(current.id) : gatewayIdOf(current.id);
		if (!targetId) return `No ${to} equivalent for ${current.provider}/${current.id}.`;

		const model = ctx.modelRegistry.find(to, targetId);
		if (!model) return `${to} has no model ${targetId} in its catalog.`;

		if (!(await pi.setModel(model))) {
			return to === DIRECT_PROVIDER
				? "No OpenRouter API key. Run /login openrouter or set $OPENROUTER_API_KEY."
				: `No API key for ${to}.`;
		}
		return `Switched to ${to}/${targetId}.`;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.model?.provider !== GATEWAY_PROVIDER) return;
		if (await gatewayReachable()) return;

		const result = await switchTo("direct", ctx);
		report(
			ctx,
			`attest-ai gateway unreachable (${HEALTH_URL}). ${result}`,
			result.startsWith("Switched") ? "warning" : "error",
		);
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		if (message.stopReason !== "error") return;
		if (message.provider !== GATEWAY_PROVIDER && ctx.model?.provider !== GATEWAY_PROVIDER) return;
		if (!GATEWAY_DOWN.test(message.errorMessage ?? "")) return;
		// Confirm it is the gateway and not the upstream model provider having a bad minute.
		if (await gatewayReachable()) return;

		const result = await switchTo("direct", ctx);
		report(
			ctx,
			result.startsWith("Switched")
				? `attest-ai gateway is down. ${result} Resend your message.`
				: `attest-ai gateway is down. ${result}`,
			result.startsWith("Switched") ? "warning" : "error",
		);
	});

	pi.registerCommand("gateway", {
		description: "attest-ai gateway status, or switch between gateway and direct OpenRouter",
		handler: async (args: string, ctx: any) => {
			const arg = args.trim().toLowerCase();

			if (arg === "direct" || arg === "gateway") {
				const result = await switchTo(arg as "direct" | "gateway", ctx);
				report(ctx, result, result.startsWith("Switched") ? "info" : "error");
				return;
			}

			const up = await gatewayReachable();
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
			report(
				ctx,
				`Gateway ${up ? "up" : "down"} (${HEALTH_URL}) | active model: ${model}\n` +
					"/gateway direct - use OpenRouter directly | /gateway gateway - use attest-ai",
				up ? "info" : "warning",
			);
		},
	});
}
