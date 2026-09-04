/**
 * Approve Edits Extension
 *
 * Prompts for confirmation before file-modifying tools and destructive shell
 * commands run. Toggle at runtime with `/approvals on|off|status`.
 *
 * Gated:
 *   - edit, write            (always, when approvals are on)
 *   - bash                   (only destructive commands, when approvals are on)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FILE_TOOLS = new Set(["edit", "write"]);

// Paths that must never be modified, even if the user would approve.
const PROTECTED_PATTERNS: RegExp[] = [
	/(^|\/)\.env(\.|$)/i,          // .env, .env.local, .env.production
	/(^|\/)\.git\//i,              // anything inside .git/
	/(^|\/)\.ssh\//i,              // ssh keys/config
	/(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
	/(^|\/)\.aws\/(credentials|config)$/i,
	/(^|\/)\.npmrc$/i,
	/\.pem$/i,
	/(^|\/)secrets?\.(ya?ml|json|toml)$/i,
];

const isProtected = (text: string) => PROTECTED_PATTERNS.some((p) => p.test(text));

const DESTRUCTIVE_PATTERNS: RegExp[] = [
	/\brm\s+(-[a-z]*f|-[a-z]*r|--recursive|--force)/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b.*\b777\b/i,
	/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force|push\s+.*-f\b)/i,
	/\b(mkfs|dd)\b/i,
	/>\s*\/dev\/(sd|nvme|disk)/i,
	/\btruncate\b/i,
	/\bshred\b/i,
];

export default function (pi: ExtensionAPI) {
	let enabled = true;

	const setStatus = (ctx: { ui: { setStatus: (k: string, v: string) => void } }) => {
		ctx.ui.setStatus("approvals", enabled ? "approvals: on" : "approvals: off");
	};

	pi.on("tool_call", async (event, ctx) => {
		const isFileTool = FILE_TOOLS.has(event.toolName);
		const isBashTool = event.toolName === "bash";

		// Protected-path blocks apply even when approvals are disabled.
		if (isFileTool) {
			const path = (event.input as { path?: string }).path ?? "";
			if (isProtected(path)) {
				return { block: true, reason: `Protected path — writes to ${path} are not allowed` };
			}
		} else if (isBashTool) {
			const command = (event.input as { command?: string }).command ?? "";
			if (isProtected(command)) {
				return { block: true, reason: "Protected path referenced in shell command — blocked" };
			}
		}

		if (!enabled) return undefined;
		if (!isFileTool && !isBashTool) return undefined;

		let summary: string;
		if (isFileTool) {
			const path = (event.input as { path?: string }).path ?? "(unknown path)";
			summary = `✎ ${event.toolName} → ${path}`;
		} else {
			const command = (event.input as { command?: string }).command ?? "";
			if (!DESTRUCTIVE_PATTERNS.some((p) => p.test(command))) return undefined;
			summary = `⚠️ destructive shell command:\n\n  ${command}`;
		}

		if (!ctx.hasUI) {
			return { block: true, reason: "Action requires approval but no UI is available" };
		}

		const choice = await ctx.ui.select(`${summary}\n\nAllow?`, ["Yes", "No"]);
		if (choice !== "Yes") {
			return { block: true, reason: "Rejected by user" };
		}

		return undefined;
	});

	pi.registerCommand("approvals", {
		description: "Toggle edit/command approval gate (on|off|status)",
		getArgumentCompletions: (prefix: string) => {
			const opts = ["on", "off", "status"].filter((o) => o.startsWith(prefix));
			return opts.length ? opts.map((o) => ({ value: o, label: o })) : null;
		},
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "on") enabled = true;
			else if (arg === "off") enabled = false;
			else if (arg !== "status" && arg !== "") enabled = !enabled;
			setStatus(ctx);
			ctx.ui.notify(`Approvals ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
