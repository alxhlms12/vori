var DEEZER_API_BASE = "https://api.deezer.com";
var QOBUZ_WORKER = "https://qobuz.alxhlms.workers.dev";
var DEEZER_WORKER = "https://deezer.alxhlms.workers.dev";

var MAX_SEARCH_CACHE = 100;
var MAX_TRACK_CACHE = 1000;

var searchCache = new Map();
var pendingSearches = new Map();
var trackCache = new Map();
var isrcPromises = new Map();

function cacheSet(map, key, value, maxEntries) {
  if (map.has(key)) map.delete(key);
  while (map.size >= maxEntries) {
    map.delete(map.keys().next().value);
  }
  map.set(key, value);
  return value;
}

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

function transformDeezerTrack(raw) {
  raw = raw || {};
  var id = String(raw.id || "").trim();
  var isrc = String(raw.isrc || raw.ISRC || "").trim() || null;

  var track = {
    id: id,
    isrc: isrc,
    title: String(raw.title || raw.title_short || "Unknown Track").trim(),
    artist: raw.artist && typeof raw.artist.name === "string" ? raw.artist.name.trim() : "Unknown Artist",
    album: raw.album && raw.album.title ? raw.album.title.trim() : "",
    albumCover: raw.album ? (raw.album.cover_xl || raw.album.cover_big || raw.album.cover_medium || null) : null,
    duration: Number(raw.duration) || 0,
    audioQuality: "LOSSLESS"
  };

  if (id) cacheSet(trackCache, id, track, MAX_TRACK_CACHE);
  if (isrc) cacheSet(trackCache, isrc, track, MAX_TRACK_CACHE);
  return track;
}

async function searchTracks(query, limit, context) {
  query = String(query || "").trim().replace(/\s+/g, " ");
  if (!query) return { tracks: [], total: 0 };

  var effectiveLimit = Math.max(Number(limit) || 10, 10);
  var cacheKey = query.toLowerCase() + "|" + effectiveLimit;

  var cached = searchCache.get(cacheKey);
  if (cached) return cached;

  var existingRequest = pendingSearches.get(cacheKey);
  if (existingRequest) return existingRequest;

  var requestUrl = DEEZER_API_BASE + "/search?q=" + encodeURIComponent(query) + "&limit=25";

  var request = (async function () {
    try {
      var response = await fetch(requestUrl);
      if (!response.ok) throw new Error("Search HTTP " + response.status);

      var body = await response.json();
      if (body.error) throw new Error(body.error.message || "Search error");

      var rawTracks = Array.isArray(body.data) ? body.data : [];
      var count = Math.min(rawTracks.length, effectiveLimit);
      var tracks = new Array(count);

      for (var i = 0; i < count; i++) {
        tracks[i] = transformDeezerTrack(rawTracks[i]);
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

async function fetchFromQobuz(isrc) {
  var url = QOBUZ_WORKER + "/?isrc=" + encodeURIComponent(isrc);
  var res = await fetch(url);
  if (!res.ok) throw new Error("Qobuz HTTP " + res.status);

  var data = await res.json();
  if (!data || !data.streamUrl) throw new Error("No Qobuz streamUrl");

  return {
    provider: "qobuz",
    streamUrl: data.streamUrl,
    audioQuality: "LOSSLESS", // Strictly LOSSLESS for 8SPINE badge
    title: data.title,
    artist: data.artist,
    album: data.album,
    duration: data.duration
  };
}

async function fetchFromDeezer(isrc, trackId) {
  var query = isrc ? "isrc=" + encodeURIComponent(isrc) : "id=" + encodeURIComponent(trackId);
  var url = DEEZER_WORKER + "/?" + query;
  var res = await fetch(url);
  if (!res.ok) throw new Error("Deezer HTTP " + res.status);

  var data = await res.json();
  if (!data || !data.streamUrl) throw new Error("No Deezer streamUrl");

  // Strictly LOSSLESS or HIGH per 8SPINE specification
  var qualityBadge = data.audioQuality || (String(data.format || "").toUpperCase().includes("FLAC") ? "LOSSLESS" : "HIGH");

  return {
    provider: "deezer",
    streamUrl: data.streamUrl,
    audioQuality: qualityBadge,
    title: data.title,
    artist: data.artist,
    album: data.album,
    duration: data.duration
  };
}

async function getTrackStreamUrl(trackId, quality, context) {
  var inputId = String(trackId || "").trim();
  if (!inputId) throw new Error("Valid track ID or ISRC required");

  var isrc = null;

  var contextIsrc =
    (context && typeof context.isrc === "string" && context.isrc.trim()) ||
    (context && context.track && typeof context.track.isrc === "string" && context.track.isrc.trim()) ||
    null;

  if (contextIsrc) isrc = contextIsrc;
  if (!isrc && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(inputId)) isrc = inputId;

  var track = trackCache.get(inputId);
  if (!isrc && track && track.isrc) isrc = track.isrc;

  if (!isrc && /^\d+$/.test(inputId)) {
    var inFlight = isrcPromises.get(inputId);
    isrc = inFlight ? await inFlight : await preloadTrackIsrc(inputId);
  }

  var candidates = [];
  if (isrc) {
    candidates.push(fetchFromQobuz(isrc));
    candidates.push(fetchFromDeezer(isrc, inputId));
  } else if (/^\d+$/.test(inputId)) {
    candidates.push(fetchFromDeezer(null, inputId));
  } else {
    throw new Error("Could not resolve ISRC for: " + inputId);
  }

  var result = await Promise.any(candidates);

  return {
    streamUrl: result.streamUrl,
    track: {
      id: inputId,
      title: result.title || (track && track.title) || "",
      artist: result.artist || (track && track.artist) || "",
      album: result.album || (track && track.album) || "",
      albumCover: (track && track.albumCover) || null,
      duration: result.duration || (track && track.duration) || 0,
      audioQuality: result.audioQuality // Strictly 'LOSSLESS' or 'HIGH'
    }
  };
}

return {
  id: "vori-test",
  name: "vori-test",
  author: "alxhlms",
  version: "1.5.1",
  description: "Lossless playback via Qobuz and Deezer",
  labels: ["FLAC", "LOSSLESS", "HI-RES"],

  searchTracks: searchTracks,
  getTrackStreamUrl: getTrackStreamUrl
};
