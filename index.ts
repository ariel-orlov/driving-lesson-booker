import puppeteer, { type Page } from "puppeteer";
import http from "http";
import path from "path";
import fs from "fs";

// ── Config ──────────────────────────────────────────────────────────────────
const LOGIN_URL =
  "https://www.tds.ms/CentralizeSP/Student/Login/chelmsfordautoschool";
const REQUIRED_ENV = ["TDS_USERNAME", "TDS_PASSWORD", "DISCORD_WEBHOOK", "DISCORD_WEBHOOK_IMPORTANT", "DISCORD_WEBHOOK_SCAN"] as const;
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const USERNAME = process.env.TDS_USERNAME!;
const PASSWORD = process.env.TDS_PASSWORD!;

const POLL_INTERVAL_MS = 3 * 60_000;
const SCAN_TIMEOUT_MS = 90_000; // kill scan if it takes longer than 90s
const MAX_PAGES = 50; // safety cap only (pagination stops naturally when no more pages)
const TOTAL_LESSON_CAP = 8; // never book beyond this total (checked against scraped booked count + session count)
const NOTIFY_ONLY_MODE = process.env.NOTIFY_ONLY === "true"; // set NOTIFY_ONLY=true to disable booking permanently

const DISCORD_LOG = process.env.DISCORD_WEBHOOK!;
const DISCORD_ALERT = process.env.DISCORD_WEBHOOK_IMPORTANT!;
const DISCORD_SCAN = process.env.DISCORD_WEBHOOK_SCAN!;

// ── Blackout dates (don't book during these ranges) ─────────────────────────
// Format: [year, month, startDay, endDay] (month is 1-indexed)
const BLACKOUT_RANGES: [number, number, number, number][] = [
  [2026, 2, 17, 23],  // Feb 17-23, 2026
  [2026, 4, 18, 27],  // Apr 18-27, 2026
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
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseSlotDate(dateText: string): { dayOfWeek: string; month: number; day: number; hour: number; minute: number; year: number } | null {
  const match = dateText.match(
    /^(\w+),\s+(\w+)\s+(\d+),\s+(\d{1,2}):(\d{2})\s+(AM|PM)/
  );
  if (!match) return null;

  const dayOfWeek = match[1].toUpperCase();
  // Normalize to title case for MONTH_MAP lookup (e.g. "MAR" → "Mar")
  const monthStr = match[2].charAt(0).toUpperCase() + match[2].slice(1).toLowerCase();
  const month = MONTH_MAP[monthStr] ?? 0;
  const day = parseInt(match[3], 10);
  let hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  const ampm = match[6];

  if (ampm === "PM" && hour !== 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;

  // Infer year: site doesn't provide it, so use current year
  // If the slot is in a past month, assume next year
  const now = new Date();
  let year = now.getFullYear();
  if (month < now.getMonth() + 1) year++;

  return { dayOfWeek, month, day, hour, minute, year };
}

/** Normalize a date string into a comparable key like "2026-3-3-17-0" (year-month-day-hour-minute). */
function slotDateKey(dateText: string): string | null {
  const parsed = parseSlotDate(dateText);
  if (!parsed) return null;
  return `${parsed.year}-${parsed.month}-${parsed.day}-${parsed.hour}-${parsed.minute}`;
}

function isBlackedOut(slot: Slot): boolean {
  const parsed = parseSlotDate(slot.dateText);
  if (!parsed) return false;

  for (const [year, month, startDay, endDay] of BLACKOUT_RANGES) {
    if (parsed.year === year && parsed.month === month && parsed.day >= startDay && parsed.day <= endDay) {
      return true;
    }
  }
  return false;
}

function isWeekend(dayOfWeek: string): boolean {
  const d = dayOfWeek.toUpperCase();
  return d === "SAT" || d === "SUN";
}

function isEligible(slot: Slot, ignoreBlackout = false): { eligible: boolean; pickup: "Home" | "High School" } {
  if (!ignoreBlackout && isBlackedOut(slot)) return { eligible: false, pickup: "Home" };

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

/** Human-readable countdown from now to a slot date (e.g. "13d 23h"). */
function timeUntilSlot(dateText: string): string {
  const parsed = parseSlotDate(dateText);
  if (!parsed) return "";
  const now = new Date();
  const target = new Date(parsed.year, parsed.month - 1, parsed.day, parsed.hour, parsed.minute);
  const diffMs = target.getTime() - now.getTime();
  if (diffMs <= 0) return "now";
  const days = Math.floor(diffMs / 86400_000);
  const hours = Math.floor((diffMs % 86400_000) / 3600_000);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((diffMs % 3600_000) / 60_000);
  return `${hours}h ${mins}m`;
}

function log(msg: string): void {
  console.log(`[${timestamp()}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Race a promise against a timeout. Rejects with a clear error if time runs out. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${label} took longer than ${ms / 1000}s`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// Set SCREENSHOTS=true to enable, SCREENSHOTS=false to disable. Defaults to on when headful, off on server.
const SCREENSHOTS_ENABLED = process.env.SCREENSHOTS === "true" || (process.env.SCREENSHOTS !== "false" && process.env.HEADLESS !== "true");
const SCREENSHOT_DIR = path.join(process.cwd(), "screenshots");

async function screenshot(page: Page, name: string): Promise<void> {
  if (!SCREENSHOTS_ENABLED) return;
  try {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const file = path.join(SCREENSHOT_DIR, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    log(`Screenshot saved: ${file}`);
  } catch (err) {
    log(`Screenshot failed (${name}): ${err}`);
  }
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

/** Check if the session has expired (redirected to login page). */
async function checkSessionExpired(page: Page): Promise<boolean> {
  const url = page.url();
  if (url.includes("/Login/")) {
    log("Session expired — redirected to login page.");
    return true;
  }
  return false;
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
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: chunk }),
        });
        if (resp.status === 429) {
          const retryAfter = parseInt(resp.headers.get("retry-after") || "2", 10);
          log(`Discord rate limited, retrying in ${retryAfter}s...`);
          await sleep(retryAfter * 1000);
          continue;
        }
        if (!resp.ok && resp.status !== 204) {
          log(`Discord send failed: ${resp.status}`);
        }
        break; // success or non-retryable error
      } catch (err) {
        log(`Discord send error: ${err}`);
        break;
      }
    }
    if (chunks.length > 1) await sleep(500); // rate limit
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

  // Use locator.fill() to atomically clear + set — avoids autofill interference corrupting the password
  await page.locator("#username").fill(USERNAME);
  await page.locator("#password").fill(PASSWORD);

  await page.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>("button.green-haze");
    if (btn) btn.click();
  });

  // Wait for login to complete — URL leaves the login page
  await page.waitForFunction(
    () => !window.location.href.includes("/Login/"),
    { timeout: 60_000 }
  );
  await ensurePageReady(page);

  log("Logged in successfully.");
  await screenshot(page, "01-after-login");
}

async function navigateToSchedule(page: Page): Promise<void> {
  await ensurePageReady(page);

  const url = "https://www.tds.ms/CentralizeSP/BtwScheduling/Lessons?SchedulingTypeId=-1";
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch {
    await sleep(3000);
    await ensurePageReady(page);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
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

  if (await checkSessionExpired(page)) {
    throw new Error("Session expired before navigating to schedule");
  }

  const schedElement = schedLink.asElement();
  if (!schedElement) {
    throw new Error("Could not find 'Schedule My Drive' link — page layout may have changed");
  }

  await sleep(300);
  const box = await schedElement.boundingBox();
  if (!box) {
    throw new Error("Could not get bounding box for 'Schedule My Drive' link");
  }

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

  await page.waitForSelector("table tbody tr", { timeout: 15_000 }).catch(() => {
    log("No slots table found (may be empty).");
  });

  await sleep(1000);
  await screenshot(page, "02-schedule-loaded");
}

async function scrapeBookedLessons(page: Page): Promise<Set<string>> {
  const bookedKeys = new Set<string>();

  try {
    log("Checking already-booked lessons...");
    await ensurePageReady(page);

    // Navigate to the scheduling page (same base as available slots)
    const url = "https://www.tds.ms/CentralizeSP/BtwScheduling/Lessons?SchedulingTypeId=-1";
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Click the "My Schedule" tab using trusted mouse click + wait for XHR
    const mySchedLink = await page.evaluateHandle(() => {
      const links = document.querySelectorAll("a");
      for (const link of links) {
        const text = link.textContent?.trim() ?? "";
        if (text.includes("My Schedule")) {
          link.scrollIntoView({ block: "center" });
          return link;
        }
      }
      return null;
    });

    const mySchedElement = mySchedLink.asElement();
    if (!mySchedElement) {
      log("Could not find 'My Schedule' tab — skipping booked lessons check.");
      return bookedKeys;
    }

    await sleep(300);
    const box = await mySchedElement.boundingBox();
    if (!box) {
      log("Could not get bounding box for 'My Schedule' tab.");
      return bookedKeys;
    }

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
      log(`"My Schedule" XHR: ${resp.status()} ${resp.url().substring(0, 100)}`);
    }

    await sleep(2000);
    await screenshot(page, "00-my-schedule");

    // The "My Schedule" page uses cards (not a table).
    // Scrape text from the main content area to find date patterns like "TUE, MAR 3, 5:00 PM".
    const scheduleText = await page.evaluate(() => {
      // Try scoped selectors first, fall back to body
      const container = document.querySelector(".schedule-content")
        || document.querySelector("#schedule-content")
        || document.querySelector("[class*='schedule']")
        || document.querySelector("[class*='lesson']")
        || document.querySelector(".content-body")
        || document.querySelector("#content")
        || document.querySelector("main")
        || document.body;
      return (container as HTMLElement).innerText;
    });
    const datePattern = /[A-Z]{3},\s+[A-Z]{3}\s+\d{1,2},\s+\d{1,2}:\d{2}\s+[AP]M/gi;
    const matches = scheduleText.match(datePattern) || [];

    for (const match of matches) {
      const key = slotDateKey(match);
      if (key) {
        bookedKeys.add(key);
        log(`  ↳ Booked: ${match} → key: ${key}`);
      }
    }

    if (bookedKeys.size > 0) {
      log(`Found ${bookedKeys.size} already-booked lesson(s).`);
    } else {
      log("No existing booked lessons found.");
    }
  } catch (err) {
    log(`Error checking booked lessons: ${err}`);
  }

  return bookedKeys;
}

// ── Available Open Slots table targeting ──────────────────────────────────
// The page has MULTIPLE tables (My Schedule, calendar datepicker, Available Open Slots).
// We target the correct one by checking headers: has "Date" but NOT "Starts in" or "Cancel".
//
// The findSlotsTable() function is duplicated inside each page.evaluate() call because
// Puppeteer serializes the function body and cannot capture outer-scope references.
// If you change the heuristic, search for "findSlotsTable" and update ALL copies.

async function scrapeCurrentPage(page: Page, pageNum: number): Promise<Slot[]> {
  return page.evaluate((pn) => {
    // -- findSlotsTable (see note above) --
    function findSlotsTable(): HTMLTableElement | null {
      const tables = document.querySelectorAll("table");
      for (const table of tables) {
        const ths = Array.from(table.querySelectorAll("thead th"));
        const headers = ths.map(th => (th.textContent || "").trim().toLowerCase());
        if (headers.some(h => h === "date") &&
            !headers.some(h => h.includes("starts in")) &&
            !headers.some(h => h === "cancel")) {
          return table;
        }
      }
      return null;
    }

    const targetTable = findSlotsTable();
    if (!targetTable) return []; // Don't fall back to unscoped scraping

    // Find instructor column from this table's headers
    let instructorCol = 1;
    const ths = Array.from(targetTable.querySelectorAll("thead th"));
    for (let i = 0; i < ths.length; i++) {
      if ((ths[i].textContent || "").trim().toLowerCase().includes("instructor")) {
        instructorCol = i;
        break;
      }
    }

    const rows = targetTable.querySelectorAll("tbody tr");
    const slots: { dateText: string; instructor: string; rowIndex: number; page: number }[] = [];

    rows.forEach((row, idx) => {
      const cells = row.querySelectorAll("td");
      if (cells.length >= 2) {
        const dateText = cells[0]?.textContent?.trim() ?? "";
        const instructor = cells[instructorCol]?.textContent?.trim() ?? "";
        if (dateText && /^\w{3},\s+\w{3}\s+\d/.test(dateText)) {
          slots.push({ dateText, instructor, rowIndex: idx, page: pn });
        }
      }
    });

    return slots;
  }, pageNum);
}

/** Get max page number from .table-pager. */
async function getMaxPage(page: Page): Promise<number> {
  return page.evaluate(() => {
    const pager = document.querySelector(".table-pager");
    if (!pager) return 1;
    let maxPage = 1;
    const anchors = pager.querySelectorAll("a");
    for (const a of anchors) {
      const text = a.textContent?.trim() || "";
      if (/^\d+$/.test(text)) {
        const num = parseInt(text, 10);
        if (num > maxPage) maxPage = num;
      }
    }
    return maxPage;
  });
}

/** Get the current active page number from .table-pager. */
async function getCurrentPage(page: Page): Promise<number> {
  return page.evaluate(() => {
    const active = document.querySelector(".table-pager a.currentPage");
    const text = active?.textContent?.trim() || "1";
    return parseInt(text, 10) || 1;
  });
}

/** Click a pagination link inside .table-pager by its label text, using a trusted mouse click. */
async function clickPagerLink(page: Page, label: string): Promise<boolean> {
  const handle = await page.evaluateHandle((lbl) => {
    const pager = document.querySelector(".table-pager");
    if (!pager) return null;
    const anchors = pager.querySelectorAll("a");
    for (const a of anchors) {
      if (a.textContent?.trim() === lbl) {
        a.scrollIntoView({ block: "center" });
        return a;
      }
    }
    return null;
  }, label);

  const element = handle.asElement();
  if (!element) return false;

  const box = await element.boundingBox();
  if (!box) return false;

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return true;
}

/** Click a pagination button and wait for the active page to change. */
async function goToPage(page: Page, targetPage: number): Promise<boolean> {
  log(`Clicking pagination button ${targetPage}...`);
  const clicked = await clickPagerLink(page, String(targetPage));
  if (!clicked) {
    log(`No pagination button found for page ${targetPage}`);
    return false;
  }

  // Wait for the currentPage class to move to the target page number
  let arrived = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      const cur = await getCurrentPage(page);
      if (cur === targetPage) {
        arrived = true;
        break;
      }
    } catch {
      log(`Frame error while waiting for page ${targetPage}, retrying...`);
    }
  }

  if (!arrived) {
    log(`WARNING: currentPage did not update to ${targetPage} after clicking`);
  }

  await page.waitForSelector("table tbody tr", { timeout: 10_000 }).catch(() => {});
  await sleep(500);
  log(`Navigated to page ${targetPage} (arrived: ${arrived})`);
  await screenshot(page, `03-page-${targetPage}`);
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

  function monthSummary(slots: Slot[]): string {
    const byMonth: Record<string, number> = {};
    for (const s of slots) {
      const parsed = parseSlotDate(s.dateText);
      const name = parsed ? (Object.entries(MONTH_MAP).find(([, v]) => v === parsed.month)?.[0] ?? "?") : "?";
      byMonth[name] = (byMonth[name] || 0) + 1;
    }
    return Object.entries(byMonth).map(([m, c]) => `${m}:${c}`).join(" ");
  }

  // Scrape page 1 (already loaded)
  const page1Slots = await scrapeCurrentPage(page, 1);
  addSlots(page1Slots);
  const p1sample = page1Slots.slice(0, 3).map(s => s.dateText).join(" | ");
  log(`pg 1 -> ${page1Slots.length} slots [${monthSummary(page1Slots)}] sample: ${p1sample}`);

  // Find max page from pagination links
  const maxPage = await getMaxPage(page);
  log(`maxPage=${maxPage}`);

  if (maxPage <= 1) {
    log(`Done (single page): ${allSlots.length} unique slots`);
  } else {
    // Click through pages; re-check maxPage each time in case ">" reveals more
    for (let p = 2; p <= MAX_PAGES; p++) {
      try {
        if (await checkSessionExpired(page)) {
          throw new Error("Session expired during pagination");
        }
        // Re-read maxPage on current page (pagination may show more pages after navigating)
        const currentMax = await getMaxPage(page);
        if (p > currentMax) {
          log(`No more pages (current max: ${currentMax}), stopping`);
          break;
        }

        const navigated = await goToPage(page, p);
        if (!navigated) {
          log(`No link for page ${p}, stopping`);
          break;
        }

        const pageSlots = await scrapeCurrentPage(page, p);
        const nc = addSlots(pageSlots);
        const sample = pageSlots.slice(0, 3).map(s => s.dateText).join(" | ");
        log(`pg ${p} -> ${pageSlots.length} slots (${nc} new) [${monthSummary(pageSlots)}] sample: ${sample}`);

        if (pageSlots.length === 0) {
          log(`Page ${p} had no slots, stopping pagination`);
          break;
        }
      } catch (err) {
        log(`pg ${p} error: ${err}`);
        break;
      }
    }

    log(`Done: ${allSlots.length} unique slots`);
  }

  // Log summary (just counts — detailed breakdown happens after dedup in openBrowserAndScan)
  const eligible = allSlots.filter(s => isEligible(s).eligible);
  const blacked = allSlots.filter(s => isBlackedOut(s));
  const months = [...new Set(allSlots.map(s => parseSlotDate(s.dateText)?.month).filter(Boolean))].sort();
  const monthNames = months.map(m => Object.entries(MONTH_MAP).find(([, v]) => v === m)?.[0] ?? "?");
  log(`Scan done: ${allSlots.length} total across ${monthNames.join("/")} | ${eligible.length} time-eligible | ${blacked.length} blacked out`);

  return allSlots;
}

function msUntilNextHourEdge(): number {
  const now = new Date();
  const min = now.getMinutes();
  const sec = now.getSeconds();
  const ms = now.getMilliseconds();

  const currentMs = (min * 60 + sec) * 1000 + ms;

  const target1 = 5 * 1_000;           // :00:05 — 5s after the hour
  const target2 = (30 * 60 + 5) * 1_000; // :30:05 — 5s after the half-hour
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

    // Navigate to schedule list
    await navigateToSchedule(page);

    // Find and click the slot link — check page 1 first, then paginate.
    // Uses consistent table-finding logic (see findSlotsTable note above scrapeCurrentPage).
    let slotClicked = false;

    async function clickSlotOnCurrentPage(targetDate: string): Promise<boolean> {
      return page.evaluate((td) => {
        // -- findSlotsTable (see note above scrapeCurrentPage) --
        function findSlotsTable(): HTMLTableElement | null {
          const tables = document.querySelectorAll("table");
          for (const table of tables) {
            const ths = Array.from(table.querySelectorAll("thead th"));
            const headers = ths.map(th => (th.textContent || "").trim().toLowerCase());
            if (headers.some(h => h === "date") &&
                !headers.some(h => h.includes("starts in")) &&
                !headers.some(h => h === "cancel")) {
              return table;
            }
          }
          return null;
        }

        const targetTable = findSlotsTable();
        if (!targetTable) return false;

        const rows = targetTable.querySelectorAll("tbody tr");
        for (const row of rows) {
          const firstTd = row.querySelector("td:first-child");
          if (!firstTd || firstTd.textContent?.trim() !== td) continue;
          const clickable = firstTd.querySelector("a") || firstTd.querySelector("span") ||
                            firstTd.querySelector("button") || firstTd;
          if (clickable) {
            (clickable as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, targetDate);
    }

    // Try page 1 (already loaded in DOM)
    slotClicked = await clickSlotOnCurrentPage(slot.dateText);
    if (slotClicked) {
      log(`Found slot on page 1: ${slot.dateText}`);
    }

    // If not on page 1, click through pagination to find the slot
    if (!slotClicked) {
      const bookMaxPage = await getMaxPage(page);

      const pagesToTry = slot.page > 1
        ? [slot.page, ...Array.from({ length: bookMaxPage }, (_, i) => i + 1).filter(p => p !== slot.page && p !== 1)]
        : Array.from({ length: bookMaxPage - 1 }, (_, i) => i + 2);

      for (const p of pagesToTry) {
        const navigated = await goToPage(page, p);
        if (!navigated) continue;

        slotClicked = await clickSlotOnCurrentPage(slot.dateText);
        if (slotClicked) {
          log(`Found slot on page ${p}: ${slot.dateText}`);
          break;
        }
      }
    }

    if (!slotClicked) {
      log(`Could not find slot link for: ${slot.dateText}`);
      await screenshot(page, "04-slot-not-found");
      return false;
    }

    await sleep(3000);
    await screenshot(page, "04-slot-clicked");

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

    // Click the booking confirmation button.
    // Be specific to avoid clicking navigation elements like "SCHEDULE MY DRIVE" tab.
    const bookClicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll("button, input[type='submit'], input[type='button'], a.btn");
      const candidates: { el: HTMLElement; text: string; priority: number }[] = [];

      for (const btn of buttons) {
        const text = btn.textContent?.trim() || (btn as HTMLInputElement).value || "";
        const lower = text.toLowerCase();

        // Skip navigation tabs and links
        if (lower === "schedule my drive" || lower === "my schedule" ||
            lower === "refine search" || lower === "clear search" ||
            lower === "close") {
          continue;
        }

        // High priority: exact booking phrases
        if (lower === "schedule lesson" || lower === "book lesson" ||
            lower === "confirm booking" || lower === "submit") {
          candidates.push({ el: btn as HTMLElement, text, priority: 1 });
        }
        // Medium priority: contains booking-related words (but not tab names)
        else if ((lower.includes("schedule") || lower.includes("book") ||
                  lower.includes("confirm")) && !lower.includes("my drive")) {
          candidates.push({ el: btn as HTMLElement, text, priority: 2 });
        }
      }

      candidates.sort((a, b) => a.priority - b.priority);
      if (candidates.length > 0) {
        candidates[0].el.click();
        return `Clicked: "${candidates[0].text}"`;
      }
      return null;
    });

    if (!bookClicked) {
      log("Could not find booking button!");
      return false;
    }

    log(`Book button: ${bookClicked}`);
    await sleep(4000);

    // Check if booking was successful — look for confirmation dialogs/alerts first, then body text
    const result = await page.evaluate(() => {
      // Check for success indicators in alerts, modals, or status elements first
      const alertEl = document.querySelector(".alert-success, .success-message, .confirmation, [class*='success']");
      if (alertEl) return "success";

      const errorEl = document.querySelector(".alert-danger, .alert-error, .error-message, [class*='error']");
      if (errorEl) return "error: " + (errorEl.textContent?.trim().substring(0, 200) || "unknown error");

      // Fall back to checking text in the main content area (not nav/header/footer)
      const content = document.querySelector("main, .content, #content, .modal-body, .page-content") || document.body;
      const text = (content as HTMLElement).innerText;
      if (text.includes("successfully") || text.includes("has been scheduled") || text.includes("confirmed")) {
        return "success";
      }
      if (text.includes("no longer available") || text.includes("already been taken") || text.includes("unavailable")) {
        return "error: slot taken";
      }
      if (text.includes("one") && text.includes("per day") || text.includes("1") && text.includes("per day") || text.includes("already have") || text.includes("limit")) {
        return "error: day limit";
      }
      return "unknown";
    });

    log(`Booking result: ${result}`);
    await screenshot(page, "05-booking-result");

    if (result === "success") {
      // Double-check: verify this isn't a false positive by confirming we're NOT
      // still on the schedule listing page.
      const stillOnSchedule = await page.evaluate(() => {
        const t = document.body.innerText.toLowerCase();
        return t.includes("available open slots") && t.includes("filter by date");
      });
      if (stillOnSchedule) {
        log(`FALSE POSITIVE: "success" detected but still on schedule page. Not booked.`);
        await screenshot(page, "05-false-positive");
        return false;
      }
      log(`BOOKED: ${slot.dateText} with ${slot.instructor} (pickup: ${pickup})`);
      return true;
    }

    log(`Booking did not succeed: ${result}`);
    await screenshot(page, "05-booking-failed");

    if (result === "unknown") {
      await notifyAlert(
        `❓ **Booking Result Unclear**\n` +
        `📅 ${slot.dateText} — ${slot.instructor}\n` +
        `Result was ambiguous. Check screenshots.`
      );
    }
    return false;
  } catch (err) {
    log(`Failed to book slot: ${err}`);
    const msg = err instanceof Error ? err.message : String(err);
    await notifyAlert(`🚨 **Booking Error**\nSlot: ${slot.dateText}\nInstructor: ${slot.instructor}\nError: ${msg}`);
    return false;
  }
}

// ── Main loop ───────────────────────────────────────────────────────────────

async function openBrowserAndScan(): Promise<boolean> {
  log("Launching browser...");
  const browser = await withTimeout(
    puppeteer.launch({
      headless: process.env.HEADLESS !== "false",
      defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--force-device-scale-factor=1"],
    }),
    30_000,
    "browser launch",
  );
  activeBrowser = browser;

  try {
    const page = await browser.newPage();
    await login(page);

    // Scrape already-booked lessons so we don't try to re-book them
    const bookedKeys = await scrapeBookedLessons(page);

    if (bookedKeys.size === 0) {
      log("WARNING: No booked lessons detected. If lessons ARE booked, the scraper may be broken.");
    }

    // Cap reached if we booked 1 this session OR if scraped future lessons already fill the cap
    // (scraped count can be TOTAL_LESSON_CAP - 1 when one past lesson has dropped off the schedule)
    const atCap = NOTIFY_ONLY_MODE || sessionBookedCount >= 1 || bookedKeys.size >= TOTAL_LESSON_CAP - 1;

    await navigateToSchedule(page);

    const allSlots = await scrapeAllSlots(page);

    const isAlreadyBooked = (s: Slot) => bookedKeys.has(slotDateKey(s.dateText) ?? "");

    // Collect days that already have a booked in-car lesson
    const bookedDays = new Set<string>();
    for (const key of bookedKeys) {
      // key format: "year-month-day-hour-minute" — extract "year-month-day"
      const parts = key.split("-");
      if (parts.length >= 3) bookedDays.add(`${parts[0]}-${parts[1]}-${parts[2]}`);
    }

    const slotsToBook = allSlots
      .map((slot) => ({ slot, ...isEligible(slot) }))
      .filter((s) => s.eligible)
      .filter((s) => !isAlreadyBooked(s.slot))
      .filter((s) => {
        // Only 1 in-car lesson per day allowed
        const parsed = parseSlotDate(s.slot.dateText);
        if (!parsed) return false;
        const dayKey = `${parsed.year}-${parsed.month}-${parsed.day}`;
        return !bookedDays.has(dayKey);
      });

    const alreadyBookedCount = allSlots.filter(s => isEligible(s).eligible && isAlreadyBooked(s)).length;
    const blackoutCount = allSlots.filter(s => isBlackedOut(s)).length;
    const skippedCount = Math.max(0, allSlots.length - slotsToBook.length - blackoutCount - alreadyBookedCount);

    // Log detailed breakdown after dedup
    for (const s of allSlots) {
      const { eligible, pickup } = isEligible(s);
      if (!eligible) continue;
      const booked = isAlreadyBooked(s);
      const tag = booked ? "📌 BOOKED" : "✅ NEW";
      log(`  ${tag}: ${s.dateText} | ${s.instructor} | ${pickup}`);
    }

    // Build concise scan summary for log channel
    const months = [...new Set(allSlots.map(s => parseSlotDate(s.dateText)?.month).filter(Boolean))].sort();
    const monthNames = months.map(m => Object.entries(MONTH_MAP).find(([, v]) => v === m)?.[0] ?? "?");

    const eligibleSlotLines = slotsToBook
      .map(({ slot, pickup }) => {
        const countdown = timeUntilSlot(slot.dateText);
        return `• ${slot.dateText} — ${slot.instructor} → ${pickup}${countdown ? ` (${countdown})` : ""}`;
      })
      .join("\n");

    const scanMsg = [
      `📋 **Scan** — ${new Date().toLocaleString("en-US")}`,
      `${allSlots.length} slots | ${slotsToBook.length} new | ${alreadyBookedCount} booked | ${blackoutCount} blacked out | ${skippedCount} skipped`,
      slotsToBook.length > 0
        ? `\n**New eligible:**\n${eligibleSlotLines}`
        : `No new eligible slots.`,
    ].join("\n");

    await notifyLog(scanMsg);

    // Scan channel — full list grouped by status
    const groupedLines: { booked: string[]; eligible: string[]; blacked: string[]; skipped: string[] } = {
      booked: [], eligible: [], blacked: [], skipped: [],
    };

    for (const slot of allSlots) {
      const { eligible, pickup } = isEligible(slot);
      const alreadyBooked = eligible && isAlreadyBooked(slot);
      const countdown = timeUntilSlot(slot.dateText);
      const countdownStr = countdown ? ` (${countdown})` : "";

      if (isBlackedOut(slot)) {
        groupedLines.blacked.push(`🚫 ${slot.dateText} — ${slot.instructor}`);
      } else if (alreadyBooked) {
        groupedLines.booked.push(`📌 ${slot.dateText} — ${slot.instructor}${countdownStr}`);
      } else if (eligible) {
        groupedLines.eligible.push(`✅ ${slot.dateText} — ${slot.instructor} → ${pickup}${countdownStr}`);
      } else {
        groupedLines.skipped.push(`⏭️ ${slot.dateText} — ${slot.instructor}`);
      }
    }

    const scanLines = [
      `📋 **Scan** — ${new Date().toLocaleString("en-US")}`,
      `${allSlots.length} slots | ${monthNames.join(", ") || "none"}`,
      ``,
    ];

    if (groupedLines.eligible.length > 0) {
      scanLines.push(`**NEW (${groupedLines.eligible.length}):**`, ...groupedLines.eligible, ``);
    }
    if (groupedLines.booked.length > 0) {
      scanLines.push(`**Already Booked (${groupedLines.booked.length}):**`, ...groupedLines.booked, ``);
    }
    if (groupedLines.blacked.length > 0) {
      scanLines.push(`**Blacked Out (${groupedLines.blacked.length}):**`, ...groupedLines.blacked, ``);
    }
    if (groupedLines.skipped.length > 0) {
      scanLines.push(`*${groupedLines.skipped.length} ineligible slots omitted*`);
    }

    await notifyScan(scanLines.join("\n"));

    // Cap reached: switch to notify-only (all months, no blackout filter)
    if (atCap) {
      log(`Notify-only mode (booked ${sessionBookedCount} this session, ${bookedKeys.size} scraped). Alerting about open slots.`);
      const notifySlots = allSlots
        .map((slot) => ({ slot, ...isEligible(slot, true) }))  // ignoreBlackout = true
        .filter((s) => s.eligible)
        .filter((s) => !isAlreadyBooked(s.slot));
      if (notifySlots.length === 0) return false;
      const lines = notifySlots
        .map(({ slot, pickup }) => {
          const countdown = timeUntilSlot(slot.dateText);
          const blackoutTag = isBlackedOut(slot) ? " 🚫blackout" : "";
          return `• ${slot.dateText} — ${slot.instructor} → ${pickup}${blackoutTag}${countdown ? ` (${countdown})` : ""}`;
        })
        .join("\n");
      await notifyAlert(
        `👀 **${notifySlots.length} Open Slot${notifySlots.length > 1 ? "s" : ""} Available** (notify-only)\n\n${lines}`
      );
      return false;
    }

    if (slotsToBook.length === 0) {
      log("No new bookable slots right now. Will keep checking...");
      return false;
    }

    // For booking: only attempt Mar/Apr slots (month <= 4)
    const slotsToBookFiltered = slotsToBook.filter(({ slot }) => {
      const p = parseSlotDate(slot.dateText);
      return p && p.month <= 4;
    });

    if (slotsToBookFiltered.length === 0) {
      log("No bookable slots in Mar/Apr right now. Will keep watching...");
      return false;
    }

    // Alert on important channel when eligible slots are found
    const alertLines = slotsToBookFiltered
      .map(({ slot, pickup }) => {
        const countdown = timeUntilSlot(slot.dateText);
        return `• ${slot.dateText} — ${slot.instructor} → ${pickup}${countdown ? ` (${countdown})` : ""}`;
      })
      .join("\n");

    await notifyAlert(
      `🔔 **${slotsToBookFiltered.length} New Slot${slotsToBookFiltered.length > 1 ? "s" : ""} Found!**\n` +
      `Attempting to book...\n\n${alertLines}`
    );

    let anyBooked = false;
    for (const { slot, pickup } of slotsToBookFiltered) {
      if (atCap) {
        log(`Skipping ${slot.dateText} — lesson cap reached (${bookedKeys.size} scraped, ${sessionBookedCount} this session).`);
        break;
      }
      // Skip if we already booked a lesson on this day during this run
      const parsed = parseSlotDate(slot.dateText);
      if (parsed) {
        const dayKey = `${parsed.year}-${parsed.month}-${parsed.day}`;
        if (bookedDays.has(dayKey)) {
          log(`Skipping ${slot.dateText} — already have a lesson on this day`);
          continue;
        }
      }

      const success = await bookSlot(page, slot, pickup);
      if (success) {
        anyBooked = true;
        sessionBookedCount++;
        const key = slotDateKey(slot.dateText);
        if (key) bookedKeys.add(key);
        // Track the day so we don't try to book another slot on the same day
        if (parsed) {
          bookedDays.add(`${parsed.year}-${parsed.month}-${parsed.day}`);
        }
        log("Lesson booked successfully!");
        const countdown = timeUntilSlot(slot.dateText);
        await notifyAlert(
          `✅ **Driving Lesson Booked!**\n\n` +
          `📅 ${slot.dateText}\n` +
          `👤 ${slot.instructor}\n` +
          `📍 Pickup: ${pickup}\n` +
          `⏳ ${countdown}\n` +
          `🕐 ${new Date().toLocaleString("en-US")}`
        );
      } else {
        await notifyAlert(
          `⚠️ **Booking Failed**\n` +
          `📅 ${slot.dateText} — ${slot.instructor}\n` +
          `Slot may have been taken.`
        );
      }
    }
    return anyBooked;
  } finally {
    activeBrowser = null;
    try {
      await withTimeout(browser.close(), 10_000, "browser close");
    } catch {
      log("Browser close timed out — force-killing process...");
      browser.process()?.kill("SIGKILL");
    }
    log("Browser closed.");
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────────────
let activeBrowser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
// Cap: book at most 1 more lesson this session; after that switch to notify-only
let sessionBookedCount = 0;

async function shutdown(signal: string): Promise<void> {
  log(`Received ${signal}, shutting down...`);
  if (activeBrowser) {
    try { await activeBrowser.close(); } catch {}
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log(`Unhandled rejection: ${msg}`);
  sendDiscord(DISCORD_ALERT, `💀 **Unhandled Rejection**\n${msg}\nTime: ${new Date().toLocaleString("en-US")}`).finally(() => process.exit(1));
});

async function main(): Promise<void> {
  const port = process.env.PORT || 3000;
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("running");
  });
  server.on("error", (err) => log(`Health server error: ${err.message}`));
  server.listen(port, () => log(`Health server listening on port ${port}`));

  log("Starting driving lesson booker...");

  await notifyAlert(
    `🟢 **Driving Booker Started**\nPolling every ${POLL_INTERVAL_MS / 60_000} minutes.` +
    `\nBlackout dates: Feb 17-23, Apr 18-27` +
    `\nBooking cap: 1 lesson (Mar/Apr only — no May+). Notify-only after that.` +
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
    let booked = false;
    try {
      booked = await withTimeout(openBrowserAndScan(), SCAN_TIMEOUT_MS, "full scan");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack ?? "" : "";
      log(`Error during scan: ${msg}`);
      // Force-kill any lingering browser process on timeout
      if (activeBrowser) {
        log("Killing lingering browser after scan error...");
        activeBrowser.process()?.kill("SIGKILL");
        activeBrowser = null;
      }
      // Strip file paths from stack before sending to Discord
      const safeStack = stack.replace(/\(.*?:\d+:\d+\)/g, "").substring(0, 400);
      await notifyAlert(
        `🚨 **Scan Error**\n\nError: ${msg}\n\nStack:\n\`\`\`\n${safeStack}\n\`\`\`\nTime: ${new Date().toLocaleString("en-US")}`
      );
    }

    // If we just booked something, re-scan immediately to check for more slots
    if (booked) {
      log("Booking made! Re-scanning immediately to check for more slots...");
      continue;
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
