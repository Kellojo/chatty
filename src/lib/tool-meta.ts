export interface ToolMeta {
	label: string;
	server: string;
}

export const TOOL_META: Record<string, ToolMeta> = {
	fetch: { label: 'Fetch URL', server: 'webfetch' },
	now: { label: 'Current time', server: 'datetime' },
	get_timezone: { label: 'Get timezone', server: 'datetime' },
	format: { label: 'Format date', server: 'datetime' },
	convert: { label: 'Convert timezone', server: 'datetime' },
	search_chats: { label: 'Search chats', server: 'chat-search' },
	fs_ls: { label: 'List files', server: 'fs' },
	fs_read: { label: 'Read file', server: 'fs' },
	fs_head: { label: 'Read file start', server: 'fs' },
	fs_tail: { label: 'Read file end', server: 'fs' },
	fs_wc: { label: 'Count words', server: 'fs' },
	fs_grep: { label: 'Search in files', server: 'fs' },
	fs_glob: { label: 'Find files', server: 'fs' },
	fs_write: { label: 'Write file', server: 'fs' },
	fs_edit: { label: 'Edit file', server: 'fs' },
	fs_mkdir: { label: 'Create directory', server: 'fs' },
	fs_rm: { label: 'Delete file', server: 'fs' },
	fs_curl: { label: 'Download file', server: 'fs' },
	get_setting: { label: 'Get setting', server: 'settings' },
	list_settings: { label: 'List settings', server: 'settings' },
	update_setting: { label: 'Update setting', server: 'settings' },
	generate_image: { label: 'Generate image', server: 'image' }
};
