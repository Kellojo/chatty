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
	const ago = timeAgoParts(timestamp, now);
	return 'text' in ago ? ago.text : `${ago.value}${ago.unit} ago`;
}

/**
 * `formatTimeAgo` as a number and unit (`5` + `m`) so it can be animated, or plain text
 * ("just now", a date) when there is no number to show.
 */
export function timeAgoParts(
	timestamp: number,
	now = Date.now()
): { text: string } | { value: number; unit: 'm' | 'h' | 'd' } {
	const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (seconds < 60) return { text: 'just now' };
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return { value: minutes, unit: 'm' };
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return { value: hours, unit: 'h' };
	const days = Math.floor(hours / 24);
	if (days < 30) return { value: days, unit: 'd' };
	return { text: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(timestamp) };
}

/** How long until `timestamp`, e.g. "in 5m", "in 18h", "in 3d" ("soon" when it's due). */
export function formatTimeUntil(timestamp: number, now = Date.now()): string {
	const minutes = Math.round((timestamp - now) / 60_000);
	if (minutes < 1) return 'soon';
	if (minutes < 60) return `in ${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `in ${hours}h`;
	const days = Math.round(hours / 24);
	if (days < 30) return `in ${days}d`;
	return `on ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(timestamp)}`;
}

export function formatMessageTime(timestamp: number, format: TimeFormat, now = new Date()): string {
	const date = new Date(timestamp);
	const sameDay =
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate();
	return sameDay ? formatTime(timestamp, format) : formatDateTime(timestamp, format);
}
