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
 *
 * Required secret (set with `wrangler secret put NOTION_TOKEN`):
 *   NOTION_TOKEN  - Notion internal integration token
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
