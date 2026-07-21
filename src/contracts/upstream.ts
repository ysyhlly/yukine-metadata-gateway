import { z } from "zod";

const looseObject = z.looseObject({});

export const musicBrainzRecordingSchema = z.looseObject({
  id: z.string()
});

export const musicBrainzRecordingListSchema = z.looseObject({
  recordings: z.array(looseObject)
});

export const musicBrainzArtistSchema = z.looseObject({
  id: z.string()
});

export const musicBrainzArtistListSchema = z.looseObject({
  artists: z.array(looseObject)
});

const musicBrainzReleaseGroupItemSchema = z.looseObject({
  id: z.uuid(),
  title: z.string()
});

export const musicBrainzReleaseGroupSchema = musicBrainzReleaseGroupItemSchema;

export const musicBrainzReleaseGroupListSchema = z.looseObject({
  "release-groups": z.array(musicBrainzReleaseGroupItemSchema)
});

export const musicBrainzReleaseSchema = z.looseObject({
  id: z.uuid(),
  title: z.string(),
  "release-group": musicBrainzReleaseGroupItemSchema
});

export const acoustIdResponseSchema = z.looseObject({
  status: z.string(),
  results: z.array(looseObject).optional()
});

export const itunesResponseSchema = z.looseObject({
  resultCount: z.number().optional(),
  results: z.array(looseObject)
});

export const wikidataResponseSchema = z.looseObject({
  entities: z.record(z.string(), looseObject)
});

export const neteaseResponseSchema = z.looseObject({
  code: z.number()
});

export const lrclibExactResponseSchema = looseObject;
export const lrclibSearchResponseSchema = z.array(looseObject);

export const neteaseLyricsResponseSchema = z.looseObject({
  code: z.number(),
  lrc: z.looseObject({ lyric: z.string().optional() }).optional(),
  yrc: z.looseObject({ lyric: z.string().optional() }).optional()
});

export const qqMusicResponseSchema = z.looseObject({
  code: z.number()
});

export const qqMusicLyricsResponseSchema = z.looseObject({
  code: z.number(),
  lyric: z.string().optional()
});

export const kugouResponseSchema = z.looseObject({
  status: z.number()
});

export const kugouLyricsSearchResponseSchema = z.looseObject({
  status: z.number(),
  candidates: z.array(looseObject).optional()
});

export const kugouLyricsDownloadResponseSchema = z.looseObject({
  status: z.number(),
  content: z.string().optional()
});
