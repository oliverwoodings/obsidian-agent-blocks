import type { PromptCacheEntry } from '../domain/types';

export function enforcePromptCacheLimit(cache: Record<string, PromptCacheEntry>, limit: number): void {
	const entries = Object.entries(cache);
	if (entries.length <= limit) {
		return;
	}

	entries
		.sort((a, b) => {
			const aTime = Date.parse(a[1].cachedAt);
			const bTime = Date.parse(b[1].cachedAt);
			const aScore = Number.isNaN(aTime) ? 0 : aTime;
			const bScore = Number.isNaN(bTime) ? 0 : bTime;
			return bScore - aScore;
		})
		.slice(limit)
		.forEach(([hash]) => {
			delete cache[hash];
		});
}

export function pruneBlockPromptCacheIndex(
	blockPromptCacheIndex: Record<string, string>,
	cache: Record<string, PromptCacheEntry>,
): void {
	for (const [blockId, hash] of Object.entries(blockPromptCacheIndex)) {
		if (!cache[hash]) {
			delete blockPromptCacheIndex[blockId];
		}
	}
}

export function pruneBlockPromptCacheHistory(
	blockPromptCacheHistory: Record<string, string[]>,
	cache: Record<string, PromptCacheEntry>,
): void {
	for (const [blockId, hashes] of Object.entries(blockPromptCacheHistory)) {
		const normalized = dedupeHashes(hashes).filter((hash) => Boolean(cache[hash]));
		if (normalized.length > 0) {
			blockPromptCacheHistory[blockId] = normalized;
			continue;
		}
		delete blockPromptCacheHistory[blockId];
	}
}

export function enforcePerBlockPromptCacheLimit(
	blockPromptCacheHistory: Record<string, string[]>,
	limit: number,
): string[] {
	const removedHashes: string[] = [];
	for (const [blockId, hashes] of Object.entries(blockPromptCacheHistory)) {
		const normalized = dedupeHashes(hashes);
		if (normalized.length <= limit) {
			if (normalized.length > 0) {
				blockPromptCacheHistory[blockId] = normalized;
			} else {
				delete blockPromptCacheHistory[blockId];
			}
			continue;
		}
		const removed = normalized.slice(limit);
		removedHashes.push(...removed);
		blockPromptCacheHistory[blockId] = normalized.slice(0, limit);
	}
	return dedupeHashes(removedHashes);
}

export function syncBlockPromptCacheIndexFromHistory(
	blockPromptCacheIndex: Record<string, string>,
	blockPromptCacheHistory: Record<string, string[]>,
): void {
	for (const blockId of Object.keys(blockPromptCacheIndex)) {
		if (!blockPromptCacheHistory[blockId]?.[0]) {
			delete blockPromptCacheIndex[blockId];
		}
	}

	for (const [blockId, hashes] of Object.entries(blockPromptCacheHistory)) {
		const latestHash = hashes[0];
		if (latestHash) {
			blockPromptCacheIndex[blockId] = latestHash;
		}
	}
}

export function isPromptHashReferencedByAnyBlock(
	hash: string,
	blockPromptCacheHistory: Record<string, string[]>,
): boolean {
	for (const hashes of Object.values(blockPromptCacheHistory)) {
		if (hashes.includes(hash)) {
			return true;
		}
	}
	return false;
}

export function reconcileBlockCacheEntriesForSourcePath(input: {
	sourceBlockIds: string[];
	currentBlocks: Array<{ blockId: string; sourceFingerprint: string }>;
	blockPromptCacheHistory: Record<string, string[]>;
	blockPromptCacheIndex: Record<string, string>;
	blockPromptCacheSourceFingerprintIndex: Record<string, string>;
}): boolean {
	const sourceBlockIds = dedupeHashes(input.sourceBlockIds);
	const currentBlocks = input.currentBlocks;
	const matchedByOldId = new Map<string, string>();
	const usedCurrentBlockIds = new Set<string>();

	const oldEntries = sourceBlockIds
		.map((blockId) => ({
			blockId,
			ordinal: extractOrdinalFromBlockId(blockId),
			sourceFingerprint: input.blockPromptCacheSourceFingerprintIndex[blockId] ?? '',
		}))
		.sort((a, b) => a.ordinal - b.ordinal);

	const currentByFingerprint = new Map<string, string[]>();
	for (const currentBlock of currentBlocks) {
		const queue = currentByFingerprint.get(currentBlock.sourceFingerprint) ?? [];
		queue.push(currentBlock.blockId);
		currentByFingerprint.set(currentBlock.sourceFingerprint, queue);
	}

	for (const oldEntry of oldEntries) {
		const fingerprint = oldEntry.sourceFingerprint;
		if (!fingerprint) {
			continue;
		}
		const queue = currentByFingerprint.get(fingerprint);
		if (!queue?.length) {
			continue;
		}
		while (queue.length > 0 && usedCurrentBlockIds.has(queue[0] ?? '')) {
			queue.shift();
		}
		const matchedCurrentBlockId = queue.shift();
		if (!matchedCurrentBlockId || usedCurrentBlockIds.has(matchedCurrentBlockId)) {
			continue;
		}
		usedCurrentBlockIds.add(matchedCurrentBlockId);
		matchedByOldId.set(oldEntry.blockId, matchedCurrentBlockId);
	}

	for (const oldEntry of oldEntries) {
		if (matchedByOldId.has(oldEntry.blockId)) {
			continue;
		}
		const ordinalMatch = currentBlocks[oldEntry.ordinal];
		if (!ordinalMatch || usedCurrentBlockIds.has(ordinalMatch.blockId)) {
			continue;
		}
		usedCurrentBlockIds.add(ordinalMatch.blockId);
		matchedByOldId.set(oldEntry.blockId, ordinalMatch.blockId);
	}

	const nextHistoryByBlockId: Record<string, string[]> = {};
	for (const oldEntry of oldEntries) {
		const matchedCurrentBlockId = matchedByOldId.get(oldEntry.blockId);
		if (!matchedCurrentBlockId) {
			continue;
		}
		const oldHistory = input.blockPromptCacheHistory[oldEntry.blockId] ?? [];
		if (oldHistory.length === 0) {
			continue;
		}
		const existing = nextHistoryByBlockId[matchedCurrentBlockId] ?? [];
		nextHistoryByBlockId[matchedCurrentBlockId] = dedupeHashes([...existing, ...oldHistory]);
	}

	let changed = false;

	for (const blockId of sourceBlockIds) {
		if (input.blockPromptCacheHistory[blockId]) {
			delete input.blockPromptCacheHistory[blockId];
			changed = true;
		}
		if (input.blockPromptCacheIndex[blockId]) {
			delete input.blockPromptCacheIndex[blockId];
			changed = true;
		}
		if (input.blockPromptCacheSourceFingerprintIndex[blockId]) {
			delete input.blockPromptCacheSourceFingerprintIndex[blockId];
			changed = true;
		}
	}

	for (const currentBlock of currentBlocks) {
		const nextFingerprint = currentBlock.sourceFingerprint.trim();
		if (nextFingerprint) {
			if (input.blockPromptCacheSourceFingerprintIndex[currentBlock.blockId] !== nextFingerprint) {
				input.blockPromptCacheSourceFingerprintIndex[currentBlock.blockId] = nextFingerprint;
				changed = true;
			}
		}

		const nextHistory = nextHistoryByBlockId[currentBlock.blockId] ?? [];
		if (nextHistory.length > 0) {
			if (!areStringArraysEqual(input.blockPromptCacheHistory[currentBlock.blockId] ?? [], nextHistory)) {
				input.blockPromptCacheHistory[currentBlock.blockId] = nextHistory;
				changed = true;
			}
			continue;
		}
		if (input.blockPromptCacheHistory[currentBlock.blockId]) {
			delete input.blockPromptCacheHistory[currentBlock.blockId];
			changed = true;
		}
	}

	syncBlockPromptCacheIndexFromHistory(input.blockPromptCacheIndex, input.blockPromptCacheHistory);
	return changed;
}

function dedupeHashes(hashes: string[]): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const hash of hashes) {
		if (typeof hash !== 'string') {
			continue;
		}
		const trimmed = hash.trim();
		if (!trimmed || seen.has(trimmed)) {
			continue;
		}
		seen.add(trimmed);
		normalized.push(trimmed);
	}
	return normalized;
}

function extractOrdinalFromBlockId(blockId: string): number {
	const separatorIndex = blockId.lastIndexOf('#');
	if (separatorIndex < 0) {
		return Number.POSITIVE_INFINITY;
	}
	const parsed = Number.parseInt(blockId.slice(separatorIndex + 1), 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return Number.POSITIVE_INFINITY;
	}
	return parsed;
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	for (let i = 0; i < left.length; i += 1) {
		if (left[i] !== right[i]) {
			return false;
		}
	}
	return true;
}
