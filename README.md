# linkedin-syncer

Scrapes the last N posts from the nFactorial School LinkedIn page and pushes them into a Framer CMS collection — one Node/TypeScript project, one npm command.

```
scraper.ts       → posts.json                (Playwright + LinkedIn)
upload-framer.ts → Framer CMS                (framer-api)
sync.ts          → both in sequence
```

## Setup

```bash
npm install        # postinstall downloads Playwright's Chromium
```

Create `.env` at the project root:

```dotenv
# LinkedIn
LINKEDIN_EMAIL=you@example.com
LINKEDIN_PASSWORD=...

# Framer
EXAMPLE_PROJECT_URL=https://framer.com/projects/YOUR_PROJECT_ID
COLLECTION_NAME=Blog
AUTHOR=Arman Suleimenov
AUTHOR_PHOTO=https://framerusercontent.com/images/ywIXzKc0Z1Q1HQj5SiOxA4N93ho.jpeg
DRAFT=false                # "true" to import as drafts
# SKIP_PUBLISH=true        # uncomment to skip the framer.publish() step
```

## One-time: sign in to LinkedIn

```bash
npm run login
```

Opens a visible browser, auto-fills credentials from `.env`, waits for any 2FA challenge. Cookies persist in `.pw-profile/` so every later run is silent.

## Run it

```bash
npm run sync           # scrape + upload, default 10 posts
npm run sync -- -n 25  # scrape 25 posts then upload
```

Or run the steps separately:

```bash
npm run scrape -- -n 25 --headful   # scrape only, writes posts.json
npm run upload                       # upload posts.json to Framer
```

## Output

`posts.json` — array of:

```json
{
  "activity_id": "7453029612088942592",
  "time": "8m",
  "published_at": "2026-04-23T10:38:50.116Z",
  "url": "https://www.linkedin.com/feed/update/urn:li:activity:7453029612088942592/",
  "text": "Post body…",
  "images": [{ "src": "https://media.licdn.com/…", "alt": "diagram" }]
}
```

## How the Framer side works

- Connects with `framer-api` → finds a collection by `COLLECTION_NAME`.
- Discovers fields at runtime and maps each row column (`Main image`, `Post body`, `Date`, `Option`, …) to the matching field ID, casting values to the field's declared type (`string`, `formattedText`, `image`, `date`, `enum`, …).
- Uses `slug` as primary key — items with the same slug are **updated** in place.
- Calls `framer.publish()` at the end so changes reach the live site.

## Caveats

- `media.licdn.com` image URLs are signed and expire. Framer re-hosts on import; just re-run the pipeline periodically.
- LinkedIn rate-limits anonymous traffic per IP, which is why we always authenticate.
- Row columns with no matching Framer field are dropped with a `WARN:` line — rename the column here or the field in Framer so they line up.

## Legacy

`scraper.py`, `to_framer_csv.py`, `requirements.txt` are the original Python implementation. Safe to delete once the TypeScript flow is verified.
