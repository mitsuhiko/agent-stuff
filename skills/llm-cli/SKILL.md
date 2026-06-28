---
name: llm-cli
description: "Use Simon Willison's `llm` command-line tool specifically: `llm models`, `llm prompt`, `llm openrouter`, plugins, keys, aliases, templates, logs, and command-line model comparison. Do not use for generic LLM/model-selection advice unless the user asks to use the `llm` CLI."
---

# LLM CLI Skill

The `llm` CLI is installed via Homebrew. Use it to test prompts against different models, compare outputs, run benchmark scripts, and evaluate which model works best for a task.

## Basic Prompting

```bash
# Default model (uses configured default or first available)
llm 'Write a haiku about recursion'

# Specify a model by name or alias
llm 'Explain quantum computing' -m gpt-4o
llm 'Explain quantum computing' -m 4o        # alias
llm 'Write a poem' -m claude-sonnet

# System prompt
llm 'Summarize this report' -s 'You are a concise analyst'

# With an image attachment
llm 'Describe this image' -a photo.jpg

# Extract just the code block
llm 'Write a Python function to reverse a string' -x
```

## Listing & Selecting Models

```bash
# List all available models with aliases
llm models list

# List with per-model options (temperature, max_tokens, etc.)
llm models list --options

# Show/set default model
llm models default               # show current default
llm models default claude-sonnet # set default

# List aliases
llm aliases list

# Register a new alias
llm aliases set my-4o gpt-4o
```

## Evaluate / Compare Models

```bash
# Run the same prompt against multiple models
for model in gpt-4o gpt-4.1-mini claude-sonnet; do
    echo "--- $model ---"
    llm 'Write a JSON parser in Python' -m "$model" -x
    echo
done

# Compare with a stored template
llm -t my-prompt -m gpt-4o > /tmp/4o.txt
llm -t my-prompt -m claude-3.5-sonnet > /tmp/sonnet.txt
sdiff /tmp/4o.txt /tmp/sonnet.txt
```

## Templates

```bash
# Save a prompt template for reuse
llm 'Summarize the following text in 3 bullet points: $text' --save summarize

# Use the template
llm -t summarize -p text "$(cat article.txt)"

# List templates
llm templates list

# Show template details
llm templates show summarize
```

## Logging & Conversation

```bash
# View recent prompts & responses (stored in SQLite)
llm logs list -n 10

# Continue the last conversation
llm -c 'Now explain it like I am five'

# Continue a specific conversation by ID
llm -c 'Follow-up question' --cid abc123

# Do not log a sensitive prompt
llm 'secret stuff' -n
```

## Keys & Plugins

```bash
# Set an API key
llm keys set openai
llm keys set anthropic
llm keys set openrouter

# List installed plugins
llm plugins

# Install extra model plugins (e.g., OpenRouter, Anthropic, Google, local models)
llm install llm-openrouter
llm install llm-anthropic
llm install llm-gemini
llm install llm-ollama
llm install llm-gguf
llm install llm-cmd        # generate shell commands

# Uninstall a plugin
llm uninstall llm-anthropic
```

## OpenRouter

OpenRouter is configured via the `llm-openrouter` plugin. Use it when comparing many providers/models through a single API key.

```bash
# Refresh OpenRouter's model catalog
llm openrouter refresh

# List OpenRouter models and metadata/pricing
llm openrouter models

# Check key limits/usage
llm openrouter key

# Use an OpenRouter model
llm 'Reply with exactly: OK' -m 'openrouter/nex-agi/nex-n2-pro:free'
llm 'Compare these architectures' -m 'openrouter/anthropic/claude-opus-4.8'

# Search installed model IDs
llm models list | grep -i openrouter | grep -i claude
```

## Options & Parameters

```bash
# Model-specific options (check `llm models list --options` for supported keys)
llm 'Be creative' -m gpt-4o -o temperature 0.9 -o max_tokens 500

# No streaming (return full response at once)
llm 'Long essay...' --no-stream

# Show token usage
llm 'Test' -u

# Run asynchronously
llm 'Research this...' --async
```

## Embeddings

```bash
# Embed text to a vector
llm embed -m text-embedding-3-small -c 'hello world'

# Embed multiple items into a collection
llm embed-multi my-collection file1.txt file2.txt

# Query similar items
llm similar my-collection -c 'query text'
```

## Eval / Benchmark Workflow

When deciding which model to use for a task:

1. **List models** – `llm models list`
2. **Set the prompt** – save with `llm '...' --save eval-prompt`
3. **Run across candidates** – loop model names, capture outputs to files
4. **Compare outputs** – use `diff`, `sdiff`, or manual review
5. **Check cost/performance** – use `-u` for token counts, cross-reference with provider pricing
6. **Settle on a model** – update the project default or alias as needed
