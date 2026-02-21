import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import process from 'process';
import type { CodexCliToolsSettings } from './settings';

const PROMPT_PLACEHOLDER = '{{prompt}}';
const DEFAULT_EXECUTION_TIMEOUT_MS = 5 * 60 * 1000;

interface InvocationPlan {
	command: string;
	args: string[];
	sendPromptViaStdin: boolean;
	timeoutMs: number;
}

interface RunPromptOptions {
	model?: string | null;
	reasoningEffort?: string | null;
	onInvocation?: (invocation: { command: string; args: string[] }) => void;
	onOutputChunk?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
}

export class CodexCliRunner {
	private readonly runningProcesses = new Set<ChildProcessWithoutNullStreams>();
	private readonly getSettings: () => CodexCliToolsSettings;

	constructor(getSettings: () => CodexCliToolsSettings) {
		this.getSettings = getSettings;
	}

	async runPrompt(prompt: string, options: RunPromptOptions = {}): Promise<string> {
		const promptText = prompt.trim();
		if (!promptText) {
			throw new Error('Prompt is empty. Add content to the codex block or template.');
		}

		const settings = this.getSettings();
		const invocation = buildInvocation(
			settings,
			promptText,
			options.model ?? null,
			options.reasoningEffort ?? null,
		);
		safelyEmitInvocation(options.onInvocation, invocation);
		return runProcess(invocation, promptText, this.runningProcesses, options.onOutputChunk);
	}

	dispose(): void {
		for (const process of this.runningProcesses) {
			process.kill();
		}
		this.runningProcesses.clear();
	}
}

function parseArguments(argumentText: string): string[] {
	return argumentText
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function buildInvocation(
	settings: CodexCliToolsSettings,
	promptText: string,
	modelOverride: string | null,
	reasoningEffortOverride: string | null,
): InvocationPlan {
	const command = settings.codexCommand.trim() || 'codex';
	const rawArgs = parseArguments(settings.codexArguments);
	const selectedModel = normalizeModelName(modelOverride) ?? normalizeModelName(settings.defaultModel);
	const selectedReasoningEffort = normalizeReasoningEffort(reasoningEffortOverride)
		?? normalizeReasoningEffort(settings.defaultReasoningEffort);
	const enableMcpServers = settings.enableMcpServers;
	const timeoutMs = normalizeTimeoutMs(settings.executionTimeoutSeconds);
	const configuredMcpServerNames = getConfiguredMcpServerNames(rawArgs);

	const hasPlaceholder = rawArgs.some((arg) => arg.includes(PROMPT_PLACEHOLDER));
	const argsWithPrompt = rawArgs.map((arg) => arg.split(PROMPT_PLACEHOLDER).join(promptText));
	const argsWithModel = injectModelArgument(argsWithPrompt, selectedModel);
	const argsWithReasoning = injectReasoningEffortArgument(argsWithModel, selectedReasoningEffort);
	const args = injectMcpArguments(argsWithReasoning, enableMcpServers, configuredMcpServerNames);

	if (hasPlaceholder) {
		return {
			command,
			args,
			sendPromptViaStdin: false,
			timeoutMs,
		};
	}

	if (args.includes('-')) {
		return {
			command,
			args,
			sendPromptViaStdin: true,
			timeoutMs,
		};
	}

	return {
		command,
		args: [...args, promptText],
		sendPromptViaStdin: false,
		timeoutMs,
	};
}

function normalizeModelName(model: string | null | undefined): string | null {
	if (!model) {
		return null;
	}
	const normalized = model.trim();
	return normalized.length > 0 ? normalized : null;
}

function injectModelArgument(args: string[], model: string | null): string[] {
	if (!model || hasModelArgument(args)) {
		return args;
	}

	const argsWithModel = [...args];
	let insertionIndex = 0;
	const firstArg = argsWithModel[0];
	if (firstArg && !firstArg.startsWith('-')) {
		insertionIndex = 1;
	}
	argsWithModel.splice(insertionIndex, 0, '-m', model);
	return argsWithModel;
}

function normalizeReasoningEffort(reasoningEffort: string | null | undefined): string | null {
	if (!reasoningEffort) {
		return null;
	}
	const normalized = reasoningEffort.trim();
	return normalized.length > 0 ? normalized : null;
}

function injectReasoningEffortArgument(args: string[], reasoningEffort: string | null): string[] {
	if (!reasoningEffort) {
		return args;
	}

	const argsWithoutReasoning = stripReasoningConfigOverrides(args);
	const argsWithReasoning = [...argsWithoutReasoning];
	let insertionIndex = 0;
	const firstArg = argsWithReasoning[0];
	if (firstArg && !firstArg.startsWith('-')) {
		insertionIndex = 1;
	}
	argsWithReasoning.splice(insertionIndex, 0, '-c', `model_reasoning_effort=${formatTomlString(reasoningEffort)}`);
	return argsWithReasoning;
}

function hasModelArgument(args: string[]): boolean {
	return args.some((arg, index) => (
		arg === '--model'
		|| arg.startsWith('--model=')
		|| (arg === '-m' && index < args.length - 1)
	));
}

function injectMcpArguments(
	args: string[],
	enableMcpServers: boolean,
	configuredMcpServerNames: string[],
): string[] {
	if (enableMcpServers) {
		return args;
	}

	const argsWithMcpDisabled = stripMcpConfigOverrides(args);
	let insertionIndex = 0;
	const firstArg = argsWithMcpDisabled[0];
	if (firstArg && !firstArg.startsWith('-')) {
		insertionIndex = 1;
	}
	const overrides = buildMcpDisableOverrides(configuredMcpServerNames);
	if (overrides.length === 0) {
		overrides.push('-c', 'mcp_servers={}');
	}
	argsWithMcpDisabled.splice(insertionIndex, 0, ...overrides);
	return argsWithMcpDisabled;
}

function buildMcpDisableOverrides(serverNames: string[]): string[] {
	const overrides: string[] = [];
	for (const serverName of serverNames) {
		overrides.push('-c', `mcp_servers.${formatTomlPathSegment(serverName)}.enabled=false`);
	}
	return overrides;
}

function formatTomlPathSegment(segment: string): string {
	if (/^[A-Za-z0-9_-]+$/u.test(segment)) {
		return segment;
	}
	const escaped = segment
		.split('\\')
		.join('\\\\')
		.split('"')
		.join('\\"');
	return `"${escaped}"`;
}

function stripMcpConfigOverrides(args: string[]): string[] {
	const strippedArgs: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if ((arg === '-c' || arg === '--config') && index + 1 < args.length) {
			const value = args[index + 1];
			if (value && isMcpConfigOverride(value)) {
				index += 1;
				continue;
			}
		}
		strippedArgs.push(arg ?? '');
	}
	return strippedArgs;
}

function isMcpConfigOverride(value: string): boolean {
	const trimmed = value.trim();
	return trimmed.startsWith('mcp_servers');
}

function stripReasoningConfigOverrides(args: string[]): string[] {
	const strippedArgs: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if ((arg === '-c' || arg === '--config') && index + 1 < args.length) {
			const value = args[index + 1];
			if (value && isReasoningConfigOverride(value)) {
				index += 1;
				continue;
			}
		}
		strippedArgs.push(arg ?? '');
	}
	return strippedArgs;
}

function isReasoningConfigOverride(value: string): boolean {
	const trimmed = value.trim();
	return trimmed.startsWith('model_reasoning_effort');
}

function formatTomlString(value: string): string {
	const escaped = value
		.split('\\')
		.join('\\\\')
		.split('"')
		.join('\\"');
	return `"${escaped}"`;
}

function getConfiguredMcpServerNames(rawArgs: string[]): string[] {
	const names = new Set<string>();
	for (const serverName of parseMcpServerNamesFromConfigFile()) {
		names.add(serverName);
	}
	for (const serverName of parseMcpServerNamesFromArgs(rawArgs)) {
		names.add(serverName);
	}
	return [...names];
}

function parseMcpServerNamesFromConfigFile(): string[] {
	try {
		const configPath = getCodexConfigPath();
		const configText = fs.readFileSync(configPath, 'utf8');
		const names = new Set<string>();
		const sectionRegex = /^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/gmu;
		let match: RegExpExecArray | null;
		do {
			match = sectionRegex.exec(configText);
			if (!match) {
				continue;
			}
			const name = match[1] ?? match[2];
			if (name) {
				names.add(name);
			}
		} while (match);
		return [...names];
	} catch {
		return [];
	}
}

function parseMcpServerNamesFromArgs(rawArgs: string[]): string[] {
	const names = new Set<string>();
	for (let index = 0; index < rawArgs.length; index += 1) {
		const arg = rawArgs[index];
		if ((arg === '-c' || arg === '--config') && index + 1 < rawArgs.length) {
			const value = rawArgs[index + 1];
			if (!value) {
				continue;
			}
			const parsedName = extractMcpServerNameFromConfigOverride(value);
			if (parsedName) {
				names.add(parsedName);
			}
			index += 1;
		}
	}
	return [...names];
}

function extractMcpServerNameFromConfigOverride(configOverride: string): string | null {
	const quotedMatch = /^mcp_servers\."([^"]+)"\./u.exec(configOverride);
	if (quotedMatch?.[1]) {
		return quotedMatch[1];
	}
	const unquotedMatch = /^mcp_servers\.([A-Za-z0-9_-]+)\./u.exec(configOverride);
	if (unquotedMatch?.[1]) {
		return unquotedMatch[1];
	}
	return null;
}

function getCodexConfigPath(): string {
	const codexHome = process.env.CODEX_HOME?.trim();
	if (codexHome) {
		return path.join(codexHome, 'config.toml');
	}
	return path.join(os.homedir(), '.codex', 'config.toml');
}

function normalizeTimeoutMs(timeoutSeconds: number): number {
	if (!Number.isFinite(timeoutSeconds)) {
		return DEFAULT_EXECUTION_TIMEOUT_MS;
	}
	const clampedSeconds = Math.max(15, Math.min(3600, Math.round(timeoutSeconds)));
	return clampedSeconds * 1000;
}

function runProcess(
	invocation: InvocationPlan,
	promptText: string,
	runningProcesses: Set<ChildProcessWithoutNullStreams>,
	onOutputChunk?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void,
): Promise<string> {
	const commandCandidates = buildCommandCandidates(invocation.command);
	let candidateIndex = 0;

	return new Promise((resolve, reject) => {
		const tryStart = (): void => {
			const command = commandCandidates[candidateIndex];
			if (!command) {
				reject(new Error('No codex command candidates were available.'));
				return;
			}

			const childProcess = spawn(command, invocation.args, {
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true,
			});

			runningProcesses.add(childProcess);
			let timedOut = false;
			let settled = false;
			const timeoutHandle = window.setTimeout(() => {
				timedOut = true;
				childProcess.kill();
			}, invocation.timeoutMs);

			let stdout = '';
			let stderr = '';

			childProcess.stdout.on('data', (chunk: unknown) => {
				const text = chunkToString(chunk);
				stdout += text;
				safelyEmitOutputChunk(onOutputChunk, {
					stream: 'stdout',
					text,
				});
			});

			childProcess.stderr.on('data', (chunk: unknown) => {
				const text = chunkToString(chunk);
				stderr += text;
				safelyEmitOutputChunk(onOutputChunk, {
					stream: 'stderr',
					text,
				});
			});

			childProcess.on('error', (error: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				window.clearTimeout(timeoutHandle);
				runningProcesses.delete(childProcess);
				if (isCommandNotFoundError(error) && candidateIndex + 1 < commandCandidates.length) {
					candidateIndex += 1;
					tryStart();
					return;
				}

				reject(new Error(buildStartFailureMessage(invocation.command, commandCandidates, error)));
			});

			childProcess.on('close', (code) => {
				if (settled) {
					return;
				}
				settled = true;
				window.clearTimeout(timeoutHandle);
				runningProcesses.delete(childProcess);
				if (timedOut) {
					reject(new Error(buildTimeoutMessage(invocation.timeoutMs)));
					return;
				}
				if (code === 0) {
					resolve(stdout.trim());
					return;
				}

				const details = stderr.trim() || stdout.trim() || `Process exited with code ${String(code)}`;
				reject(new Error(details));
			});

			if (invocation.sendPromptViaStdin) {
				childProcess.stdin.write(promptText);
			}
			childProcess.stdin.end();
		};

		tryStart();
	});
}

function buildTimeoutMessage(timeoutMs: number): string {
	const seconds = Math.round(timeoutMs / 1000);
	return `Codex execution timed out after ${seconds} seconds.`;
}

function buildCommandCandidates(command: string): string[] {
	const trimmedCommand = command.trim();
	if (!trimmedCommand) {
		return ['codex'];
	}

	const candidates = [trimmedCommand];
	if (trimmedCommand !== 'codex') {
		return candidates;
	}

	if (process.platform === 'darwin') {
		candidates.push('/Applications/Codex.app/Contents/Resources/codex');
	}
	candidates.push('/opt/homebrew/bin/codex');
	candidates.push('/usr/local/bin/codex');

	const homePath = process.env.HOME;
	if (homePath) {
		candidates.push(`${homePath}/.local/bin/codex`);
	}

	return [...new Set(candidates)];
}

function isCommandNotFoundError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) {
		return false;
	}
	return 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

function buildStartFailureMessage(requestedCommand: string, triedCommands: string[], error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const isNotFound = isCommandNotFoundError(error);
	if (!isNotFound) {
		return `Failed to start Codex command "${requestedCommand}": ${message}`;
	}

	const tried = triedCommands.map((candidate) => `"${candidate}"`).join(', ');
	return [
		`Failed to start Codex command "${requestedCommand}" (not found).`,
		`Tried: ${tried}.`,
		'Set an absolute binary path in plugin settings under "Codex command".',
	].join(' ');
}

function chunkToString(chunk: unknown): string {
	if (typeof chunk === 'string') {
		return chunk;
	}
	if (chunk instanceof Uint8Array) {
		return new TextDecoder().decode(chunk);
	}
	return String(chunk);
}

function safelyEmitOutputChunk(
	onOutputChunk: ((chunk: { stream: 'stdout' | 'stderr'; text: string }) => void) | undefined,
	chunk: { stream: 'stdout' | 'stderr'; text: string },
): void {
	if (!onOutputChunk || !chunk.text) {
		return;
	}
	try {
		onOutputChunk(chunk);
	} catch {
		// Stream logging must not break execution.
	}
}

function safelyEmitInvocation(
	onInvocation: ((invocation: { command: string; args: string[] }) => void) | undefined,
	invocation: { command: string; args: string[] },
): void {
	if (!onInvocation) {
		return;
	}
	try {
		onInvocation({
			command: invocation.command,
			args: [...invocation.args],
		});
	} catch {
		// Invocation logging must not break execution.
	}
}
