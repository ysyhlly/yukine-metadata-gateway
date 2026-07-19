import {
  musicBrainzArtistById,
  musicBrainzArtistSearch,
  musicBrainzReleaseById,
  musicBrainzReleaseGroupById,
  musicBrainzReleaseGroupSearch,
  musicBrainzRecordingById,
  musicBrainzRecordingSearch,
  musicBrainzRecordingsByIsrc
} from "../requests.js";
import type {
  MetadataProvider,
  ProviderSearchContext
} from "../types.js";
import type { UpstreamJsonResult } from "../../types.js";
import {
  musicBrainzArtistListSchema,
  musicBrainzArtistSchema,
  musicBrainzReleaseGroupListSchema,
  musicBrainzReleaseGroupSchema,
  musicBrainzReleaseSchema,
  musicBrainzRecordingListSchema,
  musicBrainzRecordingSchema
} from "../../contracts/upstream.js";
import { validateUpstream } from "../validation.js";

export type MusicBrainzQuery =
  | { operation: "recording-by-id"; id: string }
  | { operation: "recordings-by-isrc"; isrc: string }
  | { operation: "recording-search"; clauses: string[]; limit: number }
  | { operation: "artist-by-id"; id: string }
  | { operation: "artist-search"; query: string; limit: number }
  | { operation: "release-group-by-id"; id: string }
  | { operation: "release-by-id"; id: string }
  | { operation: "release-group-search"; clauses: string[]; limit: number };

export class MusicBrainzProvider
implements MetadataProvider<MusicBrainzQuery, UpstreamJsonResult> {
  readonly name = "musicbrainz" as const;
  readonly capabilities = ["recording-search", "artist-search", "album-search"] as const;

  async search(
    query: MusicBrainzQuery,
    context: ProviderSearchContext
  ): Promise<UpstreamJsonResult> {
    let response: UpstreamJsonResult;
    switch (query.operation) {
      case "recording-by-id":
        response = await context.requestJson(this.name, musicBrainzRecordingById(query.id));
        return validateUpstream(response, musicBrainzRecordingSchema);
      case "recordings-by-isrc":
        response = await context.requestJson(this.name, musicBrainzRecordingsByIsrc(query.isrc));
        return validateUpstream(response, musicBrainzRecordingListSchema);
      case "recording-search":
        response = await context.requestJson(
          this.name,
          musicBrainzRecordingSearch(query.clauses, query.limit)
        );
        return validateUpstream(response, musicBrainzRecordingListSchema);
      case "artist-by-id":
        response = await context.requestJson(this.name, musicBrainzArtistById(query.id));
        return validateUpstream(response, musicBrainzArtistSchema);
      case "artist-search":
        response = await context.requestJson(
          this.name,
          musicBrainzArtistSearch(query.query, query.limit)
        );
        return validateUpstream(response, musicBrainzArtistListSchema);
      case "release-group-by-id":
        response = await context.requestJson(this.name, musicBrainzReleaseGroupById(query.id));
        return validateUpstream(response, musicBrainzReleaseGroupSchema);
      case "release-by-id":
        response = await context.requestJson(this.name, musicBrainzReleaseById(query.id));
        return validateUpstream(response, musicBrainzReleaseSchema);
      case "release-group-search":
        response = await context.requestJson(
          this.name,
          musicBrainzReleaseGroupSearch(query.clauses, query.limit)
        );
        return validateUpstream(response, musicBrainzReleaseGroupListSchema);
    }
  }
}
