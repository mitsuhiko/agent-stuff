import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Send a literal continuation prompt, but never steer or queue one mid-run. */
export default function (pi: ExtensionAPI) {
	pi.registerShortcut("shift+alt+enter", {
		description: 'Send "continue" when the agent is stopped',
		handler: (ctx) => {
			// isIdle() also remains false while Pi is retrying, compacting, or has
			// queued messages, so this cannot accidentally create a follow-up.
			if (!ctx.isIdle()) return;
			pi.sendUserMessage("continue");
		},
	});
}
