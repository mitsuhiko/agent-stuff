---
name: mermaid
description: "Must read guide on creating/editing mermaid charts with valiation tools"
---

# Mermaid Skill

Use this skill to quickly validate Mermaid diagrams by parsing + rendering them with the official Mermaid CLI.

## Prerequisites

- Node.js + npm (for `npx`).
- First run downloads a headless Chromium via Puppeteer. If Chromium is missing, set `PUPPETEER_EXECUTABLE_PATH`.

## Tool

### Validate a diagram

```bash
./tools/validate.sh diagram.mmd [output.svg]
```

- Parses and renders the Mermaid source.
- Non-zero exit = invalid Mermaid syntax.
- Prints an ASCII preview using `beautiful-mermaid` (best-effort; not all diagram types are supported).
- If `output.svg` is omitted, the SVG is rendered to a temp file and discarded.

## Workflow (short)

1. **If the diagram will live in Markdown**: draft it in a standalone `diagram.mmd` first (the tool only validates plain Mermaid files).
2. Write/update `diagram.mmd`.
3. Run `./tools/validate.sh diagram.mmd`.
4. Fix any errors shown by the CLI.
5. Once it validates, copy the Mermaid block into your Markdown file.
