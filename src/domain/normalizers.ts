import {
	DEFAULT_CODEX_PROVIDER_CONFIG,
	DEFAULT_OLLAMA_PROVIDER_CONFIG,
	DEFAULT_SETTINGS,
	DEFAULT_TEMPLATE_CONTEXT_CONFIG,
} from './defaults';
import type { AgentCacheMode, LinkedNoteSortDirection, LinkedNoteSortField } from './types';

export function normalizeAgentCacheMode(value: unknown): AgentCacheMode {
	if (typeof value === 'string' && value.trim().toLowerCase() === 'prefer-cache') {
		return 'prefer-cache';
	}
	return 'auto-refresh';
}

export function normalizeOptionalString(value: unknown): string {
	if (typeof value !== 'string') {
		return '';
	}
	return value.trim();
}

export function normalizeLinkedSortField(
	value: unknown,
	fallback: LinkedNoteSortField = DEFAULT_TEMPLATE_CONTEXT_CONFIG.linkedNoteContent.sort.field,
): LinkedNoteSortField {
	if (typeof value !== 'string') {
		return fallback;
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === 'created-date' || normalized === 'recently-created') {
		return 'created-date';
	}
	if (normalized === 'frontmatter-date') {
		return 'frontmatter-date';
	}
	if (normalized === 'modified-date' || normalized === 'recently-modified') {
		return 'modified-date';
	}
	return fallback;
}

export function normalizeLinkedSortDirection(
	value: unknown,
	fallback: LinkedNoteSortDirection = DEFAULT_TEMPLATE_CONTEXT_CONFIG.linkedNoteContent.sort.direction,
): LinkedNoteSortDirection {
	if (typeof value !== 'string') {
		return fallback;
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === 'ascending') {
		return 'ascending';
	}
	if (normalized === 'descending') {
		return 'descending';
	}
	return fallback;
}

export function normalizeTimeoutSeconds(
	value: unknown,
	fallback: number = DEFAULT_CODEX_PROVIDER_CONFIG.executionTimeoutSeconds,
): number {
	const parsed = parseNumber(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	if (parsed < 15) {
		return 15;
	}
	if (parsed > 3600) {
		return 3600;
	}
	return Math.round(parsed);
}

export function normalizeTemperature(
	value: unknown,
	fallback: number = DEFAULT_OLLAMA_PROVIDER_CONFIG.temperature,
): number {
	const parsed = parseNumber(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	if (parsed < 0) {
		return 0;
	}
	if (parsed > 2) {
		return 2;
	}
	return Number(parsed.toFixed(2));
}

export function normalizeNumPredict(
	value: unknown,
	fallback: number = DEFAULT_OLLAMA_PROVIDER_CONFIG.numPredict,
): number {
	const parsed = parseInteger(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	if (parsed < 1) {
		return 1;
	}
	if (parsed > 32768) {
		return 32768;
	}
	return Math.round(parsed);
}

export function normalizePromptCacheMaxEntries(
	value: unknown,
	fallback: number = DEFAULT_SETTINGS.promptCacheMaxEntries,
): number {
	const parsed = parseInteger(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	if (parsed < 1) {
		return 1;
	}
	if (parsed > 50_000) {
		return 50_000;
	}
	return Math.round(parsed);
}

export function normalizePromptCacheMaxEntriesPerBlock(
	value: unknown,
	fallback: number = DEFAULT_SETTINGS.promptCacheMaxEntriesPerBlock,
): number {
	const parsed = parseInteger(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	if (parsed < 1) {
		return 1;
	}
	if (parsed > 100) {
		return 100;
	}
	return Math.round(parsed);
}

export function normalizeLinkedMaxNotes(
	value: unknown,
	fallback: number = DEFAULT_TEMPLATE_CONTEXT_CONFIG.linkedNoteContent.maxNotes,
): number {
	const parsed = parseInteger(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	if (parsed < 0) {
		return 0;
	}
	if (parsed > 50) {
		return 50;
	}
	return Math.round(parsed);
}

export function normalizeLinkedMaxChars(
	value: unknown,
	fallback: number = DEFAULT_TEMPLATE_CONTEXT_CONFIG.linkedNoteContent.maxCharsPerNote,
): number {
	const parsed = parseInteger(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	if (parsed < 200) {
		return 200;
	}
	if (parsed > 100_000) {
		return 100_000;
	}
	return Math.round(parsed);
}

function parseNumber(value: unknown): number {
	if (typeof value === 'number') {
		return value;
	}
	if (typeof value === 'string') {
		const parsed = Number.parseFloat(value.trim());
		return parsed;
	}
	return Number.NaN;
}

function parseInteger(value: unknown): number {
	if (typeof value === 'number') {
		return Math.round(value);
	}
	if (typeof value === 'string') {
		const parsed = Number.parseInt(value.trim(), 10);
		return parsed;
	}
	return Number.NaN;
}
