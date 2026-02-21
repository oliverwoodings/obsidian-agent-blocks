# Obsidian Agent Blocks

Render local LLM output directly inside notes using an `agent` Markdown code block.

## Features

- Runs automatically when the note is rendered.
- Reusable agent templates with provider-specific configuration.
- Multiple providers:
  - Codex CLI
  - Ollama (local)
- Loading state and one-click refresh per block.
- Execution log in settings with:
  - timestamp
  - origin note
  - provider/template
  - duration
  - full prompt
  - full response
  - command line args
  - streamed stdout/stderr output
  - in-flight status
- Prompt cache (default max size: 1000 entries).
- Standardized prompt wrapper with Obsidian context:
  - vault root path
  - current file path
  - outgoing links
  - backlinks
- Global instructions applied to every run.
- Per-block provider overrides (for example model, reasoning, temperature, timeout, mcp, local provider).

## Requirements

- Desktop Obsidian (`isDesktopOnly: true`).
- For Codex templates: local `codex` CLI installed.
- For Ollama templates: local Ollama server and a pulled model.

## Block usage

### Inline instruction (uses default agent template)

````markdown
```agent
Summarize this note into 5 action items.
```
````

### Template reference

````markdown
```agent
template: weekly-summary
Focus on blockers and decisions.
```
````

### Codex overrides in a block

````markdown
```agent
template: codex-default
model: gpt-5-mini
reasoning: low
mcp: false
timeout: 120
oss: true
local_provider: ollama
Summarize only unresolved items.
```
````

### Ollama overrides in a block

````markdown
```agent
template: local-ollama
model: llama3.2
temperature: 0.1
num_predict: 700
host: http://127.0.0.1:11434
Summarize this file.
```
````

## Codex local model setting

For Codex templates, you can enable:

- `Use local OSS provider` (adds `--oss`)
- `Local provider` (adds `--local-provider`, e.g. `ollama`, `lmstudio`, `ollama-chat`)

This lets Codex route to a local provider while keeping Codex prompt/tooling behavior.

## Development

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
```
