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
const MAX_PAGES = 50; // safety cap only (pagination stops naturally when no more pages)

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
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseSlotDate(dateText: string): { dayOfWeek: string; month: number; day: number; hour: number; minute: number } | null {
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
  const d = dayOfWeek.toUpperCase();
  return d === "SAT" || d === "SUN";
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
  await screenshot(page, "01-after-login");
}

async function navigateToSchedule(page: Page): Promise<void> {
  await ensurePageReady(page);

  const url = "https://www.tds.ms/CentralizeSP/BtwScheduling/Lessons?SchedulingTypeId=-1";
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
  } catch {
    await sleep(3000);
    await ensurePageReady(page);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
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
  await screenshot(page, "02-schedule-loaded");
}

async function scrapeCurrentPage(page: Page, pageNum: number): Promise<Slot[]> {
  return page.evaluate((pn) => {
    const rows = document.querySelectorAll("table tbody tr");
    const slots: { dateText: string; instructor: string; rowIndex: number; page: number }[] = [];

    rows.forEach((row, idx) => {
      const cells = row.querySelectorAll("td");
      if (cells.length >= 2) {
        const dateText = cells[0]?.textContent?.trim() ?? "";
        const instructor = cells[1]?.textContent?.trim() ?? "";
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
    const cur = await getCurrentPage(page);
    if (cur === targetPage) {
      arrived = true;
      break;
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

  // Log summary
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

    // Navigate to schedule list
    await navigateToSchedule(page);

    // Find and click the slot link — check page 1 first, then paginate
    let slotClicked = false;

    // Try page 1 (already loaded in DOM)
    slotClicked = await page.evaluate((targetDate) => {
      const rows = document.querySelectorAll("table tbody tr");
      for (const row of rows) {
        const firstTd = row.querySelector("td:first-child");
        const clickable = firstTd?.querySelector("a") || firstTd?.querySelector("span") || firstTd?.querySelector("button") || firstTd;
        if (clickable && firstTd?.textContent?.trim() === targetDate) {
          (clickable as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, slot.dateText);

    if (slotClicked) {
      log(`Found slot on page 1: ${slot.dateText}`);
    }

    // If not on page 1, click through pagination to find the slot
    if (!slotClicked) {
      const bookMaxPage = await getMaxPage(page);

      // Try the slot's known page first, then other pages
      const pagesToTry = slot.page > 1
        ? [slot.page, ...Array.from({ length: bookMaxPage }, (_, i) => i + 1).filter(p => p !== slot.page && p !== 1)]
        : Array.from({ length: bookMaxPage - 1 }, (_, i) => i + 2);

      for (const p of pagesToTry) {
        const navigated = await goToPage(page, p);
        if (!navigated) continue;

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
    await screenshot(page, "05-booking-result");

    if (result === "success") {
      log(`BOOKED: ${slot.dateText} with ${slot.instructor} (pickup: ${pickup})`);
      return true;
    }

    log(`Booking may have failed: ${result}`);
    await screenshot(page, "05-booking-failed");
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
  const browser = await puppeteer.launch({
    headless: process.env.HEADLESS !== "false",
    defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--force-device-scale-factor=1"],
  });
  activeBrowser = browser;

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
      return false;
    }

    // Alert on important channel when eligible slots are found
    const eligibleLines = slotsToBook
      .map(({ slot, pickup }) => `• ${slot.dateText} | ${slot.instructor} | pickup: ${pickup}`)
      .join("\n");

    await notifyAlert(
      `🔔 **${slotsToBook.length} Eligible Slot${slotsToBook.length > 1 ? "s" : ""} Found!**\n` +
      `Attempting to book...\n\n${eligibleLines}`
    );

    let anyBooked = false;
    for (const { slot, pickup } of slotsToBook) {
      const success = await bookSlot(page, slot, pickup);
      if (success) {
        anyBooked = true;
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
    return anyBooked;
  } finally {
    activeBrowser = null;
    await browser.close();
    log("Browser closed.");
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────────────
let activeBrowser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;

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
  log(`Unhandled rejection: ${reason}`);
});

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
    let booked = false;
    try {
      booked = await openBrowserAndScan();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack ?? "" : "";
      log(`Error during scan: ${msg}`);
      await notifyAlert(
        `🚨 **Scan Error**\n\nError: ${msg}\n\nStack:\n\`\`\`\n${stack.substring(0, 500)}\n\`\`\`\nTime: ${new Date().toLocaleString("en-US")}`
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
