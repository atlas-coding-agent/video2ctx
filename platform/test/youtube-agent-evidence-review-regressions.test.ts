import { describe, expect, it } from 'vitest';
import type { Comment } from 'all-things-youtube';
import type { AgentCitation, EvidencePacket } from '../src/agents/contracts';
import { citedEvidenceForConversation } from '../src/agents/runtime/conversation-memory';
import { unambiguousMetadataRecords } from '../src/agents/runtime/conversation-metadata';
import { commentPassage } from '../src/agents/providers/youtube/tools/get-video-comments';
import { evidencePacketForModel, finalizationEvidenceForModel } from '../src/agents/runtime/model-evidence';

// Regressions contributed by the independent review of this branch.

const VIDEO = 'abcdefghijk';
const source: EvidencePacket['sources'][number] = {
  id: 's', provider: 'youtube', kind: 'transcript', videoId: VIDEO, url: `https://www.youtube.com/watch?v=${VIDEO}`,
};
const excerpt: EvidencePacket['excerpts'][number] = { id: 'e', sourceId: 's', text: 'Exact text', startMs: 10, endMs: 20 };
const packet: EvidencePacket = {
  packetId: 'p', kind: 'youtube_transcript', assetVersions: ['v1'], sources: [source],
  excerpts: [excerpt, { ...excerpt, id: 'other', text: 'Other text' }], artifacts: [], warnings: [], usage: [],
};
/** The citation a finalized answer records for `excerpt`. */
const citation: AgentCitation = {
  id: excerpt.id, sourceId: source.id, provider: 'youtube', videoId: source.videoId, url: source.url,
  excerpt: excerpt.text, startMs: excerpt.startMs, endMs: excerpt.endMs, sourceKind: source.kind,
};

describe('cited evidence lineage review regressions', () => {
  it('rejects a legacy citation that matches the same excerpt in two immutable versions', () => {
    expect(citedEvidenceForConversation([citation], [], [packet, { ...packet, packetId: 'q', assetVersions: ['v2'] }])).toEqual([]);
  });

  it('rejects a citation with a different timestamp, video, URL or title even when its ID and text match', () => {
    for (const override of [{ startMs: 11 }, { videoId: 'xxxxxxxxxxx' }, { url: 'https://example.com' }, { title: 'Wrong' }])
      expect(citedEvidenceForConversation([{ ...citation, ...override }], [packet], [packet])).toEqual([]);
  });

  it('restores only the exact cited excerpt from a legacy saved packet and drops its uncited artifacts', () => {
    const saved: EvidencePacket = { ...packet, artifacts: [{ type: 'private', data: { uncited: 'claim' } }] };
    const restored = citedEvidenceForConversation([citation], [], [saved]);
    expect(restored[0]!.excerpts).toEqual([excerpt]);
    expect(restored[0]!.artifacts).toEqual([]);
  });

  // Repeated calls to the production helper, feeding each result into the next call.
  // This checks the helper's output is stable; it is not a Durable Object lifecycle test.
  it('keeps the admitted packet scope unchanged across eleven repeated restorations', () => {
    let current = [packet];
    for (let turn = 0; turn < 11; turn += 1) {
      current = citedEvidenceForConversation([citation], current, [packet]);
      expect(current[0]!.excerpts).toHaveLength(2);
    }
  });

  it('rejects metadata snapshots that collide with different values but accepts equivalent ones', () => {
    const metadata = (viewCount: number): EvidencePacket => ({ ...packet, kind: 'youtube_video', excerpts: [],
      artifacts: [{ type: 'youtube_video_metadata', data: { id: VIDEO, viewCount } }] });
    const first = { packet: metadata(10), recordedAt: 123 };
    const conflicting = { packet: metadata(11), recordedAt: 123 };
    const delivered = new Set([`memory:${VIDEO}:123`]);
    expect(unambiguousMetadataRecords([first, conflicting], delivered)).toEqual([]);
    expect(unambiguousMetadataRecords([first, first], delivered)).toHaveLength(2);
  });
});

describe('comment passage review regressions', () => {
  it('keeps a matched tail and its author through every reduction without reporting a shortening that did not happen', () => {
    const comment = {
      id: 'janine', text: `${'Setup detail. '.repeat(150)}But the final objection is about tilting the brush.`,
      author: { name: 'Janine', thumbnails: [] }, replyCount: 0, isPinned: false, isHearted: false, replies: [],
    } as unknown as Comment;
    const passage = commentPassage(comment, ['objection']);
    const hit: EvidencePacket = { ...packet, kind: 'youtube_comments', excerpts: [{ ...excerpt, text: passage.text }], artifacts: [] };
    expect(passage.text.length).toBeLessThan(800);
    expect(evidencePacketForModel(hit).warnings).toEqual([]);
    const full = JSON.stringify(finalizationEvidenceForModel([hit], 1_000_000).evidence).length;
    for (let budget = full; budget > 0; budget -= 10) {
      const shown = finalizationEvidenceForModel([hit], budget).evidence[0]?.excerpts?.[0]?.text;
      if (!shown) continue;
      expect(shown).toContain('objection');
      expect(shown).toContain('Author: Janine');
    }
  });
});
