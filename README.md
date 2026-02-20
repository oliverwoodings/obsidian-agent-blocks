# Obsidian Codex CLI Tools

Render Codex CLI responses directly inside notes using a custom `codex` Markdown code block.

## Features

- Runs a prompt when the note preview is rendered.
- Supports inline prompts directly in the block.
- Supports reusable prompt templates configured in plugin settings.
- Shows a loading state while Codex is running.
- Renders Codex output as Markdown.
- Caches responses by hashed prompt so reopening a note can reuse cached output instead of re-running codex.
- Includes a refresh button on each block to force re-run the prompt and update the cached result.
- Standardized prompt requests a title derived from the instruction at the top of each response.
- Standardized prompt encourages Obsidian-flavored Markdown output and preserving relevant wikilinks when summarizing.
- Stores an execution log in settings with timestamp, origin note, prompt, and response.
- Stores an execution log in settings with timestamp, origin note, duration, prompt, and response.
- Wraps each instruction in a standardized prompt that includes vault path, file path, backlinks, and outgoing links.
- Supports a settings-level default model with per-block model override.
- Supports enabling/disabling MCP server usage for plugin-run codex executions.

## Requirements

- Desktop Obsidian (plugin is desktop-only).
- `codex` CLI installed and available on your PATH.

## Usage

### 1) Inline prompt

````markdown
```codex
Summarize this note into 5 action items.
```
````

### 2) Template reference

Create templates in **Settings → Community plugins → Obsidian Codex CLI Tools**.

Then reference them in a block:

````markdown
```codex
template: weekly-summary
```
````

Optional: add extra instructions under the template line. They are appended to the template prompt.

````markdown
```codex
template: weekly-summary
Focus on blockers and decisions.
```
````

### 3) Model override in a block

Set a plugin-wide default model in settings (`Default model`; leave blank for CLI default), then override per block when needed:

````markdown
```codex
model: gpt-5-mini
Summarize this note in 3 bullets.
```
````

## MCP server setting

Use **Enable MCP servers** in plugin settings to control whether codex runs from this plugin can use configured MCP servers.

You can combine template + model override:

````markdown
```codex
template: weekly-summary
model: gpt-5-nano
Focus on blockers only.
```
````

## Codex CLI arguments

In settings, `Codex arguments` accepts one argument per line.

Default arguments:

- `exec`
- `--skip-git-repo-check`
- `--output-last-message`
- `-`

Argument behavior:

- If an argument contains `{{prompt}}`, that placeholder is replaced with the prompt.
- Otherwise, if `-` is present, the prompt is sent over stdin.
- Otherwise, the prompt is appended as the final argument.

## Development

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
```
