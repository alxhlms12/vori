var ITUNES_API_BASE = "https://itunes.apple.com";
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
 * ISRC Resolver & Background Preloader
 * ----------------------------------------------------- */

function getOrResolveIsrc(trackId, context) {
  var id = String(trackId || "").trim();
  if (!id) return Promise.resolve(null);

  // 1. Check context
  var contextIsrc =
    (context && typeof context.isrc === "string" && context.isrc.trim()) ||
    (context && context.track && typeof context.track.isrc === "string" && context.track.isrc.trim()) ||
    null;
  if (contextIsrc) return Promise.resolve(contextIsrc);

  // 2. Direct ISRC pattern check
  if (/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(id)) {
    return Promise.resolve(id);
  }

  // 3. In-memory cache
  var track = trackCache.get(id);
  if (track && track.isrc) {
    return Promise.resolve(track.isrc);
  }

  // 4. Check in-flight resolution
  if (isrcPromises.has(id)) {
    return isrcPromises.get(id);
  }

  // 5. Query Deezer by artist and clean title to fetch the canonical ISRC
  var promise = (async function () {
    try {
      if (!track) return null;

      // Strip feature tags for clean matching
      var cleanTitle = (track.title || "")
        .replace(/\s*\(feat\..*?\)/i, "")
        .replace(/\s*\[feat\..*?\]/i, "")
        .trim();

      var query = 'artist:"' + (track.artist || "") + '" track:"' + cleanTitle + '"';
      var res = await fetch(DEEZER_API_BASE + "/search?q=" + encodeURIComponent(query) + "&limit=1");
      if (!res.ok) {
        // Fallback to broader search if strict query fails
        res = await fetch(DEEZER_API_BASE + "/search?q=" + encodeURIComponent(track.artist + " " + cleanTitle) + "&limit=1");
      }
      if (!res.ok) return null;

      var data = await res.json();
      if (data && Array.isArray(data.data) && data.data.length > 0) {
        var deezerId = data.data[0].id;
        var trackRes = await fetch(DEEZER_API_BASE + "/track/" + encodeURIComponent(deezerId));
        if (trackRes.ok) {
          var trackData = await trackRes.json();
          if (trackData && trackData.isrc) {
            var isrc = String(trackData.isrc).trim();
            track.isrc = isrc;
            cacheSet(trackCache, isrc, track, MAX_TRACK_CACHE);
            cacheSet(trackCache, id, track, MAX_TRACK_CACHE);
            return isrc;
          }
        }
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

function preloadIsrcForTrack(track) {
  if (!track || !track.id || track.isrc) return;
  getOrResolveIsrc(track.id, null).catch(function () {});
}

/* -------------------------------------------------------
 * Search via iTunes API (Best / Top Track First)
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

  // Direct ISRC search bypass
  if (/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(query)) {
    var directTrack = {
      id: query,
      isrc: query,
      title: "Track " + query,
      artist: "Unknown Artist",
      album: "",
      albumCover: null,
      duration: 0,
      audioQuality: "LOSSLESS"
    };
    return { tracks: [directTrack], total: 1 };
  }

  var requestUrl =
    ITUNES_API_BASE +
    "/search?term=" +
    encodeURIComponent(query) +
    "&media=music&entity=song&limit=" +
    effectiveLimit;

  var request = (async function () {
    try {
      var response = await fetch(requestUrl);
      if (!response.ok) throw new Error("iTunes HTTP " + response.status);

      var body = await response.json();
      var rawResults = Array.isArray(body.results) ? body.results : [];

      var tracks = [];
      for (var i = 0; i < rawResults.length; i++) {
        var item = rawResults[i];
        if (!item || !item.trackId) continue;

        var id = String(item.trackId).trim();
        var albumCover = item.artworkUrl100
          ? item.artworkUrl100.replace("100x100bb", "600x600bb")
          : null;

        var track = {
          id: id,
          isrc: null,
          title: String(item.trackName || "Unknown Track").trim(),
          artist: String(item.artistName || "Unknown Artist").trim(),
          album: String(item.collectionName || "").trim(),
          albumCover: albumCover,
          duration: Math.round((Number(item.trackTimeMillis) || 0) / 1000),
          trackNumber: Number(item.trackNumber) || 1,
          audioQuality: "LOSSLESS"
        };

        cacheSet(trackCache, id, track, MAX_TRACK_CACHE);
        tracks.push(track);
      }

      // Fast-Path: Immediately preload candidate 0 so when clicked, ISRC is instant
      if (tracks.length > 0) {
        preloadIsrcForTrack(tracks[0]);
      }
      if (tracks.length > 1) {
        setTimeout(function () {
          preloadIsrcForTrack(tracks[1]);
        }, 80);
      }

      var result = { tracks: tracks, total: Math.max(Number(body.resultCount) || 0, tracks.length) };
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
 * Stream Fetchers (Strict Non-Empty streamUrl Validation)
 * ----------------------------------------------------- */

async function fetchFromQobuz(isrc) {
  var url = QOBUZ_WORKER + "/?isrc=" + encodeURIComponent(isrc);
  var res = await fetch(url);
  if (!res.ok) throw new Error("Qobuz HTTP " + res.status);

  var data = await res.json();
  // Validate that streamUrl exists and is non-empty
  if (!data || !data.streamUrl || typeof data.streamUrl !== "string" || !data.streamUrl.trim()) {
    throw new Error("Qobuz returned no valid streamUrl");
  }

  return {
    provider: "qobuz",
    streamUrl: data.streamUrl.trim(),
    audioQuality: "LOSSLESS",
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
  // Validate that streamUrl exists and is non-empty
  if (!data || !data.streamUrl || typeof data.streamUrl !== "string" || !data.streamUrl.trim()) {
    throw new Error("Deezer returned no valid streamUrl");
  }

  var rawQuality = String(data.format || data.quality || "").toUpperCase();
  var audioQuality = (rawQuality.includes("320") || rawQuality.includes("MP3_320")) ? "HIGH" : "LOSSLESS";

  return {
    provider: "deezer",
    streamUrl: data.streamUrl.trim(),
    audioQuality: audioQuality,
    title: data.title,
    artist: data.artist,
    album: data.album,
    duration: data.duration
  };
}

/* -------------------------------------------------------
 * Playback Method (Concurrent Race with Fallback)
 * ----------------------------------------------------- */

async function getTrackStreamUrl(trackId, quality, context) {
  var inputId = String(trackId || "").trim();
  if (!inputId) throw new Error("Valid track ID required for playback");

  // Resolve ISRC (instant if preloaded)
  var isrc = await getOrResolveIsrc(inputId, context);
  if (!isrc) {
    throw new Error("Could not resolve ISRC for track: " + inputId);
  }

  // Race Qobuz and Deezer concurrently.
  // Whichever fulfills with a valid streamUrl first wins.
  // If one fails or returns no streamUrl, it rejects and Promise.any takes the other.
  var result = null;
  try {
    result = await Promise.any([
      fetchFromQobuz(isrc),
      fetchFromDeezer(isrc)
    ]);
  } catch (err) {
    var details = err instanceof AggregateError
      ? err.errors.map(function (e) { return e.message; }).join(" | ")
      : err.message;
    throw new Error("Both Qobuz and Deezer failed: " + details);
  }

  var track = trackCache.get(inputId);

  return {
    streamUrl: result.streamUrl,
    track: {
      id: inputId, // Preserves original queue ID to prevent player stalls
      isrc: isrc,
      title: result.title || (track && track.title) || "",
      artist: result.artist || (track && track.artist) || "",
      album: result.album || (track && track.album) || "",
      albumCover: (track && track.albumCover) || null,
      duration: result.duration || (track && track.duration) || 0,
      audioQuality: result.audioQuality || "LOSSLESS"
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
  version: "1.5.2-beta-v1",
  description: "16 / 44.1 Maximum Quality Playback, Occasional MP3_128 from Deezer Worker from ARL expirations",
  labels: ["DEEZER", "QOBUZ", "CD-QUALITY"],

  searchTracks: searchTracks,
  getTrackStreamUrl: getTrackStreamUrl
};
