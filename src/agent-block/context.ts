import path from 'path';
import { stat } from 'fs/promises';
import { FileSystemAdapter, MarkdownView, Plugin, TFile } from 'obsidian';
import type {
	AgentTemplateContextConfig,
	LinkedNoteContentContextConfig,
	LinkedNoteSortConfig,
	LinkedNoteSortDirection,
	LinkedNoteSortField,
} from '../domain/types';

export interface PromptContext {
	vaultRootPath: string;
	currentFilePath: string;
	currentFileVaultPath: string;
	currentNoteContent: string;
	currentNoteAvailable: boolean;
	linkedNoteSnapshots: LinkedNoteSnapshot[];
	linkedNoteContentEnabled: boolean;
	linkedNoteSortField: LinkedNoteSortField;
	linkedNoteSortDirection: LinkedNoteSortDirection;
	linkedNoteSortFrontmatterDateField: string;
	linkedNoteRequiredFrontmatterField: string;
	linkedNoteIncludeOutgoingLinks: boolean;
	linkedNoteIncludeBacklinks: boolean;
}

export interface LinkedNoteSnapshot {
	path: string;
	relationship: 'outgoing' | 'backlink' | 'outgoing+backlink';
	content: string;
	wasTruncated: boolean;
}

interface LinkedNoteCandidate {
	file: TFile;
	createdTimestamp: number;
	sortTimestamp: number | null;
	frontmatter: Record<string, unknown> | null;
}

export async function buildPromptContext(
	plugin: Plugin,
	sourcePath: string,
	contextConfig: AgentTemplateContextConfig,
): Promise<PromptContext> {
	const vaultRootPath = getVaultRootPath(plugin);
	const currentNote = await getCurrentNoteContent(plugin, sourcePath);
	const linkedNoteSnapshots = await getLinkedNoteSnapshots(plugin, sourcePath, contextConfig.linkedNoteContent);
	return {
		vaultRootPath,
		currentFilePath: getAbsoluteFilePath(vaultRootPath, sourcePath),
		currentFileVaultPath: sourcePath || '(current file path unavailable)',
		currentNoteContent: currentNote.content,
		currentNoteAvailable: currentNote.available,
		linkedNoteSnapshots,
		linkedNoteContentEnabled: contextConfig.linkedNoteContent.enabled,
		linkedNoteSortField: contextConfig.linkedNoteContent.sort.field,
		linkedNoteSortDirection: contextConfig.linkedNoteContent.sort.direction,
		linkedNoteSortFrontmatterDateField: contextConfig.linkedNoteContent.sort.frontmatterDateField,
		linkedNoteRequiredFrontmatterField: contextConfig.linkedNoteContent.filters.requiredFrontmatterField,
		linkedNoteIncludeOutgoingLinks: contextConfig.linkedNoteContent.filters.includeOutgoingLinks,
		linkedNoteIncludeBacklinks: contextConfig.linkedNoteContent.filters.includeBacklinks,
	};
}

function getVaultRootPath(plugin: Plugin): string {
	const adapter = plugin.app.vault.adapter;
	if (adapter instanceof FileSystemAdapter) {
		return adapter.getBasePath();
	}
	return '(vault root path unavailable)';
}

function getAbsoluteFilePath(vaultRootPath: string, sourcePath: string): string {
	if (!sourcePath) {
		return '(current file path unavailable)';
	}
	if (vaultRootPath.startsWith('(')) {
		return sourcePath;
	}
	const normalizedSourcePath = sourcePath.split('/').join(path.sep);
	return path.join(vaultRootPath, normalizedSourcePath);
}

function getBacklinks(plugin: Plugin, sourcePath: string): string[] {
	if (!sourcePath) {
		return [];
	}

	const backlinks = new Set<string>();
	for (const [candidateSource, targets] of Object.entries(plugin.app.metadataCache.resolvedLinks)) {
		if ((targets[sourcePath] ?? 0) > 0) {
			backlinks.add(candidateSource);
		}
	}
	return [...backlinks].sort((a, b) => a.localeCompare(b));
}

async function getCurrentNoteContent(
	plugin: Plugin,
	sourcePath: string,
): Promise<{ content: string; available: boolean }> {
	if (!sourcePath) {
		return {
			content: 'Current note path is unavailable.',
			available: false,
		};
	}

	const abstractFile = plugin.app.vault.getAbstractFileByPath(sourcePath);
	if (!(abstractFile instanceof TFile)) {
		return {
			content: `Current note "${sourcePath}" could not be resolved.`,
			available: false,
		};
	}

	const openViewContent = getOpenMarkdownViewContent(plugin, sourcePath);
	if (openViewContent !== null) {
		return {
			content: normalizeLinkedContent(openViewContent),
			available: true,
		};
	}

	try {
		const content = await plugin.app.vault.cachedRead(abstractFile);
		return {
			content: normalizeLinkedContent(content),
			available: true,
		};
	} catch {
		return {
			content: `Current note "${sourcePath}" could not be read.`,
			available: false,
		};
	}
}

function getOpenMarkdownViewContent(plugin: Plugin, sourcePath: string): string | null {
	let currentContent: string | null = null;
	plugin.app.workspace.iterateAllLeaves((leaf) => {
		if (currentContent !== null) {
			return;
		}
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) {
			return;
		}
		if (view.file?.path !== sourcePath) {
			return;
		}
		currentContent = view.getViewData();
	});
	return currentContent;
}

async function getLinkedNoteSnapshots(
	plugin: Plugin,
	sourcePath: string,
	config: LinkedNoteContentContextConfig,
): Promise<LinkedNoteSnapshot[]> {
	if (!config.enabled || config.maxNotes < 1) {
		return [];
	}

	const relationshipByPath = new Map<string, { outgoing: boolean; backlink: boolean }>();
	if (config.filters.includeOutgoingLinks) {
		for (const linkPath of getOutgoingLinkCandidates(plugin, sourcePath)) {
			const linkedFile = resolveLinkedMarkdownFile(plugin, linkPath, sourcePath);
			if (!linkedFile) {
				continue;
			}
			const existing = relationshipByPath.get(linkedFile.path) ?? { outgoing: false, backlink: false };
			existing.outgoing = true;
			relationshipByPath.set(linkedFile.path, existing);
		}
	}
	if (config.filters.includeBacklinks) {
		for (const linkPath of getBacklinks(plugin, sourcePath)) {
			const linkedFile = resolveLinkedMarkdownFile(plugin, linkPath, sourcePath);
			if (!linkedFile) {
				continue;
			}
			const existing = relationshipByPath.get(linkedFile.path) ?? { outgoing: false, backlink: false };
			existing.backlink = true;
			relationshipByPath.set(linkedFile.path, existing);
		}
	}

	relationshipByPath.delete(sourcePath);
	const candidateFiles = [...relationshipByPath.keys()]
		.map((linkedPath) => resolveLinkedMarkdownFile(plugin, linkedPath, sourcePath))
		.filter((file): file is TFile => file !== null);
	const fileSystemAdapter = getFileSystemAdapter(plugin);
	const candidates = await Promise.all(candidateFiles.map(async (file) => {
		const createdTimestamp = await getCreatedTimestamp(fileSystemAdapter, file);
		const frontmatter = getNoteFrontmatter(plugin, file);
		const requiredFrontmatterField = config.filters.requiredFrontmatterField;
		if (requiredFrontmatterField && !hasRequiredFrontmatterField(frontmatter, requiredFrontmatterField)) {
			return null;
		}

		return {
			file,
			createdTimestamp,
			sortTimestamp: resolveLinkedSortTimestamp({
				file,
				createdTimestamp,
				frontmatter,
				sort: config.sort,
			}),
			frontmatter,
		};
	}));
	const filteredCandidates = candidates.filter((candidate): candidate is LinkedNoteCandidate => candidate !== null);
	filteredCandidates.sort((a, b) => compareLinkedNoteCandidates(a, b, config.sort));
	const snapshots: LinkedNoteSnapshot[] = [];

	for (const candidate of filteredCandidates) {
		if (snapshots.length >= config.maxNotes) {
			break;
		}
		const candidateFile = candidate.file;
		const linkedPath = candidateFile.path;

		try {
			const rawContent = await plugin.app.vault.cachedRead(candidateFile);
			const normalizedContent = normalizeLinkedContent(rawContent);
			if (!normalizedContent.trim()) {
				continue;
			}

			const trimmedContent = normalizedContent.slice(0, config.maxCharsPerNote);
			const wasTruncated = normalizedContent.length > config.maxCharsPerNote;
			const relationship = relationshipByPath.get(linkedPath) ?? { outgoing: false, backlink: false };
			snapshots.push({
				path: linkedPath,
				relationship: getRelationshipLabel(relationship),
				content: trimmedContent,
				wasTruncated,
			});
		} catch {
			// Skip unreadable files without failing the block.
		}
	}

	return snapshots;
}

function resolveLinkedMarkdownFile(plugin: Plugin, linkPath: string, sourcePath: string): TFile | null {
	const direct = plugin.app.vault.getAbstractFileByPath(linkPath);
	if (direct instanceof TFile && direct.extension === 'md') {
		return direct;
	}

	if (!linkPath.endsWith('.md')) {
		const withMd = plugin.app.vault.getAbstractFileByPath(`${linkPath}.md`);
		if (withMd instanceof TFile && withMd.extension === 'md') {
			return withMd;
		}
	}

	const resolved = plugin.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
	if (resolved instanceof TFile && resolved.extension === 'md') {
		return resolved;
	}

	if (linkPath.endsWith('.md')) {
		const withoutExt = linkPath.slice(0, -3);
		const resolvedWithoutExt = plugin.app.metadataCache.getFirstLinkpathDest(withoutExt, sourcePath);
		if (resolvedWithoutExt instanceof TFile && resolvedWithoutExt.extension === 'md') {
			return resolvedWithoutExt;
		}
	}

	return null;
}

function compareLinkedNoteCandidates(
	a: LinkedNoteCandidate,
	b: LinkedNoteCandidate,
	sort: LinkedNoteSortConfig,
): number {
	const directionMultiplier = sort.direction === 'ascending' ? 1 : -1;
	const bySortTimestamp = compareSortTimestamps(a.sortTimestamp, b.sortTimestamp, directionMultiplier);
	if (bySortTimestamp !== 0) {
		return bySortTimestamp;
	}

	const byMtime = (a.file.stat.mtime - b.file.stat.mtime) * directionMultiplier;
	if (byMtime !== 0) {
		return byMtime;
	}

	return a.file.path.localeCompare(b.file.path);
}

function compareSortTimestamps(
	aTimestamp: number | null,
	bTimestamp: number | null,
	directionMultiplier: number,
): number {
	const aMissing = aTimestamp === null;
	const bMissing = bTimestamp === null;
	if (aMissing && !bMissing) {
		return 1;
	}
	if (!aMissing && bMissing) {
		return -1;
	}
	if (aMissing && bMissing) {
		return 0;
	}

	return ((aTimestamp ?? 0) - (bTimestamp ?? 0)) * directionMultiplier;
}

function resolveLinkedSortTimestamp(input: {
	file: TFile;
	createdTimestamp: number;
	frontmatter: Record<string, unknown> | null;
	sort: LinkedNoteSortConfig;
}): number | null {
	if (input.sort.field === 'created-date') {
		return Number.isFinite(input.createdTimestamp) && input.createdTimestamp > 0
			? input.createdTimestamp
			: null;
	}

	if (input.sort.field === 'frontmatter-date') {
		const field = input.sort.frontmatterDateField;
		if (!field) {
			return null;
		}
		return parseFrontmatterDateValue(input.frontmatter?.[field]);
	}

	return Number.isFinite(input.file.stat.mtime) && input.file.stat.mtime > 0
		? input.file.stat.mtime
		: null;
}

function getNoteFrontmatter(plugin: Plugin, file: TFile): Record<string, unknown> | null {
	const cache = plugin.app.metadataCache.getFileCache(file);
	const frontmatter = cache?.frontmatter;
	if (!frontmatter || typeof frontmatter !== 'object') {
		return null;
	}
	return frontmatter as Record<string, unknown>;
}

function hasRequiredFrontmatterField(frontmatter: Record<string, unknown> | null, field: string): boolean {
	if (!frontmatter) {
		return false;
	}
	const value = frontmatter[field];
	if (value === null || value === undefined) {
		return false;
	}
	if (typeof value === 'string') {
		return value.trim().length > 0;
	}
	return true;
}

function parseFrontmatterDateValue(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		if (value <= 0) {
			return null;
		}
		return value < 1_000_000_000_000 ? value * 1000 : value;
	}

	if (typeof value !== 'string') {
		return null;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}

	const numeric = Number(trimmed);
	if (Number.isFinite(numeric) && numeric > 0) {
		return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
	}

	const parsed = Date.parse(trimmed);
	if (Number.isNaN(parsed) || parsed <= 0) {
		return null;
	}
	return parsed;
}

function getOutgoingLinkCandidates(plugin: Plugin, sourcePath: string): string[] {
	const resolved = plugin.app.metadataCache.resolvedLinks[sourcePath] ?? {};
	const unresolved = plugin.app.metadataCache.unresolvedLinks[sourcePath] ?? {};
	const candidates = new Set<string>();
	for (const path of Object.keys(resolved)) {
		candidates.add(path);
	}
	for (const path of Object.keys(unresolved)) {
		candidates.add(path);
	}
	return [...candidates];
}

function normalizeLinkedContent(content: string): string {
	return content.replace(/\r\n/g, '\n');
}

function getRelationshipLabel(relationship: { outgoing: boolean; backlink: boolean }): LinkedNoteSnapshot['relationship'] {
	if (relationship.outgoing && relationship.backlink) {
		return 'outgoing+backlink';
	}
	if (relationship.backlink) {
		return 'backlink';
	}
	return 'outgoing';
}

function getFileSystemAdapter(plugin: Plugin): FileSystemAdapter | null {
	const adapter = plugin.app.vault.adapter;
	if (adapter instanceof FileSystemAdapter) {
		return adapter;
	}
	return null;
}

async function getCreatedTimestamp(fileSystemAdapter: FileSystemAdapter | null, file: TFile): Promise<number> {
	if (fileSystemAdapter) {
		const normalizedFilePath = file.path.split('/').join(path.sep);
		const absoluteFilePath = path.join(fileSystemAdapter.getBasePath(), normalizedFilePath);
		try {
			const fileStats = await stat(absoluteFilePath);
			if (Number.isFinite(fileStats.birthtimeMs) && fileStats.birthtimeMs > 0) {
				return fileStats.birthtimeMs;
			}
		} catch {
			// Fall back to Obsidian metadata.
		}
	}

	if (Number.isFinite(file.stat.ctime) && file.stat.ctime > 0) {
		return file.stat.ctime;
	}
	if (Number.isFinite(file.stat.mtime) && file.stat.mtime > 0) {
		return file.stat.mtime;
	}
	return 0;
}
