import puppeteer, { type Page } from "puppeteer";
import http from "http";

// ── Config ──────────────────────────────────────────────────────────────────
const LOGIN_URL =
  "https://www.tds.ms/CentralizeSP/Student/Login/chelmsfordautoschool";

const USERNAME = process.env.TDS_USERNAME!;
const PASSWORD = process.env.TDS_PASSWORD!;

const POLL_INTERVAL_MS = 3 * 60_000;
const MAX_PAGES = 10; // safety cap; actual page count detected dynamically
const MAX_MONTHS_AHEAD = 8; // keep expanding as new months appear; loop breaks when no new slots found

const DISCORD_LOG = process.env.DISCORD_WEBHOOK!;
const DISCORD_ALERT = process.env.DISCORD_WEBHOOK_IMPORTANT!;
const DISCORD_SCAN = process.env.DISCORD_WEBHOOK_SCAN!;

// ── Blackout dates (don't book during these ranges) ─────────────────────────
// Format: [month, startDay, endDay] (month is 1-indexed)
const BLACKOUT_RANGES: [number, number, number][] = [
  [2, 17, 23],  // Feb 17-23
  [4, 18, 27],  // Apr 18-27
];

const MONTH_MAP: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

// ── Types ───────────────────────────────────────────────────────────────────
interface Slot {
  dateText: string;
  instructor: string;
  rowIndex: number;
  page: number;
  monthOffset: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseSlotDate(dateText: string): { dayOfWeek: string; month: number; day: number; hour: number; minute: number } | null {
  const match = dateText.match(
    /^(\w+),\s+(\w+)\s+(\d+),\s+(\d{1,2}):(\d{2})\s+(AM|PM)/
  );
  if (!match) return null;

  const dayOfWeek = match[1];
  const month = MONTH_MAP[match[2]] ?? 0;
  const day = parseInt(match[3], 10);
  let hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  const ampm = match[6];

  if (ampm === "PM" && hour !== 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;

  return { dayOfWeek, month, day, hour, minute };
}

function isBlackedOut(slot: Slot): boolean {
  const parsed = parseSlotDate(slot.dateText);
  if (!parsed) return false;

  for (const [month, startDay, endDay] of BLACKOUT_RANGES) {
    if (parsed.month === month && parsed.day >= startDay && parsed.day <= endDay) {
      return true;
    }
  }
  return false;
}

function isWeekend(dayOfWeek: string): boolean {
  return dayOfWeek === "Sat" || dayOfWeek === "Sun";
}

function isEligible(slot: Slot): { eligible: boolean; pickup: "Home" | "High School" } {
  if (isBlackedOut(slot)) return { eligible: false, pickup: "Home" };

  const parsed = parseSlotDate(slot.dateText);
  if (!parsed) return { eligible: false, pickup: "Home" };

  const { dayOfWeek, hour, minute } = parsed;
  const timeInMinutes = hour * 60 + minute;

  if (isWeekend(dayOfWeek)) {
    return { eligible: true, pickup: "Home" };
  }

  // Weekday: 3:00 PM to 3:30 PM (inclusive) → High School
  if (timeInMinutes >= 15 * 60 && timeInMinutes <= 15 * 60 + 30) {
    return { eligible: true, pickup: "High School" };
  }

  // Weekday: after 3:30 PM → Home
  if (timeInMinutes > 15 * 60 + 30) {
    return { eligible: true, pickup: "Home" };
  }

  return { eligible: false, pickup: "Home" };
}

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: true });
}

function log(msg: string): void {
  console.log(`[${timestamp()}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until the page's main frame is usable (recovers after frame detach). */
async function ensurePageReady(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await page.evaluate(() => document.readyState);
      return;
    } catch {
      log(`Frame not ready (attempt ${attempt + 1}/10), waiting...`);
      await sleep(2000);
    }
  }
  throw new Error("Page frame could not recover after 10 attempts");
}

// ── Discord notifications ──────────────────────────────────────────────────

async function sendDiscord(webhookUrl: string, message: string): Promise<void> {
  if (!webhookUrl) return;

  // Split long messages into chunks at line boundaries
  const chunks: string[] = [];
  if (message.length <= 1900) {
    chunks.push(message);
  } else {
    const lines = message.split("\n");
    let current = "";
    for (const line of lines) {
      if (current.length + line.length + 1 > 1900) {
        chunks.push(current);
        current = line;
      } else {
        current += (current ? "\n" : "") + line;
      }
    }
    if (current) chunks.push(current);
  }

  for (const chunk of chunks) {
    try {
      const resp = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: chunk }),
      });
      if (!resp.ok && resp.status !== 204) {
        log(`Discord send failed: ${resp.status}`);
      }
      if (chunks.length > 1) await sleep(500); // rate limit
    } catch (err) {
      log(`Discord send error: ${err}`);
    }
  }
}

async function notifyLog(message: string): Promise<void> {
  await sendDiscord(DISCORD_LOG, message);
}

async function notifyAlert(message: string): Promise<void> {
  await sendDiscord(DISCORD_ALERT, message);
}

async function notifyScan(message: string): Promise<void> {
  await sendDiscord(DISCORD_SCAN, message);
}

// ── Browser actions ─────────────────────────────────────────────────────────

async function login(page: Page): Promise<void> {
  log("Navigating to login page...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

  await page.waitForSelector("#username", { visible: true, timeout: 15_000 });

  await page.$eval("#username", (el) => ((el as HTMLInputElement).value = ""));
  await page.$eval("#password", (el) => ((el as HTMLInputElement).value = ""));
  await page.type("#username", USERNAME);
  await page.type("#password", PASSWORD);

  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30_000 }),
    page.evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>("button.green-haze");
      if (btn) btn.click();
    }),
  ]);

  log("Logged in successfully.");
}

async function navigateToSchedule(page: Page): Promise<void> {
  // Ensure frame is usable (may be detached after datepicker navigation)
  await ensurePageReady(page);

  const url = "https://www.tds.ms/CentralizeSP/BtwScheduling/Lessons?SchedulingTypeId=-1";
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
  } catch {
    await sleep(3000);
    await ensurePageReady(page);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
  }

  await page.evaluate(() => {
    const links = document.querySelectorAll("a");
    for (const link of links) {
      if (link.textContent?.includes("Schedule My Drive")) {
        link.click();
        return;
      }
    }
  });

  await page.waitForSelector("table tbody tr", { timeout: 15_000 }).catch(() => {
    log("No slots table found (may be empty).");
  });

  await sleep(1000);
}

async function scrapeCurrentPage(page: Page, pageNum: number, monthOff: number = 0): Promise<Slot[]> {
  return page.evaluate((pn, mo) => {
    const rows = document.querySelectorAll("table tbody tr");
    const slots: { dateText: string; instructor: string; rowIndex: number; page: number; monthOffset: number }[] = [];

    rows.forEach((row, idx) => {
      const cells = row.querySelectorAll("td");
      if (cells.length >= 2) {
        const dateText = cells[0]?.textContent?.trim() ?? "";
        const instructor = cells[1]?.textContent?.trim() ?? "";
        if (dateText && /^\w{3},\s+\w{3}\s+\d/.test(dateText)) {
          slots.push({ dateText, instructor, rowIndex: idx, page: pn, monthOffset: mo });
        }
      }
    });

    return slots;
  }, pageNum, monthOff);
}

async function getMaxPage(page: Page): Promise<number> {
  return page.evaluate(() => {
    let maxPage = 1;
    const links = document.querySelectorAll("a");
    for (const link of links) {
      const href = link.href || "";
      const rawHref = link.getAttribute("href") || "";
      if (!href || rawHref.startsWith("javascript:")) continue;

      const pageMatch = href.match(/[?&]page=(\d+)/);
      if (pageMatch) {
        const num = parseInt(pageMatch[1], 10);
        if (num > maxPage) maxPage = num;
      }
    }
    return maxPage;
  });
}

async function goToPage(page: Page, targetPage: number): Promise<boolean> {
  // Strategy 1: DataTables API — switch page without click events
  const dtResult = await page.evaluate((target) => {
    try {
      const jq = (window as any).jQuery;
      if (!jq || !jq.fn?.dataTable) return null;
      // Try multiple selectors for the DataTable
      for (const sel of ["table.dataTable", "#DataTables_Table_0", "table"]) {
        try {
          const dt = jq(sel).DataTable();
          const info = dt.page.info();
          if (info && info.pages > 1) {
            dt.page(target - 1).draw(false);
            return `datatables(${sel})`;
          }
        } catch { /* try next selector */ }
      }
      return null;
    } catch {
      return null;
    }
  }, targetPage);

  if (dtResult) {
    log(`Switched to page ${targetPage} via ${dtResult}`);
    await sleep(500);
    return true;
  }

  // Strategy 2: Navigate via window.location.href (preserves session state unlike page.goto)
  const pageUrl = await page.evaluate((target) => {
    const links = document.querySelectorAll("a");
    for (const link of links) {
      const text = link.textContent?.trim();
      const href = link.getAttribute("href") || "";
      if (text === String(target) && (href.includes("page=") || link.href.includes("page="))) {
        return link.href; // full resolved URL
      }
    }
    return null;
  }, targetPage);

  if (pageUrl) {
    log(`Navigating to page ${targetPage} via window.location.href`);
    try {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15_000 }),
        page.evaluate((url) => { window.location.href = url; }, pageUrl),
      ]);
    } catch {
      await sleep(3000);
      await ensurePageReady(page);
    }
    await sleep(500);
    return true;
  }

  // Strategy 3: Click link + wait for XHR response (AJAX pagination)
  // Set up XHR listener BEFORE clicking so we catch the AJAX response
  const xhrPromise = page.waitForResponse(
    (resp) => resp.url().includes("page=") && resp.request().resourceType() === "xhr",
    { timeout: 8000 },
  ).catch(() => null);

  const clickResult = await page.evaluate((target) => {
    const links = document.querySelectorAll("a");
    for (const link of links) {
      const text = link.textContent?.trim();
      if (text === String(target)) {
        const jq = (window as any).jQuery;
        if (jq) {
          jq(link).trigger("click");
          return "jquery-trigger";
        }
        link.click();
        return "dom-click";
      }
    }
    return null;
  }, targetPage);

  if (!clickResult) {
    log(`No page link found for page ${targetPage}`);
    return false;
  }

  log(`Clicked page ${targetPage} via ${clickResult}`);

  // Wait for AJAX response OR navigation OR timeout
  const xhrResp = await xhrPromise;
  if (xhrResp) {
    log(`  AJAX response for page ${targetPage}: ${xhrResp.status()} (${xhrResp.url().substring(0, 80)})`);
    await sleep(1000); // let DOM update
  } else {
    // Fallback: wait for navigation or just sleep
    await Promise.race([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 5_000 }).catch(() => {}),
      sleep(3000),
    ]);
  }
  await sleep(500);
  return true;
}

async function advanceDatepicker(page: Page): Promise<boolean> {
  // ONLY advances the datepicker by one month. Does NOT click a date cell.
  const clicked = await page.evaluate(() => {
    // Try jQuery UI datepicker next button first (most reliable)
    const selectors = [
      ".ui-datepicker-next:not(.ui-state-disabled)",
      "[data-handler='next']",
      ".datepicker-next",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el) {
        el.click();
        return `selector: ${sel}`;
      }
    }

    // Fallback: ">" link that is NOT a pagination link (no "page=" in href)
    const els = document.querySelectorAll("a, span, button");
    for (const el of els) {
      const text = el.textContent?.trim() || "";
      const href = (el as HTMLAnchorElement).getAttribute?.("href") || "";
      if ((text === ">" || text === "›" || text === "»") && !href.includes("page=")) {
        (el as HTMLElement).click();
        return `text: "${text}"`;
      }
    }
    return null;
  });

  if (!clicked) return false;
  log(`Advanced datepicker via ${clicked}`);
  await sleep(2000);
  return true;
}

async function clickDateInDatepicker(page: Page): Promise<boolean> {
  // Check if a date cell exists before clicking
  const hasDate = await page.evaluate(() => {
    const cells = document.querySelectorAll(
      ".ui-datepicker td:not(.ui-state-disabled) a, .datepicker td:not(.disabled) a"
    );
    return cells.length > 0;
  });

  if (!hasDate) {
    log("No available date cell found in datepicker.");
    return false;
  }

  // Use Promise.all to properly track the navigation triggered by the date click.
  // This prevents "detached frame" errors by ensuring waitForNavigation is set up
  // BEFORE the click fires.
  try {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15_000 }),
      page.evaluate(() => {
        const cells = document.querySelectorAll(
          ".ui-datepicker td:not(.ui-state-disabled) a, .datepicker td:not(.disabled) a"
        );
        if (cells.length > 0) {
          (cells[cells.length - 1] as HTMLElement).click();
        }
      }),
    ]);
  } catch {
    // Navigation may have detached the frame — wait for recovery
    await sleep(3000);
    try {
      await ensurePageReady(page);
    } catch {
      log("Frame recovery failed after datepicker click, will retry via navigateToSchedule.");
      return true; // Return true so the caller tries to scrape (navigateToSchedule will handle recovery)
    }
  }

  try {
    await page.waitForSelector("table tbody tr", { timeout: 15_000 });
  } catch {
    log("No slots table after clicking date in datepicker.");
  }
  await sleep(1000);
  return true;
}

async function scrapeAllSlots(page: Page): Promise<Slot[]> {
  const seen = new Set<string>();
  const allSlots: Slot[] = [];

  function addSlots(slots: Slot[]) {
    let newCount = 0;
    for (const slot of slots) {
      const key = `${slot.dateText}|${slot.instructor}`;
      if (!seen.has(key)) {
        seen.add(key);
        allSlots.push(slot);
        newCount++;
      }
    }
    return newCount;
  }

  // Summarize which months appear in a set of slots
  function monthSummary(slots: Slot[]): string {
    const byMonth: Record<string, number> = {};
    for (const s of slots) {
      const parsed = parseSlotDate(s.dateText);
      const name = parsed ? (Object.entries(MONTH_MAP).find(([, v]) => v === parsed.month)?.[0] ?? "?") : "?";
      byMonth[name] = (byMonth[name] || 0) + 1;
    }
    return Object.entries(byMonth).map(([m, c]) => `${m}:${c}`).join(" ");
  }

  // Helper: scrape all pages in the current table view.
  // Tries multiple strategies in order (A-E), falls back to page-by-page as last resort (F).
  async function scrapeAllPages(label: string, monthOff: number): Promise<number> {
    let totalNew = 0;

    // ── Diagnostic: log page state before trying strategies ──────────────
    const pageDiag = await page.evaluate(() => {
      const links = document.querySelectorAll("a");
      const pageLinks: string[] = [];
      for (const link of links) {
        const text = link.textContent?.trim() || "";
        const href = link.getAttribute("href") || "";
        if (/^\d+$/.test(text) || text === ">" || text === "<" || href.includes("page=")) {
          pageLinks.push(`"${text}" href="${href.substring(0, 80)}"`);
        }
      }
      const hasJquery = typeof (window as any).jQuery !== "undefined";
      const hasDtPlugin = hasJquery && !!(window as any).jQuery.fn?.dataTable;
      const tableCount = document.querySelectorAll("table").length;
      const tbodyRows = document.querySelectorAll("table tbody tr").length;
      const allTrs = document.querySelectorAll("table tr").length;
      const selects = Array.from(document.querySelectorAll("select")).map(s => ({
        id: s.id, name: s.name, className: s.className,
        options: Array.from(s.options).map(o => o.value),
      }));
      const currentUrl = window.location.href;
      return { pageLinks, hasJquery, hasDtPlugin, tableCount, tbodyRows, allTrs, selects, currentUrl };
    });

    log(`${label}: jQuery:${pageDiag.hasJquery} DT-plugin:${pageDiag.hasDtPlugin} tables:${pageDiag.tableCount} visibleRows:${pageDiag.tbodyRows} allTrs:${pageDiag.allTrs}`);
    log(`${label}: selects: ${pageDiag.selects.length > 0 ? JSON.stringify(pageDiag.selects) : "none"}`);
    log(`${label}: page links: ${pageDiag.pageLinks.join(", ") || "none"}`);
    log(`${label}: URL: ${pageDiag.currentUrl}`);

    // ═══════════════════════════════════════════════════════════════════════
    // STRATEGY A: Show all rows via page length / "show entries" dropdown
    // ═══════════════════════════════════════════════════════════════════════
    try {
      log(`${label} [Strategy A]: Attempting page length manipulation...`);
      const stratAResult = await page.evaluate((mo) => {
        const diag: string[] = [];
        try {
          // Look for any <select> that might control page length
          const selects = document.querySelectorAll("select");
          let lengthSelect: HTMLSelectElement | null = null;
          for (const sel of selects) {
            const id = sel.id.toLowerCase();
            const name = sel.name.toLowerCase();
            const cls = sel.className.toLowerCase();
            const parent = sel.closest("div,label,span")?.textContent?.toLowerCase() || "";
            diag.push(`select id="${sel.id}" name="${sel.name}" class="${sel.className}" opts=[${Array.from(sel.options).map(o=>o.value).join(",")}]`);
            if (
              id.includes("length") || id.includes("pagesize") || id.includes("pagelength") ||
              name.includes("length") || name.includes("pagesize") || name.includes("pagelength") ||
              cls.includes("length") || cls.includes("pagesize") ||
              parent.includes("show") || parent.includes("entries") || parent.includes("per page")
            ) {
              lengthSelect = sel;
              diag.push(`=> matched as length control`);
              break;
            }
          }

          // Also try DataTables length select (common pattern: select[name$="_length"])
          if (!lengthSelect) {
            const dtLenSel = document.querySelector('select[name$="_length"]') as HTMLSelectElement | null;
            if (dtLenSel) {
              lengthSelect = dtLenSel;
              diag.push(`=> found DT length select: name="${dtLenSel.name}"`);
            }
          }

          // Also try: .dataTables_length select
          if (!lengthSelect) {
            const dtLenSel2 = document.querySelector('.dataTables_length select') as HTMLSelectElement | null;
            if (dtLenSel2) {
              lengthSelect = dtLenSel2;
              diag.push(`=> found .dataTables_length select`);
            }
          }

          if (!lengthSelect) {
            return { success: false, diag, reason: "no length select found" };
          }

          // Try to set value to -1 (show all) or the highest numeric option
          const options = Array.from(lengthSelect.options).map(o => o.value);
          let targetValue = "-1"; // "show all" in many table libraries
          if (!options.includes("-1")) {
            // Pick the largest numeric option
            const numericOpts = options.map(Number).filter(n => !isNaN(n) && n > 0);
            if (numericOpts.length > 0) {
              targetValue = String(Math.max(...numericOpts));
            } else {
              return { success: false, diag, reason: `no usable option values: [${options.join(",")}]` };
            }
          }

          diag.push(`setting length select to "${targetValue}"`);
          lengthSelect.value = targetValue;
          lengthSelect.dispatchEvent(new Event("change", { bubbles: true }));

          // Also try jQuery trigger if available
          const jq = (window as any).jQuery;
          if (jq) {
            jq(lengthSelect).trigger("change");
            diag.push("also triggered via jQuery");
          }

          return { success: true, diag, targetValue };
        } catch (e: any) {
          return { success: false, diag, reason: `error: ${e?.message ?? String(e)}` };
        }
      }, monthOff);

      log(`${label} [Strategy A]: ${stratAResult.success ? "set length to " + stratAResult.targetValue : stratAResult.reason}`);
      if (stratAResult.diag.length > 0) log(`${label} [Strategy A] diag: ${stratAResult.diag.join(" | ")}`);

      if (stratAResult.success) {
        await sleep(2000); // wait for table to re-render

        const rows = await scrapeCurrentPage(page, 1, monthOff);
        log(`${label} [Strategy A]: scraped ${rows.length} rows after length change`);

        if (rows.length > pageDiag.tbodyRows) {
          totalNew = addSlots(rows);
          log(`${label} [Strategy A] SUCCESS: got ${rows.length} rows (was ${pageDiag.tbodyRows}), ${totalNew} new [${monthSummary(rows)}]`);
          log(`${label} done: ${totalNew} new, ${allSlots.length} unique overall`);
          return totalNew;
        } else {
          log(`${label} [Strategy A]: row count didn't increase (${rows.length} vs ${pageDiag.tbodyRows}), trying next strategy`);
        }
      }
    } catch (err) {
      log(`${label} [Strategy A] error: ${err}`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STRATEGY B: Scrape ALL DOM rows regardless of visibility (CSS hidden)
    // ═══════════════════════════════════════════════════════════════════════
    try {
      log(`${label} [Strategy B]: Scraping all DOM rows (including hidden)...`);
      const stratBResult = await page.evaluate((mo) => {
        const diag: string[] = [];
        try {
          const tables = document.querySelectorAll("table");
          diag.push(`found ${tables.length} tables`);
          const allRows: { dateText: string; instructor: string; rowIndex: number; page: number; monthOffset: number }[] = [];
          let visibleCount = 0;
          let hiddenCount = 0;

          for (let t = 0; t < tables.length; t++) {
            const trs = tables[t].querySelectorAll("tbody tr");
            diag.push(`table[${t}]: ${trs.length} tbody trs`);
            trs.forEach((row, idx) => {
              const cells = row.querySelectorAll("td");
              if (cells.length >= 2) {
                const dateText = cells[0]?.textContent?.trim() ?? "";
                const instructor = cells[1]?.textContent?.trim() ?? "";
                if (dateText && /^\w{3},\s+\w{3}\s+\d/.test(dateText)) {
                  const style = window.getComputedStyle(row);
                  const isVisible = style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
                  allRows.push({ dateText, instructor, rowIndex: idx, page: 1, monthOffset: mo });
                  if (isVisible) visibleCount++;
                  else hiddenCount++;
                }
              }
            });
          }

          diag.push(`total slot rows: ${allRows.length} (${visibleCount} visible, ${hiddenCount} hidden)`);
          return { rows: allRows, visibleCount, hiddenCount, diag };
        } catch (e: any) {
          return { rows: [] as any[], visibleCount: 0, hiddenCount: 0, diag: [...diag, `error: ${e?.message ?? String(e)}`] };
        }
      }, monthOff);

      log(`${label} [Strategy B]: ${stratBResult.rows.length} total DOM rows (${stratBResult.visibleCount} visible, ${stratBResult.hiddenCount} hidden)`);
      if (stratBResult.diag.length > 0) log(`${label} [Strategy B] diag: ${stratBResult.diag.join(" | ")}`);

      if (stratBResult.rows.length > pageDiag.tbodyRows && stratBResult.hiddenCount > 0) {
        // There ARE hidden rows — the pagination is CSS-based! Grab them all.
        totalNew = addSlots(stratBResult.rows);
        log(`${label} [Strategy B] SUCCESS: got ${stratBResult.rows.length} rows from DOM (${stratBResult.hiddenCount} were hidden), ${totalNew} new [${monthSummary(stratBResult.rows)}]`);
        log(`${label} done: ${totalNew} new, ${allSlots.length} unique overall`);
        return totalNew;
      } else {
        log(`${label} [Strategy B]: no hidden rows found (pagination is server-side or AJAX-based)`);
      }
    } catch (err) {
      log(`${label} [Strategy B] error: ${err}`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STRATEGY C: URL parameter manipulation (in-page navigation)
    // ═══════════════════════════════════════════════════════════════════════
    try {
      log(`${label} [Strategy C]: Trying URL parameter manipulation...`);
      const currentUrl = pageDiag.currentUrl;
      // Try multiple parameter names for "show all" / large page size
      const paramAttempts = [
        { param: "length", value: "200" },
        { param: "length", value: "-1" },
        { param: "pageSize", value: "200" },
        { param: "iDisplayLength", value: "200" },
        { param: "per_page", value: "200" },
        { param: "page_size", value: "200" },
      ];

      for (const { param, value } of paramAttempts) {
        try {
          // Build the new URL
          const newUrl = await page.evaluate((baseUrl, p, v) => {
            const url = new URL(baseUrl);
            url.searchParams.set(p, v);
            // Also remove page= param so we get the first (full) page
            url.searchParams.delete("page");
            return url.toString();
          }, currentUrl, param, value);

          log(`${label} [Strategy C]: trying ${param}=${value} ...`);

          // Use window.location.href to preserve session state
          try {
            await Promise.all([
              page.waitForNavigation({ waitUntil: "networkidle2", timeout: 10_000 }),
              page.evaluate((url) => { window.location.href = url; }, newUrl),
            ]);
          } catch {
            await sleep(3000);
            await ensurePageReady(page);
          }

          await sleep(1000);

          const rows = await scrapeCurrentPage(page, 1, monthOff);
          log(`${label} [Strategy C] ${param}=${value}: got ${rows.length} rows`);

          if (rows.length > pageDiag.tbodyRows) {
            totalNew = addSlots(rows);
            log(`${label} [Strategy C] SUCCESS with ${param}=${value}: ${rows.length} rows (was ${pageDiag.tbodyRows}), ${totalNew} new [${monthSummary(rows)}]`);
            log(`${label} done: ${totalNew} new, ${allSlots.length} unique overall`);
            return totalNew;
          }
        } catch (err) {
          log(`${label} [Strategy C] ${param}=${value} error: ${err}`);
        }
      }

      // After Strategy C attempts, we may have navigated away. Go back to the original URL.
      log(`${label} [Strategy C]: no parameter worked, restoring original URL...`);
      try {
        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle2", timeout: 10_000 }),
          page.evaluate((url) => { window.location.href = url; }, currentUrl),
        ]);
      } catch {
        await sleep(3000);
        await ensurePageReady(page);
      }
      await sleep(1000);
    } catch (err) {
      log(`${label} [Strategy C] error: ${err}`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STRATEGY D: DataTables API — extract all rows across pages in one shot
    // (Also tries dt.rows().data() to bypass pagination entirely)
    // ═══════════════════════════════════════════════════════════════════════
    try {
      log(`${label} [Strategy D]: Trying DataTables API...`);
      const dtResult = await page.evaluate((mo) => {
        try {
          const jq = (window as any).jQuery;
          if (!jq) return { method: "no-jquery" as const };
          if (!jq.fn?.dataTable) return { method: "no-datatables-plugin" as const };

          const selectors = ["table.dataTable", "#DataTables_Table_0", ".table", "table"];

          // Attempt 1: page-iterate approach
          for (const sel of selectors) {
            try {
              const $table = jq(sel);
              if (!$table.length) continue;
              const dt = $table.DataTable();
              const info = dt.page.info();
              if (!info || info.pages <= 0) continue;

              const allRows: { dateText: string; instructor: string; rowIndex: number; page: number; monthOffset: number }[] = [];
              const origPage = info.page;

              for (let p = 0; p < info.pages; p++) {
                dt.page(p).draw(false);
                const rows = document.querySelectorAll("table tbody tr");
                rows.forEach((row, idx) => {
                  const cells = row.querySelectorAll("td");
                  if (cells.length >= 2) {
                    const dateText = cells[0]?.textContent?.trim() ?? "";
                    const instructor = cells[1]?.textContent?.trim() ?? "";
                    if (dateText && /^\w{3},\s+\w{3}\s+\d/.test(dateText)) {
                      allRows.push({ dateText, instructor, rowIndex: idx, page: p + 1, monthOffset: mo });
                    }
                  }
                });
              }

              dt.page(origPage).draw(false);
              return { method: "datatables" as const, selector: sel, rows: allRows, pages: info.pages, recordsTotal: info.recordsTotal };
            } catch { /* try next selector */ }
          }

          // Attempt 2: dt.rows().data() to get ALL rows regardless of pagination
          for (const sel of selectors) {
            try {
              const $table = jq(sel);
              if (!$table.length) continue;
              const dt = $table.DataTable();
              const allData = dt.rows().data();
              if (allData && allData.length > 0) {
                const allRows: { dateText: string; instructor: string; rowIndex: number; page: number; monthOffset: number }[] = [];
                const tmp = document.createElement("div");
                for (let i = 0; i < allData.length; i++) {
                  const rowData = allData[i];
                  let dateText = "";
                  let instructor = "";
                  if (Array.isArray(rowData)) {
                    tmp.innerHTML = String(rowData[0] || "");
                    dateText = tmp.textContent?.trim() ?? "";
                    tmp.innerHTML = String(rowData[1] || "");
                    instructor = tmp.textContent?.trim() ?? "";
                  } else if (rowData && typeof rowData === "object") {
                    const vals = Object.values(rowData);
                    tmp.innerHTML = String(vals[0] || "");
                    dateText = tmp.textContent?.trim() ?? "";
                    tmp.innerHTML = String(vals[1] || "");
                    instructor = tmp.textContent?.trim() ?? "";
                  }
                  if (dateText && /^\w{3},\s+\w{3}\s+\d/.test(dateText)) {
                    allRows.push({ dateText, instructor, rowIndex: i, page: 1, monthOffset: mo });
                  }
                }
                if (allRows.length > 0) {
                  return { method: "dt-rows-data" as const, selector: sel, rows: allRows, pages: 0, recordsTotal: allData.length };
                }
              }
            } catch { /* try next selector */ }
          }

          return { method: "dt-no-match" as const };
        } catch (e: any) {
          return { method: "dt-error" as const, error: e?.message ?? String(e) };
        }
      }, monthOff);

      log(`${label} [Strategy D]: method=${dtResult.method}${"error" in dtResult ? ` error=${(dtResult as any).error}` : ""}`);

      if ((dtResult.method === "datatables" || dtResult.method === "dt-rows-data") && "rows" in dtResult && dtResult.rows!.length > 0) {
        totalNew = addSlots(dtResult.rows!);
        log(`${label} [Strategy D] SUCCESS via ${dtResult.method} (${(dtResult as any).selector}): ${dtResult.rows!.length} rows across ${(dtResult as any).pages} pages, ${totalNew} new [${monthSummary(dtResult.rows!)}]`);
        log(`${label} done: ${totalNew} new, ${allSlots.length} unique overall`);
        return totalNew;
      }
    } catch (err) {
      log(`${label} [Strategy D] error: ${err}`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STRATEGY E: Intercept AJAX — find the data source URL and fetch all
    // ═══════════════════════════════════════════════════════════════════════
    try {
      log(`${label} [Strategy E]: Trying to find and call AJAX data source...`);
      const ajaxResult = await page.evaluate((mo) => {
        const diag: string[] = [];
        try {
          const jq = (window as any).jQuery;
          if (!jq) return { success: false, diag: ["no jQuery"], rows: [] as any[], ajaxUrl: null as string | null };

          // Check if DataTable has an ajax URL configured
          const selectors = ["table.dataTable", "#DataTables_Table_0", ".table", "table"];
          for (const sel of selectors) {
            try {
              const $table = jq(sel);
              if (!$table.length) continue;
              const dt = $table.DataTable();
              const ajaxUrl = dt.ajax?.url?.();
              if (ajaxUrl) {
                diag.push(`DT ajax URL: ${ajaxUrl}`);
                return { success: false, diag, rows: [] as any[], ajaxUrl };
              }
              const settings = dt.settings?.()?.[0];
              if (settings) {
                const sAjax = settings.sAjaxSource || settings.ajax?.url || settings.ajax;
                if (typeof sAjax === "string") {
                  diag.push(`DT settings ajax: ${sAjax}`);
                  return { success: false, diag, rows: [] as any[], ajaxUrl: sAjax };
                }
                if (sAjax && typeof sAjax === "object" && sAjax.url) {
                  diag.push(`DT settings ajax.url: ${sAjax.url}`);
                  return { success: false, diag, rows: [] as any[], ajaxUrl: sAjax.url };
                }
              }
            } catch { /* next */ }
          }

          diag.push("no DT ajax URL found");
          return { success: false, diag, rows: [] as any[], ajaxUrl: null as string | null };
        } catch (e: any) {
          return { success: false, diag: [...diag, `error: ${e?.message ?? String(e)}`], rows: [] as any[], ajaxUrl: null as string | null };
        }
      }, monthOff);

      if (ajaxResult.diag.length > 0) log(`${label} [Strategy E] diag: ${ajaxResult.diag.join(" | ")}`);

      // If we found an AJAX URL, try fetching it with a large page size
      if (ajaxResult.ajaxUrl) {
        const ajaxUrl = ajaxResult.ajaxUrl;
        log(`${label} [Strategy E]: found ajax URL: ${ajaxUrl}, attempting fetch with large length...`);

        const fetchResult = await page.evaluate(async (baseAjaxUrl, mo) => {
          try {
            const url = new URL(baseAjaxUrl, window.location.origin);
            url.searchParams.set("length", "200");
            url.searchParams.set("iDisplayLength", "200");
            url.searchParams.set("start", "0");
            url.searchParams.set("iDisplayStart", "0");

            const resp = await fetch(url.toString(), {
              credentials: "include",
              headers: { "X-Requested-With": "XMLHttpRequest" },
            });
            if (!resp.ok) return { success: false as const, reason: `HTTP ${resp.status}` };

            const data = await resp.json();
            // DataTables server-side returns { data: [...], recordsTotal, recordsFiltered }
            const rowsArray = data.data || data.aaData || data.rows || data;
            if (!Array.isArray(rowsArray)) return { success: false as const, reason: "response not array", keys: Object.keys(data) };

            const allRows: { dateText: string; instructor: string; rowIndex: number; page: number; monthOffset: number }[] = [];
            const tmp = document.createElement("div");
            for (let i = 0; i < rowsArray.length; i++) {
              const row = rowsArray[i];
              let dateText = "";
              let instructor = "";
              if (Array.isArray(row)) {
                tmp.innerHTML = String(row[0] || "");
                dateText = tmp.textContent?.trim() ?? "";
                tmp.innerHTML = String(row[1] || "");
                instructor = tmp.textContent?.trim() ?? "";
              } else if (row && typeof row === "object") {
                const vals = Object.values(row);
                tmp.innerHTML = String(vals[0] || "");
                dateText = tmp.textContent?.trim() ?? "";
                tmp.innerHTML = String(vals[1] || "");
                instructor = tmp.textContent?.trim() ?? "";
              }
              if (dateText && /^\w{3},\s+\w{3}\s+\d/.test(dateText)) {
                allRows.push({ dateText, instructor, rowIndex: i, page: 1, monthOffset: mo });
              }
            }

            return { success: true as const, totalReceived: rowsArray.length, slotRows: allRows.length, rows: allRows };
          } catch (e: any) {
            return { success: false as const, reason: `fetch error: ${e?.message ?? String(e)}` };
          }
        }, ajaxUrl, monthOff);

        if (fetchResult.success) {
          log(`${label} [Strategy E] fetch: ${(fetchResult as any).totalReceived} received, ${(fetchResult as any).slotRows} slot rows`);
        } else {
          log(`${label} [Strategy E] fetch failed: ${(fetchResult as any).reason}`);
        }

        if (fetchResult.success && "rows" in fetchResult && fetchResult.rows!.length > 0) {
          totalNew = addSlots(fetchResult.rows!);
          log(`${label} [Strategy E] SUCCESS: ${fetchResult.rows!.length} rows from AJAX, ${totalNew} new [${monthSummary(fetchResult.rows!)}]`);
          log(`${label} done: ${totalNew} new, ${allSlots.length} unique overall`);
          return totalNew;
        }
      } else {
        log(`${label} [Strategy E]: no AJAX URL found`);
      }
    } catch (err) {
      log(`${label} [Strategy E] error: ${err}`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STRATEGY E2: Fetch page URLs as AJAX partial views (ASP.NET MVC)
    // The site likely uses jquery.unobtrusive-ajax.js — pagination links
    // are fetched via XHR and the server returns a partial HTML view.
    // Key: the X-Requested-With: XMLHttpRequest header makes ASP.NET MVC
    // return just the table HTML instead of the full page layout.
    // ═══════════════════════════════════════════════════════════════════════
    try {
      log(`${label} [Strategy E2]: Fetching page URLs as AJAX partial views...`);

      // Collect all page URLs from pagination links
      const pageUrls = await page.evaluate(() => {
        const urls: { pageNum: number; url: string }[] = [];
        const links = document.querySelectorAll("a");
        for (const link of links) {
          const text = link.textContent?.trim() || "";
          const href = link.href || "";
          if (/^\d+$/.test(text) && href.includes("page=")) {
            urls.push({ pageNum: parseInt(text, 10), url: href });
          }
        }
        // Also check for data-ajax attributes (unobtrusive AJAX)
        const ajaxLinks = document.querySelectorAll("a[data-ajax]");
        for (const link of ajaxLinks) {
          const text = link.textContent?.trim() || "";
          const href = (link as HTMLAnchorElement).href || "";
          if (/^\d+$/.test(text) && !urls.some(u => u.pageNum === parseInt(text, 10))) {
            urls.push({ pageNum: parseInt(text, 10), url: href });
          }
        }
        return urls.sort((a, b) => a.pageNum - b.pageNum);
      });

      log(`${label} [Strategy E2]: found ${pageUrls.length} page URLs: ${pageUrls.map(u => `pg${u.pageNum}`).join(", ")}`);

      if (pageUrls.length > 0) {
        // First scrape page 1 normally (it's already loaded)
        const p1Slots = await scrapeCurrentPage(page, 1, monthOff);
        let e2New = addSlots(p1Slots);
        log(`${label} [Strategy E2]: pg 1 (current) → ${p1Slots.length} slots`);

        // Fetch each additional page via XHR
        for (const { pageNum, url } of pageUrls) {
          if (pageNum === 1) continue; // already scraped
          try {
            const fetchedSlots = await page.evaluate(async (fetchUrl, pn, mo) => {
              try {
                const resp = await fetch(fetchUrl, {
                  method: "GET",
                  credentials: "include",
                  headers: { "X-Requested-With": "XMLHttpRequest" },
                });
                if (!resp.ok) return { error: `HTTP ${resp.status}`, slots: [] as any[] };

                const html = await resp.text();
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, "text/html");
                const rows = doc.querySelectorAll("table tbody tr, tbody tr, tr");
                const slots: { dateText: string; instructor: string; rowIndex: number; page: number; monthOffset: number }[] = [];

                rows.forEach((row, idx) => {
                  const cells = row.querySelectorAll("td");
                  if (cells.length >= 2) {
                    const dateText = cells[0]?.textContent?.trim() ?? "";
                    const instructor = cells[1]?.textContent?.trim() ?? "";
                    if (dateText && /^\w{3},\s+\w{3}\s+\d/.test(dateText)) {
                      slots.push({ dateText, instructor, rowIndex: idx, page: pn, monthOffset: mo });
                    }
                  }
                });

                return { error: null, slots, htmlLength: html.length };
              } catch (e: any) {
                return { error: e?.message ?? String(e), slots: [] as any[] };
              }
            }, url, pageNum, monthOff);

            if (fetchedSlots.error) {
              log(`${label} [Strategy E2]: pg ${pageNum} error: ${fetchedSlots.error}`);
            } else {
              const nc = addSlots(fetchedSlots.slots);
              e2New += nc;
              log(`${label} [Strategy E2]: pg ${pageNum} → ${fetchedSlots.slots.length} slots (${nc} new) [${monthSummary(fetchedSlots.slots)}]`);
            }
          } catch (err) {
            log(`${label} [Strategy E2]: pg ${pageNum} exception: ${err}`);
          }
        }

        if (e2New > p1Slots.length) {
          log(`${label} [Strategy E2] SUCCESS: ${e2New} total new slots from ${pageUrls.length} pages, ${allSlots.length} unique overall`);
          log(`${label} done: ${e2New} new, ${allSlots.length} unique overall`);
          return e2New;
        }
        log(`${label} [Strategy E2]: no additional slots from AJAX fetches (${e2New} total = page 1 only)`);
      }
    } catch (err) {
      log(`${label} [Strategy E2] error: ${err}`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STRATEGY F (FALLBACK): Page-by-page scraping with goToPage
    // ═══════════════════════════════════════════════════════════════════════
    log(`${label} [Strategy F/Fallback]: Falling back to page-by-page scraping...`);
    const page1Slots = await scrapeCurrentPage(page, 1, monthOff);
    totalNew += addSlots(page1Slots);

    const maxPage = await getMaxPage(page);
    const pageLimit = Math.min(maxPage, MAX_PAGES);
    log(`${label} [Fallback]: pg 1 -> ${page1Slots.length} slots [${monthSummary(page1Slots)}], ${pageLimit} pages detected`);

    for (let p = 2; p <= pageLimit; p++) {
      try {
        const navigated = await goToPage(page, p);
        if (!navigated) break;

        const pageSlots = await scrapeCurrentPage(page, p, monthOff);
        const nc = addSlots(pageSlots);
        totalNew += nc;
        log(`  pg ${p}: ${pageSlots.length} slots (${nc} new) [${monthSummary(pageSlots)}]`);
      } catch (err) {
        log(`  pg ${p} error: ${err}`);
        break;
      }
    }

    log(`${label} done: ${totalNew} new, ${allSlots.length} unique overall`);
    return totalNew;
  }

  // 1) Scrape the default view (should contain all months currently shown)
  await scrapeAllPages("Default", 0);

  // 2) Try advancing the calendar to find slots in additional months
  for (let m = 0; m < MAX_MONTHS_AHEAD; m++) {
    const calendarOffset = m + 1;
    try {
      await navigateToSchedule(page);

      // Advance the datepicker calendarOffset times WITHOUT clicking any dates
      let advanced = true;
      for (let i = 0; i < calendarOffset; i++) {
        if (!await advanceDatepicker(page)) {
          advanced = false;
          break;
        }
      }
      if (!advanced) {
        log(`Calendar: no more months after +${m}.`);
        break;
      }

      // NOW click a date to load the target month's slots
      if (!await clickDateInDatepicker(page)) {
        log(`Calendar +${calendarOffset}: could not click date in datepicker.`);
        break;
      }

      const newFound = await scrapeAllPages(`Calendar +${calendarOffset}`, calendarOffset);
      if (newFound === 0) {
        log(`No new slots after calendar +${calendarOffset}. Done.`);
        break;
      }
    } catch (err) {
      log(`Calendar +${calendarOffset} error (frame may have detached): ${err}`);
      // Continue to next iteration — navigateToSchedule will reset the page
      continue;
    }
  }

  // Log summary: only eligible/blackout slots
  const eligible = allSlots.filter(s => isEligible(s).eligible);
  const blacked = allSlots.filter(s => isBlackedOut(s));
  const months = [...new Set(allSlots.map(s => parseSlotDate(s.dateText)?.month).filter(Boolean))].sort();
  const monthNames = months.map(m => Object.entries(MONTH_MAP).find(([, v]) => v === m)?.[0] ?? "?");
  log(`Scan done: ${allSlots.length} total across ${monthNames.join("/")} | ${eligible.length} eligible | ${blacked.length} blacked out`);
  for (const s of eligible) {
    const { pickup } = isEligible(s);
    log(`  ✓ ${s.dateText} | ${s.instructor} | ${pickup}`);
  }

  return allSlots;
}

function msUntilNextHourEdge(): number {
  const now = new Date();
  const min = now.getMinutes();
  const sec = now.getSeconds();
  const ms = now.getMilliseconds();

  const currentMs = (min * 60 + sec) * 1000 + ms;

  const target1 = (0 * 60 + 5) * 1000;
  const target2 = (30 * 60 + 5) * 1000;
  const hourMs = 60 * 60 * 1000;

  const candidates = [
    target1 - currentMs,
    target2 - currentMs,
    target1 + hourMs - currentMs,
  ];

  const positive = candidates.filter((c) => c > 0);
  return Math.min(...positive);
}

async function bookSlot(page: Page, slot: Slot, pickup: "Home" | "High School"): Promise<boolean> {
  try {
    log(`Attempting to book: ${slot.dateText} with ${slot.instructor} (pickup: ${pickup})`);

    // Navigate via session-preserving method: go to schedule tab, advance month, then click through pages
    await navigateToSchedule(page);

    // Advance to the correct month
    if (slot.monthOffset > 0) {
      // Advance the datepicker N times without clicking dates
      for (let m = 0; m < slot.monthOffset; m++) {
        const advanced = await advanceDatepicker(page);
        if (!advanced) {
          log(`Could not advance datepicker to month offset ${slot.monthOffset} for booking.`);
          return false;
        }
      }
      // Now click a date to load the target month's slots
      if (!await clickDateInDatepicker(page)) {
        log(`Could not click date in datepicker for month offset ${slot.monthOffset}.`);
        return false;
      }
    }

    // Find and click the slot link — may need to navigate through pages
    let slotClicked = false;
    const maxPage = await getMaxPage(page);
    const pagesToTry = slot.page > 1 ? [slot.page, ...Array.from({ length: maxPage }, (_, i) => i + 1).filter(p => p !== slot.page)] : [1, ...Array.from({ length: maxPage - 1 }, (_, i) => i + 2)];

    for (const p of pagesToTry) {
      if (p > 1) {
        const reached = await goToPage(page, p);
        if (!reached) continue;
      }
      await sleep(1000);

      slotClicked = await page.evaluate((targetDate) => {
        const rows = document.querySelectorAll("table tbody tr");
        for (const row of rows) {
          const firstCell = row.querySelector("td:first-child a");
          if (firstCell && firstCell.textContent?.trim() === targetDate) {
            (firstCell as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, slot.dateText);

      if (slotClicked) {
        log(`Found slot on page ${p}: ${slot.dateText}`);
        break;
      }
    }

    if (!slotClicked) {
      log(`Could not find slot link for: ${slot.dateText} (searched ${pagesToTry.length} pages)`);
      return false;
    }

    await sleep(3000);

    // Select the pickup location radio button
    const radioSelected = await page.evaluate((pickupType) => {
      const radios = document.querySelectorAll('input[type="radio"]');
      for (const radio of radios) {
        const input = radio as HTMLInputElement;
        // Check label text from various parent containers
        const labelText = (
          radio.closest("label")?.textContent?.trim() ||
          radio.closest("li")?.textContent?.trim() ||
          radio.closest("div")?.textContent?.trim() ||
          ""
        );
        if (labelText.includes(pickupType)) {
          input.checked = true;
          input.click();
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return `Selected: "${labelText}"`;
        }
      }
      // Fallback: just click the first radio button
      if (radios.length > 0) {
        const first = radios[0] as HTMLInputElement;
        first.checked = true;
        first.click();
        first.dispatchEvent(new Event("change", { bubbles: true }));
        return `Fallback: clicked first radio`;
      }
      return null;
    }, pickup);

    if (!radioSelected) log("Warning: no radio button found for pickup");
    await sleep(1000);

    // Click "Schedule Lesson" button - try multiple selectors
    const bookClicked = await page.evaluate(() => {
      // Try exact text match
      const buttons = document.querySelectorAll("button, input[type='submit'], input[type='button'], a.btn");
      for (const btn of buttons) {
        const text = btn.textContent?.trim() || (btn as HTMLInputElement).value || "";
        if (text.includes("Schedule") || text.includes("Book") || text.includes("Confirm") || text.includes("Submit")) {
          (btn as HTMLElement).click();
          return `Clicked: "${text}"`;
        }
      }
      return null;
    });

    if (!bookClicked) {
      log("Could not find booking button!");
      return false;
    }

    log(`Book button: ${bookClicked}`);
    await sleep(4000);

    // Check if booking was successful by looking for confirmation or error
    const result = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      if (bodyText.includes("successfully") || bodyText.includes("scheduled") || bodyText.includes("confirmed")) {
        return "success";
      }
      if (bodyText.includes("error") || bodyText.includes("failed") || bodyText.includes("unavailable")) {
        return "error: " + bodyText.substring(0, 200);
      }
      return "unknown";
    });

    log(`Booking result: ${result}`);

    if (result === "success" || result === "unknown") {
      log(`BOOKED: ${slot.dateText} with ${slot.instructor} (pickup: ${pickup})`);
      return true;
    }

    log(`Booking may have failed: ${result}`);
    return false;
  } catch (err) {
    log(`Failed to book slot: ${err}`);
    const msg = err instanceof Error ? err.message : String(err);
    await notifyAlert(`🚨 **Booking Error**\nSlot: ${slot.dateText}\nInstructor: ${slot.instructor}\nError: ${msg}`);
    return false;
  }
}

// ── Main loop ───────────────────────────────────────────────────────────────

async function openBrowserAndScan(): Promise<void> {
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1280, height: 900 },
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await login(page);
    await navigateToSchedule(page);

    const allSlots = await scrapeAllSlots(page);

    const slotsToBook = allSlots
      .map((slot) => ({ slot, ...isEligible(slot) }))
      .filter((s) => s.eligible);

    const blackoutCount = allSlots.filter(s => isBlackedOut(s)).length;
    const skippedCount = allSlots.length - slotsToBook.length - blackoutCount;

    // Build concise scan summary for log channel
    const months = [...new Set(allSlots.map(s => parseSlotDate(s.dateText)?.month).filter(Boolean))].sort();
    const monthNames = months.map(m => Object.entries(MONTH_MAP).find(([, v]) => v === m)?.[0] ?? "?");

    const eligibleSlotLines = slotsToBook
      .map(({ slot, pickup }) => `• ${slot.dateText} | ${slot.instructor} | ${pickup}`)
      .join("\n");

    const scanMsg = [
      `📋 **Scan Complete** — ${new Date().toLocaleString("en-US")}`,
      ``,
      `**Months:** ${monthNames.join(", ") || "none"}`,
      `**Total:** ${allSlots.length} | **Eligible:** ${slotsToBook.length} | **Blacked out:** ${blackoutCount} | **Skipped:** ${skippedCount}`,
      ``,
      slotsToBook.length > 0
        ? `**Eligible slots:**\n${eligibleSlotLines}`
        : `No eligible slots found.`,
    ].join("\n");

    await notifyLog(scanMsg);

    // Scan completion — full list of every slot found
    const allSlotLines = allSlots
      .map((slot) => {
        const { eligible, pickup } = isEligible(slot);
        const tag = isBlackedOut(slot) ? "🚫" : eligible ? "✅" : "⏭️";
        return `${tag} ${slot.dateText} | ${slot.instructor}${eligible ? ` | ${pickup}` : ""}`;
      })
      .join("\n");

    await notifyScan(
      `📋 **Scan Complete** — ${new Date().toLocaleString("en-US")}\n` +
      `**${allSlots.length}** slots across **${monthNames.join(", ") || "no months"}** | ` +
      `${slotsToBook.length} eligible | ${blackoutCount} blacked out | ${skippedCount} skipped\n\n` +
      allSlotLines
    );

    if (slotsToBook.length === 0) {
      log("No eligible slots right now. Will keep checking...");
      return;
    }

    // Alert on important channel when eligible slots are found
    const eligibleLines = slotsToBook
      .map(({ slot, pickup }) => `• ${slot.dateText} | ${slot.instructor} | pickup: ${pickup}`)
      .join("\n");

    await notifyAlert(
      `🔔 **${slotsToBook.length} Eligible Slot${slotsToBook.length > 1 ? "s" : ""} Found!**\n` +
      `Attempting to book...\n\n${eligibleLines}`
    );

    for (const { slot, pickup } of slotsToBook) {
      const success = await bookSlot(page, slot, pickup);
      if (success) {
        log("Lesson booked successfully!");
        await notifyAlert(
          `✅ **Driving Lesson Booked!**\n\n` +
          `📅 ${slot.dateText}\n` +
          `👤 Instructor: ${slot.instructor}\n` +
          `📍 Pickup: ${pickup}\n` +
          `🕐 ${new Date().toLocaleString("en-US")}`
        );
      } else {
        await notifyAlert(
          `⚠️ **Booking Failed**\n` +
          `📅 ${slot.dateText}\n` +
          `👤 ${slot.instructor}\n` +
          `Slot may have been taken.`
        );
      }
    }
  } finally {
    await browser.close();
    log("Browser closed.");
  }
}

async function main(): Promise<void> {
  const port = process.env.PORT || 3000;
  http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("running");
  }).listen(port, () => log(`Health server listening on port ${port}`));

  log("Starting driving lesson booker...");

  await notifyAlert(
    `🟢 **Driving Booker Started**\nPolling every ${POLL_INTERVAL_MS / 60_000} minutes.` +
    `\nBlackout dates: Feb 17-23, Apr 18-27` +
    `\nTime: ${new Date().toLocaleString("en-US")}`
  );

  let hourEdgePending = false;
  function scheduleHourEdgeCheck() {
    const ms = msUntilNextHourEdge();
    const nextTime = new Date(Date.now() + ms);
    log(`Next hour-edge check at ${nextTime.toLocaleTimeString("en-US")} (in ${Math.round(ms / 1000)}s)`);
    setTimeout(() => {
      hourEdgePending = true;
    }, ms);
  }

  scheduleHourEdgeCheck();

  while (true) {
    try {
      await openBrowserAndScan();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack ?? "" : "";
      log(`Error during scan: ${msg}`);
      await notifyAlert(
        `🚨 **Scan Error**\n\nError: ${msg}\n\nStack:\n\`\`\`\n${stack.substring(0, 500)}\n\`\`\`\nTime: ${new Date().toLocaleString("en-US")}`
      );
    }

    const pollEnd = Date.now() + POLL_INTERVAL_MS;
    while (Date.now() < pollEnd && !hourEdgePending) {
      await sleep(1000);
    }

    if (hourEdgePending) {
      log("Hour-edge trigger fired! Running extra check...");
      hourEdgePending = false;
      scheduleHourEdgeCheck();
    } else {
      log("Regular 3-minute poll...");
    }
  }
}

main().catch(async (err) => {
  console.error("Fatal error:", err);
  const msg = err instanceof Error ? err.message : String(err);
  await notifyAlert(`💀 **Fatal Crash**\n\n${msg}\n\nTime: ${new Date().toLocaleString("en-US")}`);
  process.exit(1);
});
