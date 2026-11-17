import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db/index.js';
import { findRoleModel } from '$lib/server/db/repo/models.js';
import { transcribeLogged, TranscriptionError } from '$lib/server/speech/transcriber.js';
import { speechRequestPrivacy } from '../request-privacy.js';
import type { RequestHandler } from './$types';

/** The transcriber's refusal for private audio (vs. a provider's own 403). */
function isPrivacyRefusal(e: TranscriptionError): boolean {
	return /^This chat is private/.test(e.message);
}

function jsonError(status: number, error: string): Response {
	return json({ error }, { status });
}

/**
 * Transcribes a recording. Form fields: `audio`, optional `providerId` +
 * `modelId` (else the Speech to text default), and the chat it is for:
 * `conversationId`, or `private` (`true`/`false`) for an unsaved new chat.
 * Without either it counts as private, so only trusted models hear it.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return jsonError(401, 'Unauthorized');

	const formData = await request.formData();
	const audioFile = formData.get('audio');
	if (!audioFile || !(audioFile instanceof File)) return jsonError(400, 'Missing audio file');

	const db = getDb();
	const privacy = speechRequestPrivacy(db, locals.user.id, {
		conversationId: formData.get('conversationId'),
		private: formData.get('private')
	});
	if (!privacy) return jsonError(404, 'Conversation not found');

	// Resolve model: use explicit provider/model from the form, or fall back to the role default.
	// Either way the transcriber drops targets a private recording may not reach (403 if none is left).
	const explicitProviderId = formData.get('providerId');
	const explicitModelId = formData.get('modelId');
	let ref: { providerId: string; modelId: string };
	if (typeof explicitProviderId === 'string' && typeof explicitModelId === 'string') {
		ref = { providerId: explicitProviderId, modelId: explicitModelId };
	} else {
		const roleModel = findRoleModel(db, 'speech-to-text');
		if (!roleModel) return json({ text: '' });
		ref = { providerId: roleModel.provider_id, modelId: roleModel.model_id };
	}

	try {
		const text = await transcribeLogged(
			await audioFile.arrayBuffer(),
			ref,
			{
				userId: locals.user.id,
				source: 'chat',
				conversationId: privacy.conversationId ?? null
			},
			privacy,
			{ fileName: audioFile.name || undefined, mimeType: audioFile.type || undefined }
		);
		return json({ text });
	} catch (e) {
		if (e instanceof TranscriptionError) {
			// Chatty's own refusal: a private recording and no trusted model to take it.
			if (e.status === 403 && isPrivacyRefusal(e)) {
				return json({ error: e.message, code: 'private_data_blocked' }, { status: 403 });
			}
			return jsonError(e.status, e.message);
		}
		return jsonError(500, 'Transcription failed');
	}
};
