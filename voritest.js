var SEARCH_ENDPOINT = "https://search.alxhlms.workers.dev";
var PLAYBACK_ENDPOINT = "https://playback.alxhlms.workers.dev";

var MAX_SEARCH_CACHE = 100;
var MAX_TRACK_CACHE = 1000;

var searchCache = new Map();
var pendingSearches = new Map();
var trackCache = new Map();

/* -------------------------------------------------------
 * Bounded Cache
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
 * Search Response Extraction
 * ----------------------------------------------------- */

function extractTracks(body) {
  if (!body) return [];

  if (Array.isArray(body)) {
    return body;
  }

  if (Array.isArray(body.tracks)) {
    return body.tracks;
  }

  if (Array.isArray(body.results)) {
    return body.results;
  }

  if (Array.isArray(body.items)) {
    return body.items;
  }

  if (Array.isArray(body.data)) {
    return body.data;
  }

  if (body.data && typeof body.data === "object") {
    if (Array.isArray(body.data.tracks)) {
      return body.data.tracks;
    }

    if (Array.isArray(body.data.results)) {
      return body.data.results;
    }

    if (Array.isArray(body.data.items)) {
      return body.data.items;
    }
  }

  return [];
}

/* -------------------------------------------------------
 * Track Transformation
 * ----------------------------------------------------- */

function transformTrack(raw) {
  raw = raw || {};

  var isrc = String(
    raw.isrc ||
    raw.ISRC ||
    ""
  ).trim();

  var id = isrc || String(
    raw.id ||
    raw.trackId ||
    ""
  ).trim();

  var artist = "Unknown Artist";

  if (typeof raw.artist === "string") {
    artist = raw.artist;
  } else if (
    raw.artist &&
    typeof raw.artist.name === "string"
  ) {
    artist = raw.artist.name;
  } else if (raw.artistName) {
    artist = String(raw.artistName);
  } else if (Array.isArray(raw.artists)) {
    var artists = [];

    for (var i = 0; i < raw.artists.length; i++) {
      var artistItem = raw.artists[i];

      if (typeof artistItem === "string") {
        artists.push(artistItem);
      } else if (
        artistItem &&
        typeof artistItem.name === "string"
      ) {
        artists.push(artistItem.name);
      }
    }

    if (artists.length) {
      artist = artists.join(", ");
    }
  }

  var album = "";

  if (typeof raw.album === "string") {
    album = raw.album;
  } else if (
    raw.album &&
    typeof raw.album.title === "string"
  ) {
    album = raw.album.title;
  } else if (raw.albumName) {
    album = String(raw.albumName);
  }

  var albumCover =
    raw.albumCover ||
    raw.cover ||
    null;

  if (!albumCover && raw.album) {
    albumCover =
      raw.album.cover_xl ||
      raw.album.cover_big ||
      raw.album.cover_medium ||
      raw.album.cover ||
      null;
  }

  var track = {
    id: id,
    isrc: isrc || null,
    title:
      raw.title ||
      raw.name ||
      raw.trackName ||
      raw.title_short ||
      "Unknown Track",

    artist: artist,
    album: album,
    albumCover: albumCover,
    duration: Number(raw.duration) || 0,

    trackNumber:
      raw.trackNumber ||
      raw.track_number ||
      1
  };

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

  if (!query) {
    return {
      tracks: [],
      total: 0
    };
  }

  limit = Number(limit) || 15;

  var cacheKey =
    query.toLowerCase() +
    "|" +
    limit;

  var cached = searchCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  var existingRequest =
    pendingSearches.get(cacheKey);

  if (existingRequest) {
    return existingRequest;
  }

  var requestUrl =
    SEARCH_ENDPOINT +
    "/search?q=" +
    encodeURIComponent(query);

  var request = (async function() {
    try {
      var response = await fetch(requestUrl);

      if (!response.ok) {
        throw new Error(
          "Search failed: HTTP " +
          response.status
        );
      }

      var body = await response.json();

      var rawTracks =
        extractTracks(body);

      var count = Math.min(
        rawTracks.length,
        limit
      );

      var tracks = new Array(count);

      for (var i = 0; i < count; i++) {
        tracks[i] =
          transformTrack(rawTracks[i]);
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
 * The Worker automatically selects the highest
 * available quality.
 *
 * Vori does not attempt to determine or report
 * the actual stream quality.
 * ----------------------------------------------------- */

function getTrackStreamUrl(trackId, quality, context) {
  var isrc = String(trackId || "").trim();

  if (!isrc) {
    throw new Error(
      "Valid ISRC required for playback"
    );
  }

  var track = trackCache.get(isrc);

  return {
    streamUrl:
      PLAYBACK_ENDPOINT +
      "/stream?i=" +
      encodeURIComponent(isrc),

    track: track || {
      id: isrc,
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
  version: "1.2.2",
  description:
    "coming to regular vori sometime idfk",

  searchTracks: searchTracks,
  getTrackStreamUrl: getTrackStreamUrl
};
