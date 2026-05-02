import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Generic command aliases. Add alias mappings below to register
 * shorthand commands that delegate to built-in or extension commands.
 * Run /aliases to see all registered aliases.
 */

interface AliasEntry {
  command: string;
  target: string;
  description: string;
}

const aliases: AliasEntry[] = [];

function registerAlias(
  pi: ExtensionAPI,
  command: string,
  target: string,
  description: string,
  handler: (args: string[], ctx: any) => Promise<void>,
) {
  aliases.push({ command, target, description });
  pi.registerCommand(command, { description, handler });
}

export default function (pi: ExtensionAPI) {
  // /clear  → /new
  registerAlias(pi, "clear", "/new", "Start a new session", async (_args, ctx) => {
    await ctx.waitForIdle();
    const result = await ctx.newSession();
    if (result.cancelled) {
      ctx.ui.notify("New session cancelled", "info");
    }
  });

  // /aliases — list all registered aliases
  pi.registerCommand("aliases", {
    description: "List all command aliases",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      if (aliases.length === 0) {
        ctx.ui.notify("No aliases registered", "info");
        return;
      }

      const lines = aliases.map(
        (a) => `  /${a.command}  →  ${a.target}  — ${a.description}`,
      );

      const message = `**Command Aliases**\n\n${lines.join("\n")}`;
      ctx.ui.markdown(message, { title: "Aliases" });
    },
  });

  // Add more aliases here. Example:
  //
  // registerAlias(pi, "shortcut", "/some-other-command", "Alias for some command", async (args, ctx) => {
  //   // delegate to another command's logic
  // });
}
