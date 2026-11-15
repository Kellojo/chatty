-- Voices a text-to-speech model accepts, as a JSON array of names, when its provider
-- lists them on model sync (OpenRouter's `supported_voices`). NULL when unknown.
ALTER TABLE models ADD COLUMN voices TEXT;
