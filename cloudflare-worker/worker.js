/**
 * tv-dashboard-notion
 *
 * Cloudflare Worker that proxies a few read-only views of Joe's "Fall
 * Semester 26" Notion workspace so the TV dashboard (a static page on
 * GitHub Pages) can render them without exposing a Notion token to the
 * browser.
 *
 * Routes:
 *   GET /today       -> { classes: [...], work: [...] }   (today only)
 *   GET /assignments -> { items: [...] }                   (Status != Done)
 *   GET /photos      -> { photos: [{ url, width, height, date }] }
 *                       (iCloud Shared Album, public website link)
 *
 * Required secrets (set with `wrangler secret put <NAME>`):
 *   NOTION_TOKEN      - Notion internal integration token
 *   ICLOUD_ALBUM_URL  - iCloud Shared Album public website link
 *                       (either https://www.icloud.com/sharedalbum/#TOKEN or
 *                       https://photos.icloud.com/shared/album/ID)
 *
 * CORS is locked to https://ijoeyburt.github.io
 */

const ALLOWED_ORIGIN = 'https://ijoeyburt.github.io';
const NOTION_VERSION = '2022-06-28';
const NOTION_API = 'https://api.notion.com/v1';

const COURSES_DB_ID = '221b822c-7b58-4f07-a806-1fade0555c97';
const ASSIGNMENTS_DB_ID = '579e9b5e-ea4a-44c4-8a50-cfa3810617ee';
const WORK_SHIFTS_DB_ID = '172cb91e-cc73-459d-abc9-78e7a9fa7c74';

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Module-level cache for the course ID -> name map. Cloudflare keeps an
// isolate warm across requests, so this saves a Notion round trip on most
// invocations. TTL is intentionally short since course names basically
// never change mid-semester, but this keeps things self-healing.
let courseMapCache = { map: null, fetchedAt: 0 };
const COURSE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export default {
    async fetch(request, env) {
          const url = new URL(request.url);

      if (request.method === 'OPTIONS') {
              return withCors(new Response(null, { status: 204 }));
      }

      try {
              if (url.pathname === '/today' && request.method === 'GET') {
                        return withCors(await handleToday(env));
              }
              if (url.pathname === '/assignments' && request.method === 'GET') {
                        return withCors(await handleAssignments(env));
              }
              if (url.pathname === '/photos' && request.method === 'GET') {
                        return withCors(await handlePhotos(env));
              }
              return withCors(jsonResponse({ error: 'Not found' }, 404));
      } catch (err) {
              console.error('Unhandled worker error', err);
              return withCors(jsonResponse({ error: 'Internal error', detail: String(err) }, 500));
      }
    }
};


// ---------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------

async function handleToday(env) {
    const today = new Date();
    const dayAbbr = DAY_ABBR[today.getDay()];
    const todayIso = today.toISOString().slice(0, 10);

  const [coursesRes, shiftsRes] = await Promise.all([
        queryDatabase(env, COURSES_DB_ID, {
                filter: {
                          property: 'Days',
                          rich_text: { contains: dayAbbr }
                }
        }),
        queryDatabase(env, WORK_SHIFTS_DB_ID, {
                filter: {
                          property: 'Date',
                          date: { equals: todayIso }
                }
        })
      ]);

  const classes = coursesRes.map(page => {
        const p = page.properties;
        return {
                name: getTitle(p['Course Name']) || getRichText(p['Code']) || 'Class',
                code: getRichText(p['Code']),
                time: getRichText(p['Time']),
                location: getRichText(p['Location']),
                professor: getRichText(p['Professor']) || getPeopleNames(p['Professor'])
        };
  });

  const work = shiftsRes.map(page => {
        const p = page.properties;
        return {
                name: getTitle(p['Shift']) || 'Shift',
                time: formatShiftTime(getText(p['Start Time']), getText(p['End Time'])),
                location: getRichText(p['Location'])
        };
  });

  return jsonResponse({ classes, work });
}


async function handleAssignments(env) {
    const [results, courseMap] = await Promise.all([
          queryDatabase(env, ASSIGNMENTS_DB_ID, {
                  filter: {
                            property: 'Status',
                            status: { does_not_equal: 'Done' }
                  },
                  sorts: [{ property: 'Due Date', direction: 'ascending' }]
          }).catch(async (err) => {
                  // Fall back in case "Status" is a select property instead of the
                         // native "status" type in this workspace.
                         console.warn('Status filter (status type) failed, retrying as select', err);
                  return queryDatabase(env, ASSIGNMENTS_DB_ID, {
                            filter: {
                                        property: 'Status',
                                        select: { does_not_equal: 'Done' }
                            },
                            sorts: [{ property: 'Due Date', direction: 'ascending' }]
                  });
          }),
          getCourseMap(env)
        ]);

  const items = results.map(page => {
        const p = page.properties;
        const classIds = getRelationIds(p['Class']);
        const className = classIds.map(id => courseMap[id]).filter(Boolean).join(', ');
        return {
                id: page.id,
                name: getTitle(p['Assignment']) || 'Assignment',
                dueDate: getDate(p['Due Date']),
                status: getStatusOrSelect(p['Status']),
                priority: getSelect(p['Priority']),
                type: getSelect(p['Type']),
                className: className || null
        };
  });

  return jsonResponse({ items });
}


// ---------------------------------------------------------------------
// iCloud Shared Album (undocumented public endpoints, two link formats)
//
// Legacy links (www.icloud.com/sharedalbum/#TOKEN) use "sharedstreams":
//   POST /webstream -> photo GUIDs + derivative checksums,
//   POST /webasseturls -> checksum -> signed download URL.
// Newer links (photos.icloud.com/shared/album/ID) are CloudKit "Shared
// Collections": records/resolve gives an anonymous token, partition and
// zone; records/query returns CPLAsset/CPLMaster records whose master
// fields already carry download URLs.
// Signed URLs expire, so results are only cached briefly.
// ---------------------------------------------------------------------

let photoCache = { photos: null, fetchedAt: 0, album: null };
const PHOTO_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CLOUDKIT_CONTAINER = 'com.apple.photos.cloud';
const CLOUDKIT_RESOLVE_HOST = 'https://ckdatabasews.icloud.com';
const MAX_DISPLAY_WIDTH = 2560;

async function handlePhotos(env) {
    const album = env.ICLOUD_ALBUM_URL;
    if (!album) {
          return jsonResponse({ photos: [], error: 'ICLOUD_ALBUM_URL secret is not set on this Worker' });
    }

  const now = Date.now();
    if (photoCache.photos && photoCache.album === album && (now - photoCache.fetchedAt) < PHOTO_CACHE_TTL_MS) {
          return jsonResponse({ photos: photoCache.photos, cached: true });
    }

  const token = parseAlbumToken(album);
    if (!token) throw new Error('Could not parse album token from ICLOUD_ALBUM_URL');

  const isCollection = /photos\.icloud\.com\/shared\/album/i.test(album);
    const photos = isCollection ? await getCollectionPhotos(token) : await getLegacyPhotos(token);

  photoCache = { photos, fetchedAt: now, album };
    return jsonResponse({ photos });
}

// ---- Newer links: CloudKit Shared Collections ----

async function getCollectionPhotos(shareId) {
    const key = encodeURIComponent(shareId);
    const resolved = await cloudKitPost(
          `${CLOUDKIT_RESOLVE_HOST}/database/1/${CLOUDKIT_CONTAINER}/production/public/records/resolve?remapEnums=true&getCurrentSyncToken=true&sharing_url_key=${key}`,
          { shortGUIDs: [{ value: shareId }] }
    );

  const share = (resolved.results || [])[0];
    if (!share) throw new Error('iCloud share lookup returned no result');
    if (share.serverErrorCode) {
          throw new Error(`iCloud could not open the album (${share.serverErrorCode}${share.reason ? ': ' + share.reason : ''})`);
    }
    if (share.requireAppleLogin) throw new Error('Album requires Apple sign-in; turn on public link sharing in Photos');

  const access = share.anonymousPublicAccess || {};
    const partition = access.databasePartition;
    if (!share.zoneID || !access.token || !/^https:\/\/p\d{1,3}-ckdatabasews\.icloud\.com(:443)?\/?$/i.test(partition || '')) {
          throw new Error('iCloud share lookup did not include public access details');
    }

  const queryUrl = `${partition.replace(/\/$/, '')}/database/1/${CLOUDKIT_CONTAINER}/production/shared/records/query`
        + `?remapEnums=true&getCurrentSyncToken=true&sharing_url_key=${key}&publicAccessAuthToken=${encodeURIComponent(access.token)}`;

  const assets = [];
    const masters = {};
    let continuation;
    for (let page = 0; page < 50; page++) {
          const body = {
                  query: {
                            recordType: 'CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted',
                            filterBy: [{ fieldName: 'direction', comparator: 'EQUALS', fieldValue: { value: 'ASCENDING', type: 'STRING' } }]
                  },
                  zoneID: share.zoneID,
                  resultsLimit: 200
          };
          if (continuation) body.continuationMarker = continuation;
          const res = await cloudKitPost(queryUrl, body);
          for (const rec of res.records || []) {
                  if (rec.recordType === 'CPLAsset') assets.push(rec);
                  else if (rec.recordType === 'CPLMaster' && rec.recordName) masters[rec.recordName] = rec;
          }
          continuation = res.continuationMarker;
          if (!continuation) break;
    }

  const photos = [];
    for (const asset of assets) {
          const f = asset.fields || {};
          const masterName = f.masterRef && f.masterRef.value && f.masterRef.value.recordName;
          const master = masterName && masters[masterName];
          if (!master) continue;
          const best = pickCollectionRendition(master.fields || {});
          if (!best) continue;
          const ms = f.assetDate && f.assetDate.value;
          photos.push({
                  url: best.url,
                  width: best.width,
                  height: best.height,
                  date: ms ? new Date(Number(ms)).toISOString() : null
          });
    }
    return photos;
}

// Image renditions are res{Name}Res fields with res{Name}Width/Height.
// Video renditions are skipped. JPEG renditions are preferred because the
// original may be HEIC, which most TV browsers can't display.
function pickCollectionRendition(fields) {
    const options = [];
    for (const [name, field] of Object.entries(fields)) {
          const m = /^res([A-Za-z]+)Res$/.exec(name);
          if (!m || name.includes('Vid') || !field || !field.value) continue;
          const r = m[1];
          const url = field.value.downloadURL && field.value.downloadURL.replace('${f}', 'photo');
          const width = Number(fields[`res${r}Width`] && fields[`res${r}Width`].value) || 0;
          const height = Number(fields[`res${r}Height`] && fields[`res${r}Height`].value) || 0;
          const fileType = String((fields[`res${r}FileType`] && fields[`res${r}FileType`].value) || '');
          if (!url || !width || !height || !/^https:\/\/[^/]*\.(icloud-content|icloud)\.com\//i.test(url)) continue;
          const isJpeg = /jpe?g/i.test(r) || /jpeg/i.test(fileType);
          const isHeic = /heic|heif/i.test(fileType) || (r === 'Original' && !isJpeg);
          options.push({ url, width, height, isJpeg, isHeic });
    }
    if (!options.length) return null;
    const usable = options.filter(o => !o.isHeic);
    const pool = usable.length ? usable : options;
    const fitting = pool.filter(o => o.width <= MAX_DISPLAY_WIDTH);
    const candidates = fitting.length ? fitting : pool;
    candidates.sort((a, b) => (b.isJpeg - a.isJpeg) || (fitting.length ? b.width - a.width : a.width - b.width));
    return candidates[0];
}

async function cloudKitPost(url, body) {
    const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain', Origin: 'https://www.icloud.com' },
          body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`iCloud CloudKit request failed (${res.status}): ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch (_) { throw new Error('iCloud CloudKit response was not JSON'); }
}

// ---- Legacy links: sharedstreams ----

async function getLegacyPhotos(token) {
    // Any partition answers 330 + X-Apple-MMe-Host pointing at the real one.
  let host = 'p01-sharedstreams.icloud.com';
    let stream = await icloudPost(host, token, 'webstream', { streamCtag: null });
    if (stream.redirectHost) {
          host = stream.redirectHost;
          stream = await icloudPost(host, token, 'webstream', { streamCtag: null });
    }
    const photosRaw = (stream.data.photos || []).filter(p => p.mediaAssetType !== 'video');

  const picked = photosRaw.map(p => {
        let best = null;
        for (const d of Object.values(p.derivatives || {})) {
                if (!d || !d.checksum) continue;
                if (!best || Number(d.fileSize || 0) > Number(best.fileSize || 0)) best = d;
        }
        return best ? {
                guid: p.photoGuid,
                checksum: best.checksum,
                width: Number(best.width) || null,
                height: Number(best.height) || null,
                date: p.dateCreated || null
        } : null;
  }).filter(Boolean);

  const urlMap = {};
    for (let i = 0; i < picked.length; i += 25) {
          const guids = picked.slice(i, i + 25).map(p => p.guid);
          const res = await icloudPost(host, token, 'webasseturls', { photoGuids: guids });
          const items = (res.data && res.data.items) || {};
          for (const [checksum, loc] of Object.entries(items)) {
                  if (loc && loc.url_location && loc.url_path) {
                            urlMap[checksum] = `https://${loc.url_location}${loc.url_path}`;
                  }
          }
    }

  return picked
        .filter(p => urlMap[p.checksum])
        .map(p => ({ url: urlMap[p.checksum], width: p.width, height: p.height, date: p.date }));
}

function parseAlbumToken(input) {
    const s = String(input).trim();
    if (s.includes('#')) return s.split('#').pop().split(/[/?;]/)[0] || null;
    if (!s.includes('/')) return s; // raw token
  const parts = s.replace(/[?#].*$/, '').split('/').filter(Boolean);
    return parts.pop() || null;
}

async function icloudPost(host, token, endpoint, body) {
    const res = await fetch(`https://${host}/${token}/sharedstreams/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain', Origin: 'https://www.icloud.com' },
          body: JSON.stringify(body),
          redirect: 'manual'
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { /* non-JSON */ }

  if (res.status === 330) {
        const redirectHost = data['X-Apple-MMe-Host'];
        if (redirectHost) return { data, redirectHost };
  }
    if (!res.ok) {
          throw new Error(`iCloud ${endpoint} failed (${res.status}): ${text.slice(0, 200)}`);
    }
    return { data, redirectHost: null };
}


// ---------------------------------------------------------------------
// Course ID -> name cache (fixes relation-only-returns-IDs gap)
// ---------------------------------------------------------------------

async function getCourseMap(env) {
    const now = Date.now();
    if (courseMapCache.map && (now - courseMapCache.fetchedAt) < COURSE_CACHE_TTL_MS) {
          return courseMapCache.map;
    }

  const pages = await queryDatabase(env, COURSES_DB_ID, {});
    const map = {};
    for (const page of pages) {
          const name = getTitle(page.properties['Course Name']);
          if (name) map[page.id] = name;
    }

  courseMapCache = { map, fetchedAt: now };
    return map;
}

// ---------------------------------------------------------------------
// Notion API helpers
// ---------------------------------------------------------------------

async function queryDatabase(env, databaseId, body) {
    if (!env.NOTION_TOKEN) {
          throw new Error('NOTION_TOKEN secret is not set on this Worker');
    }

  let results = [];
    let cursor = undefined;

  do {
        const payload = { ...body };
        if (cursor) payload.start_cursor = cursor;

        const res = await fetch(`${NOTION_API}/databases/${databaseId}/query`, {
                method: 'POST',
                headers: {
                          Authorization: `Bearer ${env.NOTION_TOKEN}`,
                          'Notion-Version': NOTION_VERSION,
                          'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
        });

        if (!res.ok) {
                const detail = await res.text().catch(() => '');
                throw new Error(`Notion query failed (${res.status}) for db ${databaseId}: ${detail}`);
        }

        const data = await res.json();
        results = results.concat(data.results || []);
        cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return results;
}


// ---------------------------------------------------------------------
// Notion property extractors (defensive -- tolerate property-type drift)
// ---------------------------------------------------------------------

function getTitle(prop) {
    if (!prop || prop.type !== 'title') return null;
    return (prop.title || []).map(t => t.plain_text).join('').trim() || null;
}

function getRichText(prop) {
    if (!prop) return null;
    if (prop.type === 'rich_text') {
          return (prop.rich_text || []).map(t => t.plain_text).join('').trim() || null;
    }
    return null;
}

function getText(prop) {
    // Accepts rich_text, select, or date-as-text properties defensively.
  if (!prop) return null;
    if (prop.type === 'rich_text') return getRichText(prop);
    if (prop.type === 'select') return getSelect(prop);
    if (prop.type === 'date') return getDate(prop);
    return null;
}

function getSelect(prop) {
    if (!prop || prop.type !== 'select') return null;
    return prop.select ? prop.select.name : null;
}

function getStatusOrSelect(prop) {
    if (!prop) return null;
    if (prop.type === 'status') return prop.status ? prop.status.name : null;
    if (prop.type === 'select') return prop.select ? prop.select.name : null;
    return null;
}

function getDate(prop) {
    if (!prop || prop.type !== 'date' || !prop.date) return null;
    return prop.date.start || null;
}

function getRelationIds(prop) {
    if (!prop || prop.type !== 'relation') return [];
    return (prop.relation || []).map(r => r.id);
}

function getPeopleNames(prop) {
    if (!prop || prop.type !== 'people') return null;
    return (prop.people || []).map(p => p.name).filter(Boolean).join(', ') || null;
}

function formatShiftTime(start, end) {
    if (start && end) return `${start} - ${end}`;
    return start || end || '';
}


// ---------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------

function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
          status,
          headers: { 'Content-Type': 'application/json' }
    });
}

function withCors(response) {
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
    return new Response(response.body, { status: response.status, headers });
}
