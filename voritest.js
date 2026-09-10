var PLAYBACK_ENDPOINT = "https://playback.alxhlms.workers.dev";
var DEEZER_API_FALLBACK = "https://api.deezer.com";

var MAX_SEARCH_CACHE = 100;
var MAX_TRACK_CACHE = 1000;

var searchCache = new Map();
var pendingSearches = new Map();
var trackCache = new Map();
var isrcPromises = new Map();

/* -------------------------------------------------------
 * Connection Pre-warmer
 * ----------------------------------------------------- */

function prewarmPlaybackStream(isrc) {
  if (!isrc) return;
  var streamUrl = PLAYBACK_ENDPOINT + "/stream?i=" + encodeURIComponent(isrc);
  fetch(streamUrl, { method: "HEAD" }).catch(function () {});
}

/* -------------------------------------------------------
 * Bounded Cache Helper
 * ----------------------------------------------------- */

function cacheSet(map, key, value, maxEntries) {
  if (map.has(key)) map.delete(key);
  while (map.size >= maxEntries) {
    map.delete(map.keys().next().value);
  }
  map.set(key, value);
  return value;
}

/* -------------------------------------------------------
 * Smart Deezer Result Ranking
 * ----------------------------------------------------- */

function sortAndFilterDeezerTracks(rawTracks, query) {
  if (!Array.isArray(rawTracks) || rawTracks.length === 0) return [];

  var q = (query || "").toLowerCase();
  var isSearchingKaraoke = q.includes("karaoke");
  var isSearchingTribute = q.includes("tribute") || q.includes("cover");
  var isSearchingLive = q.includes("live");
  var isSearchingRemix = q.includes("remix");

  return rawTracks.slice().sort(function (a, b) {
    var scoreA = 0;
    var scoreB = 0;

    var artistA = (a.artist && a.artist.name ? a.artist.name : "").toLowerCase();
    var artistB = (b.artist && b.artist.name ? b.artist.name : "").toLowerCase();
    var titleA = (a.title || "").toLowerCase();
    var titleB = (b.title || "").toLowerCase();

    if (!isSearchingKaraoke) {
      if (artistA.includes("karaoke") || titleA.includes("karaoke")) scoreA -= 60;
      if (artistB.includes("karaoke") || titleB.includes("karaoke")) scoreB -= 60;
    }
    if (!isSearchingTribute) {
      if (artistA.includes("tribute") || titleA.includes("tribute") || titleA.includes("cover version")) scoreA -= 50;
      if (artistB.includes("tribute") || titleB.includes("tribute") || titleB.includes("cover version")) scoreB -= 50;
    }
    if (!isSearchingLive) {
      if (titleA.includes("live") || titleA.includes("en vivo")) scoreA -= 20;
      if (titleB.includes("live") || titleB.includes("en vivo")) scoreB -= 20;
    }
    if (!isSearchingRemix) {
      if (titleA.includes("remix") || titleA.includes("mixed")) scoreA -= 15;
      if (titleB.includes("remix") || titleB.includes("mixed")) scoreB -= 15;
    }

    if (artistA && q.includes(artistA)) scoreA += 40;
    if (artistB && q.includes(artistB)) scoreB += 40;

    return scoreB - scoreA;
  });
}

/* -------------------------------------------------------
 * Priority ISRC Preloader
 * ----------------------------------------------------- */

function preloadTrackIsrc(trackId) {
  var id = String(trackId || "").trim();
  if (!id || !/^\d+$/.test(id)) return Promise.resolve(null);

  var cachedTrack = trackCache.get(id);
  if (cachedTrack && cachedTrack.isrc) {
    return Promise.resolve(cachedTrack.isrc);
  }
  if (isrcPromises.has(id)) return isrcPromises.get(id);

  var promise = (async function () {
    try {
      var res = await fetch(PLAYBACK_ENDPOINT + "/track?id=" + encodeURIComponent(id));
      if (!res.ok) {
        res = await fetch(DEEZER_API_FALLBACK + "/track/" + encodeURIComponent(id));
      }
      if (!res.ok) return null;

      var data = await res.json();
      if (data && data.isrc) {
        var isrc = String(data.isrc).trim();
        if (cachedTrack) {
          cachedTrack.isrc = isrc;
        }
        cacheSet(trackCache, isrc, cachedTrack || { id: id, isrc: isrc }, MAX_TRACK_CACHE);
        cacheSet(trackCache, id, Object.assign({}, cachedTrack || { id: id }, { isrc: isrc }), MAX_TRACK_CACHE);

        prewarmPlaybackStream(isrc);
        return isrc;
      }
    } catch (e) {
    } finally {
      isrcPromises.delete(id);
    }
    return null;
  })();

  isrcPromises.set(id, promise);
  return promise;
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
    artist = raw.artist.name.trim();
  }

  var album = (raw.album && raw.album.title) ? raw.album.title.trim() : "";
  var albumCover = raw.album
    ? (raw.album.cover_xl || raw.album.cover_big || raw.album.cover_medium || null)
    : null;

  var title = String(raw.title || raw.title_short || "Unknown Track").trim();

  var track = {
    id: id,
    isrc: isrc,
    title: title,
    artist: artist,
    album: album,
    albumCover: albumCover,
    duration: Number(raw.duration) || 0,
    trackNumber: Number(raw.track_position || raw.track_number) || 1,
    audioQuality: "LOSSLESS"
  };

  if (id) cacheSet(trackCache, id, track, MAX_TRACK_CACHE);
  if (isrc) cacheSet(trackCache, isrc, track, MAX_TRACK_CACHE);

  return track;
}

/* -------------------------------------------------------
 * Search
 * ----------------------------------------------------- */

async function searchTracks(query, limit, context) {
  query = String(query || "").trim().replace(/\s+/g, " ");
  if (!query) return { tracks: [], total: 0 };

  var effectiveLimit = Math.max(Number(limit) || 10, 10);
  var cacheKey = query.toLowerCase() + "|" + effectiveLimit;

  var cached = searchCache.get(cacheKey);
  if (cached) return cached;

  var existingRequest = pendingSearches.get(cacheKey);
  if (existingRequest) return existingRequest;

  var requestUrl =
    PLAYBACK_ENDPOINT +
    "/search?q=" +
    encodeURIComponent(query) +
    "&limit=" +
    Math.max(effectiveLimit, 25);

  var request = (async function () {
    try {
      var response = await fetch(requestUrl);
      if (!response.ok) {
        response = await fetch(DEEZER_API_FALLBACK + "/search?q=" + encodeURIComponent(query) + "&limit=25");
      }
      if (!response.ok) throw new Error("Search HTTP " + response.status);

      var body = await response.json();
      if (body.error) throw new Error(body.error.message || "Search error");

      var rawTracks = Array.isArray(body.data) ? body.data : [];
      var sortedRawTracks = sortAndFilterDeezerTracks(rawTracks, query);

      var count = Math.min(sortedRawTracks.length, effectiveLimit);
      var tracks = new Array(count);

      for (var i = 0; i < count; i++) {
        tracks[i] = transformDeezerTrack(sortedRawTracks[i]);
      }

      if (tracks.length > 0 && tracks[0].id) {
        preloadTrackIsrc(tracks[0].id);
      }

      var result = { tracks: tracks, total: Math.max(Number(body.total) || 0, tracks.length) };
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
 * Quality Badge Formatter
 * ----------------------------------------------------- */

function map8SpineQuality(qualityStr, audioQualityEnum) {
  if (audioQualityEnum === "HI_RES" || audioQualityEnum === "LOSSLESS" || audioQualityEnum === "HIGH") {
    return audioQualityEnum;
  }
  var q = String(qualityStr || "").toUpperCase();
  if (q.includes("24-BIT") || q.includes("HI-RES") || q.includes("HI_RES") || q.includes("96") || q.includes("192")) {
    return "HI_RES";
  }
  if (q.includes("16-BIT") || q.includes("LOSSLESS") || q.includes("FLAC")) {
    return "LOSSLESS";
  }
  return "HIGH";
}

/* -------------------------------------------------------
 * Playback (Routes through Cloudflare Worker Proxy)
 * ----------------------------------------------------- */

async function getTrackStreamUrl(trackId, quality, context) {
  var inputId = String(trackId || "").trim();
  if (!inputId) throw new Error("Valid track ID or ISRC required for playback");

  var isrc = null;

  // 1. Context check
  var contextIsrc =
    (context && typeof context.isrc === "string" && context.isrc.trim()) ||
    (context && context.track && typeof context.track.isrc === "string" && context.track.isrc.trim()) ||
    null;

  if (contextIsrc) {
    isrc = contextIsrc;
  }

  // 2. Direct ISRC check
  if (!isrc && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(inputId)) {
    isrc = inputId;
  }

  // 3. Cache check
  var track = trackCache.get(inputId);
  if (!isrc && track && track.isrc) {
    isrc = track.isrc;
  }

  // 4. Resolve from Deezer ID if needed
  if (!isrc && /^\d+$/.test(inputId)) {
    var inFlight = isrcPromises.get(inputId);
    if (inFlight) {
      isrc = await inFlight;
    }
    if (!isrc) {
      isrc = await preloadTrackIsrc(inputId);
    }
  }

  if (!isrc) {
    throw new Error("Could not resolve ISRC for track: " + inputId);
  }

  // Fetch JSON stream details from the Worker to get accurate quality metadata
  var workerUrl = PLAYBACK_ENDPOINT + "/stream?i=" + encodeURIComponent(isrc) + "&json";
  var res = await fetch(workerUrl);

  if (!res.ok) {
    throw new Error("Playback worker returned HTTP " + res.status);
  }

  var data = await res.json();
  if (!data || (!data.streamUrl && !data.source)) {
    throw new Error("Worker did not return a valid stream response");
  }

  var resolvedBadge = map8SpineQuality(data.quality, data.audioQuality);

  // Use PLAYBACK_ENDPOINT so the worker proxies audio bytes (bypassing Deezer 403 Forbidden)
  var playableStreamUrl = PLAYBACK_ENDPOINT + "/stream?i=" + encodeURIComponent(isrc);

  return {
    streamUrl: playableStreamUrl,
    track: {
      id: inputId, // Preserves original queue ID (fixes infinite loading)
      isrc: isrc,
      title: (track && track.title) || (context && context.track && context.track.title) || "",
      artist: (track && track.artist) || (context && context.track && context.track.artist) || "",
      album: (track && track.album) || (context && context.track && context.track.album) || "",
      albumCover: (track && track.albumCover) || (context && context.track && context.track.albumCover) || null,
      duration: (track && track.duration) || (context && context.track && context.track.duration) || 0,
      audioQuality: resolvedBadge // Renders 'LOSSLESS' badge
    }
  };
}

/* -------------------------------------------------------
 * 8SPINE Module Export
 * ----------------------------------------------------- */

return {
  id: "vori-test",
  name: "vori-test",
  author: "alxhlms",
  version: "1.3.0",
  description: "High-Res playback via Qobuz and Deezer",
  labels: ["FLAC", "LOSSLESS", "HI-RES"],

  searchTracks: searchTracks,
  getTrackStreamUrl: getTrackStreamUrl
};
