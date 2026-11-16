/**
 * Every model call must go through a privacy choke point. This test fails when
 * a model call, a provider factory or a raw `fetch` shows up in a file that
 * isn't listed below, so new code can't skip the check by accident. Adding a
 * file here means checking that its calls pass a `Privacy` (or carry no user
 * data) first.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.join(process.cwd(), 'src');

/** Files that call the AI SDK directly; each resolves its model with a Privacy. */
const MODEL_CALL_FILES = new Set([
	'lib/server/agents/stepCompaction.ts',
	'lib/server/chat/compact.ts',
	'lib/server/chat/handoff.ts',
	'lib/server/chat/service.ts',
	'lib/server/chat/title.ts',
	'lib/server/mcp/servers/image.ts',
	'lib/server/proxy/handler.ts'
]);

/** Provider factories (`@ai-sdk/anthropic` etc.) are only built behind resolveModel. */
const PROVIDER_FACTORY_FILES = new Set(['lib/server/llm/registry.ts']);

/**
 * Server files that call `fetch`/`safeFetch` themselves, and why that's fine:
 * none of them carries a prompt to a model provider outside the choke points.
 */
const FETCH_FILES: Record<string, string> = {
	'lib/server/decisions/handler.ts': 'forwardDecisions: filterTargets + assertModelAllowed',
	'lib/server/speech/transcriber.ts': 'resolveAudioEndpoint checks privacy',
	'lib/server/speech/synthesizer.ts': 'resolveAudioEndpoint checks privacy',
	'lib/server/speech/voices.ts': 'voice listing, no content',
	'lib/server/llm/registry.ts': 'model listing, no content',
	'lib/server/llm/lmstudio.ts': 'model probe, no content',
	'lib/server/llm/openrouterImage.ts': 'built by resolveImageModel, which checks privacy',
	'lib/server/mcp/oauth.ts': 'OAuth discovery and tokens, no content',
	'lib/server/t3/client.ts': 'coding chats are never private',
	'lib/server/net/safeFetch.ts': 'the guarded fetch itself',
	'lib/server/net/favicon.ts': 'site icons only, no chat content',
	'lib/server/mcp/servers/weather.ts': 'a tool; tools are not restricted',
	'lib/server/mcp/servers/webfetch.ts': 'a tool; tools are not restricted',
	'lib/server/mcp/servers/fs.ts': 'fs_curl, a tool; tools are not restricted',
	'lib/server/websearch/providers.ts': 'web_search, a tool; tools are not restricted',
	'lib/server/websearch/service.ts': 'web_search (a tool) and admin setup',
	'lib/server/skills/gitImport.ts': 'started by the user, no chat content',
	'lib/server/benchmarks/artificial-analysis.ts': 'model scores only, no user data'
};

const MODEL_CALL =
	/\b(streamText|generateText|generateImage|generateObject|streamObject|embedMany|embed)\(/;
const PROVIDER_FACTORY = /from ['"]@ai-sdk\/(?!mcp['"]|svelte['"]|provider['"]|provider-utils['"])/;
/** A call of the global fetch, or passing it on (e.g. a `fetchImpl = fetch` default). */
const FETCH = /(?:^|[^\w.])(?:safeFetch|fetch)\(|=\s*fetch(?![\w(])/;

async function sourceFiles(dir: string): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
	return entries
		.filter((e) => e.isFile() && /\.(ts|svelte)$/.test(e.name))
		.map((e) => path.join(e.parentPath, e.name))
		.filter((file) => !/\.(spec|test|eval)\.ts$/.test(file));
}

const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/');

// These scan every source file, which can take a while under a busy test run.
describe('privacy static guard', { timeout: 30_000 }, () => {
	it('keeps model calls and provider factories in allowlisted files', async () => {
		const offenders: string[] = [];
		for (const file of await sourceFiles(SRC)) {
			const text = await fs.readFile(file, 'utf8');
			const name = rel(file);
			if (MODEL_CALL.test(text) && !MODEL_CALL_FILES.has(name))
				offenders.push(`model call: ${name}`);
			if (PROVIDER_FACTORY.test(text) && !PROVIDER_FACTORY_FILES.has(name)) {
				offenders.push(`provider factory: ${name}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('keeps raw fetch in server code to allowlisted files', async () => {
		const offenders: string[] = [];
		for (const file of await sourceFiles(path.join(SRC, 'lib/server'))) {
			const text = await fs.readFile(file, 'utf8');
			const name = rel(file);
			if (FETCH.test(text) && !(name in FETCH_FILES)) offenders.push(name);
		}
		expect(offenders).toEqual([]);
	});

	it('lists no file that no longer needs it', async () => {
		const stale: string[] = [];
		for (const name of [
			...MODEL_CALL_FILES,
			...PROVIDER_FACTORY_FILES,
			...Object.keys(FETCH_FILES)
		]) {
			const text = await fs.readFile(path.join(SRC, name), 'utf8').catch(() => '');
			if (!MODEL_CALL.test(text) && !PROVIDER_FACTORY.test(text) && !FETCH.test(text)) {
				stale.push(name);
			}
		}
		expect(stale).toEqual([]);
	});
});

describe('conversation privacy is decided by every creator', { timeout: 30_000 }, () => {
	it('passes `private` in every production createConversation call', async () => {
		const missing: string[] = [];
		for (const file of await sourceFiles(SRC)) {
			const text = await fs.readFile(file, 'utf8');
			if (rel(file) === 'lib/server/db/repo/conversations.ts') continue;
			for (const match of text.matchAll(/createConversation\(([\s\S]*?)\n\t*\}\)/g)) {
				if (!/\bprivate:/.test(match[1])) missing.push(rel(file));
			}
		}
		expect(missing).toEqual([]);
	});
});
