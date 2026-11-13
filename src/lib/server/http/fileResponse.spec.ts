import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileResponse, parseRange } from './fileResponse.js';

let dir: string;
let file: string;
const CONTENT = 'abcdefghijklmnopqrstuvwxyz';

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-response-'));
	file = path.join(dir, 'a.txt');
	await fs.writeFile(file, CONTENT);
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

function get(headers: Record<string, string> = {}, method = 'GET'): Promise<Response> {
	return fileResponse(file, new Request('http://localhost/f', { method, headers }), {
		'content-type': 'text/plain',
		'cache-control': 'private, no-cache'
	});
}

describe('parseRange', () => {
	it.each([
		[null, null],
		['bytes=0-4', { start: 0, end: 4 }],
		['bytes=5-', { start: 5, end: 25 }],
		['bytes=-3', { start: 23, end: 25 }],
		['bytes=-100', { start: 0, end: 25 }],
		['bytes=20-1000', { start: 20, end: 25 }],
		['bytes=26-', 'unsatisfiable'],
		['bytes=-0', 'unsatisfiable'],
		['bytes=5-2', null],
		['bytes=0-1,4-5', null],
		['items=0-1', null],
		['bytes=-', null]
	] as const)('%s -> %j', (header, expected) => {
		expect(parseRange(header, 26)).toEqual(expected);
	});
});

describe('fileResponse', () => {
	it('streams the whole file with length, validators and the given headers', async () => {
		const res = await get();
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(CONTENT);
		expect(res.headers.get('content-length')).toBe(String(CONTENT.length));
		expect(res.headers.get('accept-ranges')).toBe('bytes');
		expect(res.headers.get('content-type')).toBe('text/plain');
		expect(res.headers.get('cache-control')).toBe('private, no-cache');
		expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]+-1a"$/);
		expect(res.headers.get('last-modified')).toBeTruthy();
	});

	it('serves a single range as 206', async () => {
		const res = await get({ range: 'bytes=2-5' });
		expect(res.status).toBe(206);
		expect(await res.text()).toBe('cdef');
		expect(res.headers.get('content-range')).toBe(`bytes 2-5/${CONTENT.length}`);
		expect(res.headers.get('content-length')).toBe('4');
	});

	it('answers an unsatisfiable range with 416', async () => {
		const res = await get({ range: 'bytes=100-' });
		expect(res.status).toBe(416);
		expect(res.headers.get('content-range')).toBe(`bytes */${CONTENT.length}`);
	});

	it('ignores the range when If-Range no longer matches', async () => {
		const res = await get({ range: 'bytes=0-1', 'if-range': '"stale"' });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(CONTENT);
		const { headers } = await get();
		const current = await get({ range: 'bytes=0-1', 'if-range': headers.get('etag')! });
		expect(current.status).toBe(206);
		expect(await current.text()).toBe('ab');
	});

	it('answers matching If-None-Match / If-Modified-Since with 304', async () => {
		const first = await get();
		const etag = first.headers.get('etag')!;
		await first.body?.cancel();
		const byEtag = await get({ 'if-none-match': `W/${etag}` });
		expect(byEtag.status).toBe(304);
		expect(byEtag.body).toBeNull();
		expect(byEtag.headers.get('etag')).toBe(etag);
		const byDate = await get({ 'if-modified-since': first.headers.get('last-modified')! });
		expect(byDate.status).toBe(304);
		const stale = await get({ 'if-none-match': '"other"' });
		expect(stale.status).toBe(200);
		expect(await stale.text()).toBe(CONTENT);
	});

	it('changes the ETag when the file is rewritten', async () => {
		const other = path.join(dir, 'b.txt');
		await fs.writeFile(other, 'one');
		const req = () => new Request('http://localhost/f', { method: 'HEAD' });
		const a = (await fileResponse(other, req(), {})).headers.get('etag');
		await fs.writeFile(other, 'three');
		await fs.utimes(other, new Date(), new Date(Date.now() + 5000));
		const b = (await fileResponse(other, req(), {})).headers.get('etag');
		expect(a).toBeTruthy();
		expect(a).not.toBe(b);
	});

	it('sends no body for HEAD and handles empty files', async () => {
		const head = await get({}, 'HEAD');
		expect(head.status).toBe(200);
		expect(head.body).toBeNull();
		expect(head.headers.get('content-length')).toBe(String(CONTENT.length));
		const empty = path.join(dir, 'empty.txt');
		await fs.writeFile(empty, '');
		const res = await fileResponse(empty, new Request('http://localhost/e'), {});
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('');
		expect(res.headers.get('content-length')).toBe('0');
	});

	it('rejects when the file cannot be opened', async () => {
		await expect(
			fileResponse(path.join(dir, 'missing'), new Request('http://localhost/m'), {})
		).rejects.toThrow();
	});
});
