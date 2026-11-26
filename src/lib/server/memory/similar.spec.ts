import { describe, expect, it } from 'vitest';
import { commonWords, sharesSubject, subjectWords } from './similar.js';

describe('commonWords', () => {
	const titles = [
		'Chatty — voice mode',
		'Chatty — web search settings',
		'Chatty — built-in Maps/Places provider (Google + OSM)',
		'Chatty — Maps Provider (places search + map widget)',
		'Chatty — onboarding',
		'Home interior style'
	];

	it('finds words most titles share, and only those', () => {
		expect([...commonWords(titles)]).toEqual(['chatt']);
	});

	it('lets real duplicates match once the shared app name is ignored, and not siblings', () => {
		const common = commonWords(titles);
		const [, search, maps, mapsPlaces] = titles.map((t) => subjectWords(t, common));
		expect(sharesSubject(maps, mapsPlaces)).toBe(true);
		expect(sharesSubject(subjectWords('Chatty — voice settings', common), search)).toBe(false);
	});

	it('needs at least three titles before a word counts as common', () => {
		expect(commonWords(['Chatty voice', 'Chatty search']).size).toBe(0);
	});
});

describe('subjectWords', () => {
	it('keeps distinctive words as stems, dropping short words and stopwords', () => {
		expect([...subjectWords('The user’s Marmalade tracker for jam')]).toEqual(['marma', 'track']);
	});
});

describe('sharesSubject', () => {
	const words = (t: string) => subjectWords(t);

	it('matches notes that share two subject words, across word forms', () => {
		expect(sharesSubject(words('Marmalade tracker'), words('Marmalade tracking app'))).toBe(true);
	});

	it('does not match on a single shared word when the new note has more', () => {
		expect(sharesSubject(words('Chatty voice mode'), words('Chatty web search'))).toBe(false);
	});

	it('matches a one-word subject on that word', () => {
		expect(sharesSubject(words('Statty'), words('Statty status page'))).toBe(true);
	});

	it('never matches on stopwords alone', () => {
		expect(sharesSubject(words('About the user'), words('The user and their notes'))).toBe(false);
	});
});
