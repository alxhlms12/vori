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

function cacheSet(map, key, value, maxEntries) {
  if (map.has(key)) map.delete(key);
  while (map.size >= maxEntries) {
    map.delete(map.keys().next().value);
  }
  map.set(key, value);
  return value;
}

/* -------------------------------------------------------
 * Metadata Cleaning Helper
 * ----------------------------------------------------- */

function cleanMetadata(artist, title) {
  var cleanTitle = String(title || "")
    .replace(/[\(\[](feat\.|ft\.|with).*?[\)\]]/gi, "")
    .replace(/[\(\[](remastered|remaster|deluxe|bonus|version).*?[\)\]]/gi, "")
    .replace(/-\s*(remastered|single|deluxe|bonus).*$/gi, "")
    .trim();

  // Take primary artist if multiple are listed
  var cleanArtist = String(artist || "")
    .split(/[,&]/)[0]
    .replace(/[\(\[].*?[\)\]]/g, "")
    .trim();

  return { artist: cleanArtist, title: cleanTitle };
}

/* -------------------------------------------------------
 * Layer: iTunes Metadata -> Canonical ISRC Resolution
 * ----------------------------------------------------- */

function resolveIsrcFromMetadata(track) {
  if (!track || !track.id) return Promise.resolve(null);
  if (track.isrc) return Promise.resolve(track.isrc);

  var id = String(track.id).trim();
  if (isrcPromises.has(id)) return isrcPromises.get(id);

  var promise = (async function () {
    var cleaned = cleanMetadata(track.artist, track.title);
    var targetDuration = Number(track.duration) || 0;

    // Strategy 1: Deezer search with Duration Scoring
    try {
      var query = encodeURIComponent(cleaned.artist + " " + cleaned.title);
      var res = await fetch(DEEZER_API_BASE + "/search?q=" + query + "&limit=10");
      if (res.ok) {
        var data = await res.json();
        var candidates = Array.isArray(data.data) ? data.data : [];

        var bestCandidate = null;
        var lowestDiff = 999;

        for (var i = 0; i < candidates.length; i++) {
          var cand = candidates[i];
          var durDiff = Math.abs((Number(cand.duration) || 0) - targetDuration);

          // Find candidate that matches duration within 4 seconds (eliminates remixes)
          if (durDiff <= 4 && durDiff < lowestDiff) {
            lowestDiff = durDiff;
            bestCandidate = cand;
          }
        }

        // If no close duration match, take candidate 0 if available
        if (!bestCandidate && candidates.length > 0) {
          bestCandidate = candidates[0];
        }

        if (bestCandidate && bestCandidate.id) {
          var trackRes = await fetch(DEEZER_API_BASE + "/track/" + encodeURIComponent(bestCandidate.id));
          if (trackRes.ok) {
            var trackData = await trackRes.json();
            if (trackData && trackData.isrc) {
              var foundIsrc = String(trackData.isrc).trim();
              track.isrc = foundIsrc;
              cacheSet(trackCache, foundIsrc, track, MAX_TRACK_CACHE);
              cacheSet(trackCache, id, track, MAX_TRACK_CACHE);
              return foundIsrc;
            }
          }
        }
      }
    } catch (e) {}

    // Strategy 2: MusicBrainz Open ISRC Registry Fallback
    try {
      var mbQuery = 'recording:"' + cleaned.title + '" AND artist:"' + cleaned.artist + '"';
      var mbRes = await fetch("https://musicbrainz.org/ws/2/recording?query=" + encodeURIComponent(mbQuery) + "&fmt=json&limit=3");
      if (mbRes.ok) {
        var mbData = await mbRes.json();
        var recordings = Array.isArray(mbData.recordings) ? mbData.recordings : [];
        for (var j = 0; j < recordings.length; j++) {
          var rec = recordings[j];
          if (rec.isrcs && rec.isrcs.length > 0) {
            var mbIsrc = String(rec.isrcs[0]).trim();
            track.isrc = mbIsrc;
            cacheSet(trackCache, mbIsrc, track, MAX_TRACK_CACHE);
            cacheSet(trackCache, id, track, MAX_TRACK_CACHE);
            return mbIsrc;
          }
        }
      }
    } catch (e) {}

    return null;
  })().finally(function () {
    isrcPromises.delete(id);
  });

  isrcPromises.set(id, promise);
  return promise;
}

/* -------------------------------------------------------
 * Search via iTunes (Top Studio Tracks First)
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

  // Direct ISRC query check
  if (/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(query)) {
    var directTrack = {
      id: query,
      isrc: query,
      title: "Track " + query,
      artist: "Direct ISRC",
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

      // Preload ISRC for Candidate 0 in the background for instant playback
      if (tracks.length > 0) {
        resolveIsrcFromMetadata(tracks[0]);
      }
      if (tracks.length > 1) {
        setTimeout(function () {
          resolveIsrcFromMetadata(tracks[1]);
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
 * Qobuz and Deezer Stream Fetchers
 * ------------------------------------------------------- */

async function fetchFromQobuz(isrc) {
  var url = QOBUZ_WORKER + "/?isrc=" + encodeURIComponent(isrc);
  var res = await fetch(url);
  if (!res.ok) throw new Error("Qobuz HTTP " + res.status);

  var data = await res.json();
  if (!data || !data.streamUrl || typeof data.streamUrl !== "string" || !data.streamUrl.trim()) {
    throw new Error("Qobuz returned no valid streamUrl");
  }

  return {
    provider: "qobuz",
    streamUrl: data.streamUrl.trim(),
    audioQuality: "LOSSLESS", // Strictly LOSSLESS for 8SPINE badge
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
 * Playback Method (Raced with Strict URL Validation)
 * ------------------------------------------------------- */

async function getTrackStreamUrl(trackId, quality, context) {
  var inputId = String(trackId || "").trim();
  if (!inputId) throw new Error("Valid track ID required for playback");

  var track = trackCache.get(inputId);

  // 1. Resolve ISRC via the resolution layer
  var isrc = null;
  if (/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(inputId)) {
    isrc = inputId;
  } else if (track && track.isrc) {
    isrc = track.isrc;
  } else if (context && context.isrc) {
    isrc = context.isrc;
  } else {
    isrc = await resolveIsrcFromMetadata(track);
  }

  if (!isrc) {
    throw new Error("Could not map track to ISRC for: " + (track ? track.title : inputId));
  }

  // 2. Strict Valid-Stream Wrappers (Throws if streamUrl is missing/empty)
  function validQobuz(code) {
    return fetchFromQobuz(code).then(function (res) {
      if (!res || !res.streamUrl || !res.streamUrl.startsWith("http")) {
        throw new Error("Qobuz streamUrl invalid");
      }
      return res;
    });
  }

  function validDeezer(code) {
    return fetchFromDeezer(code).then(function (res) {
      if (!res || !res.streamUrl || !res.streamUrl.startsWith("http")) {
        throw new Error("Deezer streamUrl invalid");
      }
      return res;
    });
  }

  // 3. Race Qobuz and Deezer. Whichever produces a valid streamUrl first wins.
  // If one fails or returns no URL, it rejects and Promise.any automatically takes the other.
  var result = null;
  try {
    result = await Promise.any([
      validQobuz(isrc),
      validDeezer(isrc)
    ]);
  } catch (err) {
    var details = err instanceof AggregateError
      ? err.errors.map(function (e) { return e.message; }).join(" | ")
      : err.message;
    throw new Error("Both Qobuz and Deezer failed: " + details);
  }

  // 4. Return to 8SPINE (Matching the official 8SPINE Module Contract)
  return {
    streamUrl: result.streamUrl,
    track: {
      id: inputId, // Preserves original queue ID
      isrc: isrc,
      title: result.title || (track && track.title) || "",
      artist: result.artist || (track && track.artist) || "",
      album: result.album || (track && track.album) || "",
      albumCover: (track && track.albumCover) || null,
      duration: result.duration || (track && track.duration) || 0,
      audioQuality: result.audioQuality || "LOSSLESS" // Strictly 'LOSSLESS' or 'HIGH' to display the badge
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
  version: "1.5.2-beta-v3",
  description: "Canonical iTunes Search with ISRC Resolution Layer & Raced Playback",
  labels: ["G", "GR", "GRR"],

  searchTracks: searchTracks,
  getTrackStreamUrl: getTrackStreamUrl
};
