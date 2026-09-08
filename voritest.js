var DEEZER_API_BASE = "https://api.deezer.com";
var PLAYBACK_ENDPOINT = "https://playback.alxhlms.workers.dev";

var MAX_SEARCH_CACHE = 100;
var MAX_TRACK_CACHE = 1000;

var searchCache = new Map();
var pendingSearches = new Map();
var trackCache = new Map();

/* -------------------------------------------------------
 * Bounded Cache Helper
 * ----------------------------------------------------- */

function cacheSet(map, key, value, maxEntries) {
  if (map.has(key)) {
    map.delete(key);
  }

  while (map.size >= maxEntries) {
    map.delete(map.keys().next().value);
  }

  map.set(key, value);
  return value;
}

/* -------------------------------------------------------
 * Deezer Track Transformation
 * ----------------------------------------------------- */

function transformDeezerTrack(raw) {
  raw = raw || {};

  var id = String(raw.id || "").trim();
  var isrc = String(raw.isrc || raw.ISRC || "").trim() || null;

  // Deezer provides clean artist and album objects
  var artist = "Unknown Artist";
  if (raw.artist && typeof raw.artist.name === "string") {
    artist = raw.artist.name;
  } else if (typeof raw.artist === "string") {
    artist = raw.artist;
  }

  var album = "";
  if (raw.album && typeof raw.album.title === "string") {
    album = raw.album.title;
  }

  var albumCover = null;
  if (raw.album) {
    albumCover =
      raw.album.cover_xl ||
      raw.album.cover_big ||
      raw.album.cover_medium ||
      raw.album.cover ||
      null;
  }

  var track = {
    id: id,
    isrc: isrc,
    title: raw.title || raw.title_short || "Unknown Track",
    artist: artist,
    album: album,
    albumCover: albumCover,
    duration: Number(raw.duration) || 0,
    trackNumber: Number(raw.track_position || raw.track_number) || 1
  };

  if (id) {
    cacheSet(trackCache, id, track, MAX_TRACK_CACHE);
  }
  if (isrc) {
    cacheSet(trackCache, isrc, track, MAX_TRACK_CACHE);
  }

  return track;
}

/* -------------------------------------------------------
 * Search
 * ----------------------------------------------------- */

async function searchTracks(query, limit, context) {
  query = String(query || "").trim();

  if (!query) {
    return {
      tracks: [],
      total: 0
    };
  }

  limit = Number(limit) || 15;

  var cacheKey = query.toLowerCase() + "|" + limit;

  var cached = searchCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  var existingRequest = pendingSearches.get(cacheKey);
  if (existingRequest) {
    return existingRequest;
  }

  // Deezer public search endpoint with limit
  var requestUrl =
    DEEZER_API_BASE +
    "/search?q=" +
    encodeURIComponent(query) +
    "&limit=" +
    encodeURIComponent(limit);

  var request = (async function() {
    try {
      var response = await fetch(requestUrl);

      if (!response.ok) {
        throw new Error("Deezer search failed: HTTP " + response.status);
      }

      var body = await response.json();

      if (body.error) {
        throw new Error("Deezer API error: " + (body.error.message || body.error.type));
      }

      var rawTracks = Array.isArray(body.data) ? body.data : [];
      var count = Math.min(rawTracks.length, limit);
      var tracks = new Array(count);

      for (var i = 0; i < count; i++) {
        tracks[i] = transformDeezerTrack(rawTracks[i]);
      }

      var result = {
        tracks: tracks,
        total: Number(body.total) || count
      };

      cacheSet(searchCache, cacheKey, result, MAX_SEARCH_CACHE);
      return result;
    } finally {
      pendingSearches.delete(cacheKey);
    }
  })();

  pendingSearches.set(cacheKey, request);
  return request;
}

/* -------------------------------------------------------
 * Playback
 *
 * If the worker requires an ISRC and the track is a Deezer ID,
 * it fetches the ISRC on-demand from Deezer's /track/{id}.
 * ----------------------------------------------------- */

async function getTrackStreamUrl(trackId, quality, context) {
  var id = String(trackId || "").trim();

  if (!id) {
    throw new Error("Valid track ID or ISRC required for playback");
  }

  var track = trackCache.get(id);
  var isrc = track ? track.isrc : null;

  // Standard 12-character alphanumeric ISRC check (e.g. USUM71820728)
  var isIsrc = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(id);
  if (isIsrc) {
    isrc = id;
  }

  // If we don't have an ISRC yet and this is a Deezer numeric ID, look it up on-demand
  if (!isrc && /^\d+$/.test(id)) {
    try {
      var trackRes = await fetch(DEEZER_API_BASE + "/track/" + encodeURIComponent(id));
      if (trackRes.ok) {
        var trackData = await trackRes.json();
        if (trackData && trackData.isrc) {
          isrc = trackData.isrc;

          if (track) {
            track.isrc = isrc;
            cacheSet(trackCache, isrc, track, MAX_TRACK_CACHE);
          }
        }
      }
    } catch (e) {
      // Fall back to original ID if Deezer lookup fails
    }
  }

  // Use resolved ISRC if available; otherwise use the original identifier
  var playbackIdentifier = isrc || id;

  return {
    streamUrl:
      PLAYBACK_ENDPOINT +
      "/stream?i=" +
      encodeURIComponent(playbackIdentifier),

    track: track || {
      id: playbackIdentifier,
      isrc: isrc
    }
  };
}

/* -------------------------------------------------------
 * 8SPINE Module
 * ----------------------------------------------------- */

return {
  id: "vori-test",
  name: "vori-test",
  author: "alxhlms",
  version: "1.2.3",
  description: "replaces my ass search endpoint lol",

  searchTracks: searchTracks,
  getTrackStreamUrl: getTrackStreamUrl
};
