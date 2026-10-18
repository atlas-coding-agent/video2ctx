import { describe, expect, it } from 'vitest';
import type { Comment } from 'all-things-youtube';
import { commentPassage, earliestTokenMatch } from '../src/agents/providers/youtube/tools/get-video-comments';
import { collectionRetrieval, modelCollection } from '../src/agents/runtime/collection-coverage';

// Regressions for comment-search issues found in the independent PR211 review.

const longComment = (text: string) => ({
  id: 'c', text, author: { name: 'Janine', thumbnails: [] }, replyCount: 0, isPinned: false, isHearted: false, replies: [],
}) as unknown as Comment;
const filler = 'Some unrelated setup words here. '.repeat(70);

describe('search passages use the same whole-token, accent-folded matching as session search', () => {
  it('skips a term that only occurs inside a longer word', () => {
    const text = `Before we start, ${filler} the real art of it is patience.`;
    const match = earliestTokenMatch(text, ['art']);
    expect(match).toBeDefined();
    expect(text.slice(match!.at, match!.end)).toBe('art');
    expect(match!.at).toBeGreaterThan(text.indexOf('the real'));
    const passage = commentPassage(longComment(text), ['art']);
    expect(passage.start).toBeGreaterThan(0);
    expect(passage.text).toContain('the real art of it is patience');
    expect(passage.text).toContain('Author: Janine');
  });

  it('finds an accented word from an unaccented term, at its original offsets', () => {
    const text = `${filler}We finally met at the café near the station.`;
    const match = earliestTokenMatch(text, ['cafe']);
    expect(text.slice(match!.at, match!.end)).toBe('café');
    const passage = commentPassage(longComment(text), ['cafe']);
    expect(passage.text).toContain('the café near the station');
  });

  it('maps decomposed accents and case back to the original text', () => {
    const text = 'A CAFE\u0301 sign';
    const match = earliestTokenMatch(text, ['café']);
    expect(text.slice(match!.at, match!.end)).toBe('CAFE');
  });

  it('returns no match when the term is only a fragment', () => {
    expect(earliestTokenMatch('Restart the article', ['art'])).toBeUndefined();
  });
});

describe('filtered saved reads describe offsets as matches', () => {
  it('states match counts and the same-query continuation, not provider-page positions', () => {
    const retrieval = collectionRetrieval({ fetchedCount: 12, retainedCount: 8, continuationAccepted: true,
      pageOffset: 0, nextPageOffset: 8, matchesOnly: true });
    const coverage = modelCollection({ shown: 8, retained: 8, retrieval, continuationShown: false }).coverage;
    expect(coverage).toContain('12 saved entries match the query.');
    expect(coverage).toContain('Repeat this saved read with the same query at offset 8');
    expect(coverage).not.toContain('provider page had');
    expect(coverage).not.toContain('same continuation');
  });

  it('keeps provider-page wording and names the version for unfiltered saved reads', () => {
    const version = 'a'.repeat(64);
    const retrieval = collectionRetrieval({ fetchedCount: 14, retainedCount: 8, continuationAccepted: true,
      pageOffset: 0, nextPageOffset: 8, pageVersion: version });
    const coverage = modelCollection({ shown: 8, retained: 8, retrieval, continuationShown: false }).coverage;
    expect(coverage).toContain('The provider page had 14 entries.');
    expect(coverage).toContain(`Read offset 8 with pageVersion ${version}`);
  });
});
