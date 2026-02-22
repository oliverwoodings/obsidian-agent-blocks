import type { LinkedNoteSnapshot, PromptContext } from './context';

export function buildStandardizedPrompt(
	userInstruction: string,
	context: PromptContext,
	globalInstructions: string,
): string {
	const trimmedGlobalInstructions = globalInstructions.trim();
	const instructionText = userInstruction.trim();

	return [
		'<response_contract>',
		'Use Obsidian-flavored Markdown where useful (wikilinks, headings, lists, callouts, tables).',
		'When summarizing, preserve and include relevant Obsidian note links, especially existing [[Note Links]].',
		'For vault-internal links, use only Obsidian wikilinks like [[Note]], [[Folder/Note]], or [[Note#Heading]].',
		'Never include a .md extension in Obsidian wikilinks.',
		'Never wrap Obsidian wikilinks in backticks or inline code spans.',
		'Use the shortest unambiguous wikilink path.',
		'Link formatting rule for vault files:',
		'1) Prefer [[NoteName]] when unambiguous.',
		'2) If disambiguation is required, add the minimum parent path segments needed (for example [[Meetings/NoteName]]).',
		'3) Use deeper folder paths only when required for uniqueness.',
		'Do not include full vault paths unless they are required for disambiguation.',
		'Do not use standard Markdown links for vault files or relative paths (for example [X](folder/note.md)).',
		'Use standard Markdown links only for external web URLs with http or https.',
		'Respond concisely with only the final output requested by the instruction.',
		'Do not include any reasoning, hidden thoughts, tool usage, skill usage, skill selection, or process commentary.',
		'Never mention skills, capabilities, or internal workflow details in the output.',
		'If completion is blocked, return only a short issue message.',
		'</response_contract>',
		'<context>',
		'  <environment>',
		`    <vault_root_path>${escapeXml(context.vaultRootPath)}</vault_root_path>`,
		`    <current_file_path>${escapeXml(context.currentFilePath)}</current_file_path>`,
		`    <current_file_vault_path>${escapeXml(context.currentFileVaultPath)}</current_file_vault_path>`,
		'  </environment>',
		`  <current_note available="${context.currentNoteAvailable ? 'true' : 'false'}">`,
		escapeXml(context.currentNoteContent),
		'  </current_note>',
		`  <linked_note_content enabled="${context.linkedNoteContentEnabled ? 'true' : 'false'}" sort_field="${escapeXml(context.linkedNoteSortField)}" sort_direction="${escapeXml(context.linkedNoteSortDirection)}" sort_frontmatter_date_field="${escapeXml(context.linkedNoteSortFrontmatterDateField)}" include_outgoing_links="${context.linkedNoteIncludeOutgoingLinks ? 'true' : 'false'}" include_backlinks="${context.linkedNoteIncludeBacklinks ? 'true' : 'false'}" required_frontmatter_field="${escapeXml(context.linkedNoteRequiredFrontmatterField)}">`,
		context.linkedNoteSnapshots.length > 0
			? formatLinkedNoteSnapshots(context.linkedNoteSnapshots)
			: 'No linked notes were loaded.',
		'  </linked_note_content>',
		'</context>',
		...(trimmedGlobalInstructions
			? [
				'<global_instructions>',
				escapeXml(trimmedGlobalInstructions),
				'</global_instructions>',
			]
			: []),
		'<instructions>',
		escapeXml(instructionText),
		'</instructions>',
	].join('\n');
}

function formatLinkedNoteSnapshots(snapshots: LinkedNoteSnapshot[]): string {
	return snapshots
		.map((snapshot) => [
			`    <linked_note path="${escapeXml(snapshot.path)}" relationship="${escapeXml(snapshot.relationship)}" truncated="${snapshot.wasTruncated ? 'true' : 'false'}">`,
			escapeXml(snapshot.content),
			'    </linked_note>',
		].join('\n'))
		.join('\n\n');
}

function escapeXml(value: string): string {
	return value
		.split('&')
		.join('&amp;')
		.split('<')
		.join('&lt;')
		.split('>')
		.join('&gt;');
}
