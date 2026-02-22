import type { AgentBlockOverrides } from '../agent-types';
import {
	normalizeLinkedMaxChars,
	normalizeLinkedMaxNotes,
	normalizeLinkedSortDirection,
	normalizeLinkedSortField,
	normalizeOptionalString,
} from '../domain/normalizers';
import type {
	AgentCacheMode,
	AgentTemplateContextConfig,
	LinkedNoteFiltersConfig,
	LinkedNoteSortConfig,
	LinkedNoteSortDirection,
	LinkedNoteSortField,
} from '../domain/types';
import type { AgentBlockDependencies, ResolvedBlockRequest } from './dependencies';

interface BlockContextOverrides {
	linkedNoteContent?: {
		enabled?: boolean;
		maxNotes?: number;
		maxCharsPerNote?: number;
		filters?: Partial<LinkedNoteFiltersConfig>;
		sort?: Partial<LinkedNoteSortConfig>;
	};
}

interface BlockExecutionOverrides {
	cacheMode?: AgentCacheMode;
}

const TEMPLATE_REFERENCE_REGEX = /^(template|use)\s*:\s*(.+)$/iu;
const MODEL_REFERENCE_REGEX = /^model\s*:\s*(.+)$/iu;
const REASONING_REFERENCE_REGEX = /^(reasoning|reasoning_effort)\s*:\s*(.+)$/iu;
const TEMPERATURE_REFERENCE_REGEX = /^temperature\s*:\s*(.+)$/iu;
const TIMEOUT_REFERENCE_REGEX = /^(timeout|timeout_seconds|execution_timeout_seconds)\s*:\s*(.+)$/iu;
const MCP_REFERENCE_REGEX = /^(mcp|mcp_enabled)\s*:\s*(.+)$/iu;
const HOST_REFERENCE_REGEX = /^host\s*:\s*(.+)$/iu;
const KEEP_ALIVE_REFERENCE_REGEX = /^(keep_alive|keepalive)\s*:\s*(.+)$/iu;
const NUM_PREDICT_REFERENCE_REGEX = /^(num_predict|max_tokens)\s*:\s*(.+)$/iu;
const OSS_REFERENCE_REGEX = /^(oss|codex_oss)\s*:\s*(.+)$/iu;
const LOCAL_PROVIDER_REFERENCE_REGEX = /^(local_provider|codex_local_provider)\s*:\s*(.+)$/iu;
const CACHE_MODE_REFERENCE_REGEX = /^(cache_mode)\s*:\s*(.+)$/iu;
const CONTEXT_LINKED_ENABLED_REGEX = /^(context\.linked_note_content\.enabled|linked_content)\s*:\s*(.+)$/iu;
const CONTEXT_LINKED_MAX_NOTES_REGEX = /^(context\.linked_note_content\.max_notes|linked_content_max_notes)\s*:\s*(.+)$/iu;
const CONTEXT_LINKED_MAX_CHARS_REGEX = /^(context\.linked_note_content\.max_chars_per_note|linked_content_max_chars)\s*:\s*(.+)$/iu;
const CONTEXT_LINKED_INCLUDE_OUTGOING_REGEX = /^(context\.linked_note_content\.filters\.include_outgoing_links|context\.linked_note_content\.include_outgoing_links|linked_content_include_outgoing)\s*:\s*(.+)$/iu;
const CONTEXT_LINKED_INCLUDE_BACKLINKS_REGEX = /^(context\.linked_note_content\.filters\.include_backlinks|context\.linked_note_content\.include_backlinks|linked_content_include_backlinks)\s*:\s*(.+)$/iu;
const CONTEXT_LINKED_REQUIRED_FRONTMATTER_FIELD_REGEX = /^(context\.linked_note_content\.filters\.required_frontmatter_field|linked_content_filter_required_frontmatter_field)\s*:\s*(.+)$/iu;
const CONTEXT_LINKED_SORT_FIELD_REGEX = /^(context\.linked_note_content\.sort\.field|linked_content_sort_by)\s*:\s*(.+)$/iu;
const CONTEXT_LINKED_SORT_DIRECTION_REGEX = /^(context\.linked_note_content\.sort\.direction|linked_content_sort_direction)\s*:\s*(.+)$/iu;
const CONTEXT_LINKED_SORT_FRONTMATTER_FIELD_REGEX = /^(context\.linked_note_content\.sort\.frontmatter_date_field|linked_content_sort_frontmatter_date_field)\s*:\s*(.+)$/iu;
const CONTEXT_LINKED_SELECTION_REGEX = /^(context\.linked_note_content\.selection|linked_content_selection)\s*:\s*(.+)$/iu;

export function resolveBlockRequest(source: string, dependencies: AgentBlockDependencies): ResolvedBlockRequest {
	if (!source.trim()) {
		throw new Error('The agent block is empty. Add instructions or reference a template.');
	}

	const lines = source.split(/\r?\n/u);
	const directives = extractBlockDirectives(lines);
	const instructionBody = lines.slice(directives.instructionsStartIndex).join('\n').trim();
	const template = dependencies.resolveTemplate(directives.templateId);

	if (!template) {
		if (directives.templateId) {
			throw new Error(`No agent template found for ID "${directives.templateId}".`);
		}
		throw new Error('No agent templates are configured. Create one in plugin settings.');
	}

	const instructionParts = [template.instructions.trim(), instructionBody].filter((part) => part.length > 0);
	if (instructionParts.length === 0) {
		throw new Error('No instruction was provided. Add instructions in the block or template.');
	}

	return {
		template,
		prompt: instructionParts.join('\n\n'),
		overrides: directives.overrides,
		contextConfig: applyContextOverrides(template.context, directives.contextOverrides),
		cacheMode: directives.executionOverrides.cacheMode ?? template.cacheMode,
	};
}

function extractBlockDirectives(lines: string[]): {
	templateId: string | null;
	overrides: AgentBlockOverrides;
	contextOverrides: BlockContextOverrides;
	executionOverrides: BlockExecutionOverrides;
	instructionsStartIndex: number;
} {
	let index = 0;
	while (index < lines.length && (lines[index]?.trim().length ?? 0) === 0) {
		index += 1;
	}

	let templateId: string | null = null;
	const overrides: AgentBlockOverrides = {};
	const contextOverrides: BlockContextOverrides = {};
	const executionOverrides: BlockExecutionOverrides = {};

	while (index < lines.length) {
		const line = lines[index] ?? '';
		const trimmed = line.trim();
		if (!trimmed) {
			index += 1;
			continue;
		}

		const templateMatch = TEMPLATE_REFERENCE_REGEX.exec(trimmed);
		if (templateMatch) {
			const parsedTemplateId = (templateMatch[2] ?? '').trim();
			if (!parsedTemplateId) {
				throw new Error('Template directive is missing a value. Use: template: your-template-id');
			}
			templateId = parsedTemplateId;
			index += 1;
			continue;
		}

		const modelMatch = MODEL_REFERENCE_REGEX.exec(trimmed);
		if (modelMatch) {
			overrides.model = requireNonEmptyValue(modelMatch[2], 'Model override is missing a value. Use: model: gpt-5-mini');
			index += 1;
			continue;
		}

		const reasoningMatch = REASONING_REFERENCE_REGEX.exec(trimmed);
		if (reasoningMatch) {
			overrides.reasoningEffort = requireNonEmptyValue(
				reasoningMatch[2],
				'Reasoning override is missing a value. Use: reasoning: low',
			);
			index += 1;
			continue;
		}

		const temperatureMatch = TEMPERATURE_REFERENCE_REGEX.exec(trimmed);
		if (temperatureMatch) {
			overrides.temperature = parseNumberDirective(
				temperatureMatch[2],
				'Temperature override must be a number. Use: temperature: 0.2',
			);
			index += 1;
			continue;
		}

		const timeoutMatch = TIMEOUT_REFERENCE_REGEX.exec(trimmed);
		if (timeoutMatch) {
			overrides.executionTimeoutSeconds = parseIntegerDirective(
				timeoutMatch[2],
				'Timeout override must be an integer. Use: timeout: 120',
			);
			index += 1;
			continue;
		}

		const mcpMatch = MCP_REFERENCE_REGEX.exec(trimmed);
		if (mcpMatch) {
			overrides.mcpEnabled = parseBooleanDirective(
				mcpMatch[2],
				'MCP override must be true or false. Use: mcp: false',
			);
			index += 1;
			continue;
		}

		const hostMatch = HOST_REFERENCE_REGEX.exec(trimmed);
		if (hostMatch) {
			overrides.host = requireNonEmptyValue(hostMatch[2], 'Host override is missing a value. Use: host: http://127.0.0.1:11434');
			index += 1;
			continue;
		}

		const keepAliveMatch = KEEP_ALIVE_REFERENCE_REGEX.exec(trimmed);
		if (keepAliveMatch) {
			overrides.keepAlive = requireNonEmptyValue(keepAliveMatch[2], 'Keep alive override is missing a value. Use: keep_alive: 5m');
			index += 1;
			continue;
		}

		const numPredictMatch = NUM_PREDICT_REFERENCE_REGEX.exec(trimmed);
		if (numPredictMatch) {
			overrides.numPredict = parseIntegerDirective(
				numPredictMatch[2],
				'num_predict override must be an integer. Use: num_predict: 512',
			);
			index += 1;
			continue;
		}

		const ossMatch = OSS_REFERENCE_REGEX.exec(trimmed);
		if (ossMatch) {
			overrides.useOssModelProvider = parseBooleanDirective(
				ossMatch[2],
				'OSS override must be true or false. Use: oss: true',
			);
			index += 1;
			continue;
		}

		const localProviderMatch = LOCAL_PROVIDER_REFERENCE_REGEX.exec(trimmed);
		if (localProviderMatch) {
			overrides.localProvider = requireNonEmptyValue(
				localProviderMatch[2],
				'Local provider override is missing a value. Use: local_provider: ollama',
			);
			index += 1;
			continue;
		}

		const cacheModeMatch = CACHE_MODE_REFERENCE_REGEX.exec(trimmed);
		if (cacheModeMatch) {
			executionOverrides.cacheMode = parseCacheModeDirective(
				cacheModeMatch[2],
				'Cache mode override must be "auto-refresh" or "prefer-cache". Use: cache_mode: prefer-cache',
			);
			index += 1;
			continue;
		}

		const linkedEnabledMatch = CONTEXT_LINKED_ENABLED_REGEX.exec(trimmed);
		if (linkedEnabledMatch) {
			contextOverrides.linkedNoteContent = {
				...contextOverrides.linkedNoteContent,
				enabled: parseBooleanDirective(
					linkedEnabledMatch[2],
					'Linked content override must be true or false. Use: linked_content: true',
				),
			};
			index += 1;
			continue;
		}

		const linkedMaxNotesMatch = CONTEXT_LINKED_MAX_NOTES_REGEX.exec(trimmed);
		if (linkedMaxNotesMatch) {
			contextOverrides.linkedNoteContent = {
				...contextOverrides.linkedNoteContent,
				maxNotes: parseIntegerDirective(
					linkedMaxNotesMatch[2],
					'Linked content max notes must be an integer. Use: linked_content_max_notes: 5',
				),
			};
			index += 1;
			continue;
		}

		const linkedMaxCharsMatch = CONTEXT_LINKED_MAX_CHARS_REGEX.exec(trimmed);
		if (linkedMaxCharsMatch) {
			contextOverrides.linkedNoteContent = {
				...contextOverrides.linkedNoteContent,
				maxCharsPerNote: parseIntegerDirective(
					linkedMaxCharsMatch[2],
					'Linked content max chars must be an integer. Use: linked_content_max_chars: 2000',
				),
			};
			index += 1;
			continue;
		}

		const linkedSelectionMatch = CONTEXT_LINKED_SELECTION_REGEX.exec(trimmed);
		if (linkedSelectionMatch) {
			contextOverrides.linkedNoteContent = {
				...contextOverrides.linkedNoteContent,
				sort: {
					...(contextOverrides.linkedNoteContent?.sort ?? {}),
					field: parseLegacyLinkedSelectionDirective(
						linkedSelectionMatch[2],
						'Linked selection override must be "recently-modified" or "recently-created". Use: linked_content_selection: recently-created',
					),
				},
			};
			index += 1;
			continue;
		}

		const linkedIncludeOutgoingMatch = CONTEXT_LINKED_INCLUDE_OUTGOING_REGEX.exec(trimmed);
		if (linkedIncludeOutgoingMatch) {
			contextOverrides.linkedNoteContent = {
				...contextOverrides.linkedNoteContent,
				filters: {
					...(contextOverrides.linkedNoteContent?.filters ?? {}),
					includeOutgoingLinks: parseBooleanDirective(
						linkedIncludeOutgoingMatch[2],
						'Linked outgoing override must be true or false. Use: linked_content_include_outgoing: true',
					),
				},
			};
			index += 1;
			continue;
		}

		const linkedIncludeBacklinksMatch = CONTEXT_LINKED_INCLUDE_BACKLINKS_REGEX.exec(trimmed);
		if (linkedIncludeBacklinksMatch) {
			contextOverrides.linkedNoteContent = {
				...contextOverrides.linkedNoteContent,
				filters: {
					...(contextOverrides.linkedNoteContent?.filters ?? {}),
					includeBacklinks: parseBooleanDirective(
						linkedIncludeBacklinksMatch[2],
						'Linked backlinks override must be true or false. Use: linked_content_include_backlinks: false',
					),
				},
			};
			index += 1;
			continue;
		}

		const linkedRequiredFrontmatterFieldMatch = CONTEXT_LINKED_REQUIRED_FRONTMATTER_FIELD_REGEX.exec(trimmed);
		if (linkedRequiredFrontmatterFieldMatch) {
			contextOverrides.linkedNoteContent = {
				...contextOverrides.linkedNoteContent,
				filters: {
					...(contextOverrides.linkedNoteContent?.filters ?? {}),
					requiredFrontmatterField: linkedRequiredFrontmatterFieldMatch[2]?.trim() ?? '',
				},
			};
			index += 1;
			continue;
		}

		const linkedSortFieldMatch = CONTEXT_LINKED_SORT_FIELD_REGEX.exec(trimmed);
		if (linkedSortFieldMatch) {
			contextOverrides.linkedNoteContent = {
				...contextOverrides.linkedNoteContent,
				sort: {
					...(contextOverrides.linkedNoteContent?.sort ?? {}),
					field: parseLinkedSortFieldDirective(
						linkedSortFieldMatch[2],
						'Linked sort override must be "modified-date", "created-date", or "frontmatter-date". Use: linked_content_sort_by: frontmatter-date',
					),
				},
			};
			index += 1;
			continue;
		}

		const linkedSortDirectionMatch = CONTEXT_LINKED_SORT_DIRECTION_REGEX.exec(trimmed);
		if (linkedSortDirectionMatch) {
			contextOverrides.linkedNoteContent = {
				...contextOverrides.linkedNoteContent,
				sort: {
					...(contextOverrides.linkedNoteContent?.sort ?? {}),
					direction: parseLinkedSortDirectionDirective(
						linkedSortDirectionMatch[2],
						'Linked sort direction override must be "descending" or "ascending". Use: linked_content_sort_direction: descending',
					),
				},
			};
			index += 1;
			continue;
		}

		const linkedSortFrontmatterFieldMatch = CONTEXT_LINKED_SORT_FRONTMATTER_FIELD_REGEX.exec(trimmed);
		if (linkedSortFrontmatterFieldMatch) {
			contextOverrides.linkedNoteContent = {
				...contextOverrides.linkedNoteContent,
				sort: {
					...(contextOverrides.linkedNoteContent?.sort ?? {}),
					frontmatterDateField: linkedSortFrontmatterFieldMatch[2]?.trim() ?? '',
				},
			};
			index += 1;
			continue;
		}

		break;
	}

	return {
		templateId,
		overrides,
		contextOverrides,
		executionOverrides,
		instructionsStartIndex: index,
	};
}

function requireNonEmptyValue(value: string | undefined, message: string): string {
	const normalized = (value ?? '').trim();
	if (!normalized) {
		throw new Error(message);
	}
	return normalized;
}

function parseNumberDirective(value: string | undefined, message: string): number {
	const parsed = Number.parseFloat((value ?? '').trim());
	if (!Number.isFinite(parsed)) {
		throw new Error(message);
	}
	return parsed;
}

function parseIntegerDirective(value: string | undefined, message: string): number {
	const parsed = Number.parseInt((value ?? '').trim(), 10);
	if (!Number.isFinite(parsed)) {
		throw new Error(message);
	}
	return parsed;
}

function parseBooleanDirective(value: string | undefined, message: string): boolean {
	const normalized = (value ?? '').trim().toLowerCase();
	if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
		return true;
	}
	if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
		return false;
	}
	throw new Error(message);
}

function parseLegacyLinkedSelectionDirective(value: string | undefined, message: string): LinkedNoteSortField {
	const normalized = (value ?? '').trim().toLowerCase();
	if (normalized === 'recently-modified') {
		return 'modified-date';
	}
	if (normalized === 'recently-created') {
		return 'created-date';
	}
	throw new Error(message);
}

function parseLinkedSortFieldDirective(value: string | undefined, message: string): LinkedNoteSortField {
	const normalized = (value ?? '').trim().toLowerCase();
	if (normalized === 'modified-date') {
		return 'modified-date';
	}
	if (normalized === 'created-date') {
		return 'created-date';
	}
	if (normalized === 'frontmatter-date') {
		return 'frontmatter-date';
	}
	throw new Error(message);
}

function parseLinkedSortDirectionDirective(value: string | undefined, message: string): LinkedNoteSortDirection {
	const normalized = (value ?? '').trim().toLowerCase();
	if (normalized === 'descending') {
		return 'descending';
	}
	if (normalized === 'ascending') {
		return 'ascending';
	}
	throw new Error(message);
}

function parseCacheModeDirective(value: string | undefined, message: string): AgentCacheMode {
	const normalized = (value ?? '').trim().toLowerCase();
	if (normalized === 'prefer-cache' || normalized === 'manual-refresh') {
		return 'prefer-cache';
	}
	if (normalized === 'auto-refresh') {
		return 'auto-refresh';
	}
	throw new Error(message);
}

function applyContextOverrides(
	baseContext: AgentTemplateContextConfig,
	overrides: BlockContextOverrides,
): AgentTemplateContextConfig {
	const linkedOverrides = overrides.linkedNoteContent ?? {};
	return {
		linkedNoteContent: {
			enabled: typeof linkedOverrides.enabled === 'boolean'
				? linkedOverrides.enabled
				: baseContext.linkedNoteContent.enabled,
			maxNotes: normalizeLinkedMaxNotes(linkedOverrides.maxNotes ?? baseContext.linkedNoteContent.maxNotes),
			maxCharsPerNote: normalizeLinkedMaxChars(
				linkedOverrides.maxCharsPerNote ?? baseContext.linkedNoteContent.maxCharsPerNote,
			),
			filters: {
				includeOutgoingLinks: typeof linkedOverrides.filters?.includeOutgoingLinks === 'boolean'
					? linkedOverrides.filters.includeOutgoingLinks
					: baseContext.linkedNoteContent.filters.includeOutgoingLinks,
				includeBacklinks: typeof linkedOverrides.filters?.includeBacklinks === 'boolean'
					? linkedOverrides.filters.includeBacklinks
					: baseContext.linkedNoteContent.filters.includeBacklinks,
				requiredFrontmatterField: normalizeOptionalString(
					linkedOverrides.filters?.requiredFrontmatterField
						?? baseContext.linkedNoteContent.filters.requiredFrontmatterField,
				),
			},
			sort: {
				field: normalizeLinkedSortField(
					linkedOverrides.sort?.field ?? baseContext.linkedNoteContent.sort.field,
				),
				direction: normalizeLinkedSortDirection(
					linkedOverrides.sort?.direction ?? baseContext.linkedNoteContent.sort.direction,
				),
				frontmatterDateField: normalizeOptionalString(
					linkedOverrides.sort?.frontmatterDateField
						?? baseContext.linkedNoteContent.sort.frontmatterDateField,
				),
			},
		},
	};
}
