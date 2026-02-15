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

  // Log "Schedule My Drive" link attributes for diagnostics
  const schedLinkInfo = await page.evaluate(() => {
    const links = document.querySelectorAll("a");
    for (const link of links) {
      if (link.textContent?.includes("Schedule My Drive")) {
        return {
          href: link.getAttribute("href"),
          dataAjax: link.getAttribute("data-ajax"),
          dataAjaxUpdate: link.getAttribute("data-ajax-update"),
          dataAjaxMode: link.getAttribute("data-ajax-mode"),
          allDataAttrs: Array.from(link.attributes)
            .filter(a => a.name.startsWith("data-"))
            .map(a => `${a.name}="${a.value}"`)
            .join(" "),
        };
      }
    }
    return null;
  });
  if (schedLinkInfo) {
    log(`"Schedule My Drive" link: ${JSON.stringify(schedLinkInfo)}`);
  }

  // Click "Schedule My Drive" using trusted mouse click + wait for XHR response
  const schedLink = await page.evaluateHandle(() => {
    const links = document.querySelectorAll("a");
    for (const link of links) {
      if (link.textContent?.includes("Schedule My Drive")) {
        link.scrollIntoView({ block: "center" });
        return link;
      }
    }
    return null;
  });

  const schedElement = schedLink.asElement();
  if (schedElement) {
    await sleep(300);
    const box = await schedElement.boundingBox();
    if (box) {
      // Set up response listener BEFORE clicking
      const responsePromise = page.waitForResponse(
        (resp) => {
          const u = resp.url();
          return (u.includes("Lessons") || u.includes("BtwScheduling") || u.includes("Schedule"))
            && resp.request().resourceType() !== "image";
        },
        { timeout: 15_000 },
      ).catch(() => null);

      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

      const resp = await responsePromise;
      if (resp) {
        log(`"Schedule My Drive" XHR: ${resp.status()} ${resp.url().substring(0, 100)}`);
      }
    }
  }

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
  // Log diagnostic info about pagination links (first call only)
  const linkDiag = await page.evaluate((target) => {
    const links = document.querySelectorAll("a");
    for (const link of links) {
      const text = link.textContent?.trim();
      if (text === String(target) && (link.getAttribute("href")?.includes("page=") || link.href?.includes("page="))) {
        return {
          text,
          href: link.getAttribute("href"),
          fullHref: link.href,
          dataAjax: link.getAttribute("data-ajax"),
          dataAjaxUpdate: link.getAttribute("data-ajax-update"),
          dataAjaxMode: link.getAttribute("data-ajax-mode"),
          allDataAttrs: Array.from(link.attributes)
            .filter(a => a.name.startsWith("data-"))
            .map(a => `${a.name}="${a.value}"`)
            .join(" "),
        };
      }
    }
    return null;
  }, targetPage);
  log(`Page ${targetPage} link: ${linkDiag ? JSON.stringify(linkDiag) : "not found"}`);

  if (!linkDiag) {
    log(`No page link found for page ${targetPage}`);
    return false;
  }

  // Strategy 1: Trusted mouse click at raw coordinates + wait for XHR response
  // page.mouse.click() produces trusted events that trigger jquery.unobtrusive-ajax handlers
  // unlike element.click() or jQuery.trigger('click') which create untrusted synthetic events
  try {
    // Find the link element handle
    const linkHandle = await page.evaluateHandle((target) => {
      const links = document.querySelectorAll("a");
      for (const link of links) {
        const text = link.textContent?.trim();
        if (text === String(target) && (link.getAttribute("href")?.includes("page=") || link.href?.includes("page="))) {
          link.scrollIntoView({ block: "center", inline: "center" });
          return link;
        }
      }
      return null;
    }, targetPage);

    const element = linkHandle.asElement();
    if (element) {
      await sleep(300); // let scroll settle
      const box = await element.boundingBox();
      if (box) {
        // Capture current first-row text to detect DOM changes
        const prevFirstRow = await page.evaluate(() =>
          document.querySelector("table tbody tr td")?.textContent?.trim() || ""
        );

        // Set up response listener BEFORE clicking
        const responsePromise = page.waitForResponse(
          (resp) => {
            const url = resp.url();
            return (url.includes("page=") || url.includes("Lessons") || url.includes("BtwScheduling"))
              && resp.request().resourceType() !== "image";
          },
          { timeout: 10_000 },
        ).catch(() => null);

        // Click at center of element using raw mouse coordinates (trusted event)
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        log(`Mouse click page ${targetPage} at (${Math.round(x)}, ${Math.round(y)})`);
        await page.mouse.click(x, y);

        // Wait for AJAX response
        const resp = await responsePromise;
        if (resp) {
          log(`  XHR response for page ${targetPage}: ${resp.status()} (${resp.url().substring(0, 100)})`);
          await sleep(1000); // let DOM update from response
          return true;
        }

        // No XHR detected — wait for DOM mutation instead
        try {
          await page.waitForFunction(
            (prev: string) => {
              const cell = document.querySelector("table tbody tr td");
              return cell && cell.textContent?.trim() !== prev;
            },
            { timeout: 8000, polling: "mutation" },
            prevFirstRow,
          );
          log(`  DOM changed for page ${targetPage} (mutation detected)`);
          await sleep(500);
          return true;
        } catch {
          log(`  No DOM change detected after mouse click for page ${targetPage}`);
        }
      }
    }
  } catch (err) {
    log(`  Mouse click strategy failed for page ${targetPage}: ${err}`);
  }

  // Strategy 2: Direct fetch with XHR headers + inject HTML into container
  // This mimics what jquery.unobtrusive-ajax does: fetch the URL with XMLHttpRequest header,
  // server returns partial HTML, inject it into the data-ajax-update container
  try {
    const fetchResult = await page.evaluate(async (target) => {
      const links = document.querySelectorAll("a");
      for (const link of links) {
        const text = link.textContent?.trim();
        if (text !== String(target)) continue;
        const href = link.href;
        if (!href || !href.includes("page=")) continue;

        const updateTarget = link.getAttribute("data-ajax-update");

        try {
          const resp = await fetch(href, {
            headers: {
              "X-Requested-With": "XMLHttpRequest",
              "Accept": "text/html, */*; q=0.01",
            },
            credentials: "same-origin",
          });
          if (!resp.ok) return `fetch-error: ${resp.status}`;
          const html = await resp.text();
          if (!html || html.length < 50) return `fetch-empty: ${html.length} chars`;

          // Inject into the data-ajax-update container (or common containers)
          const containers = updateTarget
            ? [updateTarget]
            : ["#scheduleContent", "#content", ".table-responsive", "[data-ajax-update]"];
          for (const sel of containers) {
            const el = document.querySelector(sel);
            if (el) {
              el.innerHTML = html;
              return `injected into ${sel} (${html.length} chars)`;
            }
          }

          // Last resort: find the table's parent and replace
          const table = document.querySelector("table");
          if (table?.parentElement) {
            table.parentElement.innerHTML = html;
            return `injected into table parent (${html.length} chars)`;
          }

          return "no-container-found";
        } catch (err) {
          return `fetch-exception: ${err}`;
        }
      }
      return "link-not-found";
    }, targetPage);

    log(`  Direct fetch page ${targetPage}: ${fetchResult}`);
    if (fetchResult?.startsWith("injected")) {
      await sleep(500);
      return true;
    }
  } catch (err) {
    log(`  Direct fetch strategy failed for page ${targetPage}: ${err}`);
  }

  // Strategy 3: Hide sticky/fixed elements, then use Puppeteer page.click()
  // Metronic theme has sticky headers that can intercept Puppeteer's click
  try {
    // Tag the link with a unique ID
    const tagged = await page.evaluate((target) => {
      const links = document.querySelectorAll("a");
      for (const link of links) {
        if (link.textContent?.trim() === String(target) &&
            (link.getAttribute("href")?.includes("page=") || link.href?.includes("page="))) {
          link.id = "__paginationTarget";
          // Hide all fixed/sticky elements
          document.querySelectorAll("*").forEach((el) => {
            const style = getComputedStyle(el);
            if (style.position === "fixed" || style.position === "sticky") {
              (el as HTMLElement).style.setProperty("display", "none", "important");
            }
          });
          return true;
        }
      }
      return false;
    }, targetPage);

    if (tagged) {
      const responsePromise = page.waitForResponse(
        (resp) => resp.url().includes("page=") || resp.url().includes("Lessons"),
        { timeout: 10_000 },
      ).catch(() => null);

      await page.click("#__paginationTarget");

      const resp = await responsePromise;
      if (resp) {
        log(`  page.click() response for page ${targetPage}: ${resp.status()}`);
        await sleep(1000);
      } else {
        await sleep(3000);
      }

      // Restore visibility
      await page.evaluate(() => {
        document.querySelectorAll("*").forEach((el) => {
          (el as HTMLElement).style.removeProperty("display");
        });
        const target = document.getElementById("__paginationTarget");
        if (target) target.removeAttribute("id");
      });
      return true;
    }
  } catch (err) {
    log(`  page.click() strategy failed for page ${targetPage}: ${err}`);
    // Restore visibility on error
    await page.evaluate(() => {
      document.querySelectorAll("*").forEach((el) => {
        (el as HTMLElement).style.removeProperty("display");
      });
      const target = document.getElementById("__paginationTarget");
      if (target) target.removeAttribute("id");
    }).catch(() => {});
  }

  log(`All pagination strategies failed for page ${targetPage}`);
  return false;
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

  // Helper: scrape all pages using full browser navigation (page.goto).
  // fetch() doesn't work because the server ignores ?page=N in AJAX requests —
  // the table is populated by JavaScript after page load, so we need full navigation.
  async function scrapeAllPages(label: string, monthOff: number): Promise<number> {
    let totalNew = 0;

    // Scrape page 1 from the already-loaded DOM
    const page1Slots = await scrapeCurrentPage(page, 1, monthOff);
    totalNew += addSlots(page1Slots);
    log(`${label}: pg 1 -> ${page1Slots.length} slots [${monthSummary(page1Slots)}]`);

    // Find max page number and the base URL pattern from pagination links
    const pageInfo = await page.evaluate(() => {
      let maxPage = 1;
      const pageUrls: string[] = [];
      const links = document.querySelectorAll("a");
      for (const link of links) {
        const href = link.getAttribute("href") || "";
        const fullHref = link.href || "";
        if (href.includes("page=") || fullHref.includes("page=")) {
          const match = (fullHref || href).match(/[?&]page=(\d+)/);
          if (match) {
            const num = parseInt(match[1], 10);
            if (num > maxPage) maxPage = num;
            if (!pageUrls.includes(fullHref)) pageUrls.push(fullHref);
          }
        }
      }
      return { maxPage, pageUrls };
    });

    log(`${label}: maxPage=${pageInfo.maxPage}, ${pageInfo.pageUrls.length} page URLs found`);

    if (pageInfo.maxPage <= 1) {
      log(`${label} done (single page): ${totalNew} new, ${allSlots.length} unique overall`);
      return totalNew;
    }

    // Navigate the actual browser to each page URL (full page load with JS execution).
    // This is the ONLY approach that works because the server populates the table
    // via JavaScript after page load — fetch() always returns page 1 data.
    for (let p = 2; p <= Math.min(pageInfo.maxPage, MAX_PAGES); p++) {
      try {
        // Build the page URL — use the first found URL as template
        let pageUrl = "";
        for (const url of pageInfo.pageUrls) {
          if (url.includes(`page=${p}`)) { pageUrl = url; break; }
        }
        if (!pageUrl && pageInfo.pageUrls.length > 0) {
          pageUrl = pageInfo.pageUrls[0].replace(/page=\d+/, `page=${p}`);
        }
        if (!pageUrl) {
          log(`${label}: no URL for page ${p}`);
          break;
        }

        log(`${label}: navigating to page ${p}: ${pageUrl.substring(0, 120)}`);
        await page.goto(pageUrl, { waitUntil: "networkidle2", timeout: 30_000 });
        await page.waitForSelector("table tbody tr", { timeout: 15_000 }).catch(() => {});
        await sleep(1000);

        const pageSlots = await scrapeCurrentPage(page, p, monthOff);
        const nc = addSlots(pageSlots);
        totalNew += nc;
        log(`${label}: pg ${p} -> ${pageSlots.length} slots (${nc} new) [${monthSummary(pageSlots)}]`);

        if (pageSlots.length === 0) {
          log(`${label}: page ${p} had no slots, stopping pagination`);
          break;
        }
      } catch (err) {
        log(`${label}: pg ${p} navigation error: ${err}`);
        continue;
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

    // Find and click the slot link — check page 1 first, then fetch other pages
    let slotClicked = false;

    // Try page 1 (already loaded in DOM)
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
      log(`Found slot on page 1: ${slot.dateText}`);
    }

    // If not on page 1, get pagination base URL and fetch other pages
    if (!slotClicked) {
      const bookPageInfo = await page.evaluate(() => {
        const links = document.querySelectorAll("a");
        let maxPage = 1;
        let baseUrl = "";
        for (const link of links) {
          const text = link.textContent?.trim() || "";
          const fullHref = link.href || "";
          if (/^\d+$/.test(text) && fullHref.includes("page=")) {
            const num = parseInt(text, 10);
            if (num > maxPage) maxPage = num;
            if (!baseUrl) baseUrl = fullHref.replace(/([?&])page=\d+/, "$1page=__PAGE__");
          }
        }
        // Also find the data-ajax-update target container
        const ajaxLink = document.querySelector("a[data-ajax-update]");
        const updateTarget = ajaxLink?.getAttribute("data-ajax-update") || null;
        return { maxPage, baseUrl, updateTarget };
      });

      if (bookPageInfo.baseUrl) {
        const pagesToTry = slot.page > 1
          ? [slot.page, ...Array.from({ length: bookPageInfo.maxPage }, (_, i) => i + 1).filter(p => p !== slot.page)]
          : Array.from({ length: bookPageInfo.maxPage - 1 }, (_, i) => i + 2);

        for (const p of pagesToTry) {
          // Fetch page HTML and inject into DOM so we can click the slot link
          const injected = await page.evaluate(async (url, target) => {
            try {
              const resp = await fetch(url, {
                headers: { "X-Requested-With": "XMLHttpRequest", "Accept": "text/html, */*; q=0.01" },
                credentials: "same-origin",
              });
              if (!resp.ok) return false;
              const html = await resp.text();
              const containers = target ? [target] : [".table-responsive", "#scheduleContent", "#content"];
              for (const sel of containers) {
                const el = document.querySelector(sel);
                if (el) { el.innerHTML = html; return true; }
              }
              const table = document.querySelector("table");
              if (table?.parentElement) { table.parentElement.innerHTML = html; return true; }
              return false;
            } catch { return false; }
          }, bookPageInfo.baseUrl.replace("__PAGE__", String(p)), bookPageInfo.updateTarget);

          if (!injected) continue;
          await sleep(500);

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
      }
    }

    if (!slotClicked) {
      log(`Could not find slot link for: ${slot.dateText}`);
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
