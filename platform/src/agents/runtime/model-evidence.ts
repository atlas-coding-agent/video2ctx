import { storyboardManifestSchema } from '../providers/youtube/storyboard';
import { framesSchema } from '../../lib/youtube-frames-contract';
import { transcriptFactsSchema, transcriptSourceContextSchema } from './transcript-grounding';
import { z } from 'zod';
import {
  agentWarningSchema,
  evidenceExcerptSchema,
  evidenceSourceSchema,
  type EvidencePacket,
} from '../contracts';
import { isCollectionKind, modelCollection, modelCollectionSchema, readCollectionRetrieval } from './collection-coverage';

const MODEL_EXCERPTS_PER_PACKET = 8;
const MODEL_EXCERPT_CHARACTERS = 800;
/** Entry text lengths tried before showing fewer list entries under a budget. */
const COLLECTION_TEXT_LIMITS = [MODEL_EXCERPT_CHARACTERS, 300, 120] as const;
const MODEL_WARNINGS = 50;
const MODEL_ANALYSIS_SUMMARY_CHARACTERS = 2_000;
const MODEL_ANALYSIS_FINDINGS = 20;
const MODEL_ANALYSIS_FINDING_CHARACTERS = 600;
const frameCoverageSchema = z.object({
  requestedTimestampsMs: z.array(z.number().int().nonnegative()).max(6),
  frames: z.array(framesSchema.shape.frames.element.omit({ imageBase64: true })).max(6),
  failures: framesSchema.shape.failures,
});
const visualCoverageSchema = z.object({
  manifest: storyboardManifestSchema.optional(),
  selection: z.object({ mode: z.enum(['leading', 'spread', 'timestamps', 'indexes', 'metadata']),
    requestedTimestampsMs: z.array(z.number().int().nonnegative()).max(20).optional(),
    requestedSheetIndexes: z.array(z.number().int().nonnegative()).max(20).optional() }).optional(),
  sampledRanges: z.array(z.object({ startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative() })).max(20),
  totalFrames: z.number().int().positive(),
  sampledFrames: z.number().int().nonnegative(),
  intervalMs: z.number().int().positive(),
});

const transcriptAnalysisDataSchema = z.object({
  groundingVersion: z.literal(1).optional(),
  summary: z.string().trim().min(1),
  sourceContext: transcriptSourceContextSchema.optional(),
  findings: z.array(transcriptFactsSchema.extend({
    claim: z.string().trim().min(1),
    excerptIds: z.array(z.string().min(1).max(300)).max(3),
  })),
  coverage: z.object({
    completeTranscriptRead: z.literal(true),
    segmentCount: z.number().int().nonnegative(),
    startMs: z.number().int().nonnegative().nullable(),
    endMs: z.number().int().nonnegative().nullable(),
  }),
  selectedExcerptCount: z.number().int().nonnegative(),
});

export const modelEvidencePacketSchema = z.object({
  packetId: z.string().min(1).max(300),
  kind: z.string().min(1).max(100),
  assetVersions: z.array(z.string()).optional(),
  sources: z.array(evidenceSourceSchema).max(24),
  transcriptAnalysis: z.object({
    groundingVersion: z.literal(1).optional(),
    sourceContext: transcriptSourceContextSchema.optional(),
    summary: z.string().trim().min(1).max(MODEL_ANALYSIS_SUMMARY_CHARACTERS),
    findings: z.array(transcriptFactsSchema.extend({
      claim: z.string().trim().min(1).max(MODEL_ANALYSIS_FINDING_CHARACTERS),
      excerptIds: z.array(z.string().min(1).max(300)).max(3),
    })).max(MODEL_ANALYSIS_FINDINGS),
    coverage: transcriptAnalysisDataSchema.shape.coverage,
    selectedExcerptCount: z.number().int().nonnegative(),
  }).optional(),
  excerpts: z.array(evidenceExcerptSchema).max(5_000).optional(),
  visualCoverage: visualCoverageSchema.optional(),
  frameCoverage: frameCoverageSchema.optional(),
  artifacts: z.array(z.object({
    type: z.string().min(1).max(100),
    title: z.string().min(1).max(500).optional(),
  })).max(10).optional(),
  continuation: z.string().max(4_000).optional(),
  /** Entry-list coverage. Counts describe this projection, not the saved packet alone. */
  collection: modelCollectionSchema.optional(),
  warnings: z.array(agentWarningSchema).max(MODEL_WARNINGS),
});

export type ModelEvidencePacket = z.infer<typeof modelEvidencePacketSchema>;

/** A packet that could not fit the model budget even with no entries shown. */
export interface OmittedModelEvidence {
  packetId: string;
  kind: string;
  title?: string;
  entriesRetained: number;
  reason: 'context_budget';
}

/**
 * Produces the evidence representation that a model may read. The full packet
 * remains the source of truth for billing, recovery, and citation validation.
 */
export function evidencePacketForModel(packet: EvidencePacket): ModelEvidencePacket {
  // Single-video inspection is read directly by the main model, including on recovery/finalization.
  if (packet.artifacts.some(artifact => artifact.type === 'youtube_complete_transcript')) {
    return modelEvidencePacketSchema.parse({
      packetId: packet.packetId, kind: packet.kind, sources: packet.sources, assetVersions: packet.assetVersions,
      continuation: packet.continuation,
      excerpts: packet.artifacts.some(artifact => artifact.type === 'youtube_complete_transcript' && artifact.data.requiresAnalysis) ? [] : packet.excerpts,
      artifacts: packet.artifacts.map(({ type, title }) => ({ type, title })), warnings: packet.warnings,
    });
  }
  const transcriptAnalysis = readTranscriptAnalysis(packet);
  if (transcriptAnalysis) {
    return modelEvidencePacketSchema.parse({
      packetId: packet.packetId,
      kind: packet.kind,
      sources: packet.sources,
      assetVersions: packet.assetVersions,
      transcriptAnalysis: {
        groundingVersion: transcriptAnalysis.groundingVersion,
        sourceContext: transcriptAnalysis.sourceContext,
        summary: boundedText(transcriptAnalysis.summary, MODEL_ANALYSIS_SUMMARY_CHARACTERS),
        findings: transcriptAnalysis.findings.slice(0, MODEL_ANALYSIS_FINDINGS).map((finding) => ({
          ...finding,
          claim: boundedText(finding.claim, MODEL_ANALYSIS_FINDING_CHARACTERS),
          excerptIds: finding.excerptIds,
        })),
        coverage: transcriptAnalysis.coverage,
        selectedExcerptCount: transcriptAnalysis.selectedExcerptCount,
      },
      warnings: packet.warnings,
    });
  }
  if (isCollectionKind(packet.kind)) return collectionPacketForModel(packet);

  // One visual finding can have three frame citations. Keep each distinct
  // finding before adding duplicate observations at other timestamps.
  const ordered = (packet.kind === 'youtube_storyboard' || packet.kind === 'youtube_frames') ? distinctVisualFindingsFirst(packet.excerpts) : packet.excerpts;
  const coverage = packet.kind === 'youtube_storyboard'
    ? visualCoverageSchema.safeParse(packet.artifacts.find(artifact => ['youtube_storyboard_analysis','youtube_storyboard_retrieval'].includes(artifact.type))?.data)
    : undefined;
  const frameCoverage = packet.kind === 'youtube_frames'
    ? frameCoverageSchema.safeParse(packet.artifacts.find(artifact => ['youtube_frame_analysis','youtube_frame_retrieval'].includes(artifact.type))?.data)
    : undefined;
  const excerpts = ordered.slice(0, MODEL_EXCERPTS_PER_PACKET).map((excerpt) => ({
    ...excerpt,
    text: boundedText(excerpt.text, MODEL_EXCERPT_CHARACTERS),
  }));
  const sourceIds = new Set(excerpts.map((excerpt) => excerpt.sourceId));
  const sources = packet.sources.filter((source) => sourceIds.has(source.id));

  return modelEvidencePacketSchema.parse({
    packetId: packet.packetId,
    assetVersions: packet.assetVersions,
    kind: packet.kind,
    sources: sources.length > 0 ? sources : packet.sources.slice(0, 1),
    excerpts,
    visualCoverage: coverage?.success ? coverage.data : undefined,
    frameCoverage: frameCoverage?.success ? frameCoverage.data : undefined,
    artifacts: packet.artifacts.map((artifact) => ({
      type: artifact.type,
      title: artifact.title,
    })),
    continuation: packet.continuation,
    warnings: packet.warnings,
  });
}

function distinctVisualFindingsFirst(excerpts: EvidencePacket['excerpts']) {
  const groups = new Map<string, EvidencePacket['excerpts']>();
  for (const excerpt of excerpts) {
    const key = JSON.stringify([excerpt.sourceId, excerpt.text]);
    const group = groups.get(key) ?? [];
    group.push(excerpt);
    groups.set(key, group);
  }
  const values = [...groups.values()];
  return [...values.flatMap(group => group.slice(0, 1)), ...values.flatMap(group => group.slice(1))];
}

/**
 * Projects one entry-list packet. Every retained entry is shown unless `shown`
 * lowers the count; counts and the coverage statement are recomputed for the
 * exact entries emitted. Sources are kept only for shown entries.
 */
function collectionPacketForModel(
  packet: EvidencePacket,
  options: { shown?: number; textLimit?: number; continuation?: boolean } = {},
): ModelEvidencePacket {
  const retrieval = readCollectionRetrieval(packet);
  const retained = packet.excerpts.length;
  const shown = Math.max(0, Math.min(retained, options.shown ?? retained));
  const textLimit = options.textLimit ?? MODEL_EXCERPT_CHARACTERS;
  // get_playlist never accepted a continuation, including for packets saved before retrieval counts existed.
  const accepted = retrieval?.continuationAccepted ?? packet.kind !== 'youtube_playlist';
  const continuationShown = (options.continuation ?? true) && accepted && !!packet.continuation;
  const excerpts = packet.excerpts.slice(0, shown).map(excerpt => ({
    ...excerpt,
    text: boundedText(excerpt.text, textLimit),
  }));
  const sourceIds = new Set(excerpts.map(excerpt => excerpt.sourceId));
  const truncated = shown < retained ? [{
    code: 'COLLECTION_CONTEXT_TRUNCATED',
    message: `Only ${shown} of ${retained} retained list entries fit this context. The rest are saved but not shown.`,
  }] : [];
  return modelEvidencePacketSchema.parse({
    packetId: packet.packetId,
    kind: packet.kind,
    assetVersions: packet.assetVersions,
    sources: packet.sources.filter(source => sourceIds.has(source.id)),
    excerpts,
    artifacts: packet.artifacts.map(({ type, title }) => ({ type, title })),
    continuation: continuationShown ? packet.continuation : undefined,
    collection: modelCollection({ shown, retained, retrieval, continuationShown }),
    warnings: [...truncated, ...packet.warnings].slice(0, MODEL_WARNINGS),
  });
}

/**
 * Shows as many retained entries as fit with the packets already selected,
 * shortening entry text before dropping entries. Undefined means not even the
 * counts fit.
 */
function fitCollectionPacket(
  packet: EvidencePacket,
  fits: (candidate: ModelEvidencePacket) => boolean,
): ModelEvidencePacket | undefined {
  const retained = packet.excerpts.length;
  let best: { packet: ModelEvidencePacket; shown: number } | undefined;
  for (const textLimit of COLLECTION_TEXT_LIMITS) {
    let low = 0;
    let high = retained;
    while (low <= high) {
      const shown = Math.floor((low + high) / 2);
      const candidate = collectionPacketForModel(packet, { shown, textLimit, continuation: false });
      if (fits(candidate)) {
        if (!best || shown > best.shown) best = { packet: candidate, shown };
        low = shown + 1;
      } else high = shown - 1;
    }
    if (best?.shown === retained) break;
  }
  return best?.packet;
}

export function evidencePacketsForModel(
  packets: readonly EvidencePacket[],
  options: { maxCharacters: number },
): ModelEvidencePacket[] {
  return projectEvidencePacketsForModel(packets, options).evidence;
}

/** Like evidencePacketsForModel, and also names entry-list packets that could not fit at all. */
export function projectEvidencePacketsForModel(
  packets: readonly EvidencePacket[],
  options: { maxCharacters: number },
): { evidence: ModelEvidencePacket[]; omitted: OmittedModelEvidence[] } {
  const projected = packets.map(packet => ({ source: packet, packet: evidencePacketForModel(packet) }));
  const prioritized = [
    ...projected.filter(({ packet }) => packet.transcriptAnalysis),
    ...projected.filter(({ packet }) => !packet.transcriptAnalysis),
  ];
  const selected: ModelEvidencePacket[] = [];
  const omitted: OmittedModelEvidence[] = [];

  for (const { source, packet } of prioritized) {
    if (serializedLength([...selected, packet]) <= options.maxCharacters) {
      selected.push(packet);
      continue;
    }
    if (packet.collection) {
      const fitted = fitCollectionPacket(source, candidate => serializedLength([...selected, candidate]) <= options.maxCharacters);
      if (fitted) selected.push(fitted);
      else omitted.push({
        packetId: source.packetId,
        kind: source.kind,
        ...(source.artifacts[0]?.title ? { title: source.artifacts[0].title.slice(0, 200) } : {}),
        entriesRetained: source.excerpts.length,
        reason: 'context_budget',
      });
      continue;
    }
    if (packet.artifacts?.some(artifact => artifact.type === 'youtube_complete_transcript') && packet.excerpts?.length) {
      // Keep as much of a long transcript as fits, spread across its timeline.
      // Dropping straight to the opening sentence loses almost all comparison context.
      const excerpts = packet.excerpts;
      const candidate = (count: number): ModelEvidencePacket => ({ ...packet,
        excerpts: Array.from({length: count}, (_, index) => excerpts[count === 1 ? 0
          : Math.floor(index * (excerpts.length - 1) / (count - 1))]!),
        warnings: [...packet.warnings, {code:'TRANSCRIPT_CONTEXT_TRUNCATED',
          message:'Only sampled passages fit the finalization context. Additional passages remain available through saved evidence reads; do not claim exhaustive coverage.'}],
      });
      let low = 1, high = excerpts.length - 1;
      let fitted: ModelEvidencePacket | undefined;
      while (low <= high) {
        const count = Math.floor((low + high) / 2);
        const sample = candidate(count);
        if (serializedLength([...selected, sample]) <= options.maxCharacters) { fitted = sample; low = count + 1; }
        else high = count - 1;
      }
      if (fitted) { selected.push(fitted); continue; }
    }
    const reduced = reduceModelEvidencePacket(packet);
    if (serializedLength([...selected, reduced]) <= options.maxCharacters) selected.push(reduced);
  }

  return { evidence: selected, omitted };
}

function readTranscriptAnalysis(packet: EvidencePacket) {
  if (packet.kind !== 'youtube_transcript') return undefined;
  const artifact = packet.artifacts.find(({ type }) => type === 'youtube_transcript_analysis');
  if (!artifact) return undefined;
  const parsed = transcriptAnalysisDataSchema.safeParse(artifact.data);
  return parsed.success ? parsed.data : undefined;
}

function reduceModelEvidencePacket(packet: ModelEvidencePacket): ModelEvidencePacket {
  if (packet.transcriptAnalysis) {
    return modelEvidencePacketSchema.parse({
      ...packet,
      transcriptAnalysis: {
        ...packet.transcriptAnalysis,
        summary: boundedText(packet.transcriptAnalysis.summary, 500),
        findings: packet.transcriptAnalysis.findings.slice(0, 2).map((finding) => ({
          ...finding,
          claim: boundedText(finding.claim, 300),
        })),
      },
    });
  }

  const completeTranscript = packet.artifacts?.some(artifact => artifact.type === 'youtube_complete_transcript');
  const excerpts = packet.excerpts?.slice(0, (packet.kind === 'youtube_storyboard' || packet.kind === 'youtube_frames') ? 5 : 1).map((excerpt) => ({
    ...excerpt,
    text: boundedText(excerpt.text, 200),
  }));
  const sourceId = excerpts?.[0]?.sourceId;
  return modelEvidencePacketSchema.parse({
    ...packet,
    sources: sourceId ? packet.sources.filter((source) => source.id === sourceId) : packet.sources.slice(0, 1),
    excerpts,
    artifacts: packet.artifacts?.slice(0, 1),
    continuation: undefined,
    warnings: completeTranscript ? [...packet.warnings, { code: 'TRANSCRIPT_CONTEXT_TRUNCATED',
      message: 'The complete retrieved transcript exceeds the finalization evidence budget. Only a partial excerpt is supplied here; do not claim exhaustive coverage.' }] : packet.warnings,
  });
}

function boundedText(value: string, maximum: number): string {
  return value.trim().slice(0, maximum);
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value).length;
}

/** Short references reduce recovery output tokens; full IDs remain persisted. */
export function finalizationEvidenceForModel(
  packets: readonly EvidencePacket[], maxCharacters: number, comparisonVideoIds: readonly string[] = [],
) {
  const aliases = new Map<string, string>();
  const fullIds = new Map<string, string>();
  const alias = (id: string) => {
    let value = aliases.get(id);
    if (!value) { value = `ref_${aliases.size + 1}`; aliases.set(id, value); }
    return value;
  };
  // Shorten IDs before measuring the input budget, not only after truncation.
  const compact = packets.map(packet => {
    const analysis = readTranscriptAnalysis(packet);
    return { ...packet,
      excerpts: packet.excerpts.map(excerpt => ({ ...excerpt, id: alias(excerpt.id) })),
      artifacts: packet.artifacts.map(artifact => artifact.type === 'youtube_transcript_analysis' && analysis
        ? { ...artifact, data: { ...artifact.data, findings: analysis.findings.map(finding => ({
          ...finding, excerptIds: finding.excerptIds.map(alias),
        })) } } : artifact),
    };
  });
  const projections = comparisonVideoIds.length
    ? comparisonVideoIds.map(videoId => projectEvidencePacketsForModel(
      compact.filter(packet => packet.sources.some(source => source.videoId === videoId)),
      { maxCharacters: Math.floor(maxCharacters / comparisonVideoIds.length) },
    ))
    : [projectEvidencePacketsForModel(compact, { maxCharacters })];
  const evidence = projections.flatMap(projection => projection.evidence);
  // A packet shown for one comparison subject is not omitted overall.
  const shownPackets = new Set(evidence.map(packet => packet.packetId));
  const omitted = [...new Map(projections.flatMap(projection => projection.omitted)
    .filter(packet => !shownPackets.has(packet.packetId))
    .map(packet => [packet.packetId, packet] as const)).values()];
  const included = new Set(evidence.flatMap(packet => [
    ...(packet.excerpts?.map(excerpt => excerpt.id) ?? []),
    ...(packet.transcriptAnalysis?.findings.flatMap(finding => finding.excerptIds) ?? []),
  ]));
  for (const [full, short] of aliases) if (included.has(short)) fullIds.set(short, full);
  return { evidence, fullIds, omitted };
}
