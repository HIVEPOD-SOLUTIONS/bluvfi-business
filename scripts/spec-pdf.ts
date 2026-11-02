/**
 * `npm run spec:pdf`: prints docs/bluvfi-business-spec.html to docs/bluvfi-business-spec.pdf with a headless
 * Chromium browser (Edge or Chrome; set BROWSER to its path if neither is found), then sets the PDF's title.
 */
async function main() {
  const { execFileSync } = await import("node:child_process");
  const { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, statSync } = await import("node:fs");
  const { join, resolve } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { pathToFileURL } = await import("node:url");
  const { PDFDocument } = await import("pdf-lib");

  const html = resolve("docs/bluvfi-business-spec.html");
  const out = resolve(process.env.SPEC_PDF_OUT ?? "docs/bluvfi-business-spec.pdf");
  const candidates = [
    process.env.BROWSER,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ].filter((p): p is string => !!p);
  const browser = candidates.find((p) => existsSync(p));
  if (!browser) throw new Error("No Chromium browser found. Set BROWSER to the path of Edge or Chrome.");

  const profile = mkdtempSync(join(tmpdir(), "spec-pdf-"));
  try {
    execFileSync(browser, [
      "--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--user-data-dir=${profile}`,
      `--print-to-pdf=${join(profile, "spec.pdf")}`, pathToFileURL(html).href,
    ], { stdio: "ignore", timeout: 120_000 });
    // On Windows the browser launcher can return before the PDF is written: wait until it exists and stops growing.
    const printed = join(profile, "spec.pdf");
    let last = -1;
    for (let i = 0; i < 120; i++) {
      const size = existsSync(printed) ? statSync(printed).size : -1;
      if (size > 0 && size === last) break;
      last = size;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!existsSync(printed)) throw new Error("The browser did not write the PDF.");
    const doc = await PDFDocument.load(readFileSync(printed));
    doc.setTitle("Bluvfi Business: build spec");
    doc.setSubject("Status update, 2 November 2026");
    // Close the PDF in any viewer first: Windows locks an open file.
    writeFileSync(out, await doc.save());
    console.log(`Wrote ${out} (${doc.getPageCount()} pages)`);
  } finally {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
