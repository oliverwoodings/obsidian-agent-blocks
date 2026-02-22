# Obsidian Agent Blocks

Render local LLM output directly inside notes using an `agent` Markdown code block.

## Features

- Runs automatically when the note is rendered.
- Reusable agent templates with provider-specific configuration.
- Multiple providers:
  - Codex CLI
  - Ollama (local)
- Loading state and one-click refresh per block.
- Stop button on running blocks and running execution log entries.
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
- Prompt cache with configurable max size (default: 1000 entries).
- Standardized prompt wrapper with Obsidian context:
  - vault root path
  - current file path
  - current note content
  - optionally selected linked note content
- Template-configurable context sources (currently linked note content).
- Per-block context source overrides (enable/disable, sizing, filtering, and sorting).
- Global instructions applied to every run.
- Per-block provider overrides (for example model, reasoning, temperature, timeout, mcp, local provider).
- Template and per-block cache mode:
  - `auto-refresh` (default)
  - `prefer-cache` (uses last cached result for that block until manual refresh)

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

`linked_content_sort_by` supports:
- `modified-date` (default)
- `created-date`
- `frontmatter-date`

`linked_content_sort_direction` supports:
- `descending` (default)
- `ascending`

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

### Context source overrides in a block

````markdown
```agent
template: fast-summary
linked_content: true
linked_content_max_notes: 6
linked_content_max_chars: 1500
linked_content_sort_by: frontmatter-date
linked_content_sort_direction: descending
linked_content_sort_frontmatter_date_field: review_date
linked_content_include_outgoing: true
linked_content_include_backlinks: false
linked_content_filter_required_frontmatter_field: review_date
Summarize this note and key linked context.
```
````

### Cache mode override in a block

````markdown
```agent
template: deep-analysis
cache_mode: prefer-cache
Run a thorough analysis using linked context.
```
````

When `cache_mode: prefer-cache` is active, prompt changes do not auto-run. The block reuses the last cached result for that block and marks it as stale until you click refresh.

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
