import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from '../helpers/load-ts.mjs';
import { createBaseTemplate } from '../helpers/fixtures.mjs';

const {
	buildCacheKey,
	buildBlockCacheId,
	formatBlockCacheId,
	listAgentBlocksInFile,
	parseBlockCacheId,
} = loadTs('../../src/agent-block/cache.ts');

test('buildCacheKey is stable for identical inputs', () => {
	const template = createBaseTemplate();
	const overrides = { model: 'gpt-5-mini' };
	const contextConfig = template.context;

	const key1 = buildCacheKey('Prompt', template, overrides, contextConfig);
	const key2 = buildCacheKey('Prompt', template, overrides, contextConfig);

	assert.equal(key1, key2);
});

test('buildCacheKey changes when meaningful inputs change', () => {
	const template = createBaseTemplate();
	const key1 = buildCacheKey('Prompt', template, {}, template.context);
	const key2 = buildCacheKey('Prompt', template, { model: 'different-model' }, template.context);

	assert.notEqual(key1, key2);
});

test('buildBlockCacheId uses agentBlockOrdinalInFile when section lines match', async () => {
	const app = createMockAppForFile('note.md', [
		'# Title',
		'```agent',
		'First',
		'```',
		'',
		'```agent',
		'Second',
		'```',
	].join('\n'));

	const withLineA = await buildBlockCacheId(app, 'source text', 'note.md', { lineStart: 1 });
	const withLineB = await buildBlockCacheId(app, 'source text', 'note.md', { lineStart: 5 });
	assert.equal(withLineA, formatBlockCacheId('note.md', 0));
	assert.equal(withLineB, formatBlockCacheId('note.md', 1));
	assert.notEqual(withLineA, withLineB);
});

test('buildBlockCacheId falls back to source hash when section cannot resolve ordinal', async () => {
	const app = {
		vault: {
			getAbstractFileByPath: () => null,
			cachedRead: async () => '',
		},
	};

	const noLineA = await buildBlockCacheId(app, 'source text A', 'note.md', { lineStart: 100 });
	const noLineB = await buildBlockCacheId(app, 'source text B', 'note.md', { lineStart: 100 });
	assert.notEqual(noLineA, noLineB);
	assert.equal(parseBlockCacheId(noLineA), null);
	assert.equal(parseBlockCacheId(noLineB), null);
});

test('formatBlockCacheId and parseBlockCacheId round-trip', () => {
	const blockId = formatBlockCacheId('folder/note name.md', 3);
	const parsed = parseBlockCacheId(blockId);
	assert.deepEqual(parsed, { sourcePath: 'folder/note name.md', ordinal: 3 });
});

test('listAgentBlocksInFile prefers open editor content over cachedRead content', async () => {
	const app = createMockAppForFile(
		'note.md',
		['```agent', 'from disk', '```'].join('\n'),
		['```agent', 'open-0', '```', '', '```agent', 'open-1', '```'].join('\n'),
	);

	const blocks = await listAgentBlocksInFile(app, 'note.md');
	assert.equal(blocks.length, 2);
	assert.equal(blocks[0].source, 'open-0');
	assert.equal(blocks[1].source, 'open-1');
	assert.equal(blocks[0].blockId, formatBlockCacheId('note.md', 0));
	assert.equal(blocks[1].blockId, formatBlockCacheId('note.md', 1));
});

function createMockAppForFile(path, content, openViewContent = null) {
	const basename = path.split('/').pop() ?? path;
	const file = {
		path,
		name: basename,
		basename: basename.replace(/\.md$/iu, ''),
		extension: 'md',
		stat: { mtime: Date.now(), ctime: Date.now(), size: content.length },
	};
	const leaves = openViewContent === null
		? []
		: [{ view: { file: { path }, getViewData: () => openViewContent } }];
	return {
		vault: {
			getAbstractFileByPath: (candidatePath) => (candidatePath === path ? file : null),
			cachedRead: async () => content,
		},
		workspace: {
			iterateAllLeaves: (callback) => {
				for (const leaf of leaves) {
					callback(leaf);
				}
			},
		},
	};
}
