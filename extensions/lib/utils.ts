/**
 * Strip ANSI escape codes from a string.
 * Used by multiple extensions to get plain text from rendered TUI output.
 */
export function stripAnsi(str: string): string {
	// eslint-disable-next-line no-control-regex
	return str.replace(/\x1B\[[0-9;]*m/g, "");
}
