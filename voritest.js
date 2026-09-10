var DEEZER_API_BASE = "https://api.deezer.com";
var PLAYBACK_ENDPOINT = "https://playback.alxhlms.workers.dev";

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

function preloadTrackIsrc(trackId, shouldPrewarm) {
  var id = String(trackId || "").trim();
  if (!id || !/^\d+$/.test(id)) return Promise.resolve(null);

  var track = trackCache.get(id);
  if (track && track.isrc) {
    if (shouldPrewarm) prewarmPlaybackStream(track.isrc);
    return Promise.resolve(track.isrc);
  }
  if (isrcPromises.has(id)) return isrcPromises.get(id);

  var promise = (async function () {
    try {
      var res = await fetch(DEEZER_API_BASE + "/track/" + encodeURIComponent(id));
      if (!res.ok) return null;

      var data = await res.json();
      if (data && data.isrc) {
        var isrc = String(data.isrc).trim();
        if (track) {
          track.isrc = isrc;
        }
        cacheSet(trackCache, isrc, track || { id: id, isrc: isrc }, MAX_TRACK_CACHE);
        cacheSet(trackCache, id, Object.assign({}, track || { id: id }, { isrc: isrc }), MAX_TRACK_CACHE);

        if (shouldPrewarm) {
          prewarmPlaybackStream(isrc);
        }

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
    audioQuality: "LOSSLESS" // Informs 8SPINE this candidate supports Hi-Fi
  };

  if (id) cacheSet(trackCache, id, track, MAX_TRACK_CACHE);
  if (isrc) cacheSet(trackCache, isrc, track, MAX_TRACK_CACHE);

  return track;
}

/* -------------------------------------------------------
 * Search (Fixed endpoint & enforces minimum 10 results)
 * ----------------------------------------------------- */

async function searchTracks(query, limit, context) {
  query = String(query || "").trim().replace(/\s+/g, " ");
  if (!query) return { tracks: [], total: 0 };

  // Always enforce a minimum of 10 tracks
  var effectiveLimit = Math.max(Number(limit) || 10, 10);
  var cacheKey = query.toLowerCase() + "|" + effectiveLimit;

  var cached = searchCache.get(cacheKey);
  if (cached) return cached;

  var existingRequest = pendingSearches.get(cacheKey);
  if (existingRequest) return existingRequest;

  // Uses the official /search endpoint (not /search/track) and fetches 25 to guarantee >= 10 post-filter
  var requestUrl =
    DEEZER_API_BASE +
    "/search?q=" +
    encodeURIComponent(query) +
    "&limit=25";

  var request = (async function () {
    try {
      var response = await fetch(requestUrl);
      if (!response.ok) throw new Error("HTTP " + response.status);

      var body = await response.json();
      if (body.error) throw new Error(body.error.message || "Deezer error");

      var rawTracks = Array.isArray(body.data) ? body.data : [];
      var sortedRawTracks = sortAndFilterDeezerTracks(rawTracks, query);

      // Take at least 10 (or up to effectiveLimit)
      var count = Math.min(sortedRawTracks.length, effectiveLimit);
      var tracks = new Array(count);

      for (var i = 0; i < count; i++) {
        tracks[i] = transformDeezerTrack(sortedRawTracks[i]);
      }

      // Preload ISRC for the top result in background without blocking UI
      if (tracks.length > 0 && tracks[0].id) {
        preloadTrackIsrc(tracks[0].id, false);
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
 * Quality Badge Mapper for 8SPINE
 * ----------------------------------------------------- */

function map8SpineQuality(qualityStr, audioQualityEnum) {
  if (audioQualityEnum === "HI_RES" || audioQualityEnum === "LOSSLESS" || audioQualityEnum === "HIGH") {
    return audioQualityEnum;
  }
  var q = String(qualityStr || "").toUpperCase();
  if (q.includes("24-BIT") || q.includes("HI-RES") || q.includes("HI_RES") || q.includes("96") || q.includes("192")) {
    return "HI_RES";
  }
  if (q.includes("FLAC") || q.includes("LOSSLESS") || q.includes("16-BIT")) {
    return "LOSSLESS";
  }
  return "HIGH";
}

/* -------------------------------------------------------
 * Playback
 * ----------------------------------------------------- */

async function getTrackStreamUrl(trackId, quality, context) {
  var id = String(trackId || "").trim();
  if (!id) throw new Error("Valid track ID or ISRC required for playback");

  var isrc = null;

  // 1. Check context
  var contextIsrc =
    (context && typeof context.isrc === "string" && context.isrc.trim()) ||
    (context && context.track && typeof context.track.isrc === "string" && context.track.isrc.trim()) ||
    null;

  if (contextIsrc) {
    isrc = contextIsrc;
  }

  // 2. Direct ISRC string check
  if (!isrc && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(id)) {
    isrc = id;
  }

  // 3. Cache lookup
  var track = trackCache.get(id);
  if (!isrc && track && track.isrc) {
    isrc = track.isrc;
  }

  // 4. Resolve from Deezer API if numeric ID
  if (!isrc && /^\d+$/.test(id)) {
    var inFlight = isrcPromises.get(id);
    if (inFlight) {
      isrc = await inFlight;
    }
    if (!isrc) {
      isrc = await preloadTrackIsrc(id, false);
    }
  }

  if (!isrc) {
    throw new Error("Could not resolve a valid ISRC for track: " + id);
  }

  // Query worker with &json to retrieve direct playable link and quality metadata
  var workerUrl = PLAYBACK_ENDPOINT + "/stream?i=" + encodeURIComponent(isrc) + "&json";
  var res = await fetch(workerUrl);

  if (!res.ok) {
    throw new Error("Playback worker returned HTTP " + res.status);
  }

  var data = await res.json();
  if (!data || !data.streamUrl) {
    throw new Error("Worker did not return a playable stream URL");
  }

  // Standardized badge for 8SPINE
  var resolvedQualityBadge = map8SpineQuality(data.quality, data.audioQuality);

  return {
    streamUrl: data.streamUrl,
    track: Object.assign({}, track || { id: isrc, isrc: isrc }, {
      id: isrc,
      isrc: isrc,
      audioQuality: resolvedQualityBadge
    })
  };
}

/* -------------------------------------------------------
 * 8SPINE Module Export
 * ----------------------------------------------------- */

return {
  id: "vori-test",
  name: "vori-test",
  author: "alxhlms",
  version: "1.2.8",
  description: "High-Res playback via Qobuz and Deezer",
  labels: ["DEEZER", "QOBUZ", "CD-QUALITY"],

  searchTracks: searchTracks,
  getTrackStreamUrl: getTrackStreamUrl
};
