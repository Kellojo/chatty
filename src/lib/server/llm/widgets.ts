/**
 * Chat widgets the model writes itself: fenced code blocks of JSON that the
 * client renders (see `components/ai/markdown/markdown.svelte`). Each one
 * lists only when it can apply, judged from the conversation's tools, so
 * the prompt stays small and stays stable for the whole conversation.
 *
 * Widgets fed by one builtin tool (clock, weather, memory, calc, ...) are
 * explained in that tool's description instead: they cost nothing unless the
 * tool is in the prompt.
 */

interface PromptWidget {
	/** The fence language the client renders. */
	language: string;
	/** Whether the widget can apply, given every tool name of the conversation (deferred ones too). */
	when?: (toolNames: ReadonlySet<string>) => boolean;
	prompt: string;
}

const someTool = (names: ReadonlySet<string>, pattern: RegExp) =>
	[...names].some((name) => pattern.test(name));

const WIDGETS: PromptWidget[] = [
	{
		language: 'chart',
		prompt: `\`\`\`chart: {"type":"bar"|"line"|"area"|"pie","title":"optional","labels":["Jan","Feb"],"datasets":[{"label":"optional","data":[1,2]}]}. bar/line/area take one or more datasets over the shared labels; pie takes one dataset with a slice per label.`
	},
	{
		language: 'map',
		prompt: `\`\`\`map: whenever your answer lists specific local places (restaurants, hotels, shops, landmarks, ...), end it with {"title":"optional","center":[lat,lng],"zoom":13,"markers":[{"name":"required","lat":38.7151,"lng":-9.1341,"address":"optional","phone":"optional","website":"optional","rating":4.4,"notes":"optional"}]}. Take coordinates from a place-search tool when you used one, otherwise use well-known coordinates of established places. Never invent coordinates: leave a place out rather than guess. Up to ~10 markers, best matches first.`
	},
	{
		language: 'events',
		prompt: `\`\`\`events: whenever your answer lists concerts, festivals, games, shows or other dated events, end it with {"title":"optional","events":[{"title":"required","start":"2026-11-14T20:00","end":"optional","venue":"…","city":"…","lineup":["support act"],"price":"from €49","status":"soldout"|"few"|"cancelled"|"postponed"|"free","doors":"19:00","category":"Festival","notes":"Moved to Feb 12, tickets stay valid","url":"https://tickets…"}]}. Write start/end as the local time at the venue (no offset); use a bare date when the time is unknown or for multi-day events, and set "allDay":true only for genuinely all-day events. Never invent dates, prices or ticket URLs: leave unknown fields out.`
	},
	{
		language: 'mealplan',
		when: (names) => someTool(names, /meal|recipe/i),
		prompt: `\`\`\`mealplan: to show planned meals, {"title":"optional","from":"YYYY-MM-DD","to":"YYYY-MM-DD","items":[...]}. Pass planned items through verbatim when a meal-planner tool returned them ({date, slot, recipeName, servings, calories, …}); otherwise write {"date":"YYYY-MM-DD","slot":"Breakfast"|"Lunch"|"Dinner"|"Snack","name":"…","servings":2,"calories":450,"minutes":30}. Set from/to to the range you were asked about, so empty days show.`
	},
	{
		language: 'file',
		when: (names) => names.has('fs_write') || names.has('code_exec'),
		prompt: `\`\`\`file: for a workspace file the user should download or open, {"name":"<display name>","path":"<relative path in workspace>"}. Only for noteworthy files, not intermediate or temporary ones.`
	}
];

/**
 * The system prompt section explaining the widgets that can apply to a
 * conversation with these tools.
 */
export function widgetsPrompt(toolNames: Iterable<string> = []): string {
	const names = new Set(toolNames);
	const lines = WIDGETS.filter((w) => !w.when || w.when(names)).map((w) => `- ${w.prompt}`);
	return [
		'## Chat widgets',
		'The chat renders these fenced code blocks as interactive widgets. Put only the JSON inside the fence, no other text.',
		...lines
	].join('\n');
}
