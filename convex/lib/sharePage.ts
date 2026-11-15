// The public read-only page for a shared artifact revision. No scripts; every character of user
// content is escaped; the only allowed style is the one inline block below (pinned by its hash).
// Colours are the desktop's studio-grey tokens from apps/desktop/src/renderer/styles.css.
import { contentHash } from "../../packages/domain/src/actions";

/** SHA-256 hex of a share token; only this is stored and looked up. */
export const tokenHash = contentHash;

const STYLE = [
  ":root{color-scheme:light}",
  "body{margin:0;background:#d6d5d2;color:#0b0b0b;font:17px/1.55 \"Helvetica Neue\",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}",
  "main{max-width:38rem;margin:0 auto;padding:32px 16px}",
  "article{background:#ffffff;border-radius:14px;border-top:4px solid #1f3460;padding:24px 20px}",
  "h1{margin:0 0 16px;font-size:1.6rem;line-height:1.2;font-weight:700;color:#111111;overflow-wrap:anywhere}",
  "p{margin:0 0 1em;overflow-wrap:anywhere}",
  "footer{margin-top:16px;font-size:0.85rem;color:#393937}",
].join("");

const ENTITY: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ENTITY[char]!);

const htmlDocument = (title: string, body: string) =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
  `<meta name="robots" content="noindex, nofollow">\n<title>${escapeHtml(title)}</title>\n<style>${STYLE}</style>\n</head>\n` +
  `<body>\n<main>\n${body}\n</main>\n</body>\n</html>\n`;

/** Blank lines separate paragraphs; a single newline is a line break inside one. */
export function renderSharedPage(title: string, text: string): string {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => `<p>${block.split("\n").map(escapeHtml).join("<br>")}</p>`);
  return htmlDocument(
    title,
    `<article>\n<h1>${escapeHtml(title)}</h1>\n${paragraphs.join("\n")}\n</article>\n<footer>Shared from TARS · read-only</footer>`,
  );
}

/** One body for every bad, unknown or stopped link, so none can be told apart. */
export const NOT_FOUND_PAGE = htmlDocument("Not found", "<article>\n<h1>This page is not available</h1>\n<p>The link may be wrong, or sharing was stopped.</p>\n</article>");

export async function pageResponse(status: 200 | 404, html: string): Promise<Response> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(STYLE)));
  const styleHash = btoa(String.fromCharCode(...digest));
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
