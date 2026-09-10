var DEEZER_API_BASE = "https://api.deezer.com";
var QOBUZ_WORKER = "https://qobuz.alxhlms.workers.dev";
var DEEZER_WORKER = "https://deezer.alxhlms.workers.dev";

var MAX_SEARCH_CACHE = 100;
var MAX_TRACK_CACHE = 1000;

var searchCache = new Map();
var pendingSearches = new Map();
var trackCache = new Map();
var isrcPromises = new Map();

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
 * ISRC Preloader
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
      var res = await fetch(DEEZER_API_BASE + "/track/" + encodeURIComponent(id));
      if (!res.ok) return null;

      var data = await res.json();
      if (data && data.isrc) {
        var isrc = String(data.isrc).trim();
        if (cachedTrack) {
          cachedTrack.isrc = isrc;
        }
        cacheSet(trackCache, isrc, cachedTrack || { id: id, isrc: isrc }, MAX_TRACK_CACHE);
        cacheSet(trackCache, id, Object.assign({}, cachedTrack || { id: id }, { isrc: isrc }), MAX_TRACK_CACHE);
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
 * Search (Enforces minimum 10 items)
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

  // Requests 25 candidates so after filtering, >= 10 results are guaranteed
  var requestUrl =
    DEEZER_API_BASE +
    "/search?q=" +
    encodeURIComponent(query) +
    "&limit=25";

  var request = (async function () {
    try {
      var response = await fetch(requestUrl);
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
 * Direct Worker Fetchers
 * ----------------------------------------------------- */

async function fetchFromQobuz(isrc) {
  var url = QOBUZ_WORKER + "/?isrc=" + encodeURIComponent(isrc);
  var res = await fetch(url);
  if (!res.ok) throw new Error("Qobuz HTTP " + res.status);

  var data = await res.json();
  if (!data || !data.streamUrl) {
    throw new Error("No Qobuz streamUrl");
  }

  // Parse Qobuz bit_depth & sampling_rate
  var bitDepth = Number(data.bit_depth) || 16;
  var samplingRate = Number(data.sampling_rate) || 44.1;
  var isHiRes = bitDepth > 16 || samplingRate > 48;

  return {
    provider: "qobuz",
    streamUrl: data.streamUrl, // Direct Akamai CDN link
    audioQuality: isHiRes ? "HI_RES" : "LOSSLESS",
    title: data.title,
    artist: data.artist,
    album: data.album,
    duration: data.duration
  };
}

async function fetchFromDeezer(isrc) {
  var url = DEEZER_WORKER + "/?isrc=" + encodeURIComponent(isrc);
  var res = await fetch(url);
  if (!res.ok) throw new Error("Deezer HTTP " + res.status);

  var data = await res.json();
  if (!data || !data.streamUrl) {
    throw new Error("No Deezer streamUrl");
  }

  // Deezer returns format: "FLAC", quality: "16-bit / 44.1kHz Lossless"
  var rawQuality = String(data.quality || data.format || "").toUpperCase();
  var audioQuality = "LOSSLESS";
  if (rawQuality.includes("320") || rawQuality.includes("MP3")) {
    audioQuality = "HIGH";
  }

  return {
    provider: "deezer",
    streamUrl: data.streamUrl, // Direct deezer.alxhlms.workers.dev/stream decryptor link
    audioQuality: audioQuality,
    title: data.title,
    artist: data.artist,
    album: data.album,
    duration: data.duration
  };
}

/* -------------------------------------------------------
 * Playback (Races Qobuz & Deezer directly from the client)
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

  // 2. Direct ISRC string check
  if (!isrc && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(inputId)) {
    isrc = inputId;
  }

  // 3. Cache lookup
  var track = trackCache.get(inputId);
  if (!isrc && track && track.isrc) {
    isrc = track.isrc;
  }

  // 4. Resolve from Deezer API if numeric ID
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

  // RACE: Fire both Qobuz and Deezer concurrently. Whichever answers first wins!
  var result = null;
  try {
    result = await Promise.any([
      fetchFromQobuz(isrc),
      fetchFromDeezer(isrc)
    ]);
  } catch (err) {
    var details = err instanceof AggregateError
      ? err.errors.map(function(e) { return e.message; }).join(" | ")
      : err.message;
    throw new Error("Both Qobuz and Deezer failed: " + details);
  }

  if (!result || !result.streamUrl) {
    throw new Error("No stream URL available for track: " + inputId);
  }

  // CRITICAL: track.id MUST equal inputId to prevent 8SPINE infinite loading & track mismatches!
  return {
    streamUrl: result.streamUrl,
    track: {
      id: inputId,
      isrc: isrc,
      title: result.title || (track && track.title) || "",
      artist: result.artist || (track && track.artist) || "",
      album: result.album || (track && track.album) || "",
      albumCover: (track && track.albumCover) || null,
      duration: result.duration || (track && track.duration) || 0,
      audioQuality: result.audioQuality // 'HI_RES' | 'LOSSLESS' | 'HIGH'
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
  version: "1.4.0",
  description: "Direct High-Res playback via Qobuz & Deezer",
  labels: ["FLAC", "LOSSLESS", "GRRR"],

  searchTracks: searchTracks,
  getTrackStreamUrl: getTrackStreamUrl
};
