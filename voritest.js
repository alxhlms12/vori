var DEEZER_API_BASE = "https://api.deezer.com";
var PLAYBACK_ENDPOINT = "https://playback.alxhlms.workers.dev";

var MAX_SEARCH_CACHE = 100;
var MAX_TRACK_CACHE = 1000;

var searchCache = new Map();
var pendingSearches = new Map();
var trackCache = new Map();
var isrcPromises = new Map(); // In-flight speculative prefetch map

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
 * Speculative ISRC Preloader
 * Kicks off concurrently so 8SPINE never waits on playback
 * ----------------------------------------------------- */

function preloadTrackIsrc(trackId) {
  var id = String(trackId || "").trim();
  if (!id || !/^\d+$/.test(id)) return;

  var track = trackCache.get(id);
  if (track && track.isrc) return; // Already resolved
  if (isrcPromises.has(id)) return; // Already in-flight

  var promise = (async function () {
    try {
      var res = await fetch(DEEZER_API_BASE + "/track/" + encodeURIComponent(id));
      if (!res.ok) return null;

      var data = await res.json();
      if (data && data.isrc) {
        if (track) {
          track.isrc = data.isrc;
          cacheSet(trackCache, data.isrc, track, MAX_TRACK_CACHE);
        }
        return data.isrc;
      }
    } catch (e) {
      // Silent catch: getTrackStreamUrl will handle fallbacks
    } finally {
      isrcPromises.delete(id);
    }
    return null;
  })();

  isrcPromises.set(id, promise);
}

/* -------------------------------------------------------
 * Deezer Track Transformation
 * ----------------------------------------------------- */

function transformDeezerTrack(raw) {
  raw = raw || {};

  var id = String(raw.id || "").trim();
  var isrc = String(raw.isrc || raw.ISRC || "").trim() || null;

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
  query = String(query || "").trim().replace(/\s+/g, " ");

  if (!query) {
    return { tracks: [], total: 0 };
  }

  // 10 items is optimal: fast JSON transfer and sufficient for Stream Helper
  limit = Number(limit) || 10;

  var cacheKey = query.toLowerCase() + "|" + limit;

  var cached = searchCache.get(cacheKey);
  if (cached) return cached;

  var existingRequest = pendingSearches.get(cacheKey);
  if (existingRequest) return existingRequest;

  // Uses the dedicated /search/track index
  var requestUrl =
    DEEZER_API_BASE +
    "/search/track?q=" +
    encodeURIComponent(query) +
    "&limit=" +
    encodeURIComponent(limit);

  var request = (async function () {
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

      // Speculatively preload the top candidate's ISRC in the background!
      if (tracks.length > 0 && tracks[0].id) {
        preloadTrackIsrc(tracks[0].id);
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
 * ----------------------------------------------------- */

async function getTrackStreamUrl(trackId, quality, context) {
  var id = String(trackId || "").trim();

  if (!id) {
    throw new Error("Valid track ID or ISRC required for playback");
  }

  var track = trackCache.get(id);
  var isrc = track ? track.isrc : null;

  // Direct ISRC format check
  var isIsrc = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(id);
  if (isIsrc) {
    isrc = id;
  }

  // Resolve ISRC if missing
  if (!isrc && /^\d+$/.test(id)) {
    var inFlight = isrcPromises.get(id);

    if (inFlight) {
      // Background preload was already triggered by searchTracks: just wait on it!
      isrc = await inFlight;
    } else {
      // Wasn't preloaded; fetch it directly
      preloadTrackIsrc(id);
      var fetchPromise = isrcPromises.get(id);
      if (fetchPromise) {
        isrc = await fetchPromise;
      }
    }
  }

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
  version: "1.2.4",
  description: "Ultra-fast Deezer integration with speculative ISRC preloading (gemini wrote this)",

  searchTracks: searchTracks,
  getTrackStreamUrl: getTrackStreamUrl
};
