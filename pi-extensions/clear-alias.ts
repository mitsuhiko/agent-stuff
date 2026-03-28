import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Alias /clear to /new for users familiar with other agents
 */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description: "Start a new session (alias for /new)",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const result = await ctx.newSession();
      if (result.cancelled) {
        ctx.ui.notify("New session cancelled", "info");
      }
    },
  });
}
