import type { Component } from 'svelte';
import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';
import EyeIcon from '@lucide/svelte/icons/eye';
import FileTextIcon from '@lucide/svelte/icons/file-text';
import ImageIcon from '@lucide/svelte/icons/image';
import MessageSquareIcon from '@lucide/svelte/icons/message-square';
import MicIcon from '@lucide/svelte/icons/mic';
import SplitIcon from '@lucide/svelte/icons/split';
import VideoIcon from '@lucide/svelte/icons/video';
import Volume2Icon from '@lucide/svelte/icons/volume-2';
import WavesIcon from '@lucide/svelte/icons/waves';
import WrenchIcon from '@lucide/svelte/icons/wrench';

/** Capabilities an admin can switch on or off (the API accepts exactly these). */
export type EditableCapability =
	'chat' | 'streaming' | 'vision' | 'tool_use' | 'image' | 'decisions' | 'transcription' | 'speech';

type Icon = Component<{ class?: string }>;

export interface CapabilityInfo {
	id: EditableCapability;
	label: string;
	description: string;
	icon: Icon;
}

/** Grouped as the edit dialog shows them. */
export const CAPABILITY_GROUPS: { title: string; items: CapabilityInfo[] }[] = [
	{
		title: 'In chats',
		items: [
			{
				id: 'chat',
				label: 'Chat',
				description: 'Can hold a conversation.',
				icon: MessageSquareIcon
			},
			{
				id: 'streaming',
				label: 'Streaming',
				description: 'Replies appear as they are written.',
				icon: WavesIcon
			},
			{
				id: 'vision',
				label: 'Vision',
				description: 'Accepts image attachments.',
				icon: EyeIcon
			},
			{
				id: 'tool_use',
				label: 'Tool use',
				description: 'Can call tools. Required for MCP servers and agents.',
				icon: WrenchIcon
			}
		]
	},
	{
		title: 'Also used for',
		items: [
			{
				id: 'image',
				label: 'Image generation',
				description: 'Creates and edits images.',
				icon: ImageIcon
			},
			{
				id: 'decisions',
				label: 'Decisions API',
				description: 'Answers structured decision calls from the Decisions API.',
				icon: SplitIcon
			},
			{
				id: 'transcription',
				label: 'Speech to text',
				description: 'Transcribes voice messages and audio.',
				icon: MicIcon
			},
			{
				id: 'speech',
				label: 'Text to speech',
				description: 'Reads text aloud.',
				icon: Volume2Icon
			}
		]
	}
];

const BY_ID = new Map(CAPABILITY_GROUPS.flatMap((g) => g.items).map((c) => [c.id as string, c]));
export const EDITABLE_CAPABILITIES = [...BY_ID.keys()] as EditableCapability[];

export const isEditableCapability = (cap: string): cap is EditableCapability => BY_ID.has(cap);

/** Input kinds synced models report that can't be edited here (OpenRouter's modalities). */
const EXTRA: Record<string, { label: string; icon: Icon }> = {
	video: { label: 'Video input', icon: VideoIcon },
	file: { label: 'File input', icon: FileTextIcon },
	audio: { label: 'Audio input', icon: AudioLinesIcon }
};

export function capabilityLabel(cap: string): string {
	return BY_ID.get(cap)?.label ?? EXTRA[cap]?.label ?? cap;
}

export function capabilityIcon(cap: string): Icon | undefined {
	return BY_ID.get(cap)?.icon ?? EXTRA[cap]?.icon;
}
