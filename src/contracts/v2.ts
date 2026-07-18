import { z } from "zod";
import type {
  CanonicalRecording,
  SourceAttribution
} from "../identity/recording.js";

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const numericQuery = (minimum: number, maximum: number) =>
  z.string()
    .regex(/^\d+$/u)
    .transform(Number)
    .pipe(z.number().int().min(minimum).max(maximum));

export const recordingQuerySchema = z.strictObject({
  title: boundedText(300).optional(),
  artist: boundedText(300).optional(),
  recordingMbid: z.uuid().optional(),
  isrc: z.string().trim().min(1).max(32).regex(/^[a-z0-9-]+$/iu).optional(),
  fingerprint: boundedText(16_384).optional(),
  fingerprintDuration: numericQuery(1, 7_200).optional(),
  limit: numericQuery(1, 25).default(12)
}).superRefine((value, context) => {
  if (!value.title && !value.recordingMbid && !value.isrc && !value.fingerprint) {
    context.addIssue({
      code: "custom",
      path: ["query"],
      message: "missing_query"
    });
  }
  if (value.fingerprint && !value.fingerprintDuration) {
    context.addIssue({
      code: "custom",
      path: ["fingerprintDuration"],
      message: "required_with_fingerprint"
    });
  }
});

export const artistQuerySchema = z.strictObject({
  name: boundedText(300).optional(),
  artistMbid: z.uuid().optional(),
  limit: numericQuery(1, 25).default(10)
}).superRefine((value, context) => {
  if (!value.name && !value.artistMbid) {
    context.addIssue({ code: "custom", path: ["query"], message: "missing_query" });
  }
});

export const lyricsQuerySchema = z.strictObject({
  title: boundedText(300),
  artist: boundedText(300).optional(),
  album: boundedText(300).optional(),
  durationMs: numericQuery(1, 7_200_000).optional()
});

export type RecordingV2Query = z.output<typeof recordingQuerySchema>;
export type ArtistV2Query = z.output<typeof artistQuerySchema>;
export type LyricsV2Query = z.output<typeof lyricsQuerySchema>;

export const sourceAttributionSchema: z.ZodType<SourceAttribution> = z.strictObject({
  provider: z.string().min(1),
  id: z.string(),
  role: z.enum(["identity", "metadata", "enrichment"]),
  matchedBy: z.array(z.string()),
  fields: z.array(z.string()),
  confidence: z.number().min(0).max(1)
});

const artistReferenceSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  sortName: z.string().optional()
});

export const canonicalRecordingSchema: z.ZodType<CanonicalRecording> = z.strictObject({
  canonicalId: z.string().min(1),
  title: z.string(),
  artists: z.array(artistReferenceSchema),
  album: z.string(),
  coverUrl: z.string(),
  durationMs: z.number().int().positive().optional(),
  identifiers: z.strictObject({
    recordingMbid: z.string().optional(),
    workMbid: z.string().optional(),
    isrc: z.string().optional(),
    acoustId: z.string().optional()
  }),
  fingerprintVerified: z.boolean(),
  confidence: z.number().min(0).max(1),
  sources: z.array(sourceAttributionSchema),
  possibleDuplicates: z.array(z.strictObject({
    canonicalId: z.string(),
    confidence: z.number().min(0).max(1)
  }))
});

export const canonicalArtistSchema = z.strictObject({
  canonicalId: z.string(),
  name: z.string(),
  sortName: z.string(),
  aliases: z.array(z.string()),
  country: z.string(),
  type: z.string(),
  identifiers: z.strictObject({
    artistMbid: z.string().optional(),
    wikidata: z.string().optional()
  }),
  avatarUrl: z.string(),
  description: z.string(),
  confidence: z.number().min(0).max(1),
  sources: z.array(sourceAttributionSchema)
});

export const canonicalLyricsSchema = z.strictObject({
  canonicalId: z.string(),
  title: z.string(),
  artist: z.string(),
  album: z.string(),
  durationMs: z.number().int().nonnegative(),
  syncedLyrics: z.string(),
  plainLyrics: z.string(),
  confidence: z.number().min(0).max(1),
  sources: z.array(sourceAttributionSchema)
});

export const recordingResponseSchema = z.strictObject({
  recordings: z.array(canonicalRecordingSchema)
});

export const artistResponseSchema = z.strictObject({
  artists: z.array(canonicalArtistSchema)
});

export const lyricsResponseSchema = z.strictObject({
  lyrics: canonicalLyricsSchema.nullable()
});

export const invalidRequestSchema = z.strictObject({
  error: z.literal("invalid_request"),
  requestId: z.string(),
  issues: z.array(z.strictObject({
    field: z.string(),
    code: z.string()
  }))
});

export function queryObject(params: URLSearchParams): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of params) output[key] = value;
  return output;
}

export function validationIssues(error: z.ZodError): Array<{ field: string; code: string }> {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join(".") || "query",
    code: issue.message === "missing_query" || issue.message === "required_with_fingerprint"
      ? issue.message
      : issue.code
  }));
}
