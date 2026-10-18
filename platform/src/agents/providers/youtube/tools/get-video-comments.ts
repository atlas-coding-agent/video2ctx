import type { Comment } from 'all-things-youtube';
import { tool } from 'ai';
import { z } from 'zod';
import { evidencePacketSchema } from '../../../contracts';
import { collectionRetrieval } from '../../../runtime/collection-coverage';
import type { AgentToolContext } from '../tool-context';
import {
  bounded,
  continuationSchema,
  executeProviderEvidence,
  MAX_PROVIDER_ITEMS,
  meteredCredits,
  providerWarnings,
  safeIdPart,
  videoIdSchema,
  youtubeVideoUrl,
} from './provider-evidence';

export const getVideoCommentsInputSchema = z.object({
  videoId: videoIdSchema,
  continuation: continuationSchema,
  /** Position within the saved provider page. Independent of the provider continuation. */
  offset: z.number().int().min(0).max(10_000).optional()
    .describe('Entry offset within the same saved provider page, returned as nextOffset. Omit for the first entries of a page.'),
});

export type GetVideoCommentsInput = z.infer<typeof getVideoCommentsInputSchema>;

export function createGetVideoCommentsTool(context: AgentToolContext) {
  return tool({
    description: `Read up to ${MAX_PROVIDER_ITEMS} comments for exactly one YouTube video, in YouTube's default ranking. A provider page can hold more comments than one read returns. When nextOffset is returned, pass it with the same continuation to read the rest of that saved page without a new provider fetch. Pass the returned continuation only to fetch the next provider page, which starts after the whole current page.`,
    inputSchema: getVideoCommentsInputSchema,
    outputSchema: evidencePacketSchema,
    execute: (input, { toolCallId }) => executeGetVideoComments(input, context, toolCallId),
  });
}

/** One comment page slice. Excerpt IDs keep the comment's position on its provider page. */
export function commentPageSlice(comments: readonly Comment[], offset = 0, limit = MAX_PROVIDER_ITEMS) {
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
  return executeProviderEvidence({
    context,
    toolCallId,
    toolName: 'get_video_comments',
    operation: 'comments',
    // Offset 0 keeps the original reuse key, so first-page reads still deduplicate.
    semanticInput: { videoId: parsed.videoId, continuation: parsed.continuation, ...(parsed.offset ? { offset: parsed.offset } : {}) },
    load: () => context.provider.comments(parsed.videoId, {
      continuation: parsed.continuation,
    }),
    credits: meteredCredits('comments'),
    packet: (value) => {
      const sourceId = `youtube:${parsed.videoId}:comments`;
      const slice = commentPageSlice(value.comments, parsed.offset);
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
            ...(slice.nextOffset !== undefined ? { nextOffset: slice.nextOffset } : {}),
            collection: collectionRetrieval({
              fetchedCount: value.comments.length,
              retainedCount: slice.page.length,
              reportedTotal: value.totalCount,
              continuation: value.continuation,
              continuationAccepted: true,
              pageOffset: slice.start,
              nextPageOffset: slice.nextOffset,
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
          ...(slice.nextOffset !== undefined ? [{
            code: 'COMMENT_PAGE_REMAINING',
            message: `This read holds comments ${slice.start + 1} to ${slice.start + slice.page.length} of ${value.comments.length} on the saved provider page. Read offset ${slice.nextOffset} with the same continuation for the rest; do not describe unread comments.`,
          }] : []),
        ],
      };
    },
  });
}

export function summarizeComment(comment: Comment): string {
  return bounded([
    comment.text,
    `Author: ${comment.author.name}`,
    comment.publishedTimeText ? `Published: ${comment.publishedTimeText}` : undefined,
    comment.likeCountText ? `Likes: ${comment.likeCountText}` : undefined,
    comment.replyCount === undefined ? undefined : `Replies: ${comment.replyCount}`,
    comment.isPinned ? 'Pinned: yes' : undefined,
    comment.isHearted ? 'Creator heart: yes' : undefined,
  ].filter(Boolean).join('\n'));
}
