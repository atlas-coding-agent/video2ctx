import type { Comment } from 'all-things-youtube';
import { tool } from 'ai';
import { z } from 'zod';
import { evidencePacketSchema } from '../../../contracts';
import { COMMENT_READ_LIMIT, collectionRetrieval } from '../../../runtime/collection-coverage';
import type { AgentToolContext } from '../tool-context';
import {
  continuationSchema,
  executeProviderEvidence,
  meteredCredits,
  providerWarnings,
  safeIdPart,
  videoIdSchema,
  youtubeVideoUrl,
} from './provider-evidence';

const COMMENT_EXCERPT_CHARACTERS = 2_000;
/** Context kept before a matched term, small enough that the match survives the smallest model text budget. */
const PASSAGE_LEAD_CHARACTERS = 40;

export const getVideoCommentsInputSchema = z.object({
  videoId: videoIdSchema,
  continuation: continuationSchema,
  /** Position within the saved provider page. Independent of the provider continuation. */
  offset: z.number().int().min(0).max(10_000).optional()
    .describe('Entry offset within the same saved provider page, returned as nextOffset. Omit for the first entries of a page.'),
  pageVersion: z.string().regex(/^[a-f0-9]{64}$/).optional()
    .describe('The pageVersion returned with nextOffset. Required with an offset, so later comments come from the same saved page.'),
});

export type GetVideoCommentsInput = z.infer<typeof getVideoCommentsInputSchema>;

export function createGetVideoCommentsTool(context: AgentToolContext) {
  return tool({
    description: `Read up to ${COMMENT_READ_LIMIT} comments for exactly one YouTube video, in YouTube's default ranking. A provider page can hold more comments than one read returns. When nextOffset is returned, pass it with the returned pageVersion and the same continuation to read the rest of that saved page without a new provider fetch. Pass the returned continuation only to fetch the next provider page, which starts after the whole current page.`,
    inputSchema: getVideoCommentsInputSchema,
    outputSchema: evidencePacketSchema,
    execute: (input, { toolCallId }) => executeGetVideoComments(input, context, toolCallId),
  });
}

/** One comment page slice. Excerpt IDs keep the comment's position on its provider page. */
export function commentPageSlice<T>(comments: readonly T[], offset = 0, limit = COMMENT_READ_LIMIT) {
  const start = Math.max(0, Math.min(offset, comments.length));
  const page = comments.slice(start, start + limit);
  const next = start + page.length;
  return {
    page: page.map((comment, index) => ({ comment, position: start + index })),
    start,
    nextOffset: next < comments.length ? next : undefined,
  };
}

export function executeGetVideoComments(
  input: GetVideoCommentsInput,
  context: AgentToolContext,
  toolCallId: string,
) {
  const parsed = getVideoCommentsInputSchema.parse(input);
  if (parsed.offset && !parsed.pageVersion)
    throw new Error('Pass the pageVersion returned with nextOffset, so later comments come from the same saved page.');
  let savedVersion: string | undefined;
  return executeProviderEvidence({
    context,
    toolCallId,
    toolName: 'get_video_comments',
    operation: 'comments',
    // Offset 0 keeps the original reuse key, so first-page reads still deduplicate.
    semanticInput: { videoId: parsed.videoId, continuation: parsed.continuation,
      ...(parsed.offset ? { offset: parsed.offset } : {}), ...(parsed.pageVersion ? { pageVersion: parsed.pageVersion } : {}) },
    load: async () => {
      const response = await context.provider.comments(parsed.videoId, {
        continuation: parsed.continuation,
        ...(parsed.pageVersion ? { pageVersion: parsed.pageVersion } : {}),
      });
      if (parsed.pageVersion && response.assetVersions?.[0] !== parsed.pageVersion)
        throw new Error('The saved comment page is no longer available. Read the page again without an offset.');
      savedVersion = response.assetVersions?.[0];
      return response;
    },
    credits: meteredCredits('comments'),
    packet: (value) => {
      const sourceId = `youtube:${parsed.videoId}:comments`;
      const slice = commentPageSlice(value.comments, parsed.offset);
      // Later entries are offered only from a saved page, so every read of them is pinned.
      const nextOffset = savedVersion ? slice.nextOffset : undefined;
      const remaining = value.comments.length - slice.start - slice.page.length;
      return {
        kind: 'youtube_comments' as const,
        sources: [{
          id: sourceId,
          provider: 'youtube' as const,
          kind: 'comments' as const,
          videoId: parsed.videoId,
          url: youtubeVideoUrl(parsed.videoId),
        }],
        excerpts: slice.page.map(({ comment, position }) => ({
          id: `comment:${safeIdPart(comment.id)}:${position}`,
          sourceId,
          text: summarizeComment(comment),
        })),
        artifacts: [{
          type: 'youtube_comments',
          title: `Comments for ${parsed.videoId}`,
          data: {
            returnedCount: slice.page.length,
            totalCount: value.totalCount,
            complete: 'complete' in value ? value.complete : false,
            pagesFetched: 'pagesFetched' in value ? value.pagesFetched : 1,
            ...(savedVersion ? { pageVersion: savedVersion } : {}),
            ...(nextOffset !== undefined ? { nextOffset } : {}),
            collection: collectionRetrieval({
              fetchedCount: value.comments.length,
              retainedCount: slice.page.length,
              reportedTotal: value.totalCount,
              continuation: value.continuation,
              continuationAccepted: true,
              pageOffset: slice.start,
              nextPageOffset: nextOffset,
              pageVersion: nextOffset !== undefined ? savedVersion : undefined,
            }),
          },
        }],
        continuation: value.continuation,
        warnings: [
          ...providerWarnings(
            value.meta,
            'PARTIAL_YOUTUBE_COMMENTS',
            'YouTube returned partial comment data.',
          ),
          ...(remaining > 0 ? [{
            code: 'COMMENT_PAGE_REMAINING',
            message: nextOffset !== undefined
              // How to read the rest is stated once, in the packet's collection coverage and nextOffset.
              ? `This read holds comments ${slice.start + 1} to ${slice.start + slice.page.length} of ${value.comments.length} on the saved provider page. The rest were not read in this packet.`
              : `This read holds comments ${slice.start + 1} to ${slice.start + slice.page.length} of ${value.comments.length} on the provider page. The page was not saved, so the other ${remaining} cannot be read without fetching it again; do not describe them.`,
          }] : []),
        ],
      };
    },
  });
}

function normalizeCommentText(value: string): string {
  return value.replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function commentAttribution(comment: Comment): string {
  return [
    `Author: ${comment.author.name}`,
    comment.publishedTimeText ? `Published: ${comment.publishedTimeText}` : undefined,
    comment.likeCountText ? `Likes: ${comment.likeCountText}` : undefined,
    comment.replyCount === undefined ? undefined : `Replies: ${comment.replyCount}`,
    comment.isPinned ? 'Pinned: yes' : undefined,
    comment.isHearted ? 'Creator heart: yes' : undefined,
  ].filter(Boolean).join('\n').slice(0, 500);
}

/**
 * Comment text followed by its attribution. Space for the attribution is reserved, so a
 * long body is shortened instead of losing the author. Short comments read as before.
 */
export function summarizeComment(comment: Comment): string {
  return commentPassage(comment).text;
}

/**
 * A bounded passage of one comment. With search terms, a body longer than one excerpt is
 * shown around the earliest matching term, so a match in its tail stays visible.
 * `start` is set only when the passage does not begin at the start of the body.
 */
export function commentPassage(comment: Comment, terms: readonly string[] = []): { text: string; start?: number } {
  const attribution = commentAttribution(comment);
  const body = normalizeCommentText(comment.text ?? '');
  const budget = COMMENT_EXCERPT_CHARACTERS - attribution.length - 1;
  if (body.length <= budget) return { text: body ? `${body}\n${attribution}` : attribution };
  const match = earliestTokenMatch(body, terms);
  if (!match || match.end <= budget - 1)
    return { text: `${body.slice(0, budget - 1)}…\n${attribution}` };
  // Start just before the match, so a later shortening of the passage keeps the match.
  const start = Math.max(0, match.at - PASSAGE_LEAD_CHARACTERS);
  const end = Math.min(body.length, start + budget - 2);
  return { text: `…${body.slice(start, end)}${end < body.length ? '…' : ''}\n${attribution}`, start };
}

/** Characters the search tokenizer keeps inside a token: letters and numbers, with their marks. */
const TOKEN_CHARACTER = /[\p{L}\p{N}\p{M}]/u;

/**
 * Lowercased text without diacritics, with each folded character mapped to its original
 * index. This mirrors the session search tokenizer (SQLite FTS5 unicode61, which removes
 * diacritics by default), so "cafe" finds "café".
 */
function foldedText(text: string): { folded: string; origin: number[] } {
  let folded = '';
  const origin: number[] = [];
  for (let index = 0; index < text.length;) {
    const point = text.codePointAt(index)!;
    const character = String.fromCodePoint(point);
    for (const part of character.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()) {
      folded += part;
      for (let unit = 0; unit < part.length; unit += 1) origin.push(index);
    }
    index += character.length;
  }
  return { folded, origin };
}

/**
 * The earliest whole-token occurrence of any search term, in original-text offsets. A term
 * inside a longer word, such as "art" in "start", is not a match, as in session search.
 */
export function earliestTokenMatch(text: string, terms: readonly string[]): { at: number; end: number } | undefined {
  const { folded, origin } = foldedText(text);
  let best: { at: number; end: number } | undefined;
  for (const term of terms) {
    const needle = foldedText(term).folded.trim();
    if (!needle) continue;
    for (let offset = folded.indexOf(needle); offset >= 0; offset = folded.indexOf(needle, offset + 1)) {
      const before = folded[offset - 1];
      const after = folded[offset + needle.length];
      if ((before && TOKEN_CHARACTER.test(before)) || (after && TOKEN_CHARACTER.test(after))) continue;
      const at = origin[offset]!;
      // The end is the original index just after the last folded character of the match.
      const last = origin[offset + needle.length - 1]!;
      const end = last + String.fromCodePoint(text.codePointAt(last)!).length;
      if (!best || at < best.at) best = { at, end };
      break;
    }
  }
  return best;
}

/** Full searchable comment content: the whole body and the author, never a shortened excerpt. */
export function commentSearchText(comment: Comment): string {
  return `${comment.text ?? ''}\n${comment.author.name}`;
}
