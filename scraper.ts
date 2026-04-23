/**
 * Scrape the last N posts from the nFactorial School LinkedIn company page.
 *
 * Runs fully headless. Every invocation opens a fresh Chromium context,
 * signs in with LINKEDIN_EMAIL/LINKEDIN_PASSWORD from the environment, loads
 * the company posts feed, and writes posts.json.
 *
 * Run:
 *   npm run scrape               # 10 posts, headless
 *   npm run scrape -- -n 25
 */

import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import dotenv from "dotenv";

dotenv.config();

// ----- Constants -----

const TARGET_SLUG = "nfactorial-school";
const POSTS_URL = `https://www.linkedin.com/company/${TARGET_SLUG}/posts/?feedView=all`;
const LOGIN_URL = "https://www.linkedin.com/login";

const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    + "AppleWebKit/537.36 (KHTML, like Gecko) "
    + "Chrome/131.0.0.0 Safari/537.36";

const POST_SELECTORS = [
    "div.feed-shared-update-v2",
    'div[data-urn^="urn:li:activity:"]',
];

// ----- Types -----

export interface ScrapedImage {
    src: string;
    alt: string;
}
export interface ScrapedPost {
    activity_id: string;
    time: string;
    published_at: string;
    url: string;
    text: string;
    images: ScrapedImage[];
}

// ----- Args -----

interface Args {
    num: number;
    out: string;
    headful: boolean;
}

const STATE_PATH = resolve("linkedin-state.json");

function parseArgs(argv: string[]): Args {
    const out: Args = { num: 10, out: "posts.json", headful: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case "-n":
            case "--num": out.num = Number(argv[++i] ?? 10); break;
            case "-o":
            case "--out": out.out = String(argv[++i]); break;
            case "--headful": out.headful = true; break;
        }
    }
    return out;
}

// ----- Helpers -----

function isLoggedIn(page: Page): boolean {
    const u = page.url();
    if (!u.includes("linkedin.com")) return false;
    return !(
        u.includes("/login")
        || u.includes("/uas/login")
        || u.includes("/authwall")
        || u.includes("/checkpoint")
    );
}

function cleanText(s: string): string {
    return (s ?? "")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

async function firstText(scope: Locator, sel: string): Promise<string> {
    try {
        const loc = scope.locator(sel).first();
        if ((await loc.count()) > 0) {
            return ((await loc.innerText({ timeout: 500 })) ?? "").trim();
        }
    } catch { /* noop */ }
    return "";
}

function activityIdToIso(activityId: string): string {
    if (!/^\d+$/.test(activityId)) return "";
    try {
        const ms = Number(BigInt(activityId) >> 22n);
        return new Date(ms).toISOString();
    } catch { return ""; }
}

async function extractImages(node: Locator): Promise<ScrapedImage[]> {
    const out: ScrapedImage[] = [];
    const seen = new Set<string>();
    let imgs: Locator[] = [];
    try {
        imgs = await node.locator(".update-components-image img").all();
    } catch { return out; }
    for (const img of imgs) {
        let src = "";
        let alt = "";
        try {
            src = (await img.getAttribute("src"))
                ?? (await img.getAttribute("data-delayed-url"))
                ?? "";
            alt = ((await img.getAttribute("alt")) ?? "").trim();
        } catch { continue; }
        if (!src || seen.has(src)) continue;
        seen.add(src);
        if (alt.toLowerCase() === "no alternative text description for this image") alt = "";
        out.push({ src, alt });
    }
    return out;
}

async function scrollToLoad(page: Page, selectors: string[], want: number, maxScrolls = 60): Promise<void> {
    let stagnant = 0;
    let last = 0;
    for (let i = 0; i < maxScrolls; i++) {
        let count = 0;
        for (const sel of selectors) {
            count = await page.locator(sel).count();
            if (count) break;
        }
        if (count >= want) return;
        await page.mouse.wheel(0, 3500);
        await page.waitForTimeout(1200);
        if (count === last) {
            stagnant += 1;
            if (stagnant >= 5) return;
        } else {
            stagnant = 0;
            last = count;
        }
    }
}

async function extractPosts(page: Page, selectors: string[], want: number): Promise<ScrapedPost[]> {
    let nodes: Locator[] = [];
    for (const sel of selectors) {
        nodes = await page.locator(sel).all();
        if (nodes.length) break;
    }

    const out: ScrapedPost[] = [];
    for (const node of nodes.slice(0, want)) {
        let activityId = "";
        try {
            const urn = (await node.getAttribute("data-urn")) ?? "";
            const m = /urn:li:activity:(\d+)/.exec(urn);
            if (m) activityId = m[1]!;
        } catch { /* noop */ }

        const body =
            (await firstText(node, ".update-components-text"))
            || (await firstText(node, ".feed-shared-update-v2__description"))
            || (await firstText(node, ".feed-shared-inline-show-more-text"));

        const sub = await firstText(node, ".update-components-actor__sub-description");
        const timeText = sub ? sub.split("•", 1)[0]!.trim() : "";

        const url = activityId
            ? `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`
            : "";

        out.push({
            activity_id: activityId,
            time: timeText,
            published_at: activityIdToIso(activityId),
            url,
            text: cleanText(body),
            images: await extractImages(node),
        });
    }
    return out;
}

// ----- Login -----

async function signIn(page: Page, email: string, password: string, headful: boolean): Promise<boolean> {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await page.locator('input[name="session_key"], input#username').first().fill(email);
    await page.locator('input[name="session_password"], input#password').first().fill(password);
    await Promise.all([
        page.waitForLoadState("domcontentloaded"),
        page.locator('button[type="submit"], button[aria-label="Sign in"]').first().click(),
    ]);
    // LinkedIn sometimes lands on an intermediate page; give it a moment.
    await page.waitForTimeout(3500);

    // Checkpoint / CAPTCHA — only solvable interactively.
    if (page.url().includes("/checkpoint/")) {
        if (!headful) return false;
        console.error(
            "[!] LinkedIn checkpoint detected. Solve it in the browser window;\n"
            + "    waiting up to 3 minutes for redirect to the feed...",
        );
        try {
            await page.waitForURL((u) => !String(u).includes("/checkpoint/"), { timeout: 180_000 });
        } catch { /* timeout */ }
    }
    return isLoggedIn(page);
}

// ----- Main -----

async function run(args: Args): Promise<number> {
    const hasState = existsSync(STATE_PATH);

    // Credentials only needed when we have no saved session.
    if (!hasState || args.headful) {
        const email = process.env["LINKEDIN_EMAIL"];
        const password = process.env["LINKEDIN_PASSWORD"];
        if (!email || !password) {
            console.error("ERROR: no saved session and LINKEDIN_EMAIL/LINKEDIN_PASSWORD are not set.\n"
                + "       Run `npm run login` once with credentials in .env to create linkedin-state.json.");
            return 2;
        }
    }

    const browser = await chromium.launch({ headless: !args.headful });
    const ctx = await browser.newContext({
        userAgent: UA,
        locale: "en-US",
        viewport: { width: 1366, height: 900 },
        ...(hasState ? { storageState: STATE_PATH } : {}),
    });
    const page = await ctx.newPage();

    try {
        if (!hasState || args.headful) {
            console.error(`[1/4] Signing in (${args.headful ? "headful" : "headless"})...`);
            const ok = await signIn(
                page,
                process.env["LINKEDIN_EMAIL"]!,
                process.env["LINKEDIN_PASSWORD"]!,
                args.headful,
            );
            if (!ok) {
                console.error(
                    `ERROR: sign-in failed, current URL: ${page.url()}\n`
                    + "       LinkedIn served a checkpoint/CAPTCHA for this IP.\n"
                    + "       Run `npm run login` on a machine with a display to solve it,\n"
                    + `       then copy ${STATE_PATH} to this machine.`,
                );
                return 3;
            }
            await ctx.storageState({ path: STATE_PATH });
            console.error(`       saved session -> ${STATE_PATH}`);
        } else {
            console.error("[1/4] Using saved session (skipping login)...");
        }

        console.error(`[2/4] Navigating: ${POSTS_URL}`);
        await page.goto(POSTS_URL, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2500);

        if (!isLoggedIn(page)) {
            console.error(
                `ERROR: saved session is stale (redirected to ${page.url()}).\n`
                + `       Delete ${STATE_PATH} and run \`npm run login\` again.`,
            );
            return 3;
        }

        console.error(`[3/4] Loading (selector: ${POST_SELECTORS[0]})...`);
        await scrollToLoad(page, POST_SELECTORS, args.num);

        console.error("[4/4] Extracting...");
        const posts = await extractPosts(page, POST_SELECTORS, args.num);

        writeFileSync(resolve(args.out), JSON.stringify(posts, null, 2), "utf-8");
        console.error(`Saved ${posts.length} post(s) -> ${args.out}`);
        return posts.length > 0 ? 0 : 4;
    } finally {
        await ctx.close();
        await browser.close();
    }
}

const code = await run(parseArgs(process.argv.slice(2)));
process.exit(code);
