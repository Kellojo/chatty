// Production entrypoint. adapter-node parses BODY_SIZE_LIMIT once when
// build/handler.js is imported, so it must be set before that import happens.
// Deriving it here keeps the HTTP body limit in sync with the attachment size
// limit without requiring operators to configure two env vars. An explicitly
// set BODY_SIZE_LIMIT always wins.
import { existsSync } from 'node:fs';
import { deriveBodySizeLimit } from '../src/lib/server/body-size-limit.js';

if (existsSync('.env')) {
	process.loadEnvFile('.env');
}

process.env.BODY_SIZE_LIMIT = deriveBodySizeLimit(process.env);

await import('../build/index.js');
