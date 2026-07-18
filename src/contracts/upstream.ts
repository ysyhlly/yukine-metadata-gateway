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
