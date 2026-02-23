import { App, PluginSettingTab, Setting } from 'obsidian';
import type { AgentProviderId } from '../../agent-types';
import {
	DEFAULT_OLLAMA_PROVIDER_CONFIG,
	createDefaultCodexAgentTemplate,
} from '../../domain/defaults';
import {
	normalizeAgentCacheMode,
	normalizeLinkedMaxChars,
	normalizeLinkedMaxNotes,
	normalizeLinkedSortDirection,
	normalizeLinkedSortField,
	normalizeNumPredict,
	normalizePromptCacheMaxEntries,
	normalizePromptCacheMaxEntriesPerBlock,
	normalizeTemperature,
	normalizeTimeoutSeconds,
} from '../../domain/normalizers';
import { convertTemplateProvider, createTemplateId, duplicateTemplate } from '../../domain/template-utils';
import type {
	AgentCacheMode,
	AgentTemplate,
	CodexAgentTemplate,
	LinkedNoteSortDirection,
	LinkedNoteSortField,
	OllamaAgentTemplate,
} from '../../domain/types';
import type { AgentBlocksPluginApi } from '../../plugin-api';
import {
	captureExecutionLogScrollState,
	renderExecutionLog,
	restoreExecutionLogScrollState,
} from './execution-log';

const REASONING_OPTIONS: Array<{ value: string; label: string }> = [
	{ value: '', label: 'CLI default' },
	{ value: 'minimal', label: 'minimal' },
	{ value: 'low', label: 'low' },
	{ value: 'medium', label: 'medium' },
	{ value: 'high', label: 'high' },
];

export class AgentSettingTab extends PluginSettingTab {
	plugin: AgentBlocksPluginApi;
	private readonly expandedTemplateIds = new Set<string>();
	private readonly expandedExecutionLogIds = new Set<string>();
	private executionLogCountSetting: Setting | null = null;
	private executionLogContainerEl: HTMLElement | null = null;
	private logRefreshTimeoutId: number | null = null;

	constructor(app: App, plugin: AgentBlocksPluginApi) {
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

		const globalInstructionsSetting = new Setting(containerEl)
			.setName('Global instructions')
			.setDesc('Additional instructions applied to every agent prompt.')
			.addTextArea((text) => {
				text.setPlaceholder('Keep output concise and use Obsidian wikilinks.');
				text.setValue(this.plugin.settings.globalInstructions);
				text.inputEl.rows = 8;
				text.inputEl.addClass('agent-template-instructions-input');
				text.onChange(async (value) => {
					this.plugin.settings.globalInstructions = value;
					await this.plugin.saveSettings();
				});
			});
		globalInstructionsSetting.settingEl.addClass('agent-template-instructions-setting');

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
			text: 'Use `template: your-template-id` in a block. Linked-note context can be overridden per block with `linked_content_*` filter and sort directives.',
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
			.setName('Prompt cache')
			.setHeading();

		new Setting(containerEl)
			.setName('Max cache entries')
			.setDesc('Maximum number of cached prompt responses to retain.')
			.addText((text) => text
				.setPlaceholder('1000')
				.setValue(String(this.plugin.settings.promptCacheMaxEntries))
				.onChange(async (value) => {
					this.plugin.settings.promptCacheMaxEntries = normalizePromptCacheMaxEntries(value);
					await this.plugin.applyPromptCacheLimit();
				}));

		new Setting(containerEl)
			.setName('Max entries per block')
			.setDesc('Maximum cached responses retained per individual agent block.')
			.addText((text) => text
				.setPlaceholder('5')
				.setValue(String(this.plugin.settings.promptCacheMaxEntriesPerBlock))
				.onChange(async (value) => {
					this.plugin.settings.promptCacheMaxEntriesPerBlock = normalizePromptCacheMaxEntriesPerBlock(value);
					await this.plugin.applyPromptCacheLimit();
				}));

		new Setting(containerEl)
			.setName('Cached prompts')
			.setDesc(`${Object.keys(this.plugin.settings.promptCache).length} saved.`)
			.addButton((button) => button
				.setButtonText('Clear cache')
					.onClick(async () => {
						this.plugin.settings.promptCache = {};
						this.plugin.settings.blockPromptCacheIndex = {};
						this.plugin.settings.blockPromptCacheHistory = {};
						this.plugin.settings.blockPromptCacheSourceFingerprintIndex = {};
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
					this.expandedExecutionLogIds.clear();
					await this.plugin.saveSettings();
					this.refreshExecutionLogSection();
				}));

		this.executionLogContainerEl = containerEl.createDiv({ cls: 'agent-execution-log-section' });
		this.pruneExpandedExecutionLogIds();
		renderExecutionLog(
			this.executionLogContainerEl,
			this.plugin.settings.executionLog,
			this.expandedExecutionLogIds,
			(id) => this.stopExecutionLogRun(id),
		);
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

		const scrollStates = captureExecutionLogScrollState(this.executionLogContainerEl);
		this.executionLogContainerEl.empty();
		this.pruneExpandedExecutionLogIds();
		renderExecutionLog(
			this.executionLogContainerEl,
			this.plugin.settings.executionLog,
			this.expandedExecutionLogIds,
			(id) => this.stopExecutionLogRun(id),
		);
		restoreExecutionLogScrollState(this.executionLogContainerEl, scrollStates);
	}

	private async stopExecutionLogRun(id: string): Promise<void> {
		await this.plugin.cancelExecutionLogRun(id);
		this.refreshExecutionLogSection();
	}

	private pruneExpandedExecutionLogIds(): void {
		const currentIds = new Set(this.plugin.settings.executionLog.map((entry) => entry.id));
		for (const id of this.expandedExecutionLogIds) {
			if (!currentIds.has(id)) {
				this.expandedExecutionLogIds.delete(id);
			}
		}
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

		const templateInstructionsSetting = new Setting(templateContainer)
			.setName('Template instructions')
			.setDesc('Prepended to the block instruction when this template is used.')
			.addTextArea((text) => {
				text.setPlaceholder('Summarize in bullet points and preserve note links.');
				text.setValue(template.instructions);
				text.inputEl.rows = 8;
				text.inputEl.addClass('agent-template-instructions-input');
				text.onChange(async (value) => {
					template.instructions = value;
					await this.plugin.saveSettings();
				});
			});
		templateInstructionsSetting.settingEl.addClass('agent-template-instructions-setting');

		new Setting(templateContainer)
			.setName('Cache mode')
			.setDesc('Controls whether prompt changes auto-refresh or keep using cached output until manual refresh.')
			.addDropdown((dropdown) => dropdown
				.addOption('auto-refresh', 'Auto refresh on prompt changes')
				.addOption('prefer-cache', 'Prefer cached result (manual refresh)')
				.setValue(template.cacheMode)
				.onChange(async (value: AgentCacheMode) => {
					template.cacheMode = normalizeAgentCacheMode(value);
					await this.plugin.saveSettings();
				}));

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
			.setName('Linked note filters')
			.setHeading();

		new Setting(containerEl)
			.setName('Include outgoing links')
			.setDesc('Allows outgoing links to be included as linked note content.')
			.addToggle((toggle) => toggle
				.setValue(template.context.linkedNoteContent.filters.includeOutgoingLinks)
				.onChange(async (value) => {
					template.context.linkedNoteContent.filters.includeOutgoingLinks = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Include backlinks')
			.setDesc('Allows backlinks to be included as linked note content.')
			.addToggle((toggle) => toggle
				.setValue(template.context.linkedNoteContent.filters.includeBacklinks)
				.onChange(async (value) => {
					template.context.linkedNoteContent.filters.includeBacklinks = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Require frontmatter field')
			.setDesc('Optional. If set, linked notes must contain this frontmatter field to be included.')
			.addText((text) => text
				.setPlaceholder('Example: review_date')
				.setValue(template.context.linkedNoteContent.filters.requiredFrontmatterField)
				.onChange(async (value) => {
					template.context.linkedNoteContent.filters.requiredFrontmatterField = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Linked note sort')
			.setHeading();

		new Setting(containerEl)
			.setName('Sort by')
			.setDesc('How linked notes are ordered before max-count trimming.')
			.addDropdown((dropdown) => dropdown
				.addOption('modified-date', 'Modified date')
				.addOption('created-date', 'Created date')
				.addOption('frontmatter-date', 'Frontmatter date field')
				.setValue(template.context.linkedNoteContent.sort.field)
				.onChange(async (value: LinkedNoteSortField) => {
					template.context.linkedNoteContent.sort.field = normalizeLinkedSortField(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sort direction')
			.setDesc('Descending is newest-first for date sorts.')
			.addDropdown((dropdown) => dropdown
				.addOption('descending', 'Descending')
				.addOption('ascending', 'Ascending')
				.setValue(template.context.linkedNoteContent.sort.direction)
				.onChange(async (value: LinkedNoteSortDirection) => {
					template.context.linkedNoteContent.sort.direction = normalizeLinkedSortDirection(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Frontmatter date field')
			.setDesc('Used when sort by = frontmatter date field. Example: review_date')
			.addText((text) => text
				.setPlaceholder('Example: review_date')
				.setValue(template.context.linkedNoteContent.sort.frontmatterDateField)
				.onChange(async (value) => {
					template.context.linkedNoteContent.sort.frontmatterDateField = value.trim();
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

function buildReasoningDropdownOptions(selectedValue: string): Array<{ value: string; label: string }> {
	const options = [...REASONING_OPTIONS];
	if (selectedValue && !options.some((option) => option.value === selectedValue)) {
		options.push({ value: selectedValue, label: `Custom (${selectedValue})` });
	}
	return options;
}
