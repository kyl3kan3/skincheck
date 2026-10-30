# SkinCheck

**Skin scan → routine check.** A single-page web app built for the YouCam API
Skin AI & eCommerce VTO Hackathon (Perfect Corp, Devpost). Upload or capture
one face photo, get back AI skin scores from the YouCam AI Skin Analysis API,
and see a short, plain-language routine check based on your lowest scores.

Built in the hackathon window (Oct 30 – Nov 2, 2026). Deadline: Mon Nov 2,
2026, 10:45 AM CT.

**Live demo:** https://skincheck-kyl3kan3-6147s-projects.vercel.app

Built for the YouCam API Skin AI & eCommerce VTO Hackathon (Oct 30 – Nov 2, 2026).

What was built in the window:

- Researched the YouCam AI Skin Analysis API (V2 server-to-server flow) and
  confirmed the real response shape against live API calls.
- A single-page app: photo upload/capture → skin analysis → results, rendering
  dynamically from whatever score fields the API actually returns (12 SD
  metrics, overall score, estimated skin age).
- A Vercel serverless proxy (`api/skin.js`) implementing the full async flow
  (file init → pre-signed upload → task create → poll) with the API key kept
  server-side only.
- A rule-based "routine check" that maps the lowest scores to plain-language
  next steps (general information, not medical advice).
- Deployed live on Vercel; verified end to end against the production
  endpoint with a real photo.

## How it works

1. The browser takes a photo (file input with camera capture), downscales it
   to a 1600px long side, and POSTs it as base64 JSON to `/api/skin`.
2. The serverless function (`api/skin.js`) runs the documented YouCam V2
   flow server-side, so the API key never reaches the browser:
   - `POST /s2s/v2.0/file/skin-analysis` → `file_id` + pre-signed upload URL
   - `PUT` the raw image bytes to the pre-signed URL
   - `POST /s2s/v2.0/task/skin-analysis` with SD `dst_actions` → `task_id`
   - `GET /s2s/v2.0/task/skin-analysis/<task_id>` polled until success
     (units are only consumed on success)
3. The UI renders whatever score fields the response actually contains —
   it normalizes both documented shapes (`results.output` array and the
   `score_info` object, including nested HD zone scores), shows each metric
   with its 0–100 score (higher = healthier), plus the overall score and
   estimated skin age when present.
4. A rule-based "next steps" section maps the 2–3 lowest scores to general
   information suggestions. No medical claims, no product efficacy claims.

API research notes with quoted documentation: `../api-notes.md`.

## Project layout

```
index.html    single page (upload → preview → results)
styles.css    all styling, no framework
app.js        photo handling, API calls, dynamic result rendering
api/skin.js   Vercel serverless function (YouCam proxy, key stays server-side)
vercel.json   function maxDuration (the function polls the async task)
```

No build step, no dependencies.

## Run locally

You need the Vercel CLI for the serverless function:

```bash
npm i -g vercel
vercel dev        # serves the page and /api/skin together (run in this folder)
```

Open the local URL Vercel prints (usually http://localhost:3000).

To try the UI without any API key, don't set `YOUCAM_API_KEY` (or set
`MOCK_SKIN=1`): `/api/skin` then returns a clearly labeled mock response in
the documented shape and the page shows a "Demo data" banner.

Serving the folder with a plain static server (e.g. `python3 -m http.server`)
loads the page, but the "Check my skin" call will fail because `/api/skin`
only exists under `vercel dev` or a Vercel deployment.

## Environment variables

| Name | Required | Purpose |
| --- | --- | --- |
| `YOUCAM_API_KEY` | For live mode | YouCam API key from https://yce.makeupar.com/api-console/en/api-keys/ — sent as `Authorization: Bearer <key>`. Server-side only. |
| `YOUCAM_API_SECRET` | No | Not used by the V2 API (auth is the Bearer key only). Accepted in env for forward compatibility. |
| `YOUCAM_API_BASE` | No | Override the API host. Default `https://yce-api-01.makeupar.com`. |
| `MOCK_SKIN` | No | Set to `1` to force mock mode even when a key is present. Mock mode is also automatic when no key is set. |

Registration for the hackathon grants 1,000 free YouCam API units; the key
goes in env (Vercel project settings or a local `.env`), never in the repo —
`.env*` is gitignored.

## Privacy & disclaimer

Photos are sent to Perfect Corp's YouCam API for analysis (their docs state
uploads and results are deleted after 24 hours). SkinCheck itself stores
nothing: no accounts, no database, the photo never leaves the browser tab
except for that one analysis call.

SkinCheck provides general information about how skin appears in a photo.
It is not a medical diagnosis and is not medical advice.
