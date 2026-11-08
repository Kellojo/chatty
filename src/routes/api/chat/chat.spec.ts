import { describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { POST } = await import('./+server.js');

async function post(body: unknown): Promise<number> {
	const event = {
		locals: { user: { id: 'u1', role: 'user' }, session: null } as unknown as App.Locals,
		request: new Request('http://localhost/api/chat', {
			method: 'POST',
			body: JSON.stringify(body)
		})
	};
	try {
		return (await POST(event as never)).status;
	} catch (e) {
		if (isHttpError(e)) return e.status;
		throw e;
	}
}

const message = (parts: unknown[], role = 'user') => ({
	conversationId: 'c1',
	message: { id: 'm1', role, parts }
});

describe('POST /api/chat body validation', () => {
	it.each([
		['a non-user role', message([{ type: 'text', text: 'hi' }], 'assistant')],
		['a tool part', message([{ type: 'tool-bash', toolCallId: 'x', state: 'output-available' }])],
		['a reasoning part', message([{ type: 'reasoning', text: 'secret' }])],
		['a file part without a URL', message([{ type: 'file', mediaType: 'image/png' }])]
	])('rejects %s with 400', async (_label, body) => {
		expect(await post(body)).toBe(400);
	});

	it('lets valid text and file parts through to the service', async () => {
		// The conversation does not exist, so passing validation surfaces as a 404.
		const status = await post(
			message([
				{ type: 'text', text: 'hi' },
				{ type: 'file', url: 'data:text/plain;base64,aGk=', mediaType: 'text/plain' }
			])
		);
		expect(status).toBe(404);
	});
});
