export type MemoryScope = 'user' | 'shared';

export interface MemoryTreeNode {
	name: string;
	path: string;
	kind: 'dir' | 'concept';
	title?: string;
	description?: string;
	children?: MemoryTreeNode[];
}

export interface ConceptFrontmatter {
	type: string;
	title: string;
	description: string;
	tags: string[];
	timestamp: string;
}

export interface Concept {
	scope: MemoryScope;
	path: string;
	frontmatter: ConceptFrontmatter;
	body: string;
}

export interface MemorySearchHit {
	scope: string;
	path: string;
	title: string;
	description: string;
	tags: string[];
	snippet: string;
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
