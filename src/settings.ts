import { App, PluginSettingTab, Setting } from 'obsidian';
import CodexCliToolsPlugin from './main';

export interface PromptTemplate {
	id: string;
	name: string;
	prompt: string;
}

export interface ExecutionLogEntry {
	id: string;
	timestamp: string;
	originNote: string;
	prompt: string;
	command: string;
	commandArgs: string[];
	response: string;
	processOutput: string;
	wasError: boolean;
	durationMs: number;
	status: 'running' | 'success' | 'error';
}

export interface PromptCacheEntry {
	response: string;
	cachedAt: string;
}

export interface CodexCliToolsSettings {
	codexCommand: string;
	codexArguments: string;
	defaultModel: string;
	defaultReasoningEffort: string;
	globalInstructions: string;
	executionTimeoutSeconds: number;
	enableMcpServers: boolean;
	promptTemplates: PromptTemplate[];
	executionLog: ExecutionLogEntry[];
	promptCache: Record<string, PromptCacheEntry>;
}

export const DEFAULT_SETTINGS: CodexCliToolsSettings = {
	codexCommand: 'codex',
	codexArguments: ['exec', '--skip-git-repo-check', '--output-last-message', '-'].join('\n'),
	defaultModel: '',
	defaultReasoningEffort: '',
	globalInstructions: '',
	executionTimeoutSeconds: 300,
	enableMcpServers: true,
	promptTemplates: [],
	executionLog: [],
	promptCache: {},
};

const REASONING_OPTIONS: Array<{ value: string; label: string }> = [
	{ value: '', label: 'CLI default' },
	{ value: 'minimal', label: 'minimal' },
	{ value: 'low', label: 'low' },
	{ value: 'medium', label: 'medium' },
	{ value: 'high', label: 'high' },
];

export class CodexSettingTab extends PluginSettingTab {
	plugin: CodexCliToolsPlugin;

	constructor(app: App, plugin: CodexCliToolsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Codex CLI block')
			.setHeading();

		new Setting(containerEl)
			.setName('Codex command')
			.setDesc('Command used to invoke codex in your local environment.')
			.addText((text) => text
				.setPlaceholder('Command (for example: codex)')
				.setValue(this.plugin.settings.codexCommand)
				.onChange(async (value) => {
					this.plugin.settings.codexCommand = value.trim() || 'codex';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Codex arguments')
			.setDesc('One argument per line. Use {{prompt}} to inject the prompt as an argument. Include - to send prompt over stdin.')
			.addTextArea((text) => {
				text.setPlaceholder('Arguments (one per line)');
				text.setValue(this.plugin.settings.codexArguments);
				text.inputEl.rows = 6;
				text.onChange(async (value) => {
					this.plugin.settings.codexArguments = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Default model')
			.setDesc('Model used for codex runs unless overridden in a codex block.')
			.addText((text) => text
				.setPlaceholder('Leave blank for CLI default')
				.setValue(this.plugin.settings.defaultModel)
				.onChange(async (value) => {
					this.plugin.settings.defaultModel = value.trim();
					await this.plugin.saveSettings();
				}));
		containerEl.createEl('p', {
			text: 'Leave blank to use the default model. Override per block with: model: gpt-5-mini',
			cls: 'codex-settings-help',
		});

		new Setting(containerEl)
			.setName('Execution timeout (seconds)')
			.setDesc('Maximum time to wait for a codex run before stopping it.')
			.addText((text) => text
				.setPlaceholder('300')
				.setValue(String(this.plugin.settings.executionTimeoutSeconds))
				.onChange(async (value) => {
					const parsed = Number.parseInt(value.trim(), 10);
					this.plugin.settings.executionTimeoutSeconds = normalizeTimeoutSeconds(parsed);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Default reasoning effort')
			.setDesc('Reasoning effort used unless overridden in a codex block.')
			.addDropdown((dropdown) => {
				const options = buildReasoningDropdownOptions(this.plugin.settings.defaultReasoningEffort);
				for (const option of options) {
					dropdown.addOption(option.value, option.label);
				}
				dropdown
					.setValue(this.plugin.settings.defaultReasoningEffort)
					.onChange(async (value) => {
						this.plugin.settings.defaultReasoningEffort = value.trim();
						await this.plugin.saveSettings();
					});
			});
		containerEl.createEl('p', {
			text: 'Override per block with: reasoning: low',
			cls: 'codex-settings-help',
		});

		new Setting(containerEl)
			.setName('Global instructions')
			.setDesc('Additional instructions applied to every codex prompt.')
			.addTextArea((text) => {
				text.setPlaceholder('Always prefer bullet points and keep answers under 120 words.');
				text.setValue(this.plugin.settings.globalInstructions);
				text.inputEl.rows = 4;
				text.onChange(async (value) => {
					this.plugin.settings.globalInstructions = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Enable mcp servers')
			.setDesc('Controls whether codex runs started by this plugin can use configured mcp servers.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.enableMcpServers)
				.onChange(async (value) => {
					this.plugin.settings.enableMcpServers = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Prompt templates')
			.setHeading();
		containerEl.createEl('p', {
			text: 'Use template references in codex blocks.',
			cls: 'codex-settings-help',
		});

		for (const [index, template] of this.plugin.settings.promptTemplates.entries()) {
			const templateContainer = containerEl.createDiv({ cls: 'codex-template-setting' });

			new Setting(templateContainer)
				.setName(template.name || `Template ${index + 1}`)
				.setDesc(template.id ? `Reference: template: ${template.id}` : 'Add an ID so the template can be referenced from notes.')
				.addExtraButton((button) => button
					.setIcon('trash')
					.setTooltip('Delete template')
					.onClick(async () => {
						this.plugin.settings.promptTemplates.splice(index, 1);
						await this.plugin.saveSettings();
						this.display();
					}));

			new Setting(templateContainer)
				.setName('Template ID')
				.setDesc('Stable ID used in code blocks.')
				.addText((text) => text
					.setPlaceholder('Template ID (for example: weekly-summary)')
					.setValue(template.id)
					.onChange(async (value) => {
						template.id = value.trim();
						await this.plugin.saveSettings();
					}));

			new Setting(templateContainer)
				.setName('Name')
				.setDesc('Human-friendly label shown in settings.')
				.addText((text) => text
					.setPlaceholder('Weekly summary')
					.setValue(template.name)
					.onChange(async (value) => {
						template.name = value;
						await this.plugin.saveSettings();
					}));

			new Setting(templateContainer)
				.setName('Prompt')
				.setDesc('Prompt body that will be sent to codex.')
				.addTextArea((text) => {
					text.setPlaceholder('Summarize the active note in bullet points.');
					text.setValue(template.prompt);
					text.inputEl.rows = 5;
					text.onChange(async (value) => {
						template.prompt = value;
						await this.plugin.saveSettings();
					});
				});
		}

		new Setting(containerEl)
			.setName('Add template')
			.setDesc('Create a reusable prompt template.')
			.addButton((button) => button
				.setButtonText('Add template')
				.setCta()
				.onClick(async () => {
					this.plugin.settings.promptTemplates.push({
						id: createTemplateId(this.plugin.settings.promptTemplates),
						name: 'New template',
						prompt: '',
					});
					await this.plugin.saveSettings();
					this.display();
				}));

		new Setting(containerEl)
			.setName('Execution log')
			.setHeading();

		new Setting(containerEl)
			.setName('Log entries')
			.setDesc(`${this.plugin.settings.executionLog.length} saved.`)
			.addButton((button) => button
				.setButtonText('Clear log')
				.onClick(async () => {
					this.plugin.settings.executionLog = [];
					await this.plugin.saveSettings();
					this.display();
				}));

		renderExecutionLog(containerEl, this.plugin.settings.executionLog);

		new Setting(containerEl)
			.setName('Prompt cache')
			.setHeading();

		new Setting(containerEl)
			.setName('Cached prompts')
			.setDesc(`${Object.keys(this.plugin.settings.promptCache).length} saved.`)
			.addButton((button) => button
				.setButtonText('Clear cache')
				.onClick(async () => {
					this.plugin.settings.promptCache = {};
					await this.plugin.saveSettings();
					this.display();
				}));
	}
}

function createTemplateId(templates: PromptTemplate[]): string {
	const existingIds = new Set(templates.map((template) => template.id).filter(Boolean));
	let i = templates.length + 1;
	let candidate = `template-${i}`;
	while (existingIds.has(candidate)) {
		i += 1;
		candidate = `template-${i}`;
	}
	return candidate;
}

function renderExecutionLog(containerEl: HTMLElement, entries: ExecutionLogEntry[]): void {
	if (entries.length === 0) {
		containerEl.createEl('p', {
			text: 'No executions recorded yet.',
			cls: 'codex-settings-help',
		});
		return;
	}

	const logContainer = containerEl.createDiv({ cls: 'codex-execution-log' });
	for (const entry of entries) {
		const detailsEl = logContainer.createEl('details', { cls: 'codex-execution-log-item' });
		const summaryEl = detailsEl.createEl('summary', { cls: 'codex-execution-log-summary' });

		summaryEl.createSpan({
			text: `${formatTimestamp(entry.timestamp)} - ${entry.originNote || 'Unknown note'} - ${formatDuration(entry.durationMs)}`,
		});
		if (entry.status === 'running') {
			summaryEl.createSpan({
				text: ' (running)',
				cls: 'codex-execution-log-running-label',
			});
		} else if (entry.wasError) {
			summaryEl.createSpan({
				text: ' (error)',
				cls: 'codex-execution-log-error-label',
			});
		}

		const bodyEl = detailsEl.createDiv({ cls: 'codex-execution-log-body' });
		bodyEl.createEl('div', { text: `Duration: ${formatDuration(entry.durationMs)}`, cls: 'codex-execution-log-label' });
		bodyEl.createEl('div', { text: 'Prompt', cls: 'codex-execution-log-label' });
		bodyEl.createEl('pre', {
			text: entry.prompt,
			cls: 'codex-execution-log-pre',
		});
		bodyEl.createEl('div', { text: 'Command line', cls: 'codex-execution-log-label' });
		bodyEl.createEl('pre', {
			text: formatCommandLine(entry.command, entry.commandArgs),
			cls: 'codex-execution-log-pre',
		});
		bodyEl.createEl('div', { text: 'Process output (stdout/stderr)', cls: 'codex-execution-log-label' });
		bodyEl.createEl('pre', {
			text: entry.processOutput.trim() ? entry.processOutput : 'No process output captured.',
			cls: 'codex-execution-log-pre',
		});
		bodyEl.createEl('div', {
			text: entry.status === 'running' ? 'Response (pending)' : (entry.wasError ? 'Response / error' : 'Response'),
			cls: 'codex-execution-log-label',
		});
		bodyEl.createEl('pre', {
			text: entry.status === 'running' ? 'In progress...' : entry.response,
			cls: 'codex-execution-log-pre',
		});
	}
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

function buildReasoningDropdownOptions(selectedValue: string): Array<{ value: string; label: string }> {
	const options = [...REASONING_OPTIONS];
	if (selectedValue && !options.some((option) => option.value === selectedValue)) {
		options.push({ value: selectedValue, label: `Custom (${selectedValue})` });
	}
	return options;
}

function normalizeTimeoutSeconds(value: number): number {
	if (!Number.isFinite(value)) {
		return 300;
	}
	if (value < 15) {
		return 15;
	}
	if (value > 3600) {
		return 3600;
	}
	return Math.round(value);
}
