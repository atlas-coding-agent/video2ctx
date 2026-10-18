import { describe, expect, it } from 'vitest';
import type { Comment } from 'all-things-youtube';
import { commentPassage } from '../src/agents/providers/youtube/tools/get-video-comments';
import { collectionRetrieval, modelCollection } from '../src/agents/runtime/collection-coverage';

// Regressions for comment-search issues found in the independent PR211 review.

const longComment = (text: string) => ({
  id: 'c', text, author: { name: 'Janine', thumbnails: [] }, replyCount: 0, isPinned: false, isHearted: false, replies: [],
}) as unknown as Comment;
const filler = 'Some unrelated setup words here. '.repeat(70);

describe('search passages are placed at the match offset session search reports', () => {
  // Matching itself is decided by SQLite FTS5; session-evidence.integration.test.ts checks real tokenizer cases.
  it('shows the passage at a late reported offset even when an earlier substring exists', () => {
    const text = `Before we start, ${filler} the real art of it is patience.`;
    const passage = commentPassage(longComment(text), [], text.lastIndexOf('art'));
    expect(passage.start).toBeGreaterThan(0);
    expect(passage.text).toContain('the real art of it is patience');
    expect(passage.text).toContain('Author: Janine');
  });

  it('maps a raw offset through whitespace normalization', () => {
    const text = `${'Padding   with \t extra   spaces. '.repeat(90)}The objection is here.`;
    const passage = commentPassage(longComment(text), [], text.indexOf('The objection'));
    expect(passage.text).toContain('The objection is here.');
  });

  it('starts at the beginning for an author-only match, keeping the attribution', () => {
    const text = filler;
    const passage = commentPassage(longComment(text), [], text.length + 1);
    expect(passage.start).toBeUndefined();
    expect(passage.text).toContain('Author: Janine');
  });

  it('keeps literal matching for filtered saved reads without a reported offset', () => {
    const text = `${filler}The final objection.`;
    expect(commentPassage(longComment(text), ['objection']).text).toContain('The final objection.');
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
