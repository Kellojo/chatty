import type { TimeFormat } from '$lib/user-settings.js';

function hour12Option(format: TimeFormat): { hour12?: boolean } {
	return format === 'auto' ? {} : { hour12: format === '12h' };
}

export function formatTime(timestamp: number, format: TimeFormat): string {
	return new Intl.DateTimeFormat(undefined, {
		hour: 'numeric',
		minute: '2-digit',
		...hour12Option(format)
	}).format(timestamp);
}

export function formatDateTime(timestamp: number, format: TimeFormat): string {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
		...hour12Option(format)
	}).format(timestamp);
}

export function formatTimeAgo(timestamp: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (seconds < 60) return 'just now';
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(timestamp);
}

export function formatMessageTime(timestamp: number, format: TimeFormat, now = new Date()): string {
	const date = new Date(timestamp);
	const sameDay =
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate();
	return sameDay ? formatTime(timestamp, format) : formatDateTime(timestamp, format);
}
