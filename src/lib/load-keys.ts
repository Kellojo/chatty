// Custom `depends()` keys, so background refreshes can rerun only the loads
// they affect instead of invalidateAll().

/** The (app) layout's sidebar data: conversation list, unread markers, counts. */
export const CONVERSATIONS_KEY = 'app:conversations';

/** The Usage › Requests pages: the request log, its stats, and one request's details. */
export const PROXY_REQUESTS_KEY = 'app:proxy-requests';
