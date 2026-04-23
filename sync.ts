/**
 * Single-command pipeline: scrape LinkedIn -> upload to Framer CMS.
 *
 * Mirrors `npm run scrape && npm run upload` but in one process so the
 * scraped posts don't round-trip through disk unnecessarily (they still get
 * written to posts.json as a side effect — useful for debugging).
 */

import { spawnSync } from "node:child_process";

function run(cmd: string, args: string[]): number {
    const res = spawnSync(cmd, args, { stdio: "inherit", shell: true });
    return res.status ?? 1;
}

const forwarded = process.argv.slice(2);

const scrapeCode = run("tsx", ["scraper.ts", ...forwarded]);
if (scrapeCode !== 0) process.exit(scrapeCode);

const uploadCode = run("tsx", ["upload-framer.ts"]);
process.exit(uploadCode);
