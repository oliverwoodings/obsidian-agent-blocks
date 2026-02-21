import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import process from 'process';
import type { AgentBlockOverrides, AgentInvocation, AgentOutputChunk } from '../agent-types';
import type { CodexAgentProviderConfig } from '../settings';
import type { AgentProvider, AgentRunRequest, AgentRunResult } from './types';

const PROMPT_PLACEHOLDER = '{{prompt}}';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

interface InvocationPlan {
	command: string;
	args: string[];
	sendPromptViaStdin: boolean;
	timeoutMs: number;
}

export class CodexCliProvider implements AgentProvider {
	private readonly runningProcesses = new Set<ChildProcessWithoutNullStreams>();

	async run(request: AgentRunRequest): Promise<AgentRunResult> {
		if (request.template.provider !== 'codex') {
			throw new Error('Codex provider received a non-codex template.');
		}

		const promptText = request.prompt.trim();
		if (!promptText) {
			throw new Error('Prompt is empty. Add content to the agent block or template.');
		}

		const invocation = buildInvocation(request.template.providerConfig, request.overrides, promptText);
		safelyEmitInvocation(request.onInvocation, {
			command: invocation.command,
			args: [...invocation.args],
		});

		const response = await runProcess(
			invocation,
			promptText,
			this.runningProcesses,
			request.onOutputChunk,
		);
		return { response };
	}

	dispose(): void {
		for (const processHandle of this.runningProcesses) {
			processHandle.kill();
		}
		this.runningProcesses.clear();
	}
}

function buildInvocation(
	config: CodexAgentProviderConfig,
	overrides: AgentBlockOverrides,
	promptText: string,
): InvocationPlan {
	const command = config.command.trim() || 'codex';
	const rawArgs = parseArguments(config.arguments);
	const selectedModel = normalizeString(overrides.model) ?? normalizeString(config.model);
	const selectedReasoningEffort = normalizeString(overrides.reasoningEffort) ?? normalizeString(config.reasoningEffort);
	const selectedUseOss = typeof overrides.useOssModelProvider === 'boolean'
		? overrides.useOssModelProvider
		: config.useOssModelProvider;
	const selectedLocalProvider = normalizeString(overrides.localProvider) ?? normalizeString(config.localProvider);
	const enableMcpServers = typeof overrides.mcpEnabled === 'boolean' ? overrides.mcpEnabled : config.enableMcpServers;
	const timeoutMs = normalizeTimeoutMs(
		typeof overrides.executionTimeoutSeconds === 'number'
			? overrides.executionTimeoutSeconds
			: config.executionTimeoutSeconds,
	);
	const configuredMcpServerNames = getConfiguredMcpServerNames(rawArgs);

	const hasPlaceholder = rawArgs.some((arg) => arg.includes(PROMPT_PLACEHOLDER));
	const argsWithPrompt = rawArgs.map((arg) => arg.split(PROMPT_PLACEHOLDER).join(promptText));
	const argsWithModel = injectModelArgument(argsWithPrompt, selectedModel);
	const argsWithReasoning = injectReasoningEffortArgument(argsWithModel, selectedReasoningEffort);
	const argsWithLocalProvider = injectLocalProviderArguments(
		argsWithReasoning,
		selectedUseOss,
		selectedLocalProvider,
	);
	const args = injectMcpArguments(argsWithLocalProvider, enableMcpServers, configuredMcpServerNames);

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

function parseArguments(argumentText: string): string[] {
	return argumentText
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function normalizeString(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function normalizeTimeoutMs(timeoutSeconds: number): number {
	if (!Number.isFinite(timeoutSeconds)) {
		return DEFAULT_TIMEOUT_MS;
	}
	const clampedSeconds = Math.max(15, Math.min(3600, Math.round(timeoutSeconds)));
	return clampedSeconds * 1000;
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

function hasModelArgument(args: string[]): boolean {
	return args.some((arg, index) => (
		arg === '--model'
		|| arg.startsWith('--model=')
		|| (arg === '-m' && index < args.length - 1)
	));
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

function injectLocalProviderArguments(
	args: string[],
	useOssModelProvider: boolean,
	localProvider: string | null,
): string[] {
	if (!useOssModelProvider && !localProvider) {
		return args;
	}

	const explicitLocalProvider = localProvider ?? null;
	const useOss = useOssModelProvider || explicitLocalProvider !== null;
	const argsWithoutLocalProvider = stripLocalProviderArguments(args);
	const argsWithLocalProvider = [...argsWithoutLocalProvider];
	let insertionIndex = 0;
	const firstArg = argsWithLocalProvider[0];
	if (firstArg && !firstArg.startsWith('-')) {
		insertionIndex = 1;
	}
	if (useOss) {
		argsWithLocalProvider.splice(insertionIndex, 0, '--oss');
		insertionIndex += 1;
	}
	if (explicitLocalProvider) {
		argsWithLocalProvider.splice(insertionIndex, 0, '--local-provider', explicitLocalProvider);
	}
	return argsWithLocalProvider;
}

function stripReasoningConfigOverrides(args: string[]): string[] {
	const strippedArgs: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if ((arg === '-c' || arg === '--config') && index + 1 < args.length) {
			const value = args[index + 1];
			if (value && value.trim().startsWith('model_reasoning_effort')) {
				index += 1;
				continue;
			}
		}
		if (arg) {
			strippedArgs.push(arg);
		}
	}
	return strippedArgs;
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

function formatTomlString(value: string): string {
	const escaped = value
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
			if (value && value.trim().startsWith('mcp_servers')) {
				index += 1;
				continue;
			}
		}
		if (arg) {
			strippedArgs.push(arg);
		}
	}
	return strippedArgs;
}

function stripLocalProviderArguments(args: string[]): string[] {
	const strippedArgs: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === '--oss') {
			continue;
		}
		if ((arg === '--local-provider' || arg === '--local_provider') && index + 1 < args.length) {
			index += 1;
			continue;
		}
		if ((arg?.startsWith('--local-provider=') ?? false) || (arg?.startsWith('--local_provider=') ?? false)) {
			continue;
		}
		if (arg) {
			strippedArgs.push(arg);
		}
	}
	return strippedArgs;
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

function runProcess(
	invocation: InvocationPlan,
	promptText: string,
	runningProcesses: Set<ChildProcessWithoutNullStreams>,
	onOutputChunk?: (chunk: AgentOutputChunk) => void,
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
			const timeoutHandle = globalThis.setTimeout(() => {
				timedOut = true;
				childProcess.kill();
			}, invocation.timeoutMs);

			let stdout = '';
			let stderr = '';

			childProcess.stdout.on('data', (chunk: unknown) => {
				const text = chunkToString(chunk);
				stdout += text;
				safelyEmitOutputChunk(onOutputChunk, { stream: 'stdout', text });
			});

			childProcess.stderr.on('data', (chunk: unknown) => {
				const text = chunkToString(chunk);
				stderr += text;
				safelyEmitOutputChunk(onOutputChunk, { stream: 'stderr', text });
			});

			childProcess.on('error', (error: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				globalThis.clearTimeout(timeoutHandle);
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
				globalThis.clearTimeout(timeoutHandle);
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
	if (!isCommandNotFoundError(error)) {
		return `Failed to start Codex command "${requestedCommand}": ${message}`;
	}

	const tried = triedCommands.map((candidate) => `"${candidate}"`).join(', ');
	return [
		`Failed to start Codex command "${requestedCommand}" (not found).`,
		`Tried: ${tried}.`,
		'Set an absolute binary path in your codex template settings.',
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
	onOutputChunk: ((chunk: AgentOutputChunk) => void) | undefined,
	chunk: AgentOutputChunk,
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
	onInvocation: ((invocation: AgentInvocation) => void) | undefined,
	invocation: AgentInvocation,
): void {
	if (!onInvocation) {
		return;
	}
	try {
		onInvocation(invocation);
	} catch {
		// Invocation logging must not break execution.
	}
}
