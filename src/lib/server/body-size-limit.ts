export function deriveBodySizeLimit(env: Record<string, string | undefined>): string {
	if (env.BODY_SIZE_LIMIT) return env.BODY_SIZE_LIMIT;
	const maxMb = Number.parseInt(env.MAX_ATTACHMENT_SIZE_MB ?? '', 10);
	return `${Number.isFinite(maxMb) && maxMb > 0 ? maxMb : 50}M`;
}
