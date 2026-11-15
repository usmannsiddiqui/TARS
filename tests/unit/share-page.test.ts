import { describe, expect, test } from "vitest";
import { NOT_FOUND_PAGE, escapeHtml, pageResponse, renderSharedPage, tokenHash } from "../../convex/lib/sharePage";

describe("shared page rendering", () => {
  test("token_hash_is_sha256_hex", async () => {
    // FIPS 180-2 test vector for "abc".
    expect(await tokenHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("escapes_every_html_special_character", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });

  test("renders_one_h1_real_paragraphs_and_line_breaks_with_no_markup_from_content", () => {
    const html = renderSharedPage("Pitch <plan>", `<script>alert(1)</script>\nsecond line\n\n\n"><img src=x onerror=alert(1)>`);
    expect(html.startsWith("<!doctype html>\n<html lang=\"en\">")).toBe(true);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain("<h1>Pitch &lt;plan&gt;</h1>");
    expect(html).toContain("<p>&lt;script&gt;alert(1)&lt;/script&gt;<br>second line</p>");
    expect(html).toContain("<p>&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</p>");
    expect(html).not.toMatch(/<script|<img/);
    expect(html).toContain("Shared from TARS · read-only");
    // Only the desktop's studio-grey tokens and the one navy accent; no glow.
    expect(new Set(html.match(/#[0-9a-f]{6}/gi))).toEqual(new Set(["#d6d5d2", "#0b0b0b", "#ffffff", "#1f3460", "#111111", "#393937"]));
    expect(html).not.toMatch(/shadow|orange/i);
  });

  test("not_found_page_names_nothing_from_any_share", () => {
    expect(NOT_FOUND_PAGE).toContain("<h1>");
    expect(NOT_FOUND_PAGE).not.toContain("Shared from TARS");
  });

  test("response_allows_only_the_shipped_style_and_is_never_cached_or_indexed", async () => {
    const response = await pageResponse(200, renderSharedPage("T", "x"));
    const csp = response.headers.get("content-security-policy")!;
    const style = /<style>([\s\S]*?)<\/style>/.exec(await response.text())![1]!;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(style)));
    expect(csp).toBe(
      `default-src 'none'; style-src 'sha256-${btoa(String.fromCharCode(...digest))}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
