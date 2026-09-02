var SEARCH_ENDPOINT = "https://search.alxhlms.workers.dev";
var PLAYBACK_ENDPOINT = "https://playback.alxhlms.workers.dev";

var MAX_SEARCH_CACHE = 100;
var MAX_TRACK_CACHE = 2000;
var MAX_STREAM_CACHE = 2000;

var SEARCH_TTL = 5 * 60 * 1000;
var STREAM_TTL = 60 * 60 * 1000;

var searchCache = new Map();
var pendingSearches = new Map();
var trackMap = new Map();
var streamCache = new Map();

/*
 * ---------------------------------------------------------
 * Connection warmup
 * ---------------------------------------------------------
 *
 * Do this immediately, but don't make it part of any critical
 * request. The goal is simply to get DNS/TLS/connection setup
 * out of the way before the user actually presses play.
 */

(function prewarmConnections() {
  try {
    fetch(SEARCH_ENDPOINT + "/ping", {
      method: "HEAD",
      mode: "no-cors",
      cache: "no-store"
    }).catch(function () {});

    fetch(PLAYBACK_ENDPOINT + "/ping", {
      method: "HEAD",
      mode: "no-cors",
      cache: "no-store"
    }).catch(function () {});
  } catch (e) {}
})();

/*
 * ---------------------------------------------------------
 * Quality helpers
 * ---------------------------------------------------------
 */

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

  if (QUAL_MAP[s]) {
    return QUAL_MAP[s];
  }

  if (
    s.indexOf("HIGH") !== -1 ||
    s.indexOf("320") !== -1 ||
    s.indexOf("AAC") !== -1
  ) {
    return "HIGH";
  }

  return "LOSSLESS";
}

function qualityToPlaybackParam(quality) {
  return normalizeQuality(quality) === "HIGH"
    ? "high"
    : "flac";
}

function qualityLabel(quality) {
  return normalizeQuality(quality) === "HIGH"
    ? "AAC 320kbps"
    : "LOSSLESS 16-bit / 44.1 kHz";
}

function formatActualQualityLabel(streamInfo) {
  var q = normalizeQuality(
    streamInfo && streamInfo.quality
  );

  var bits = Number(
    streamInfo && streamInfo.bitDepth
  );

  var rate = Number(
    streamInfo && streamInfo.sampleRate
  );

  if (q === "LOSSLESS" && bits > 0 && rate > 0) {
    return (
      "LOSSLESS " +
      bits +
      "-bit / " +
      rate +
      " kHz"
    );
  }

  return qualityLabel(q);
}

/*
 * ---------------------------------------------------------
 * Fast bounded cache
 * ---------------------------------------------------------
 *
 * Map insertion order gives us cheap FIFO eviction.
 */

function setBoundedCache(map, key, value, maxEntries) {
  if (map.size >= maxEntries && !map.has(key)) {
    map.delete(map.keys().next().value);
  }

  map.set(key, value);
  return value;
}

/*
 * ---------------------------------------------------------
 * Cache helpers
 * ---------------------------------------------------------
 */

function getFreshCacheEntry(map, key, ttl) {
  var entry = map.get(key);

  if (!entry) {
    return null;
  }

  if (
    ttl !== Infinity &&
    Date.now() - entry.time > ttl
  ) {
    map.delete(key);
    return null;
  }

  return entry.value;
}

function setCacheEntry(map, key, value, maxEntries) {
  setBoundedCache(
    map,
    key,
    {
      value: value,
      time: Date.now()
    },
    maxEntries
  );

  return value;
}

/*
 * ---------------------------------------------------------
 * Response normalization
 * ---------------------------------------------------------
 */

function extractItems(res) {
  if (!res) return [];

  if (Array.isArray(res)) {
    return res;
  }

  if (Array.isArray(res.tracks)) {
    return res.tracks;
  }

  if (Array.isArray(res.data)) {
    return res.data;
  }

  if (Array.isArray(res.items)) {
    return res.items;
  }

  if (Array.isArray(res.results)) {
    return res.results;
  }

  if (res.data) {
    if (Array.isArray(res.data.tracks)) {
      return res.data.tracks;
    }

    if (Array.isArray(res.data.items)) {
      return res.data.items;
    }
  }

  return [];
}

function extractTrackQuality(rawItem) {
  if (!rawItem) {
    return "LOSSLESS";
  }

  var q =
    rawItem.audioQuality ||
    rawItem.quality ||
    rawItem.qualityLabel ||
    rawItem.format ||
    rawItem.audioFormat ||
    rawItem.formatLabel;

  if (!q && rawItem.attributes) {
    q =
      rawItem.attributes.audioQuality ||
      rawItem.attributes.quality ||
      rawItem.attributes.format ||
      rawItem.attributes.audioFormat;
  }

  return q
    ? normalizeQuality(q)
    : "LOSSLESS";
}

/*
 * ---------------------------------------------------------
 * Track transformation
 * ---------------------------------------------------------
 */

function transformTrackPayload(rawItem, fallbackQuality) {
  if (!rawItem) {
    return null;
  }

  var rawId =
    rawItem.id ||
    rawItem.trackId ||
    rawItem.track_id ||
    rawItem.isrc ||
    "";

  var artist =
    rawItem.artist ||
    rawItem.artistName ||
    rawItem.artist_name ||
    (rawItem.artists &&
      rawItem.artists[0] &&
      (
        rawItem.artists[0].name ||
        rawItem.artists[0].artistName
      )) ||
    "";

  var album =
    rawItem.album ||
    rawItem.albumName ||
    rawItem.album_name ||
    "";

  var cover =
    rawItem.cover ||
    rawItem.coverUrl ||
    rawItem.cover_url ||
    rawItem.image ||
    rawItem.thumbnail ||
    rawItem.albumArt ||
    "";

  var isrc =
    rawItem.isrc ||
    rawItem.ISRC ||
    rawItem.external_id ||
    "";

  var quality = extractTrackQuality(
    rawItem
  );

  if (!quality) {
    quality = normalizeQuality(
      fallbackQuality
    );
  }

  var bitDepth = Number(
    rawItem.bitDepth ||
    rawItem.bit_depth ||
    rawItem.maximumBitDepth ||
    rawItem.maximum_bit_depth ||
    0
  );

  var sampleRate = Number(
    rawItem.sampleRate ||
    rawItem.sample_rate ||
    rawItem.samplingRate ||
    rawItem.sampling_rate ||
    rawItem.maximumSamplingRate ||
    rawItem.maximum_sampling_rate ||
    0
  );

  var duration = Number(
    rawItem.duration ||
    rawItem.durationMs ||
    0
  );

  /*
   * Keep this object stable.
   *
   * Track objects are cached so the same result doesn't get
   * reconstructed every time a search is repeated.
   */

  var track = {
    id: String(rawId),
    trackId: String(rawId),
    isrc: isrc ? String(isrc) : "",
    title: String(
      rawItem.title ||
      rawItem.name ||
      ""
    ),
    artist: String(artist),
    album: String(album),
    cover: String(cover),
    quality: quality,
    bitDepth: bitDepth,
    sampleRate: sampleRate,
    duration: duration,

    /*
     * Preserve the original object in case the client expects
     * provider-specific metadata.
     */
    raw: rawItem
  };

  /*
   * Cache by every useful identifier.
   */

  if (track.id) {
    setBoundedCache(
      trackMap,
      track.id,
      track,
      MAX_TRACK_CACHE
    );
  }

  if (track.isrc) {
    setBoundedCache(
      trackMap,
      track.isrc.toLowerCase(),
      track,
      MAX_TRACK_CACHE
    );
  }

  return track;
}

/*
 * ---------------------------------------------------------
 * Search
 * ---------------------------------------------------------
 */

async function searchTracks(
  query,
  limit,
  context
) {
  limit = limit || 15;

  query = String(query || "").trim();

  if (!query) {
    return {
      tracks: [],
      total: 0
    };
  }

  /*
   * Normalize whitespace so:
   *
   * "  Drake   One Dance "
   *
   * and
   *
   * "Drake One Dance"
   *
   * use the same cache entry.
   */

  query = query
    .replace(/\s+/g, " ")
    .trim();

  var selectedQuality =
    context &&
    context.settings &&
    context.settings.audioQuality &&
    context.settings.audioQuality.value;

  var mappedQuality =
    normalizeQuality(selectedQuality);

  /*
   * IMPORTANT:
   *
   * Search itself doesn't need to be different just because
   * playback quality changed.
   *
   * Quality belongs to playback resolution, not metadata
   * discovery.
   */

  var cacheKey =
    query.toLowerCase() +
    "_" +
    limit;

  /*
   * -------------------------------------------------------
   * Instant cache hit
   * -------------------------------------------------------
   */

  var cached = getFreshCacheEntry(
    searchCache,
    cacheKey,
    SEARCH_TTL
  );

  if (cached) {
    return cached;
  }

  /*
   * -------------------------------------------------------
   * Deduplicate simultaneous requests
   * -------------------------------------------------------
   */

  var pending =
    pendingSearches.get(cacheKey);

  if (pending) {
    return pending;
  }

  /*
   * -------------------------------------------------------
   * Network request
   * -------------------------------------------------------
   */

  var requestUrl =
    SEARCH_ENDPOINT +
    "/search?q=" +
    encodeURIComponent(query);

  var promise = (async function () {
    try {
      var res = await fetch(requestUrl, {
        method: "GET",
        cache: "default"
      });

      if (!res.ok) {
        throw new Error(
          "Search failed with status " +
          res.status
        );
      }

      var body = await res.json();

      var rawTracks =
        extractItems(body);

      var count = Math.min(
        rawTracks.length,
        limit
      );

      var formattedTracks =
        new Array(count);

      for (
        var i = 0;
        i < count;
        i++
      ) {
        formattedTracks[i] =
          transformTrackPayload(
            rawTracks[i],
            mappedQuality
          );
      }

      var responsePayload = {
        tracks: formattedTracks,
        total: count
      };

      setCacheEntry(
        searchCache,
        cacheKey,
        responsePayload,
        MAX_SEARCH_CACHE
      );

      return responsePayload;
    } finally {
      pendingSearches.delete(
        cacheKey
      );
    }
  })();

  pendingSearches.set(
    cacheKey,
    promise
  );

  return promise;
}

/*
 * ---------------------------------------------------------
 * Playback URL
 * ---------------------------------------------------------
 */

function getTrackStreamUrl(
  trackId,
  preferredQuality,
  context
) {
  if (!trackId) {
    throw new Error(
      "Valid track ID required for stream resolution"
    );
  }

  var requestedQuality =
    normalizeQuality(
      preferredQuality ||
      (
        context &&
        context.settings &&
        context.settings.audioQuality &&
        context.settings.audioQuality.value
      ) ||
      "LOSSLESS"
    );

  var canonicalTrackId =
    String(trackId).trim();

  var qualityParam =
    qualityToPlaybackParam(
      requestedQuality
    );

  /*
   * This is the exact URL your existing backend expects.
   */

  var streamUrl =
    PLAYBACK_ENDPOINT +
    "/stream?i=" +
    encodeURIComponent(
      canonicalTrackId
    ) +
    "&quality=" +
    encodeURIComponent(
      qualityParam
    );

  /*
   * Cache the generated endpoint.
   *
   * This doesn't cache the actual Qobuz stream URL;
   * it simply avoids repeatedly constructing and encoding
   * the same endpoint.
   */

  var cacheKey =
    canonicalTrackId +
    "|" +
    qualityParam;

  var cached =
    getFreshCacheEntry(
      streamCache,
      cacheKey,
      STREAM_TTL
    );

  if (cached) {
    return cached;
  }

  var result = {
    streamUrl: streamUrl
  };

  setCacheEntry(
    streamCache,
    cacheKey,
    result,
    MAX_STREAM_CACHE
  );

  return result;
}

/*
 * ---------------------------------------------------------
 * Optional fast prefetch API
 * ---------------------------------------------------------
 *
 * This lets the host application pre-trigger the playback
 * resolver BEFORE the user actually presses play.
 *
 * It is deliberately separate from getTrackStreamUrl() so
 * existing integrations don't break.
 */

function prefetchTrackStreamUrl(
  trackId,
  preferredQuality,
  context
) {
  var result = getTrackStreamUrl(
    trackId,
    preferredQuality,
    context
  );

  /*
   * Fire and forget.
   *
   * The browser/Worker can establish its connection and the
   * resolver can begin working before playback is requested.
   */

  try {
    fetch(result.streamUrl, {
      method: "GET",
      cache: "default"
    }).catch(function () {});
  } catch (e) {}

  return result;
}

/*
 * ---------------------------------------------------------
 * Public module
 * ---------------------------------------------------------
 */

return {
  id: "vori-test",
  name: "vori-test",
  author: "alxhlms",
  version: "1.0.0",

  description:
    "Ultra-low-latency 8SPINE resolver optimized for Lossless and AAC 320",

  settings: {
    audioQuality: {
      type: "selector",

      label:
        "Streaming Audio Quality",

      description:
        "Preferred audio target quality",

      options: [
        {
          label:
            "Lossless (FLAC 16-bit / 44.1 kHz)",
          value: "LOSSLESS"
        },
        {
          label:
            "High Quality (AAC 320kbps)",
          value: "HIGH"
        }
      ],

      defaultValue: "LOSSLESS"
    }
  },

  searchTracks:
    searchTracks,

  getTrackStreamUrl:
    getTrackStreamUrl,

  /*
   * Optional.
   *
   * Existing callers don't need to change.
   */
  prefetchTrackStreamUrl:
    prefetchTrackStreamUrl
};
