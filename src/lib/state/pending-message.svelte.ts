type Pending = { conversationId: string; text: string; files: File[] };

// Hands the first message of a new chat from the start page to its ChatView.
// Bound to a conversation so it can never be delivered to a different chat.
class PendingMessage {
	#pending = $state.raw<Pending | null>(null);

	set(conversationId: string, text: string, files: File[] = []) {
		this.#pending = { conversationId, text, files };
	}

	consume(conversationId: string): { text: string; files: File[] } | null {
		const pending = this.#pending;
		if (pending?.conversationId !== conversationId) return null;
		this.#pending = null;
		return { text: pending.text, files: pending.files };
	}

	clear() {
		this.#pending = null;
	}
}

export const pendingMessage = new PendingMessage();

// Asks the new chat's ChatView to start voice mode (the new-chat page's voice button).
class PendingVoice {
	#conversationId: string | null = null;

	set(conversationId: string) {
		this.#conversationId = conversationId;
	}

	consume(conversationId: string): boolean {
		if (this.#conversationId !== conversationId) return false;
		this.#conversationId = null;
		return true;
	}

	clear() {
		this.#conversationId = null;
	}
}

export const pendingVoice = new PendingVoice();
