import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db/index.js';
import { findRoleModel } from '$lib/server/db/repo/models.js';
import { transcribeLogged, TranscriptionError } from '$lib/server/speech/transcriber.js';
import type { RequestHandler } from './$types';

function jsonError(status: number, error: string): Response {
	return json({ error }, { status });
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return jsonError(401, 'Unauthorized');

	const formData = await request.formData();
	const audioFile = formData.get('audio');
	if (!audioFile || !(audioFile instanceof File)) return jsonError(400, 'Missing audio file');

	// Resolve model: use explicit provider/model from the form, or fall back to the role default
	const explicitProviderId = formData.get('providerId');
	const explicitModelId = formData.get('modelId');
	let ref: { providerId: string; modelId: string };
	if (typeof explicitProviderId === 'string' && typeof explicitModelId === 'string') {
		ref = { providerId: explicitProviderId, modelId: explicitModelId };
	} else {
		const roleModel = findRoleModel(getDb(), 'speech-to-text');
		if (!roleModel) return json({ text: '' });
		ref = { providerId: roleModel.provider_id, modelId: roleModel.model_id };
	}

	try {
		const text = await transcribeLogged(
			await audioFile.arrayBuffer(),
			ref,
			{ userId: locals.user.id, source: 'chat' },
			{ fileName: audioFile.name || undefined, mimeType: audioFile.type || undefined }
		);
		return json({ text });
	} catch (e) {
		if (e instanceof TranscriptionError) return jsonError(e.status, e.message);
		return jsonError(500, 'Transcription failed');
	}
};
