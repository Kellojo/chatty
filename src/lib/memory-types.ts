export type MemoryScope = 'user' | 'shared';

export interface MemoryTreeNode {
	name: string;
	path: string;
	kind: 'dir' | 'concept';
	title?: string;
	description?: string;
	/** A private concept (frontmatter `private: true`): only trusted models may see it. */
	private?: boolean;
	/** Private, but Chatty suggests reviewing it: it no longer looks like it has personal details. */
	privateReview?: boolean;
	children?: MemoryTreeNode[];
}

export interface ConceptFrontmatter {
	type: string;
	title: string;
	description: string;
	tags: string[];
	timestamp: string;
	/** Only trusted models may see it. Absent means public. */
	private?: boolean;
	/** Why Chatty marked it private on its own (automatic classification). */
	privateReason?: string;
	/** Chatty suggests reviewing the flag: it no longer looks like it has personal details. */
	privateReview?: string;
}

export interface Concept {
	scope: MemoryScope;
	path: string;
	frontmatter: ConceptFrontmatter;
	body: string;
}

/** How often the AI came across a concept, since tracking began. */
export interface MemoryViewTotals {
	/** Times it was among search_memory results. */
	searchHits: number;
	/** Times read_concept opened it. */
	reads: number;
	/** The part of each made by agent runs rather than chats. */
	agentSearchHits: number;
	agentReads: number;
	lastViewedAt: number | null;
}

export interface MemorySearchHit {
	scope: string;
	path: string;
	title: string;
	description: string;
	tags: string[];
	snippet: string;
	/** A private concept (only returned where private items may be seen). */
	private: boolean;
}

export interface MemoryWriteEntry {
	id: string;
	user_id: string;
	conversation_id: string | null;
	agent_run_id: string | null;
	concept_path: string;
	action: 'create' | 'update' | 'delete';
	author: string;
	diff: string | null;
	created_at: number;
}

export interface MemoryGraphNode {
	/** `<scope>:<path>`, unique across scopes. */
	id: string;
	scope: MemoryScope;
	path: string;
	title: string;
	type: string;
	tags: string[];
	/** Top-level folder, '' for memories at the bundle root, `Shared` for shared memories. */
	folder: string;
	/** A private concept: only trusted models may see it. */
	private?: boolean;
}

export interface MemoryGraphEdge {
	/** Node ids. */
	source: string;
	target: string;
	/** `link`: one memory links to the other. `tag`: they share a tag. */
	kind: 'link' | 'tag';
}

export interface MemoryGraph {
	nodes: MemoryGraphNode[];
	edges: MemoryGraphEdge[];
}
