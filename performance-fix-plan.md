# Performance Fix Plan

Based on the verified findings in `performance-review.md`. Four fixes, ordered smallest/isolated first to largest. Verification after each task: `pnpm check` + `pnpm lint` + `pnpm test:unit`; full `pnpm test` at the end.


## Task 4: Full-history protocol change (Option A)

**Problem:** every `/api/chat` POST re-sends the entire message array (`src/lib/components/app/ChatView.svelte:69-71`), and `syncMessages` (`service.ts:101-129`) deletes any server-side message absent from the client list — a stale or buggy client can silently wipe history. Payload and processing grow linearly with conversation length on every message sent.

**Fix:**
- **Client** (`ChatView.svelte`): `prepareSendMessagesRequest` sends only the new/triggering message, not the full array.
- **Server** (`service.ts`): reconstruct history from DB via `listMessages` + map to UIMessage; `syncMessages` becomes append/upsert-only — the delete-anything-not-in-client-list path is removed.
- **Edit/regenerate flows:** replace client truncation with an explicit `truncateAfter?: string` body param handled server-side (delete messages after the given id, then proceed).
- `inlineAttachmentParts` then runs on the server-side history (cheap, thanks to Task 1's cache).
- Extend `service.spec.ts`: new sync behavior, truncation flow, no history wipe on partial client state.

---

## Out of scope (tracked as follow-ups)

- Message pagination on page load (unblocked by Task 4).
- Persisting data URIs in the message row at send time (each attachment inlined exactly once; larger schema/flow change).
- SSE connection caps, provider/model lookup caching (no measurable benefit at self-hosted scale).
