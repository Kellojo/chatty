import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db/index.js';
import { findRoleModel } from '$lib/server/db/repo/models.js';
import { transcribeAudio, TranscriptionError } from '$lib/server/speech/transcriber.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return new Response(JSON.stringify({ error: 'Unauthorized' }), {
			status: 401,
			headers: { 'content-type': 'application/json' }
		});
	}

	let providerId: string;
	let modelId: string;

	const formData = await request.formData();
	const audioFile = formData.get('audio');

	if (!audioFile || !(audioFile instanceof File)) {
		return new Response(JSON.stringify({ error: 'Missing audio file' }), {
			status: 400,
			headers: { 'content-type': 'application/json' }
		});
	}

	// Resolve model: use explicit provider/model from the form, or fall back to the role default
	const explicitProviderId = formData.get('providerId');
	const explicitModelId = formData.get('modelId');

	if (typeof explicitProviderId === 'string' && typeof explicitModelId === 'string') {
		providerId = explicitProviderId;
		modelId = explicitModelId;
	} else {
		const db = getDb();
		const roleModel = findRoleModel(db, 'speech-to-text');
		if (!roleModel) {
			return json({ text: '' }, { status: 200 });
		}
		providerId = roleModel.provider_id;
		modelId = roleModel.model_id;
	}

	try {
		const buffer = await audioFile.arrayBuffer();
		const result = await transcribeAudio(buffer, providerId, modelId);
		return json({ text: typeof result === 'string' ? result : result.text });
	} catch (e) {
		if (e instanceof TranscriptionError) {
			return new Response(JSON.stringify({ error: e.message }), {
				status: e.status,
				headers: { 'content-type': 'application/json' }
			});
		}
		return new Response(JSON.stringify({ error: 'Transcription failed' }), {
			status: 500,
			headers: { 'content-type': 'application/json' }
		});
	}
};
