var SEARCH_ENDPOINT = "https://search.alxhlms.workers.dev";
var PLAYBACK_ENDPOINT = "https://playback.alxhlms.workers.dev";

var MAX_SEARCH_CACHE = 100;
var MAX_TRACK_CACHE = 1000;

var searchCache = new Map();
var pendingSearches = new Map();
var trackCache = new Map();

/* -------------------------------------------------------
 * Cache
 * ----------------------------------------------------- */

function cacheSet(map, key, value, max) {
  if (map.has(key)) {
    map.delete(key);
  }

  while (map.size >= max) {
    map.delete(map.keys().next().value);
  }

  map.set(key, value);
  return value;
}

/* -------------------------------------------------------
 * Quality
 *
 * Playback Worker automatically selects the best quality.
 * The quality setting is therefore only metadata for 8SPINE.
 * ----------------------------------------------------- */

var QUALITY_MAP = {
  LOSSLESS: "LOSSLESS",
  FLAC: "LOSSLESS",
  CD: "LOSSLESS",
  "16BIT": "LOSSLESS",
  HIGH: "HIGH",
  AACLC: "HIGH",
  AAC320: "HIGH",
  "320": "HIGH"
};

function normalizeQuality(value) {
  if (!value) return "LOSSLESS";

  var q = String(value).toUpperCase();

  if (QUALITY_MAP[q]) {
    return QUALITY_MAP[q];
  }

  if (q.indexOf("320") !== -1 || q.indexOf("HIGH") !== -1) {
    return "HIGH";
  }

  return "LOSSLESS";
}

function qualityLabel(value) {
  return normalizeQuality(value) === "HIGH"
    ? "AAC 320kbps"
    : "LOSSLESS 16-bit / 44.1 kHz";
}

/* -------------------------------------------------------
 * Response Helpers
 * ----------------------------------------------------- */

function extractTracks(response) {
  if (!response) return [];

  if (Array.isArray(response)) {
    return response;
  }

  if (Array.isArray(response.tracks)) {
    return response.tracks;
  }

  if (Array.isArray(response.results)) {
    return response.results;
  }

  if (Array.isArray(response.items)) {
    return response.items;
  }

  if (Array.isArray(response.data)) {
    return response.data;
  }

  if (response.data) {
    if (Array.isArray(response.data.tracks)) {
      return response.data.tracks;
    }

    if (Array.isArray(response.data.items)) {
      return response.data.items;
    }

    if (Array.isArray(response.data.results)) {
      return response.data.results;
    }
  }

  return [];
}

function getQuality(item) {
  if (!item) return "LOSSLESS";

  var value =
    item.audioQuality ||
    item.quality ||
    item.qualityLabel ||
    item.format ||
    item.audioFormat ||
    item.formatLabel;

  if (!value && item.attributes) {
    value =
      item.attributes.audioQuality ||
      item.attributes.quality ||
      item.attributes.format ||
      item.attributes.audioFormat;
  }

  return normalizeQuality(value);
}

/* -------------------------------------------------------
 * Track Normalization
 * ----------------------------------------------------- */

function normalizeTrack(item, fallbackQuality) {
  item = item || {};

  var isrc = String(
    item.isrc ||
    item.ISRC ||
    ""
  ).trim();

  var id = isrc || String(
    item.id ||
    item.trackId ||
    ""
  ).trim();

  var artist = "Unknown Artist";

  if (typeof item.artist === "string") {
    artist = item.artist;
  } else if (item.artist && item.artist.name) {
    artist = item.artist.name;
  } else if (item.artistName) {
    artist = item.artistName;
  } else if (Array.isArray(item.artists)) {
    var artistNames = [];

    for (var i = 0; i < item.artists.length; i++) {
      var artistItem = item.artists[i];

      if (typeof artistItem === "string") {
        artistNames.push(artistItem);
      } else if (artistItem && artistItem.name) {
        artistNames.push(artistItem.name);
      }
    }

    if (artistNames.length) {
      artist = artistNames.join(", ");
    }
  }

  var album = "";

  if (typeof item.album === "string") {
    album = item.album;
  } else if (item.album && item.album.title) {
    album = item.album.title;
  } else if (item.albumName) {
    album = item.albumName;
  }

  var cover =
    item.albumCover ||
    item.cover ||
    null;

  if (!cover && item.album) {
    cover =
      item.album.cover_xl ||
      item.album.cover_big ||
      item.album.cover_medium ||
      item.album.cover ||
      null;
  }

  var quality = getQuality(item);

  if (!quality) {
    quality = normalizeQuality(fallbackQuality);
  }

  var bits = Number(
    item.bitDepth ||
    (item.audioInfo && item.audioInfo.bitDepth) ||
    (item.attributes && item.attributes.bitDepth) ||
    0
  );

  var sampleRate = Number(
    item.sampleRate ||
    (item.audioInfo && item.audioInfo.sampleRate) ||
    (item.attributes && item.attributes.sampleRate) ||
    0
  );

  if (sampleRate >= 1000) {
    sampleRate /= 1000;
  }

  var track = {
    id: id,
    isrc: isrc || null,
    title:
      item.title ||
      item.name ||
      item.trackName ||
      item.title_short ||
      "Unknown Track",
    artist: artist,
    album: album,
    albumCover: cover,
    duration: Number(item.duration) || 0,
    trackNumber:
      item.trackNumber ||
      item.track_number ||
      1,
    audioQuality: qualityLabel(quality),
    quality: quality
  };

  if (bits > 0) {
    track.bitDepth = bits;
  }

  if (sampleRate > 0) {
    track.sampleRate = sampleRate;
  }

  if (id) {
    cacheSet(
      trackCache,
      id,
      track,
      MAX_TRACK_CACHE
    );
  }

  return track;
}

/* -------------------------------------------------------
 * Search
 * ----------------------------------------------------- */

async function searchTracks(query, limit, context) {
  query = String(query || "").trim();
  limit = Number(limit) || 15;

  if (!query) {
    return {
      tracks: [],
      total: 0
    };
  }

  var requestedQuality =
    context &&
    context.settings &&
    context.settings.audioQuality &&
    context.settings.audioQuality.value;

  requestedQuality = normalizeQuality(
    requestedQuality || "LOSSLESS"
  );

  var cacheKey =
    query.toLowerCase() +
    "|" +
    limit +
    "|" +
    requestedQuality;

  var cached = searchCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  var pending = pendingSearches.get(cacheKey);

  if (pending) {
    return pending;
  }

  var url =
    SEARCH_ENDPOINT +
    "/search?q=" +
    encodeURIComponent(query);

  var request = (async function() {
    try {
      var response = await fetch(url);

      if (!response.ok) {
        throw new Error(
          "Search failed with status " +
          response.status
        );
      }

      var json = await response.json();
      var rawTracks = extractTracks(json);

      var count = Math.min(
        rawTracks.length,
        limit
      );

      var tracks = new Array(count);

      for (var i = 0; i < count; i++) {
        tracks[i] = normalizeTrack(
          rawTracks[i],
          requestedQuality
        );
      }

      var result = {
        tracks: tracks,
        total: count
      };

      cacheSet(
        searchCache,
        cacheKey,
        result,
        MAX_SEARCH_CACHE
      );

      return result;
    } finally {
      pendingSearches.delete(cacheKey);
    }
  })();

  pendingSearches.set(
    cacheKey,
    request
  );

  return request;
}

/* -------------------------------------------------------
 * Playback
 *
 * IMPORTANT:
 * The playback Worker accepts ONLY:
 *
 * /stream?i={ISRC}
 *
 * It automatically selects the best available quality.
 *
 * Do not fetch the Worker here.
 * Do not append a quality parameter.
 * ----------------------------------------------------- */

function getTrackStreamUrl(trackId, quality, context) {
  var isrc = String(trackId || "").trim();

  if (!isrc) {
    throw new Error("Valid ISRC required for playback");
  }

  var cachedTrack = trackCache.get(isrc);

  return {
    streamUrl:
      PLAYBACK_ENDPOINT +
      "/stream?i=" +
      encodeURIComponent(isrc),

    track: cachedTrack || {
      id: isrc,
      isrc: isrc,
      audioQuality: qualityLabel(quality),
      quality: normalizeQuality(quality)
    }
  };
}

/* -------------------------------------------------------
 * Module
 * ----------------------------------------------------- */

return {
  id: "vori-test",
  name: "vori-test",
  author: "alxhlms",
  version: "1.2.1",
  description:
    "@._.alx.",

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
