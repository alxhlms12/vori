/* VORI 1.6.0
 * Fast + compatibility-first 8SPINE resolver
 */

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

/* ---------------------------------------------------------
 * Connection warmup
 * --------------------------------------------------------- */

(function prewarmConnections() {
  try {
    fetch(SEARCH_ENDPOINT + "/ping", {
      method: "HEAD",
      mode: "no-cors"
    }).catch(function () {});

    fetch(PLAYBACK_ENDPOINT + "/ping", {
      method: "HEAD",
      mode: "no-cors"
    }).catch(function () {});
  } catch (e) {}
})();

/* ---------------------------------------------------------
 * Quality
 * --------------------------------------------------------- */

var QUAL_MAP = {
  LOSSLESS: "LOSSLESS",
  FLAC: "LOSSLESS",
  CD: "LOSSLESS",
  "16BIT": "LOSSLESS",

  HIGH: "HIGH",
  AAC: "HIGH",
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
    s.indexOf("AAC") !== -1 ||
    s.indexOf("320") !== -1 ||
    s.indexOf("HIGH") !== -1
  ) {
    return "HIGH";
  }

  return "LOSSLESS";
}

function qualityToPlaybackParam(input) {
  return normalizeQuality(input) === "HIGH"
    ? "high"
    : "flac";
}

function qualityLabel(input) {
  return normalizeQuality(input) === "HIGH"
    ? "AAC 320kbps"
    : "LOSSLESS 16-bit / 44.1 kHz";
}

function formatActualQualityLabel(streamInfo) {
  var q = normalizeQuality(
    streamInfo && (
      streamInfo.quality ||
      streamInfo.audioQuality
    )
  );

  var bits = Number(
    streamInfo && (
      streamInfo.bitDepth ||
      streamInfo.bit_depth
    )
  );

  var rate = Number(
    streamInfo && (
      streamInfo.sampleRate ||
      streamInfo.sample_rate ||
      streamInfo.samplingRate ||
      streamInfo.sampling_rate
    )
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

/* ---------------------------------------------------------
 * Cache
 * --------------------------------------------------------- */

function setBoundedCache(map, key, value, maxEntries) {
  if (!map.has(key) && map.size >= maxEntries) {
    map.delete(map.keys().next().value);
  }

  map.set(key, value);
  return value;
}

function getCache(map, key, ttl) {
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

function putCache(map, key, value, maxEntries) {
  return setBoundedCache(
    map,
    key,
    {
      value: value,
      time: Date.now()
    },
    maxEntries
  );
}

/* ---------------------------------------------------------
 * Search response handling
 * --------------------------------------------------------- */

function extractItems(res) {
  if (!res) return [];

  if (Array.isArray(res)) {
    return res;
  }

  if (Array.isArray(res.tracks)) {
    return res.tracks;
  }

  if (res.data) {
    if (Array.isArray(res.data.tracks)) {
      return res.data.tracks;
    }

    if (Array.isArray(res.data.items)) {
      return res.data.items;
    }

    if (Array.isArray(res.data)) {
      return res.data;
    }
  }

  if (Array.isArray(res.items)) {
    return res.items;
  }

  if (Array.isArray(res.results)) {
    return res.results;
  }

  return [];
}

/* ---------------------------------------------------------
 * Safe property helpers
 * --------------------------------------------------------- */

function firstString() {
  for (var i = 0; i < arguments.length; i++) {
    var v = arguments[i];

    if (
      typeof v === "string" &&
      v.trim()
    ) {
      return v.trim();
    }

    if (
      typeof v === "number" &&
      isFinite(v)
    ) {
      return String(v);
    }
  }

  return "";
}

function getNestedString(obj, paths) {
  for (var i = 0; i < paths.length; i++) {
    var current = obj;

    for (var j = 0; j < paths[i].length; j++) {
      if (
        current == null ||
        typeof current !== "object"
      ) {
        current = null;
        break;
      }

      current = current[paths[i][j]];
    }

    if (
      typeof current === "string" &&
      current.trim()
    ) {
      return current.trim();
    }

    if (
      typeof current === "number" &&
      isFinite(current)
    ) {
      return String(current);
    }
  }

  return "";
}

/* ---------------------------------------------------------
 * Quality extraction
 * --------------------------------------------------------- */

function extractTrackQuality(rawItem) {
  if (!rawItem || typeof rawItem !== "object") {
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

/* ---------------------------------------------------------
 * Track normalization
 *
 * IMPORTANT:
 * We DO NOT replace the provider's object shape.
 * We clone it and preserve all original properties.
 * --------------------------------------------------------- */

function transformTrackPayload(rawItem, fallbackQuality) {
  if (
    !rawItem ||
    typeof rawItem !== "object"
  ) {
    return null;
  }

  /*
   * Preserve the original search result.
   *
   * This is the important part that my previous version
   * screwed up.
   */
  var track = Object.assign({}, rawItem);

  var title = firstString(
    rawItem.title,
    rawItem.name
  );

  var artist = firstString(
    rawItem.artistName,
    rawItem.artist_name,
    typeof rawItem.artist === "string"
      ? rawItem.artist
      : ""
  );

  if (!artist) {
    artist = getNestedString(
      rawItem,
      [
        ["artist", "name"],
        ["artists", "0", "name"],
        ["artists", "0", "artistName"],
        ["artist", "artistName"]
      ]
    );
  }

  var album = firstString(
    rawItem.albumName,
    rawItem.album_name,
    typeof rawItem.album === "string"
      ? rawItem.album
      : ""
  );

  if (!album) {
    album = getNestedString(
      rawItem,
      [
        ["album", "title"],
        ["album", "name"],
        ["album", "albumName"]
      ]
    );
  }

  var isrc = firstString(
    rawItem.isrc,
    rawItem.ISRC,
    rawItem.external_id
  );

  var id = firstString(
    rawItem.id,
    rawItem.trackId,
    rawItem.track_id,
    rawItem.id
  );

  /*
   * Only fill missing simple fields.
   *
   * If the provider already supplied an object for artist/album,
   * DON'T overwrite it with a string.
   */

  if (
    track.title == null &&
    title
  ) {
    track.title = title;
  }

  if (
    track.isrc == null &&
    isrc
  ) {
    track.isrc = isrc;
  }

  if (
    track.id == null &&
    id
  ) {
    track.id = id;
  }

  /*
   * Do NOT do:
   *
   * track.artist = artist
   *
   * because the provider might have:
   *
   * artist: { name: "..." }
   *
   * and 8SPINE may expect that object.
   */

  if (
    track.artistName == null &&
    artist
  ) {
    track.artistName = artist;
  }

  if (
    track.albumName == null &&
    album
  ) {
    track.albumName = album;
  }

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

  /*
   * Again: only add these if they aren't already there.
   */

  if (
    track.quality == null
  ) {
    track.quality = quality;
  }

  if (
    track.bitDepth == null &&
    bitDepth > 0
  ) {
    track.bitDepth = bitDepth;
  }

  if (
    track.sampleRate == null &&
    sampleRate > 0
  ) {
    track.sampleRate = sampleRate;
  }

  /*
   * Cache the complete provider-compatible object.
   */

  var cacheId = firstString(
    rawItem.id,
    rawItem.trackId,
    rawItem.track_id,
    rawItem.isrc,
    rawItem.ISRC
  );

  if (cacheId) {
    setBoundedCache(
      trackMap,
      cacheId,
      track,
      MAX_TRACK_CACHE
    );
  }

  if (isrc) {
    setBoundedCache(
      trackMap,
      isrc.toLowerCase(),
      track,
      MAX_TRACK_CACHE
    );
  }

  return track;
}

/* ---------------------------------------------------------
 * Search
 * --------------------------------------------------------- */

async function searchTracks(
  query,
  limit,
  context
) {
  limit = Number(limit) || 15;

  query = String(
    query || ""
  )
    .replace(/\s+/g, " ")
    .trim();

  if (!query) {
    return {
      tracks: [],
      total: 0
    };
  }

  /*
   * Quality does NOT belong in the search cache key.
   *
   * Search results are metadata.
   * Playback quality is resolved later.
   */

  var cacheKey =
    query.toLowerCase() +
    "|" +
    limit;

  var cached = getCache(
    searchCache,
    cacheKey,
    SEARCH_TTL
  );

  if (cached) {
    return cached;
  }

  /*
   * Prevent duplicate searches when the UI fires the same
   * request multiple times.
   */

  var pending =
    pendingSearches.get(cacheKey);

  if (pending) {
    return pending;
  }

  var requestUrl =
    SEARCH_ENDPOINT +
    "/search?q=" +
    encodeURIComponent(query);

  var promise = (async function () {
    try {
      var response = await fetch(
        requestUrl,
        {
          method: "GET"
        }
      );

      if (!response.ok) {
        throw new Error(
          "Search failed with status " +
          response.status
        );
      }

      var body =
        await response.json();

      var rawTracks =
        extractItems(body);

      var count = Math.min(
        rawTracks.length,
        limit
      );

      var tracks =
        new Array(count);

      for (
        var i = 0;
        i < count;
        i++
      ) {
        tracks[i] =
          transformTrackPayload(
            rawTracks[i],
            "LOSSLESS"
          );
      }

      var result = {
        tracks: tracks,
        total: count
      };

      putCache(
        searchCache,
        cacheKey,
        result,
        MAX_SEARCH_CACHE
      );

      return result;
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

/* ---------------------------------------------------------
 * Playback URL
 * --------------------------------------------------------- */

function getTrackStreamUrl(
  trackId,
  preferredQuality,
  context
) {
  if (
    trackId === null ||
    trackId === undefined ||
    String(trackId).trim() === ""
  ) {
    throw new Error(
      "Valid track ID required for stream resolution"
    );
  }

  var quality =
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

  var id =
    String(trackId).trim();

  var qualityParam =
    qualityToPlaybackParam(
      quality
    );

  var cacheKey =
    id +
    "|" +
    qualityParam;

  var cached = getCache(
    streamCache,
    cacheKey,
    STREAM_TTL
  );

  if (cached) {
    return cached;
  }

  /*
   * IMPORTANT:
   *
   * Your current playback Worker/frontend contract uses:
   *
   *     /stream?i=...&quality=...
   *
   * Keep that intact.
   */

  var url =
    PLAYBACK_ENDPOINT +
    "/stream?i=" +
    encodeURIComponent(id) +
    "&quality=" +
    encodeURIComponent(
      qualityParam
    );

  var result = {
    streamUrl: url
  };

  putCache(
    streamCache,
    cacheKey,
    result,
    MAX_STREAM_CACHE
  );

  return result;
}

/* ---------------------------------------------------------
 * Optional prefetch
 *
 * This ONLY warms the playback endpoint. It does not alter
 * the normal playback result.
 * --------------------------------------------------------- */

function prefetchTrackStreamUrl(
  trackId,
  preferredQuality,
  context
) {
  var result =
    getTrackStreamUrl(
      trackId,
      preferredQuality,
      context
    );

  /*
   * Don't consume the response body.
   * Just initiate the request so the connection/resolver can
   * warm up before the user presses play.
   */

  try {
    fetch(result.streamUrl, {
      method: "GET"
    }).catch(function () {});
  } catch (e) {}

  return result;
}

/* ---------------------------------------------------------
 * Module
 * --------------------------------------------------------- */

return {
  id: "vori-test",
  name: "vori-test",
  author: "alxhlms",
  version: "1.1.0",

  description:
    "if yuo are seeing this can i get a hug please",

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

  prefetchTrackStreamUrl:
    prefetchTrackStreamUrl
};
