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

function normalizeStr(str) {
  return String(str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/* -------------------------------------------------------
 * Fast ISRC Resolver & Preloader
 * ----------------------------------------------------- */

function getOrResolveIsrc(trackId) {
  var id = String(trackId || "").trim();
  if (!id) return Promise.resolve(null);

  if (/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(id)) {
    return Promise.resolve(id);
  }

  var cachedTrack = trackCache.get(id);
  if (cachedTrack && cachedTrack.isrc) {
    return Promise.resolve(cachedTrack.isrc);
  }

  if (isrcPromises.has(id)) return isrcPromises.get(id);

  var promise = (async function () {
    try {
      // 1. If numeric Deezer ID, native lookup is instantaneous
      if (/^\d+$/.test(id)) {
        var res = await fetch(DEEZER_API_BASE + "/track/" + encodeURIComponent(id));
        if (res.ok) {
          var data = await res.json();
          if (data && data.isrc) {
            var isrc = String(data.isrc).trim();
            if (cachedTrack) cachedTrack.isrc = isrc;
            cacheSet(trackCache, isrc, cachedTrack || { id: id, isrc: isrc }, MAX_TRACK_CACHE);
            cacheSet(trackCache, id, Object.assign({}, cachedTrack || { id: id }, { isrc: isrc }), MAX_TRACK_CACHE);
            return isrc;
          }
        }
      }

      // 2. If metadata-only (iTunes fallback)
      if (cachedTrack && cachedTrack.artist && cachedTrack.title) {
        var cleanTitle = cachedTrack.title.replace(/[\(\[].*?[\)\]]/g, "").trim();
        var cleanArtist = cachedTrack.artist.split(/[,&]/)[0].trim();
        var searchRes = await fetch(DEEZER_API_BASE + "/search?q=" + encodeURIComponent(cleanArtist + " " + cleanTitle) + "&limit=5");
        if (searchRes.ok) {
          var sData = await searchRes.json();
          if (sData && Array.isArray(sData.data) && sData.data.length > 0) {
            var dId = sData.data[0].id;
            var tRes = await fetch(DEEZER_API_BASE + "/track/" + encodeURIComponent(dId));
            if (tRes.ok) {
              var tData = await tRes.json();
              if (tData && tData.isrc) {
                var isrcFound = String(tData.isrc).trim();
                cachedTrack.isrc = isrcFound;
                cacheSet(trackCache, isrcFound, cachedTrack, MAX_TRACK_CACHE);
                cacheSet(trackCache, id, cachedTrack, MAX_TRACK_CACHE);
                return isrcFound;
              }
            }
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

function preloadIsrc(trackId) {
  if (!trackId) return;
  getOrResolveIsrc(trackId).catch(function () {});
}

/* -------------------------------------------------------
 * Hybrid Search: Deezer IDs + iTunes Canonical Ranking
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

  var request = (async function () {
    try {
      var itunesUrl = ITUNES_API_BASE + "/search?term=" + encodeURIComponent(query) + "&media=music&entity=song&limit=" + effectiveLimit;
      var deezerUrl = DEEZER_API_BASE + "/search?q=" + encodeURIComponent(query) + "&limit=25";

      // Fire iTunes and Deezer in parallel
      var settled = await Promise.allSettled([
        fetch(itunesUrl).then(function (r) { return r.ok ? r.json() : null; }),
        fetch(deezerUrl).then(function (r) { return r.ok ? r.json() : null; })
      ]);

      var itunesResults = settled[0].status === "fulfilled" && settled[0].value && Array.isArray(settled[0].value.results)
        ? settled[0].value.results
        : [];
      var deezerResults = settled[1].status === "fulfilled" && settled[1].value && Array.isArray(settled[1].value.data)
        ? settled[1].value.data
        : [];

      // Map iTunes canonical ranking for comparison
      var itunesRankMap = new Map();
      for (var i = 0; i < itunesResults.length; i++) {
        var it = itunesResults[i];
        if (it && it.trackName) {
          var itKey = normalizeStr(it.artistName) + ":" + normalizeStr(it.trackName);
          if (!itunesRankMap.has(itKey)) {
            itunesRankMap.set(itKey, i);
          }
        }
      }

      // Re-rank Deezer results based on iTunes canonical studio ranking
      var scoredDeezer = [];
      var queryLower = query.toLowerCase();

      for (var d = 0; d < deezerResults.length; d++) {
        var dz = deezerResults[d];
        if (!dz || !dz.id) continue;

        var score = 100;
        var dzArtistNorm = normalizeStr(dz.artist && dz.artist.name ? dz.artist.name : "");
        var dzTitleNorm = normalizeStr(dz.title || "");
        var dzTitleLower = (dz.title || "").toLowerCase();

        // Bonus if this Deezer track matches an iTunes top canonical result
        for (var entry of itunesRankMap.entries()) {
          var pair = entry[0].split(":");
          var itRank = entry[1];
          if ((dzArtistNorm.includes(pair[0]) || pair[0].includes(dzArtistNorm)) &&
              (dzTitleNorm.includes(pair[1]) || pair[1].includes(dzTitleNorm))) {
            score += 1000 - (itRank * 50);
            break;
          }
        }

        // Penalize remixes, tributes, and karaoke
        if (dzTitleLower.includes("remix") && !queryLower.includes("remix")) score -= 250;
        if (dzTitleLower.includes("karaoke")) score -= 600;
        if (dzTitleLower.includes("tribute") || dzTitleLower.includes("cover")) score -= 400;

        scoredDeezer.push({ score: score, raw: dz });
      }

      // Sort with canonical tracks first
      scoredDeezer.sort(function (a, b) { return b.score - a.score; });

      var tracks = [];
      var count = Math.min(scoredDeezer.length, effectiveLimit);

      for (var k = 0; k < count; k++) {
        var raw = scoredDeezer[k].raw;
        var id = String(raw.id).trim();

        var albumCover = raw.album
          ? (raw.album.cover_xl || raw.album.cover_big || raw.album.cover_medium || null)
          : null;

        var track = {
          id: id, // Native Deezer track ID (guarantees direct ISRC resolution)
          isrc: null,
          title: String(raw.title || raw.title_short || "Unknown Track").trim(),
          artist: raw.artist && typeof raw.artist.name === "string" ? raw.artist.name.trim() : "Unknown Artist",
          album: raw.album && raw.album.title ? raw.album.title.trim() : "",
          albumCover: albumCover,
          duration: Number(raw.duration) || 0,
          trackNumber: Number(raw.track_position || raw.track_number) || 1,
          audioQuality: "LOSSLESS"
        };

        cacheSet(trackCache, id, track, MAX_TRACK_CACHE);
        tracks.push(track);
      }

      // If Deezer had no matches, fall back directly to iTunes tracks
      if (tracks.length === 0 && itunesResults.length > 0) {
        for (var m = 0; m < Math.min(itunesResults.length, effectiveLimit); m++) {
          var item = itunesResults[m];
          var itId = String(item.trackId).trim();
          var itTrack = {
            id: itId,
            isrc: null,
            title: String(item.trackName || "Unknown Track").trim(),
            artist: String(item.artistName || "Unknown Artist").trim(),
            album: String(item.collectionName || "").trim(),
            albumCover: item.artworkUrl100 ? item.artworkUrl100.replace("100x100bb", "600x600bb") : null,
            duration: Math.round((Number(item.trackTimeMillis) || 0) / 1000),
            trackNumber: Number(item.trackNumber) || 1,
            audioQuality: "LOSSLESS"
          };
          cacheSet(trackCache, itId, itTrack, MAX_TRACK_CACHE);
          tracks.push(itTrack);
        }
      }

      // Preload ISRC for Candidate 0 in the background for 0ms playback start
      if (tracks.length > 0) preloadIsrc(tracks[0].id);
      if (tracks.length > 1) {
        setTimeout(function () { preloadIsrc(tracks[1].id); }, 80);
      }

      var result = { tracks: tracks, total: tracks.length };
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
 * Stream Fetchers (Validating streamUrl Presence)
 * ----------------------------------------------------- */

async function fetchFromQobuz(isrc) {
  var url = QOBUZ_WORKER + "/?isrc=" + encodeURIComponent(isrc);
  var res = await fetch(url);
  if (!res.ok) throw new Error("Qobuz HTTP " + res.status);

  var data = await res.json();
  if (!data || !data.streamUrl || typeof data.streamUrl !== "string" || !data.streamUrl.startsWith("http")) {
    throw new Error("Qobuz returned no streamUrl");
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
  if (!data || !data.streamUrl || typeof data.streamUrl !== "string" || !data.streamUrl.startsWith("http")) {
    throw new Error("Deezer returned no streamUrl");
  }

  var rawQuality = String(data.format || data.quality || "").toUpperCase();
  var badge = (rawQuality.includes("320") || rawQuality.includes("MP3_320")) ? "HIGH" : "LOSSLESS";

  return {
    provider: "deezer",
    streamUrl: data.streamUrl.trim(),
    audioQuality: badge,
    title: data.title,
    artist: data.artist,
    album: data.album,
    duration: data.duration
  };
}

/* -------------------------------------------------------
 * Playback Method (Raced with Automatic Fallback)
 * ----------------------------------------------------- */

async function getTrackStreamUrl(trackId, quality, context) {
  var inputId = String(trackId || "").trim();
  if (!inputId) throw new Error("Valid track ID required");

  // 1. Resolve ISRC
  var isrc = null;
  if (/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(inputId)) {
    isrc = inputId;
  } else {
    isrc = await getOrResolveIsrc(inputId);
  }

  if (!isrc) {
    throw new Error("Could not map track to ISRC for: " + inputId);
  }

  // 2. Strict wrappers: reject if streamUrl is missing or invalid
  var qobuzCandidate = fetchFromQobuz(isrc);
  var deezerCandidate = fetchFromDeezer(isrc);

  // 3. Race both: first valid streamUrl wins; if one fails/has no URL, takes the other
  var result = null;
  try {
    result = await Promise.any([qobuzCandidate, deezerCandidate]);
  } catch (err) {
    var details = err instanceof AggregateError
      ? err.errors.map(function (e) { return e.message; }).join(" | ")
      : err.message;
    throw new Error("Both Qobuz and Deezer failed: " + details);
  }

  var track = trackCache.get(inputId);
  var badgeQuality = result.audioQuality || "LOSSLESS";

  return {
    streamUrl: result.streamUrl,
    headers: {
      "Range": "bytes=0-" // Ensures Deezer worker status 206 is compliant with AVPlayer
    },
    track: {
      id: inputId, // Preserves original queue ID
      isrc: isrc,
      title: result.title || (track && track.title) || "",
      artist: result.artist || (track && track.artist) || "",
      album: result.album || (track && track.album) || "",
      albumCover: (track && track.albumCover) || null,
      duration: result.duration || (track && track.duration) || 0,
      audioQuality: badgeQuality, // Displays 'LOSSLESS' or 'HIGH'
      quality: badgeQuality
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
  version: "1.5.2-beta-v4",
  description: "Hybrid iTunes/Deezer Search with Raced Qobuz/Deezer Playback",
  labels: ["FLAC", "LOSSLESS", "HI-RES"],

  searchTracks: searchTracks,
  getTrackStreamUrl: getTrackStreamUrl
};
