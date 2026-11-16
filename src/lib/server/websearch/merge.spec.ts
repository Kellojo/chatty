import { describe, expect, it } from 'vitest';
import { fuseResults, urlKey } from './merge.js';
import type { ProviderId, SearchResult } from './providers.js';

const ORDER: ProviderId[] = ['searxng', 'brave', 'perplexity'];

function result(url: string, extra: Partial<SearchResult['card']> = {}, published?: string) {
	const card = { url, title: extra.title ?? url, ...extra };
	return published ? { card, published } : { card };
}

describe('urlKey', () => {
	it('treats the same page as the same, whatever its spelling', () => {
		const same = [
			'https://www.Example.com/docs/?b=2&a=1#intro',
			'http://example.com/docs?a=1&b=2',
			'https://example.com:443/docs?utm_source=x&a=1&fbclid=y&b=2'
		];
		expect(new Set(same.map(urlKey)).size).toBe(1);
	});

	it('keeps what tells pages apart', () => {
		expect(urlKey('https://example.com/a')).not.toBe(urlKey('https://example.com/b'));
		expect(urlKey('https://example.com/?q=1')).not.toBe(urlKey('https://example.com/?q=2'));
		expect(urlKey('https://example.com:8080/')).not.toBe(urlKey('https://example.com/'));
		expect(urlKey('https://docs.example.com/')).not.toBe(urlKey('https://example.com/'));
	});

	it('compares a URL that does not parse as-is', () => {
		expect(urlKey('  not a url ')).toBe('not a url');
	});
});

describe('fuseResults', () => {
	it('ranks pages several providers found above one provider’s top result', () => {
		const merged = fuseResults(
			[
				{
					provider: 'searxng',
					results: [
						result('https://a.example/'),
						result('https://x.example/'),
						result('https://shared.example/')
					]
				},
				{
					provider: 'brave',
					results: [
						result('https://b.example/'),
						result('https://y.example/'),
						result('https://z.example/'),
						result('https://shared.example/')
					]
				}
			],
			ORDER,
			10
		);
		// Ranks 3 and 4 together (1/63 + 1/64) beat a single rank 1 (1/61).
		expect(merged[0]).toMatchObject({
			card: { url: 'https://shared.example/' },
			via: ['searxng', 'brave']
		});
	});

	it('breaks ties by best rank, then provider order', () => {
		const merged = fuseResults(
			[
				{ provider: 'brave', results: [result('https://b.example/')] },
				{ provider: 'searxng', results: [result('https://a.example/')] }
			],
			ORDER,
			10
		);
		expect(merged.map((r) => r.card.url)).toEqual(['https://a.example/', 'https://b.example/']);
	});

	it('merges every copy of a page into one card', () => {
		const [merged] = fuseResults(
			[
				{
					provider: 'searxng',
					results: [
						result(
							'http://example.com/post',
							{ title: 'Post', description: 'Short', favicon: 'http://example.com/favicon.ico' },
							'2025-03-02T00:00:00'
						)
					]
				},
				{
					provider: 'brave',
					results: [
						result(
							'https://www.example.com/post/',
							{
								title: 'Post (Brave)',
								description: 'A much longer description',
								favicon: 'https://imgs.search.brave.com/icon.png',
								image: 'https://imgs.search.brave.com/thumb.png'
							},
							'2025-03-01T00:00:00'
						)
					]
				}
			],
			ORDER,
			10
		);
		expect(merged).toEqual({
			card: {
				// The best-ranked copy (SearXNG wins the rank tie), upgraded to https.
				url: 'https://example.com/post',
				title: 'Post',
				description: 'A much longer description',
				// A provider's real icon beats the /favicon.ico guess.
				favicon: 'https://imgs.search.brave.com/icon.png',
				image: 'https://imgs.search.brave.com/thumb.png'
			},
			published: '2025-03-01T00:00:00',
			via: ['searxng', 'brave']
		});
	});

	it('counts a repeat inside one list once, and cuts to the limit', () => {
		const merged = fuseResults(
			[
				{
					provider: 'searxng',
					results: [
						result('https://a.example/'),
						result('https://www.a.example/'),
						result('https://b.example/'),
						result('https://c.example/')
					]
				}
			],
			ORDER,
			2
		);
		expect(merged.map((r) => [r.card.url, r.via])).toEqual([
			['https://a.example/', ['searxng']],
			['https://b.example/', ['searxng']]
		]);
	});

	it('lists via in provider order, whatever order the lists come in', () => {
		const [merged] = fuseResults(
			[
				{ provider: 'perplexity', results: [result('https://a.example/')] },
				{ provider: 'searxng', results: [result('https://a.example/')] }
			],
			ORDER,
			10
		);
		expect(merged.via).toEqual(['searxng', 'perplexity']);
	});
});
