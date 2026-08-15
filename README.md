# TV Dashboard

A single-file dashboard for a spare TV/monitor: clock, Morgantown WV weather, today's classes + work shifts, due/upcoming assignments, and Spotify now-playing. Static site on GitHub Pages, backed by a small Cloudflare Worker that proxies Notion.

## Structure

- `index.html` — the whole dashboard (vanilla JS/CSS, no build step).
- `cloudflare-worker/worker.js` — Notion proxy: `GET /today`, `GET /assignments`.
- `cloudflare-worker/wrangler.toml` — Worker config (`tv-dashboard-notion`).
- `.github/workflows/deploy.yml` — deploys `index.html` to GitHub Pages on every push to `main`.

## One-time setup

### 1. Notion

1. Create (or reuse) a Notion internal integration at [notion.so/my-integrations](https://www.notion.so/my-integrations) and copy its **Internal Integration Token**.
2. Open the "Fall Semester 26" page in Notion → **···** menu → **Connections** → add the integration. This shares the page *and* its three inline databases (Courses, Assignments, Work Shifts) with the integration. Without this step the Worker will return empty results.

### 2. Cloudflare Worker

```bash
cd cloudflare-worker
wrangler login                          # opens a browser to authorize
wrangler secret put NOTION_TOKEN        # paste the integration token when prompted
wrangler deploy
```

Note the resulting `https://tv-dashboard-notion.<your-subdomain>.workers.dev` URL.

### 3. Wire the Worker URL into the dashboard

Edit `index.html`, find `CONFIG.NOTION_WORKER_URL` near the top of the `<script>` block, and set it to the URL from step 2. Commit and push — GitHub Actions redeploys Pages automatically.

### 4. GitHub Pages

Repo → **Settings → Pages → Source → GitHub Actions**. The included workflow (`.github/workflows/deploy.yml`) handles the rest on every push to `main`.

### 5. Spotify

The dashboard uses Spotify's PKCE OAuth flow (no client secret, tokens live in the browser's `localStorage`). In the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), open the app with Client ID `20201eaddf6c44fe88fd51961df40ca2` → **Edit Settings** → **Redirect URIs** → add:

```
https://ijoeyburt.github.io/tv-dashboard/
```

Save. On first load, click **Connect Spotify** on the dashboard and authorize.

## Notion database schema expected by the Worker

- **Courses** (`c7d06355-cfc0-4d98-9e09-100f80777fb7`): Course Name (title), Code, Days (e.g. `Mon, Wed, Fri`), Time, Location, Professor.
- **Assignments** (`39107015-723d-48f6-93f5-77f77ed192ef`): Assignment (title), Due Date, Status, Priority, Type, Class (relation → Courses).
- **Work Shifts** (`f783028e-3527-406c-af0b-0f98380237e6`): Shift (title), Date, Start Time, End Time, Location.

The Worker caches a Course-ID → Course-Name map in memory (10 min TTL) so `/assignments` can resolve the `Class` relation to a readable name instead of leaving it blank.

## Local development

Just open `index.html` in a browser — no build step. To test the Worker locally: `cd cloudflare-worker && wrangler dev`.
