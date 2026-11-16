# Browser in a Browser — Render version

A little browser that runs as a website, with tabs and an address bar. Pages
load through a real server-side proxy (`server.js`) with streaming, so heavy
sites load progressively and video can use Range/206 chunk requests.

## What's inside

- `index.html` — the browser UI (tabs, address bar, back/forward/reload,
  new-tab page with search + quick links)
- `server.js` — the server: serves the UI, proxies pages (strips framing
  headers, rewrites links/resources through the proxy, injects a small script
  that shims the browser features heavy apps expect and routes the page's own
  data calls through the proxy with a cookie jar), streams binary/video
- `package.json` — tells Render how to start it (`node server.js`)
- `render.yaml` — one-click Render setup (free web service)

## Deploy on Render (free, no card needed)

Render's free tier needs no credit card. It does need your files in a GitHub
repo — but you can do that in the browser, no terminal, no git.

### 1. Put the files on GitHub

1. Make a free GitHub account at github.com (email signup, no card).
2. Click **+** (top right) → **New repository**. Name it
   `browser-in-a-browser`, leave it Public, click **Create repository**.
3. On the new repo page, click **Add file → Upload files**, then drag in
   these files: `index.html`, `server.js`, `package.json`, `render.yaml`.
4. Click **Commit changes**.

### 2. Deploy on Render

1. Make a free Render account at render.com (email or GitHub signup,
   no card).
2. Dashboard → **New + → Web Service** → **Build and deploy from a Git
   repository** → connect your GitHub and pick the
   `browser-in-a-browser` repo.
3. Render reads `render.yaml` and fills everything in: Runtime Node,
   Build Command `echo "no build step"`, Start Command `node server.js`,
   Instance Type **Free**. (If it asks you to pick a plan, pick **Free**.)
4. Click **Deploy Web Service**. First build takes a couple of minutes.
5. Your link appears at the top, like
   `https://browser-in-a-browser.onrender.com`. That's your browser.

To update it later: upload changed files to the same GitHub repo and Render
redeploys by itself.

## Things to know

- **Free services sleep.** Render spins the server down after 15 minutes
  with no visitors, so the first load after a while takes about 30–60
  seconds to wake up. After that it's fast.
- **YouTube's home feed for a brand-new session is empty** by YouTube's own
  choice — search inside it and you'll get real videos right away, and the
  feed fills in as you watch.
- If a deploy fails, paste the error here and I'll fix it.
