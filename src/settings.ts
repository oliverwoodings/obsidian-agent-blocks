import { App, PluginSettingTab, Setting } from 'obsidian';
import type { AgentProviderId } from './agent-types';
import AgentBlocksPlugin from './main';

export interface ExecutionLogEntry {
	id: string;
	timestamp: string;
	originNote: string;
	agentTemplateId: string;
	agentTemplateName: string;
	provider: AgentProviderId;
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

export interface CodexAgentProviderConfig {
	command: string;
	arguments: string;
	model: string;
	reasoningEffort: string;
	useOssModelProvider: boolean;
	localProvider: string;
	executionTimeoutSeconds: number;
	enableMcpServers: boolean;
}

export interface OllamaAgentProviderConfig {
	host: string;
	model: string;
	temperature: number;
	numPredict: number;
	keepAlive: string;
}

export interface LinkedNoteContentContextConfig {
	selectionMode: LinkedNoteSelectionMode;
	enabled: boolean;
	maxNotes: number;
	maxCharsPerNote: number;
	includeOutgoingLinks: boolean;
	includeBacklinks: boolean;
}

export type LinkedNoteSelectionMode = 'recently-modified' | 'recently-created';

export interface AgentTemplateContextConfig {
	linkedNoteContent: LinkedNoteContentContextConfig;
}

interface AgentTemplateBase {
	id: string;
	name: string;
	instructions: string;
	context: AgentTemplateContextConfig;
}

export interface CodexAgentTemplate extends AgentTemplateBase {
	provider: 'codex';
	providerConfig: CodexAgentProviderConfig;
}

export interface OllamaAgentTemplate extends AgentTemplateBase {
	provider: 'ollama';
	providerConfig: OllamaAgentProviderConfig;
}

export type AgentTemplate = CodexAgentTemplate | OllamaAgentTemplate;

export interface AgentBlocksSettings {
	globalInstructions: string;
	agentTemplates: AgentTemplate[];
	defaultAgentTemplateId: string;
	executionLog: ExecutionLogEntry[];
	promptCache: Record<string, PromptCacheEntry>;
}

export const DEFAULT_CODEX_PROVIDER_CONFIG: CodexAgentProviderConfig = {
	command: 'codex',
	arguments: ['exec', '--skip-git-repo-check', '--output-last-message', '-'].join('\n'),
	model: '',
	reasoningEffort: '',
	useOssModelProvider: false,
	localProvider: '',
	executionTimeoutSeconds: 300,
	enableMcpServers: true,
};

export const DEFAULT_OLLAMA_PROVIDER_CONFIG: OllamaAgentProviderConfig = {
	host: 'http://127.0.0.1:11434',
	model: 'llama3.2',
	temperature: 0.2,
	numPredict: 512,
	keepAlive: '5m',
};

export const DEFAULT_TEMPLATE_CONTEXT_CONFIG: AgentTemplateContextConfig = {
	linkedNoteContent: {
		selectionMode: 'recently-modified',
		enabled: false,
		maxNotes: 5,
		maxCharsPerNote: 2000,
		includeOutgoingLinks: true,
		includeBacklinks: false,
	},
};

export const DEFAULT_SETTINGS: AgentBlocksSettings = {
	globalInstructions: '',
	agentTemplates: [createDefaultCodexAgentTemplate('default-agent')],
	defaultAgentTemplateId: 'default-agent',
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

export class AgentSettingTab extends PluginSettingTab {
	plugin: AgentBlocksPlugin;
	private readonly expandedTemplateIds = new Set<string>();
	private executionLogCountSetting: Setting | null = null;
	private executionLogContainerEl: HTMLElement | null = null;
	private logRefreshTimeoutId: number | null = null;

	constructor(app: App, plugin: AgentBlocksPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.executionLogCountSetting = null;
		this.executionLogContainerEl = null;
		if (this.logRefreshTimeoutId !== null) {
			window.clearTimeout(this.logRefreshTimeoutId);
			this.logRefreshTimeoutId = null;
		}

		new Setting(containerEl)
			.setName('Agent blocks')
			.setHeading();

		new Setting(containerEl)
			.setName('Global instructions')
			.setDesc('Additional instructions applied to every agent prompt.')
			.addTextArea((text) => {
				text.setPlaceholder('Keep output concise and use Obsidian wikilinks.');
				text.setValue(this.plugin.settings.globalInstructions);
				text.inputEl.rows = 4;
				text.onChange(async (value) => {
					this.plugin.settings.globalInstructions = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Default agent template')
			.setDesc('Used for agent blocks when no template is specified.')
			.addDropdown((dropdown) => {
				for (const template of this.plugin.settings.agentTemplates) {
					dropdown.addOption(template.id, `${template.name} (${template.provider})`);
				}
				const fallbackTemplateId = this.plugin.settings.agentTemplates[0]?.id ?? '';
				const currentDefault = this.plugin.settings.defaultAgentTemplateId || fallbackTemplateId;
				dropdown
					.setValue(currentDefault)
					.onChange(async (value) => {
						this.plugin.settings.defaultAgentTemplateId = value;
						await this.plugin.saveSettings();
						this.display();
					});
			});

		new Setting(containerEl)
			.setName('Agent templates')
			.setHeading();
		containerEl.createEl('p', {
			text: 'Use `template: your-template-id` in a block. Context overrides can use `linked_content` and `linked_content_max_notes` directives.',
			cls: 'agent-settings-help',
		});

		for (const [index, template] of this.plugin.settings.agentTemplates.entries()) {
			this.renderTemplateEditor(containerEl, template, index);
		}

		new Setting(containerEl)
			.setName('Add template')
			.setDesc('Create a reusable agent template.')
			.addButton((button) => button
				.setButtonText('Add template')
				.setCta()
					.onClick(async () => {
						const id = createTemplateId(this.plugin.settings.agentTemplates);
						this.plugin.settings.agentTemplates.push(createDefaultCodexAgentTemplate(id));
						if (!this.plugin.settings.defaultAgentTemplateId) {
							this.plugin.settings.defaultAgentTemplateId = id;
						}
						this.expandedTemplateIds.add(id);
						await this.plugin.saveSettings();
						this.display();
					}));

		new Setting(containerEl)
			.setName('Execution log')
			.setHeading();

		this.executionLogCountSetting = new Setting(containerEl)
			.setName('Log entries')
			.setDesc(`${this.plugin.settings.executionLog.length} saved.`)
			.addButton((button) => button
				.setButtonText('Clear log')
				.onClick(async () => {
					this.plugin.settings.executionLog = [];
					await this.plugin.saveSettings();
					this.refreshExecutionLogSection();
				}));

		this.executionLogContainerEl = containerEl.createDiv({ cls: 'agent-execution-log-section' });
		renderExecutionLog(this.executionLogContainerEl, this.plugin.settings.executionLog);

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

	notifyExecutionLogUpdated(): void {
		if (!this.containerEl.isConnected) {
			return;
		}

		if (this.logRefreshTimeoutId !== null) {
			return;
		}

		this.logRefreshTimeoutId = window.setTimeout(() => {
			this.logRefreshTimeoutId = null;
			this.refreshExecutionLogSection();
		}, 200);
	}

	private refreshExecutionLogSection(): void {
		if (!this.containerEl.isConnected) {
			return;
		}

		this.executionLogCountSetting?.setDesc(`${this.plugin.settings.executionLog.length} saved.`);
		if (!this.executionLogContainerEl) {
			return;
		}

		this.executionLogContainerEl.empty();
		renderExecutionLog(this.executionLogContainerEl, this.plugin.settings.executionLog);
	}

	private renderTemplateEditor(containerEl: HTMLElement, template: AgentTemplate, index: number): void {
		const detailsEl = containerEl.createEl('details', { cls: 'agent-template-setting' });
		detailsEl.open = this.expandedTemplateIds.has(template.id);
		detailsEl.addEventListener('toggle', () => {
			if (detailsEl.open) {
				this.expandedTemplateIds.add(template.id);
			} else {
				this.expandedTemplateIds.delete(template.id);
			}
		});

		const summaryEl = detailsEl.createEl('summary', { cls: 'agent-template-setting__summary' });
		const summaryTextEl = summaryEl.createSpan({ cls: 'agent-template-setting__summary-text' });
		const updateSummary = (): void => {
			const templateName = template.name.trim() || `Template ${index + 1}`;
			const defaultSuffix = this.plugin.settings.defaultAgentTemplateId === template.id ? ' - default' : '';
			summaryTextEl.setText(`${templateName} (${template.provider})${defaultSuffix}`);
		};
		updateSummary();

		const templateContainer = detailsEl.createDiv({ cls: 'agent-template-setting__content' });

		new Setting(templateContainer)
			.setName(template.name || `Template ${index + 1}`)
			.setDesc(`Provider: ${template.provider}`)
			.addExtraButton((button) => button
				.setIcon('copy')
				.setTooltip('Duplicate template')
				.onClick(async () => {
					const duplicatedTemplate = duplicateTemplate(template, this.plugin.settings.agentTemplates);
					this.plugin.settings.agentTemplates.splice(index + 1, 0, duplicatedTemplate);
					this.expandedTemplateIds.add(duplicatedTemplate.id);
					await this.plugin.saveSettings();
					this.display();
				}))
			.addExtraButton((button) => button
				.setIcon('trash')
				.setTooltip('Delete template')
				.onClick(async () => {
					this.expandedTemplateIds.delete(template.id);
					this.plugin.settings.agentTemplates.splice(index, 1);
					if (this.plugin.settings.defaultAgentTemplateId === template.id) {
						this.plugin.settings.defaultAgentTemplateId = this.plugin.settings.agentTemplates[0]?.id ?? '';
					}
					await this.plugin.saveSettings();
					this.display();
				}));

		new Setting(templateContainer)
			.setName('Template identifier')
			.setDesc('Stable identifier used inside agent blocks.')
			.addText((text) => text
				.setPlaceholder('Example: my-agent')
				.setValue(template.id)
				.onChange(async (value) => {
					const nextId = value.trim();
					if (!nextId) {
						return;
					}
					const previousId = template.id;
					template.id = nextId;
					if (this.expandedTemplateIds.delete(previousId)) {
						this.expandedTemplateIds.add(nextId);
					}
					if (this.plugin.settings.defaultAgentTemplateId === previousId) {
						this.plugin.settings.defaultAgentTemplateId = nextId;
					}
					await this.plugin.saveSettings();
					updateSummary();
				}));

		new Setting(templateContainer)
			.setName('Name')
			.setDesc('Human-friendly label shown in settings.')
			.addText((text) => text
				.setPlaceholder('Project helper')
				.setValue(template.name)
				.onChange(async (value) => {
					template.name = value;
					await this.plugin.saveSettings();
					updateSummary();
				}));

		new Setting(templateContainer)
			.setName('Provider')
			.setDesc('Provider used when this template is selected.')
			.addDropdown((dropdown) => dropdown
				.addOption('codex', 'Codex')
				.addOption('ollama', 'Ollama')
				.setValue(template.provider)
				.onChange(async (value: AgentProviderId) => {
					this.plugin.settings.agentTemplates[index] = convertTemplateProvider(template, value);
					await this.plugin.saveSettings();
					this.display();
				}));

		new Setting(templateContainer)
			.setName('Template instructions')
			.setDesc('Prepended to the block instruction when this template is used.')
			.addTextArea((text) => {
				text.setPlaceholder('Summarize in bullet points and preserve note links.');
				text.setValue(template.instructions);
				text.inputEl.rows = 4;
				text.onChange(async (value) => {
					template.instructions = value;
					await this.plugin.saveSettings();
				});
			});

		this.renderContextSettings(templateContainer, template);

		new Setting(templateContainer)
			.setName('Provider')
			.setHeading();

		if (template.provider === 'codex') {
			this.renderCodexProviderSettings(templateContainer, template);
		} else {
			this.renderOllamaProviderSettings(templateContainer, template);
		}
	}

	private renderCodexProviderSettings(containerEl: HTMLElement, template: CodexAgentTemplate): void {
		new Setting(containerEl)
			.setName('Codex command')
			.setDesc('Command used to invoke codex.')
			.addText((text) => text
				.setPlaceholder('Example: codex')
				.setValue(template.providerConfig.command)
				.onChange(async (value) => {
					template.providerConfig.command = value.trim() || 'codex';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Codex arguments')
			.setDesc('One argument per line. Include - to pass prompt over stdin.')
			.addTextArea((text) => {
				text.setPlaceholder('One argument per line.');
				text.setValue(template.providerConfig.arguments);
				text.inputEl.rows = 6;
				text.onChange(async (value) => {
					template.providerConfig.arguments = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Default model')
			.setDesc('Leave blank to use codex CLI default.')
			.addText((text) => text
				.setPlaceholder('Example: gpt-5-mini')
				.setValue(template.providerConfig.model)
				.onChange(async (value) => {
					template.providerConfig.model = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Default reasoning effort')
			.setDesc('Reasoning effort used unless overridden in block.')
			.addDropdown((dropdown) => {
				const options = buildReasoningDropdownOptions(template.providerConfig.reasoningEffort);
				for (const option of options) {
					dropdown.addOption(option.value, option.label);
				}
				dropdown
					.setValue(template.providerConfig.reasoningEffort)
					.onChange(async (value) => {
						template.providerConfig.reasoningEffort = value.trim();
						await this.plugin.saveSettings();
					});
				});

		new Setting(containerEl)
			.setName('Use local oss provider')
			.setDesc('Adds --oss to codex runs so a local provider such as ollama can be used.')
			.addToggle((toggle) => toggle
				.setValue(template.providerConfig.useOssModelProvider)
				.onChange(async (value) => {
					template.providerConfig.useOssModelProvider = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Local provider')
			.setDesc('Optional codex --local-provider value (lmstudio, ollama, or ollama-chat).')
			.addText((text) => text
				.setPlaceholder('Example: ollama')
				.setValue(template.providerConfig.localProvider)
				.onChange(async (value) => {
					template.providerConfig.localProvider = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Execution timeout (seconds)')
			.setDesc('Maximum time to wait for codex runs.')
			.addText((text) => text
				.setPlaceholder('300')
				.setValue(String(template.providerConfig.executionTimeoutSeconds))
				.onChange(async (value) => {
					const parsed = Number.parseInt(value.trim(), 10);
					template.providerConfig.executionTimeoutSeconds = normalizeTimeoutSeconds(parsed);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Enable mcp servers')
			.setDesc('Allow mcp servers during codex runs.')
			.addToggle((toggle) => toggle
				.setValue(template.providerConfig.enableMcpServers)
				.onChange(async (value) => {
					template.providerConfig.enableMcpServers = value;
					await this.plugin.saveSettings();
				}));
	}

	private renderContextSettings(containerEl: HTMLElement, template: AgentTemplate): void {
		new Setting(containerEl)
			.setName('Context sources')
			.setHeading();

		new Setting(containerEl)
			.setName('Include linked note content')
			.setDesc('Include selected linked notes in the prompt context.')
			.addToggle((toggle) => toggle
				.setValue(template.context.linkedNoteContent.enabled)
				.onChange(async (value) => {
					template.context.linkedNoteContent.enabled = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Linked note max count')
			.setDesc('Maximum linked notes to include in prompt context.')
			.addText((text) => text
				.setPlaceholder('5')
				.setValue(String(template.context.linkedNoteContent.maxNotes))
				.onChange(async (value) => {
					template.context.linkedNoteContent.maxNotes = normalizeLinkedMaxNotes(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Linked note selection')
			.setDesc('How linked notes are selected when there are more than the max count.')
			.addDropdown((dropdown) => dropdown
				.addOption('recently-modified', 'Recently modified')
				.addOption('recently-created', 'Recently created')
				.setValue(template.context.linkedNoteContent.selectionMode)
				.onChange(async (value: LinkedNoteSelectionMode) => {
					template.context.linkedNoteContent.selectionMode = normalizeLinkedSelectionMode(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Linked note max chars')
			.setDesc('Maximum characters to include per linked note.')
			.addText((text) => text
				.setPlaceholder('2000')
				.setValue(String(template.context.linkedNoteContent.maxCharsPerNote))
				.onChange(async (value) => {
					template.context.linkedNoteContent.maxCharsPerNote = normalizeLinkedMaxChars(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Include outgoing links')
			.setDesc('Allows outgoing links to be included as linked note content.')
			.addToggle((toggle) => toggle
				.setValue(template.context.linkedNoteContent.includeOutgoingLinks)
				.onChange(async (value) => {
					template.context.linkedNoteContent.includeOutgoingLinks = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Include backlinks')
			.setDesc('Allows backlinks to be included as linked note content.')
			.addToggle((toggle) => toggle
				.setValue(template.context.linkedNoteContent.includeBacklinks)
				.onChange(async (value) => {
					template.context.linkedNoteContent.includeBacklinks = value;
					await this.plugin.saveSettings();
				}));
	}

	private renderOllamaProviderSettings(containerEl: HTMLElement, template: OllamaAgentTemplate): void {
		new Setting(containerEl)
			.setName('Ollama host')
			.setDesc('Address of the local ollama server.')
			.addText((text) => text
				.setPlaceholder('http://127.0.0.1:11434')
				.setValue(template.providerConfig.host)
				.onChange(async (value) => {
					template.providerConfig.host = value.trim() || DEFAULT_OLLAMA_PROVIDER_CONFIG.host;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Ollama model')
			.setDesc('Model name served by ollama.')
			.addText((text) => text
				.setPlaceholder('Example: llama3.2')
				.setValue(template.providerConfig.model)
				.onChange(async (value) => {
					template.providerConfig.model = value.trim() || DEFAULT_OLLAMA_PROVIDER_CONFIG.model;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Temperature')
			.setDesc('Sampling temperature for generation.')
			.addText((text) => text
				.setPlaceholder('0.2')
				.setValue(String(template.providerConfig.temperature))
				.onChange(async (value) => {
					template.providerConfig.temperature = normalizeTemperature(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Max tokens')
			.setDesc('Maximum tokens predicted by ollama.')
			.addText((text) => text
				.setPlaceholder('512')
				.setValue(String(template.providerConfig.numPredict))
				.onChange(async (value) => {
					template.providerConfig.numPredict = normalizeNumPredict(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Keep alive')
			.setDesc('Ollama keep alive value such as 5m.')
			.addText((text) => text
				.setPlaceholder('5m')
				.setValue(template.providerConfig.keepAlive)
				.onChange(async (value) => {
					template.providerConfig.keepAlive = value.trim() || DEFAULT_OLLAMA_PROVIDER_CONFIG.keepAlive;
					await this.plugin.saveSettings();
				}));
	}
}

export function createDefaultCodexAgentTemplate(id: string): CodexAgentTemplate {
	return {
		id,
		name: 'Default codex agent',
		provider: 'codex',
		instructions: '',
		context: createDefaultTemplateContextConfig(),
		providerConfig: { ...DEFAULT_CODEX_PROVIDER_CONFIG },
	};
}

export function createDefaultOllamaAgentTemplate(id: string): OllamaAgentTemplate {
	return {
		id,
		name: 'Default ollama agent',
		provider: 'ollama',
		instructions: '',
		context: createDefaultTemplateContextConfig(),
		providerConfig: { ...DEFAULT_OLLAMA_PROVIDER_CONFIG },
	};
}

export function createTemplateId(templates: AgentTemplate[]): string {
	const existingIds = new Set(templates.map((template) => template.id).filter(Boolean));
	let i = templates.length + 1;
	let candidate = `agent-${i}`;
	while (existingIds.has(candidate)) {
		i += 1;
		candidate = `agent-${i}`;
	}
	return candidate;
}

export function convertTemplateProvider(template: AgentTemplate, provider: AgentProviderId): AgentTemplate {
	if (provider === template.provider) {
		return template;
	}

	if (provider === 'codex') {
		return {
			id: template.id,
			name: template.name,
			instructions: template.instructions,
			context: { ...template.context, linkedNoteContent: { ...template.context.linkedNoteContent } },
			provider: 'codex',
			providerConfig: { ...DEFAULT_CODEX_PROVIDER_CONFIG },
		};
	}

	return {
		id: template.id,
		name: template.name,
		instructions: template.instructions,
		context: { ...template.context, linkedNoteContent: { ...template.context.linkedNoteContent } },
		provider: 'ollama',
		providerConfig: { ...DEFAULT_OLLAMA_PROVIDER_CONFIG },
	};
}

function duplicateTemplate(template: AgentTemplate, templates: AgentTemplate[]): AgentTemplate {
	const id = createDuplicatedTemplateId(templates, template.id);
	const sourceName = template.name.trim() || template.id;
	const name = `Copy of ${sourceName}`;

	if (template.provider === 'codex') {
		return {
			id,
			name,
			instructions: template.instructions,
			context: { ...template.context, linkedNoteContent: { ...template.context.linkedNoteContent } },
			provider: 'codex',
			providerConfig: { ...template.providerConfig },
		};
	}

	return {
		id,
		name,
		instructions: template.instructions,
		context: { ...template.context, linkedNoteContent: { ...template.context.linkedNoteContent } },
		provider: 'ollama',
		providerConfig: { ...template.providerConfig },
	};
}

function createDuplicatedTemplateId(templates: AgentTemplate[], sourceId: string): string {
	const existingIds = new Set(templates.map((template) => template.id));

	const match = /^(.*?)-(\d+)$/u.exec(sourceId.trim());
	let baseId = sourceId.trim();
	let nextNumber = 2;
	if (match) {
		const parsedNumber = Number.parseInt(match[2] ?? '', 10);
		if (Number.isFinite(parsedNumber)) {
			baseId = (match[1] ?? '').trim() || sourceId.trim();
			nextNumber = parsedNumber + 1;
		}
	}

	if (!baseId) {
		baseId = 'agent';
	}

	let candidate = `${baseId}-${nextNumber}`;
	while (existingIds.has(candidate)) {
		nextNumber += 1;
		candidate = `${baseId}-${nextNumber}`;
	}
	return candidate;
}

function renderExecutionLog(containerEl: HTMLElement, entries: ExecutionLogEntry[]): void {
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
		const summaryEl = detailsEl.createEl('summary', { cls: 'agent-execution-log-summary' });

		summaryEl.createSpan({
			text: `${formatTimestamp(entry.timestamp)} - ${entry.originNote || 'Unknown note'} - ${entry.agentTemplateName} - ${formatDuration(entry.durationMs)}`,
		});
		if (entry.status === 'running') {
			summaryEl.createSpan({
				text: ' (running)',
				cls: 'agent-execution-log-running-label',
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
		createExecutionLogTextSection(bodyEl, 'Prompt', entry.prompt);
		createExecutionLogTextSection(bodyEl, 'Command line', formatCommandLine(entry.command, entry.commandArgs));
		createExecutionLogTextSection(
			bodyEl,
			'Process output (stdout/stderr)',
			entry.processOutput.trim() ? entry.processOutput : 'No process output captured.',
		);
		createExecutionLogTextSection(
			bodyEl,
			entry.status === 'running' ? 'Response (pending)' : (entry.wasError ? 'Response / error' : 'Response'),
			entry.status === 'running' ? 'In progress...' : entry.response,
		);
	}
}

function createExecutionLogTextSection(containerEl: HTMLElement, label: string, value: string): void {
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
	preEl.tabIndex = 0;
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

function normalizeTemperature(value: string): number {
	const parsed = Number.parseFloat(value.trim());
	if (!Number.isFinite(parsed)) {
		return DEFAULT_OLLAMA_PROVIDER_CONFIG.temperature;
	}
	if (parsed < 0) {
		return 0;
	}
	if (parsed > 2) {
		return 2;
	}
	return Number(parsed.toFixed(2));
}

function normalizeNumPredict(value: string): number {
	const parsed = Number.parseInt(value.trim(), 10);
	if (!Number.isFinite(parsed)) {
		return DEFAULT_OLLAMA_PROVIDER_CONFIG.numPredict;
	}
	if (parsed < 1) {
		return 1;
	}
	if (parsed > 32768) {
		return 32768;
	}
	return parsed;
}

export function createDefaultTemplateContextConfig(): AgentTemplateContextConfig {
	return {
		linkedNoteContent: { ...DEFAULT_TEMPLATE_CONTEXT_CONFIG.linkedNoteContent },
	};
}

function normalizeLinkedMaxNotes(value: string): number {
	const parsed = Number.parseInt(value.trim(), 10);
	if (!Number.isFinite(parsed)) {
		return DEFAULT_TEMPLATE_CONTEXT_CONFIG.linkedNoteContent.maxNotes;
	}
	if (parsed < 0) {
		return 0;
	}
	if (parsed > 50) {
		return 50;
	}
	return parsed;
}

function normalizeLinkedSelectionMode(value: string): LinkedNoteSelectionMode {
	if (value === 'recently-created') {
		return 'recently-created';
	}
	if (value === 'recently-modified') {
		return 'recently-modified';
	}
	return DEFAULT_TEMPLATE_CONTEXT_CONFIG.linkedNoteContent.selectionMode;
}

function normalizeLinkedMaxChars(value: string): number {
	const parsed = Number.parseInt(value.trim(), 10);
	if (!Number.isFinite(parsed)) {
		return DEFAULT_TEMPLATE_CONTEXT_CONFIG.linkedNoteContent.maxCharsPerNote;
	}
	if (parsed < 200) {
		return 200;
	}
	if (parsed > 100_000) {
		return 100_000;
	}
	return parsed;
}

function buildReasoningDropdownOptions(selectedValue: string): Array<{ value: string; label: string }> {
	const options = [...REASONING_OPTIONS];
	if (selectedValue && !options.some((option) => option.value === selectedValue)) {
		options.push({ value: selectedValue, label: `Custom (${selectedValue})` });
	}
	return options;
}
