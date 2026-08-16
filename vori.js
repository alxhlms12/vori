var SEARCH_ENDPOINT = "https://search.alxhlms.workers.dev";
var PLAYBACK_ENDPOINT = "https://playback.alxhlms.workers.dev";

var MAX_SEARCH_CACHE = 100;
var MAX_TRACK_CACHE = 1000;

var searchCache = new Map();
var pendingSearches = new Map();
var trackMap = new Map();

/* -------------------------------------------------------
 * Eager Connection & Socket Pre-Warming
 * ----------------------------------------------------- */

(function prewarmSockets() {
  try {
    fetch(SEARCH_ENDPOINT + "/ping", { method: "HEAD", mode: "no-cors", priority: "low" }).catch(function() {});
    fetch(PLAYBACK_ENDPOINT + "/ping", { method: "HEAD", mode: "no-cors", priority: "low" }).catch(function() {});
  } catch (e) {}
})();

/* -------------------------------------------------------
 * Quality Helpers
 * ----------------------------------------------------- */

var QUAL_MAP = {
  LOSSLESS: "LOSSLESS",
  FLAC: "LOSSLESS",
  CD: "LOSSLESS",
  "16BIT": "LOSSLESS",
  HIGH: "HIGH",
  AACLC: "HIGH",
  AAC320: "HIGH",
  "320": "HIGH"
};

function normalizeQuality(input) {
  if (!input) return "LOSSLESS";
  var s = String(input).toUpperCase();
  return QUAL_MAP[s] || (s.indexOf("HIGH") !== -1 || s.indexOf("320") !== -1 ? "HIGH" : "LOSSLESS");
}

function qualityToPlaybackParam(quality) {
  return normalizeQuality(quality) === "HIGH" ? "high" : "flac";
}

function qualityLabel(quality) {
  return normalizeQuality(quality) === "HIGH" ? "AAC 320kbps" : "LOSSLESS 16-bit / 44.1 kHz";
}

function formatActualQualityLabel(streamInfo) {
  var q = normalizeQuality(streamInfo && streamInfo.quality);
  var bits = Number(streamInfo && streamInfo.bitDepth);
  var rate = Number(streamInfo && streamInfo.sampleRate);

  if (q === "LOSSLESS" && bits > 0 && rate > 0) {
    return "LOSSLESS " + bits + "-bit / " + rate + " kHz";
  }

  return qualityLabel(q);
}

/* -------------------------------------------------------
 * O(1) Map Cache Eviction
 * ----------------------------------------------------- */

function setBoundedCache(map, key, value, maxEntries) {
  if (map.size >= maxEntries) {
    map.delete(map.keys().next().value);
  }
  map.set(key, value);
  return value;
}

/* -------------------------------------------------------
 * Response Parsing
 * ----------------------------------------------------- */

function extractItems(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  if (Array.isArray(res.tracks)) return res.tracks;
  if (Array.isArray(res.data)) return res.data;
  if (Array.isArray(res.items)) return res.items;
  if (Array.isArray(res.results)) return res.results;
  if (res.data) {
    if (Array.isArray(res.data.tracks)) return res.data.tracks;
    if (Array.isArray(res.data.items)) return res.data.items;
  }
  return [];
}

function extractTrackQuality(rawItem) {
  if (!rawItem) return "LOSSLESS";

  var q = rawItem.audioQuality || rawItem.quality || rawItem.qualityLabel || rawItem.format || rawItem.audioFormat || rawItem.formatLabel;
  if (!q && rawItem.attributes) {
    q = rawItem.attributes.audioQuality || rawItem.attributes.quality || rawItem.attributes.format || rawItem.attributes.audioFormat;
  }
  return q ? normalizeQuality(q) : "LOSSLESS";
}

/* -------------------------------------------------------
 * Track Transformation
 * ----------------------------------------------------- */

function transformTrackPayload(rawItem, fallbackQuality) {
  if (!rawItem) rawItem = {};

  var actualQuality = extractTrackQuality(rawItem);
  if (actualQuality === "AUTO") {
    actualQuality = normalizeQuality(fallbackQuality);
  }

  var artistName = "Unknown Artist";
  var rawArtist = rawItem.artist;

  if (typeof rawArtist === "string") {
    artistName = rawArtist;
  } else if (rawArtist && typeof rawArtist.name === "string") {
    artistName = rawArtist.name;
  } else if (rawItem.artistName) {
    artistName = rawItem.artistName;
  } else if (Array.isArray(rawItem.artists) && rawItem.artists.length > 0) {
    var names = [];
    var artists = rawItem.artists;
    for (var i = 0; i < artists.length; i++) {
      var a = artists[i];
      names.push(a && a.name ? a.name : a);
    }
    artistName = names.join(", ");
  }

  var albumName = "";
  var rawAlbum = rawItem.album;

  if (typeof rawAlbum === "string") {
    albumName = rawAlbum;
  } else if (rawAlbum && typeof rawAlbum.title === "string") {
    albumName = rawAlbum.title;
  } else if (rawItem.albumName) {
    albumName = rawItem.albumName;
  }

  var albumCover = rawItem.albumCover || rawItem.cover || null;
  if (!albumCover && rawAlbum) {
    albumCover = rawAlbum.cover_xl || rawAlbum.cover_big || rawAlbum.cover_medium || rawAlbum.cover || null;
  }

  var canonicalIsrc = String(rawItem.isrc || rawItem.ISRC || "").trim();
  var trackId = canonicalIsrc || String(rawItem.id || rawItem.trackId || "");

  var bits = Number(rawItem.bitDepth || (rawItem.audioInfo && rawItem.audioInfo.bitDepth) || (rawItem.attributes && rawItem.attributes.bitDepth) || 0);
  var rate = Number(rawItem.sampleRate || (rawItem.audioInfo && rawItem.audioInfo.sampleRate) || (rawItem.attributes && rawItem.attributes.sampleRate) || 0);
  if (rate >= 1000) rate /= 1000;

  var transformed = {
    id: trackId,
    isrc: canonicalIsrc || null,
    title: rawItem.title || rawItem.name || rawItem.trackName || rawItem.title_short || "Unknown Track",
    artist: artistName,
    album: albumName,
    albumCover: albumCover,
    duration: Number(rawItem.duration) || 0,
    trackNumber: rawItem.trackNumber || rawItem.track_number || 1,
    audioQuality: qualityLabel(actualQuality),
    quality: actualQuality
  };

  if (bits > 0) transformed.bitDepth = bits;
  if (rate > 0) transformed.sampleRate = rate;

  if (trackId) {
    setBoundedCache(trackMap, trackId, transformed, MAX_TRACK_CACHE);
  }

  return transformed;
}

/* -------------------------------------------------------
 * Search Tracks (High Priority Execution)
 * ----------------------------------------------------- */

async function searchTracks(query, limit, context) {
  limit = limit || 15;
  query = String(query || "").trim();

  if (!query) {
    return { tracks: [], total: 0 };
  }

  var selectedQuality = context?.settings?.audioQuality?.value || "LOSSLESS";
  var mappedQuality = normalizeQuality(selectedQuality);
  var mappedQualityParam = qualityToPlaybackParam(mappedQuality);

  var cacheKey = query.toLowerCase() + "_" + limit + "_" + mappedQualityParam;

  if (searchCache.has(cacheKey)) {
    return searchCache.get(cacheKey);
  }

  if (pendingSearches.has(cacheKey)) {
    return pendingSearches.get(cacheKey);
  }

  var requestUrl = SEARCH_ENDPOINT + "/search?q=" + encodeURIComponent(query) + "&quality=" + mappedQualityParam;

  var promise = (async function() {
    try {
      var res = await fetch(requestUrl, {
        priority: "high",
        keepalive: true
      });

      if (!res.ok) {
        throw new Error("Search failed with status " + res.status);
      }

      var body = await res.json();
      var rawTracks = extractItems(body);
      var count = Math.min(rawTracks.length, limit);
      var formattedTracks = new Array(count);

      for (var i = 0; i < count; i++) {
        formattedTracks[i] = transformTrackPayload(rawTracks[i], mappedQuality);
      }

      var responsePayload = {
        tracks: formattedTracks,
        total: count
      };

      setBoundedCache(searchCache, cacheKey, responsePayload, MAX_SEARCH_CACHE);
      return responsePayload;
    } finally {
      pendingSearches.delete(cacheKey);
    }
  })();

  pendingSearches.set(cacheKey, promise);
  return promise;
}

/* -------------------------------------------------------
 * Instant Stream Resolution
 * ----------------------------------------------------- */

function getTrackStreamUrl(trackId, preferredQuality, context) {
  if (!trackId) {
    throw new Error("Valid track ID required for stream resolution");
  }

  var requestedQuality = normalizeQuality(
    preferredQuality || context?.settings?.audioQuality?.value || "LOSSLESS"
  );

  var canonicalTrackId = String(trackId).trim();
  var qualityParam = qualityToPlaybackParam(requestedQuality);

  return {
    streamUrl: PLAYBACK_ENDPOINT + "/stream?i=" + encodeURIComponent(canonicalTrackId) + "&quality=" + qualityParam
  };
}

/* -------------------------------------------------------
 * 8Spine Module Definition
 * ----------------------------------------------------- */

return {
  id: "vori",
  name: "vori",
  author: "alxhlms",
  version: "1.5.0",
  description: "Ultra-low-latency 8SPINE resolver optimized for Lossless and AAC 320",

  settings: {
    audioQuality: {
      type: "selector",
      label: "Streaming Audio Quality",
      description: "Preferred audio target quality",
      options: [
        {
          label: "Lossless (FLAC 16-bit / 44.1 kHz)",
          value: "LOSSLESS"
        },
        {
          label: "High Quality (AAC 320kbps)",
          value: "HIGH"
        }
      ],
      defaultValue: "LOSSLESS"
    }
  },

  searchTracks: searchTracks,
  getTrackStreamUrl: getTrackStreamUrl
};
