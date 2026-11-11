// Sends Web Push notices for server events, so they reach devices where Chatty
// is closed or asleep (a phone in your pocket). Runs beside the open tabs' own
// alerts: while you're using Chatty somewhere, or watching the chat in
// question (see ./presence.ts), a notice is held instead, and pushed once you
// step away if it still matters (unread, still waiting for you).
import * as webPush from 'web-push';
import type { ServerEvent } from '$lib/types.js';
import type { Db } from '../db/index.js';
import { getDb } from '../db/index.js';
import {
	deletePushSubscriptionById,
	listPushSubscriptions,
	markPushFailure,
	markPushSuccess,
	type PushSubscriptionRow
} from '../db/repo/push-subscriptions.js';
import { subscribeAllServerEvents } from '../events/bus.js';
import { createLogger } from '../logger.js';
import { isPushServiceEndpoint } from './endpoints.js';
import { noticeForPush, noticeStillWanted, toPushPayload, type PushPayload } from './notices.js';
import { isUserAround, sawPathSince } from './presence.js';
import { getVapidDetails } from './vapid.js';

const log = createLogger('push');

/** Events that can produce a notice; everything else is skipped without a DB read. */
const NOTICE_EVENTS = new Set<ServerEvent['type']>([
	'chat.message_completed',
	'coding.thread.finished',
	'coding.task.awaiting_input',
	'agent.run.awaiting_input',
	'agent.run.finished'
]);

/** Repeats of one notice within this window (e.g. reply + finished) push once. */
export const PUSH_DEDUPE_MS = 3000;
/** How long a push service keeps trying an offline device. */
const TTL_SECONDS = 12 * 60 * 60;

export type PushSender = (
	subscription: webPush.PushSubscription,
	payload: string,
	options: webPush.RequestOptions
) => Promise<{ statusCode: number }>;

const defaultSender: PushSender = (subscription, payload, options) =>
	webPush.sendNotification(subscription, payload, options);

export interface SendResult {
	sent: number;
	removed: number;
	failed: number;
}

/** Sends one payload to the user's subscriptions (or just `only`), pruning dead ones. */
export async function sendPushToUser(
	db: Db,
	userId: string,
	payload: PushPayload,
	opts: { sender?: PushSender; only?: PushSubscriptionRow[] } = {}
): Promise<SendResult> {
	const result: SendResult = { sent: 0, removed: 0, failed: 0 };
	const subscriptions: PushSubscriptionRow[] = [];
	for (const sub of opts.only ?? listPushSubscriptions(db, userId)) {
		// Rows from before the endpoint allowlist, or edited by hand: never POST there.
		if (isPushServiceEndpoint(sub.endpoint)) {
			subscriptions.push(sub);
		} else {
			deletePushSubscriptionById(db, sub.id);
			result.removed++;
		}
	}
	if (subscriptions.length === 0) return result;
	const vapid = getVapidDetails(db);
	const sender = opts.sender ?? defaultSender;
	const body = JSON.stringify(payload);
	await Promise.all(
		subscriptions.map(async (sub) => {
			try {
				await sender(
					{ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
					body,
					{
						vapidDetails: vapid,
						TTL: TTL_SECONDS,
						// Every push shows a notification, which is what high priority is for;
						// normal lets Android's Doze hold a locked phone's pushes for minutes.
						urgency: 'high',
						timeout: 15_000
					}
				);
				markPushSuccess(db, sub.id);
				result.sent++;
			} catch (e) {
				const status = (e as { statusCode?: number }).statusCode;
				// The browser unsubscribed or the subscription expired.
				if (status === 404 || status === 410) {
					deletePushSubscriptionById(db, sub.id);
					result.removed++;
					return;
				}
				result.failed++;
				// Only a rejection of this subscription counts toward dropping it. Network
				// errors, rate limits and push-service outages say nothing about the device,
				// and counting them would wipe every device after a short outage.
				if (countsAgainstSubscription(status) && markPushFailure(db, sub.id)) {
					result.removed++;
				}
				log.warn('Push send failed', {
					status: status ?? null,
					host: safeHost(sub.endpoint),
					error: e instanceof Error ? e.message : String(e)
				});
			}
		})
	);
	return result;
}

function countsAgainstSubscription(status: number | undefined): boolean {
	return status !== undefined && status >= 400 && status < 500 && status !== 429;
}

function safeHost(endpoint: string): string | null {
	try {
		return new URL(endpoint).host;
	} catch {
		return null;
	}
}

/** A notice held back because you were using Chatty is looked at again this often… */
export const PUSH_RECHECK_MS = 30_000;
/** …for up to this long. Past that you've been at Chatty all along and saw it there. */
export const PUSH_MAX_HOLD_MS = 15 * 60_000;

export type Schedule = (run: () => Promise<void>, ms: number) => () => void;

const defaultSchedule: Schedule = (run, ms) => {
	const timer = setTimeout(() => void run(), ms);
	timer.unref?.();
	return () => clearTimeout(timer);
};

export interface DispatcherOptions {
	db?: () => Db;
	sender?: PushSender;
	now?: () => number;
	schedule?: Schedule;
}

export interface PushDispatcher {
	/** Pushes the notice an event calls for, now or once you've stepped away. */
	handle(userId: string, event: ServerEvent): Promise<void>;
	/** Notices waiting for you to step away. */
	heldCount(): number;
	stop(): void;
}

export function createPushDispatcher(opts: DispatcherOptions = {}): PushDispatcher {
	const getNow = opts.now ?? Date.now;
	const schedule = opts.schedule ?? defaultSchedule;
	/** Last push per user and tag, for the dedupe window. */
	const recent = new Map<string, number>();
	/** Held notices per user and tag; a newer one with the same tag replaces it. */
	const held = new Map<string, () => void>();

	const release = (key: string) => {
		held.get(key)?.();
		held.delete(key);
	};

	async function attempt(
		userId: string,
		event: ServerEvent,
		firstSeenAt: number,
		recheck: boolean
	): Promise<void> {
		const db = (opts.db ?? getDb)();
		const now = getNow();
		const subscriptions = listPushSubscriptions(db, userId, now);
		if (subscriptions.length === 0) return;
		const notice = noticeForPush(db, userId, event);
		if (!notice) return;
		const key = `${userId}:${notice.tag}`;
		if (recheck) {
			// Held a while: you went to that chat since, or answered the question.
			if (sawPathSince(userId, notice.url, firstSeenAt, now)) return;
			if (!noticeStillWanted(db, userId, notice)) return;
		}

		// You're at Chatty: the open tab alerts. Look again shortly, since you may
		// have typed a prompt and left; the push goes out once you've stepped away,
		// unless you've seen the chat by then.
		if (isUserAround(userId, now)) {
			if (now + PUSH_RECHECK_MS - firstSeenAt > PUSH_MAX_HOLD_MS) {
				log.info('Dropped a held push notice after the maximum hold', { tag: notice.tag });
				return;
			}
			release(key);
			held.set(
				key,
				schedule(async () => {
					held.delete(key);
					await attempt(userId, event, firstSeenAt, true).catch(logDispatchError);
				}, PUSH_RECHECK_MS)
			);
			return;
		}

		release(key);
		if (now - (recent.get(key) ?? 0) < PUSH_DEDUPE_MS) return;
		recent.set(key, now);
		if (recent.size > 1000) {
			for (const [k, at] of recent) if (now - at >= PUSH_DEDUPE_MS) recent.delete(k);
		}
		await sendPushToUser(db, userId, toPushPayload(notice, firstSeenAt), {
			sender: opts.sender,
			only: subscriptions
		});
	}

	return {
		async handle(userId, event) {
			if (!NOTICE_EVENTS.has(event.type)) return;
			await attempt(userId, event, getNow(), false);
		},
		heldCount: () => held.size,
		stop() {
			// Held notices live in memory only; say so when a restart drops them.
			if (held.size > 0) log.info(`Dropping ${held.size} held push notice(s) on shutdown`);
			for (const cancel of held.values()) cancel();
			held.clear();
		}
	};
}

function logDispatchError(e: unknown): void {
	log.error('Push dispatch failed', { error: e instanceof Error ? e.message : String(e) });
}

const globalState = globalThis as { __pushDispatcherStop?: () => void };

export function stopPushDispatcher(): void {
	globalState.__pushDispatcherStop?.();
	globalState.__pushDispatcherStop = undefined;
}

export function startPushDispatcher(opts: DispatcherOptions = {}): () => void {
	globalState.__pushDispatcherStop?.();
	const dispatcher = createPushDispatcher(opts);
	const unsubscribe = subscribeAllServerEvents((userId, event) => {
		dispatcher.handle(userId, event).catch(logDispatchError);
	});
	const stop = () => {
		unsubscribe();
		dispatcher.stop();
	};
	globalState.__pushDispatcherStop = stop;
	return stop;
}
