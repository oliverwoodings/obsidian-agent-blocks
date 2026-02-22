import type { ExecutionLogEntry } from '../../domain/types';

export function renderExecutionLog(
	containerEl: HTMLElement,
	entries: ExecutionLogEntry[],
	expandedEntryIds: Set<string>,
	onStopRun: (id: string) => Promise<void>,
): void {
	if (entries.length === 0) {
		containerEl.createEl('p', {
			text: 'No executions recorded yet.',
			cls: 'agent-settings-help',
		});
		return;
	}

	const logContainer = containerEl.createDiv({ cls: 'agent-execution-log' });
	for (const entry of entries) {
		const detailsEl = logContainer.createEl('details', { cls: 'agent-execution-log-item' });
		detailsEl.open = expandedEntryIds.has(entry.id);
		detailsEl.addEventListener('toggle', () => {
			if (detailsEl.open) {
				expandedEntryIds.add(entry.id);
			} else {
				expandedEntryIds.delete(entry.id);
			}
		});
		const summaryEl = detailsEl.createEl('summary', { cls: 'agent-execution-log-summary' });

		summaryEl.createSpan({
			text: `${formatTimestamp(entry.timestamp)} - ${entry.originNote || 'Unknown note'} - ${entry.agentTemplateName} - ${formatDuration(entry.durationMs)}`,
		});
		if (entry.status === 'running') {
			summaryEl.createSpan({
				text: ' (running)',
				cls: 'agent-execution-log-running-label',
			});
			const stopButtonEl = summaryEl.createEl('button', {
				text: 'Stop',
				cls: 'agent-execution-log-stop-button',
			});
			stopButtonEl.type = 'button';
			stopButtonEl.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				stopButtonEl.disabled = true;
				void onStopRun(entry.id);
			});
		} else if (entry.status === 'stopped') {
			summaryEl.createSpan({
				text: ' (stopped)',
				cls: 'agent-execution-log-stopped-label',
			});
		} else if (entry.wasError) {
			summaryEl.createSpan({
				text: ' (error)',
				cls: 'agent-execution-log-error-label',
			});
		}

		const bodyEl = detailsEl.createDiv({ cls: 'agent-execution-log-body' });
		bodyEl.createEl('div', { text: `Provider: ${entry.provider}`, cls: 'agent-execution-log-label' });
		bodyEl.createEl('div', { text: `Duration: ${formatDuration(entry.durationMs)}`, cls: 'agent-execution-log-label' });
		createExecutionLogTextSection(bodyEl, entry.id, 'prompt', 'Prompt', entry.prompt);
		createExecutionLogTextSection(
			bodyEl,
			entry.id,
			'command-line',
			'Command line',
			formatCommandLine(entry.command, entry.commandArgs),
		);
		createExecutionLogTextSection(
			bodyEl,
			entry.id,
			'process-output',
			'Process output (stdout/stderr)',
			entry.processOutput.trim() ? entry.processOutput : 'No process output captured.',
		);
		createExecutionLogTextSection(
			bodyEl,
			entry.id,
			'response',
			entry.status === 'running'
				? 'Response (pending)'
				: (entry.status === 'stopped'
					? 'Response (stopped)'
					: (entry.wasError ? 'Response / error' : 'Response')),
			entry.status === 'running' ? 'In progress...' : entry.response,
		);
	}
}

interface ExecutionLogPaneScrollState {
	offsetFromBottom: number;
	wasAtBottom: boolean;
}

export function captureExecutionLogScrollState(containerEl: HTMLElement): Map<string, ExecutionLogPaneScrollState> {
	const states = new Map<string, ExecutionLogPaneScrollState>();
	const panes = containerEl.querySelectorAll<HTMLElement>('.agent-execution-log-pre[data-scroll-key]');
	for (let index = 0; index < panes.length; index += 1) {
		const pane = panes[index];
		if (!pane) {
			continue;
		}
		const key = pane.dataset.scrollKey;
		if (!key) {
			continue;
		}
		const offsetFromBottom = pane.scrollHeight - (pane.scrollTop + pane.clientHeight);
		const wasAtBottom = offsetFromBottom <= 2;
		states.set(key, {
			offsetFromBottom: Math.max(0, offsetFromBottom),
			wasAtBottom,
		});
	}
	return states;
}

export function restoreExecutionLogScrollState(
	containerEl: HTMLElement,
	scrollStates: Map<string, ExecutionLogPaneScrollState>,
): void {
	if (scrollStates.size === 0) {
		return;
	}

	const panes = containerEl.querySelectorAll<HTMLElement>('.agent-execution-log-pre[data-scroll-key]');
	for (let index = 0; index < panes.length; index += 1) {
		const pane = panes[index];
		if (!pane) {
			continue;
		}
		const key = pane.dataset.scrollKey;
		if (!key) {
			continue;
		}
		const previous = scrollStates.get(key);
		if (!previous) {
			continue;
		}

		const maxScrollTop = Math.max(0, pane.scrollHeight - pane.clientHeight);
		if (previous.wasAtBottom) {
			pane.scrollTop = maxScrollTop;
			continue;
		}

		pane.scrollTop = Math.max(0, maxScrollTop - previous.offsetFromBottom);
	}
}

function createExecutionLogTextSection(
	containerEl: HTMLElement,
	entryId: string,
	sectionId: string,
	label: string,
	value: string,
): void {
	const labelRowEl = containerEl.createDiv({ cls: 'agent-execution-log-label-row' });
	labelRowEl.createEl('div', { text: label, cls: 'agent-execution-log-label' });

	const copyButton = labelRowEl.createEl('button', {
		text: 'Copy',
		cls: 'agent-execution-log-copy-button',
	});
	copyButton.type = 'button';
	copyButton.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		void copyExecutionLogText(copyButton, value);
	});

	const preEl = containerEl.createEl('pre', {
		text: value,
		cls: 'agent-execution-log-pre',
	});
	preEl.dataset.scrollKey = buildExecutionLogScrollKey(entryId, sectionId);
	preEl.tabIndex = 0;
}

function buildExecutionLogScrollKey(entryId: string, sectionId: string): string {
	return `${entryId}:${sectionId}`;
}

async function copyExecutionLogText(buttonEl: HTMLButtonElement, value: string): Promise<void> {
	const originalLabel = buttonEl.textContent || 'Copy';
	try {
		await navigator.clipboard.writeText(value);
		buttonEl.setText('Copied');
	} catch {
		buttonEl.setText('Copy failed');
	}
	window.setTimeout(() => buttonEl.setText(originalLabel), 1200);
}

function formatTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) {
		return timestamp;
	}
	return date.toLocaleString();
}

function formatDuration(durationMs: number | undefined): string {
	if (typeof durationMs !== 'number' || Number.isNaN(durationMs)) {
		return 'In progress';
	}
	if (durationMs < 1000) {
		return `${durationMs} ms`;
	}
	const seconds = durationMs / 1000;
	return `${seconds.toFixed(2)} s`;
}

function formatCommandLine(command: string, args: string[]): string {
	if (!command.trim()) {
		return 'Pending...';
	}
	const renderedArgs = args.map((arg) => quoteShellArg(arg)).join(' ');
	return renderedArgs ? `${command} ${renderedArgs}` : command;
}

function quoteShellArg(value: string): string {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
