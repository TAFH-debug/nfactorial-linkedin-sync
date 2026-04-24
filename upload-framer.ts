/**
 * Push scraped LinkedIn posts (posts.json) straight into a Framer CMS
 * collection via the `framer-api` Server API.
 *
 * Run:
 *   EXAMPLE_PROJECT_URL=https://framer.com/projects/XYZ \
 *   COLLECTION_NAME=Blog \
 *   npm run upload
 *
 * Env:
 *   EXAMPLE_PROJECT_URL  required — the Framer project URL
 *   COLLECTION_NAME      optional — collection name to target  (default: "Blog")
 *   POSTS_JSON           optional — path to the scraped JSON   (default: "./posts.json")
 *   AUTHOR               optional — value for the "Author" field
 *   AUTHOR_PHOTO         optional — URL for the "Author's photo" field
 *   DRAFT                optional — "true" to import as drafts (default: false)
 *   DRY_RUN              optional — "true" to print the payload without uploading
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import {
    connect,
    type FieldDataEntryInput,
    type FieldDataInput,
} from "framer-api";
import dotenv from "dotenv";

dotenv.config();

// ----- Config -----

const projectUrl = process.env["EXAMPLE_PROJECT_URL"];
assert(projectUrl, "EXAMPLE_PROJECT_URL environment variable is required");

const collectionName = process.env["COLLECTION_NAME"] ?? "Blog";
const postsPath = process.env["POSTS_JSON"]
    ?? path.join(__dirname, "posts.json");
const author = process.env["AUTHOR"] ?? "nFactorial School";
const authorPhoto = process.env["AUTHOR_PHOTO"] ?? "";
const draft = (process.env["DRAFT"] ?? "false").toLowerCase() === "true";
const dryRun = (process.env["DRY_RUN"] ?? "").toLowerCase() === "true";

// ----- Types mirroring the JSON produced by scraper.py -----

interface ScrapedImage {
    src: string;
    alt: string;
}
interface ScrapedPost {
    activity_id: string;
    time: string;
    published_at: string;
    url: string;
    text: string;
    images: ScrapedImage[];
}

// ----- Helpers -----

const CYR: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
    и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
    с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh",
    щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
    ә: "a", і: "i", ң: "n", ғ: "g", ү: "u", ұ: "u", қ: "k", ө: "o", һ: "h",
};

function slugify(text: string, maxLen = 80): string {
    const lowered = (text ?? "").trim().toLowerCase();
    let out = "";
    for (const ch of lowered) {
        if (CYR[ch] !== undefined) out += CYR[ch];
        else if (/[a-z0-9]/.test(ch)) out += ch;
        else if (/[\s\-_/]/.test(ch)) out += "-";
    }
    return out.replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, maxLen).replace(/-+$/, "");
}

function firstLine(text: string, maxLen = 140): string {
    for (const line of (text ?? "").split("\n")) {
        const t = line.trim();
        if (t) {
            if (t.length <= maxLen) return t;
            const cut = t.slice(0, maxLen);
            const space = cut.lastIndexOf(" ");
            return (space > 0 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "") + "…";
        }
    }
    return "";
}

function toBodyHtml(text: string): string {
    const paragraphs = (text ?? "")
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => p.replace(/\n/g, "<br>"));
    return `<p dir="auto">${paragraphs.join("<br><br>")}</p>`;
}

/**
 * Cast a raw value to the entry shape that matches the target field's type.
 * The `framer-api` FieldDataEntryInput is a discriminated union keyed by
 * `type`; the set of supported types depends on the collection's schema.
 */
/** Check the string parses as a full URL (so we don't hand Framer `new URL("")`). */
function isValidUrl(s: string): boolean {
    try { new URL(s); return true; }
    catch { return false; }
}

function toEntry(fieldType: string, value: unknown): FieldDataEntryInput | null {
    const s = value == null ? "" : String(value);
    switch (fieldType) {
        case "string":
            return { type: "string", value: s } as FieldDataEntryInput;
        case "formattedText":
            return { type: "formattedText", value: s } as FieldDataEntryInput;
        case "number":
            return { type: "number", value: Number(s) || 0 } as FieldDataEntryInput;
        case "boolean":
            return { type: "boolean", value: /^(true|yes|1)$/i.test(s) } as FieldDataEntryInput;
        case "date":
            // Empty date → null. Framer won't accept an empty string here.
            return { type: "date", value: s ? s.slice(0, 10) : null } as FieldDataEntryInput;
        case "link":
            // Server does `new URL(value)` — empty / non-URL must be null.
            return { type: "link", value: isValidUrl(s) ? s : null } as FieldDataEntryInput;
        case "color":
            return { type: "color", value: s || null } as FieldDataEntryInput;
        case "enum":
            if (!s) return null;
            return { type: "enum", value: s } as FieldDataEntryInput;
        case "image": {
            if (typeof value === "object" && value && "src" in (value as any)) {
                const v = value as ScrapedImage;
                if (!isValidUrl(v.src)) return null;
                return { type: "image", value: v.src, alt: v.alt ?? "" } as FieldDataEntryInput;
            }
            if (!isValidUrl(s)) return null;
            return { type: "image", value: s } as FieldDataEntryInput;
        }
        case "file":
            return { type: "file", value: isValidUrl(s) ? s : null } as FieldDataEntryInput;
        default:
            return { type: "string", value: s } as FieldDataEntryInput;
    }
}

// ----- Data -----

const raw = readFileSync(postsPath, "utf-8");
const posts = JSON.parse(raw) as ScrapedPost[];
assert(Array.isArray(posts), `${postsPath} must contain a JSON array`);

/**
 * Row shape matching the blog3.csv column names. Keep keys aligned exactly
 * with the field names in the Framer collection so we can look each one up
 * by (case-insensitive) name.
 */
interface Row {
    Slug: string;
    "Main image": ScrapedImage | "";
    "Main image:alt": string;
    Name: string;
    Author: string;
    "Post body": string;
    "Author's photo": string;
    "Author's photo:alt": string;
    Date: string;
    Option: string;
    isRecommend: string;
}

const slugsUsed = new Set<string>();
function uniqueSlug(base: string): string {
    let slug = base || "post";
    let i = 1;
    while (slugsUsed.has(slug)) {
        i += 1;
        slug = `${base}-${i}`;
    }
    slugsUsed.add(slug);
    return slug;
}

const rows: Row[] = posts.map((p) => {
    const title = firstLine(p.text);
    const main: ScrapedImage | "" = p.images?.[0] ?? "";
    return {
        Slug: uniqueSlug(slugify(title)),
        "Main image": main,
        "Main image:alt": main ? main.alt : "",
        Name: title,
        Author: author,
        "Post body": toBodyHtml(p.text),
        "Author's photo": authorPhoto,
        "Author's photo:alt": "",
        Date: p.published_at ?? "",
        Option: "Статья",
        isRecommend: "Yes",
    };
});

// ----- Upload -----

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (err: any) {
        console.error(`ERROR at step "${label}":`, err?.code ?? "", err?.message ?? err);
        if (err?.cause) console.error("  cause:", err.cause);
        throw err;
    }
}

async function main() {
    if (dryRun) {
        console.log(JSON.stringify(rows, null, 2));
        console.log(`(dry run) ${rows.length} row(s) prepared; not uploading.`);
        return;
    }

    using framer = await step("connect", () => connect(projectUrl!));

    const collections = await step("getCollections", () => framer.getCollections());
    console.log(
        `Available collections: ${collections.map((c) => `"${c.name}"`).join(", ") || "(none)"}`,
    );
    const collection = collections.find((c) => c.name === collectionName);
    assert(
        collection,
        `Collection "${collectionName}" not found.`,
    );
    console.log(`Target: "${collection.name}" (id=${collection.id})`);

    const fields = await step("getFields", () => collection.getFields());
    const byName = new Map(
        fields.map((f) => [f.name.toLowerCase(), { id: f.id, type: (f as any).type as string, name: f.name }]),
    );
    console.log(
        `Fields: ${[...byName.values()].map((f) => `${f.name}:${f.type}`).join(", ")}`,
    );

    // Warn about row columns we'd lose because the collection has no matching field.
    const unmappedColumns = Object.keys(rows[0] ?? {}).filter(
        (col) => col !== "Slug" && !byName.has(col.toLowerCase()),
    );
    if (unmappedColumns.length) {
        console.log(`WARN: no matching Framer field for: ${unmappedColumns.join(", ")}`);
    }

    const existingItems = await step("getItems (before)", () => collection.getItems());
    console.log(`Items in collection before: ${existingItems.length}`);
    const slugToId = new Map(existingItems.map((it) => [it.slug, it.id]));

    const items = rows.map((row) => {
        const fieldData: FieldDataInput = {};

        for (const [col, raw] of Object.entries(row)) {
            if (col === "Slug") continue;
            const meta = byName.get(col.toLowerCase());
            if (!meta) continue;
            const entry = toEntry(meta.type, raw as unknown);
            if (entry) fieldData[meta.id] = entry;
        }

        return {
            id: slugToId.get(row.Slug),
            slug: row.Slug,
            draft,
            fieldData,
        };
    });

    if ((process.env["DEBUG_PAYLOAD"] ?? "").toLowerCase() === "true") {
        console.log("Payload:", JSON.stringify(items, null, 2));
    }

    await step("addItems", () => collection.addItems(items as any));

    const after = await step("getItems (after)", () => collection.getItems());
    console.log(`Items in collection after:  ${after.length} (delta +${after.length - existingItems.length})`);
    console.log(
        `Uploaded ${items.length} item(s) to "${collection.name}"`
        + ` (merged ${items.filter((i) => i.id).length}, new ${items.filter((i) => !i.id).length}).`,
    );
}

await main();
