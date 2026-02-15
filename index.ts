import puppeteer, { type Page } from "puppeteer";
import http from "http";

// ── Config ──────────────────────────────────────────────────────────────────
const LOGIN_URL =
  "https://www.tds.ms/CentralizeSP/Student/Login/chelmsfordautoschool";

const USERNAME = process.env.TDS_USERNAME!;
const PASSWORD = process.env.TDS_PASSWORD!;

const POLL_INTERVAL_MS = 3 * 60_000;
const MAX_PAGES = 10; // safety cap; actual page count detected dynamically
const MAX_MONTHS_AHEAD = 4;

const DISCORD_LOG = process.env.DISCORD_WEBHOOK!;
const DISCORD_ALERT = process.env.DISCORD_WEBHOOK_IMPORTANT!;

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

// ── Discord notifications ──────────────────────────────────────────────────

async function sendDiscord(webhookUrl: string, message: string): Promise<void> {
  if (!webhookUrl) return;
  try {
    const truncated = message.length > 1900 ? message.substring(0, 1900) + "\n..." : message;
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: truncated }),
    });
    if (!resp.ok && resp.status !== 204) {
      log(`Discord send failed: ${resp.status}`);
    }
  } catch (err) {
    log(`Discord send error: ${err}`);
  }
}

async function notifyLog(message: string): Promise<void> {
  await sendDiscord(DISCORD_LOG, message);
}

async function notifyAlert(message: string): Promise<void> {
  await sendDiscord(DISCORD_ALERT, message);
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
  // Navigate to schedule page
  await page.goto("https://www.tds.ms/CentralizeSP/BtwScheduling/Lessons?SchedulingTypeId=-1", {
    waitUntil: "networkidle2",
    timeout: 30_000,
  });

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

async function getPageLinks(page: Page): Promise<{ maxPage: number; nextUrl: string | null; pageUrls: Record<number, string> }> {
  return page.evaluate(() => {
    let maxPage = 1;
    let nextUrl: string | null = null;
    const pageUrls: Record<number, string> = {};

    const links = document.querySelectorAll("a");
    for (const link of links) {
      const href = link.href || "";
      const rawHref = link.getAttribute("href") || "";
      const text = link.textContent?.trim() || "";
      if (!href || rawHref.startsWith("javascript:")) continue;

      const pageMatch = href.match(/[?&]page=(\d+)/);
      if (pageMatch) {
        const pageNum = parseInt(pageMatch[1], 10);
        if (pageNum > maxPage) maxPage = pageNum;
        pageUrls[pageNum] = href;

        if (text === ">") {
          nextUrl = href;
        }
      }
    }

    return { maxPage, nextUrl, pageUrls };
  });
}

async function goToPage(page: Page, targetPage: number): Promise<boolean> {
  // Tag the specific page number link so we can click it with Puppeteer's native click
  const found = await page.evaluate((target) => {
    document.querySelectorAll("[data-nav-target]").forEach(el => el.removeAttribute("data-nav-target"));
    const links = document.querySelectorAll("a");
    for (const link of links) {
      const text = link.textContent?.trim();
      const href = link.href || "";
      if (text === String(target) && href.includes("page=")) {
        link.setAttribute("data-nav-target", "true");
        return true;
      }
    }
    return false;
  }, targetPage);

  if (!found) {
    log(`No page link found for page ${targetPage}`);
    return false;
  }

  // Puppeteer's native click fires real mouse events (mousedown/mouseup/click)
  // unlike evaluate(() => el.click()) which only fires a synthetic click event.
  // Promise.all ensures navigation listener is set up BEFORE the click.
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15_000 }).catch(() => {}),
    page.click('[data-nav-target="true"]'),
  ]);
  await sleep(1000);
  return true;
}

async function clickToPage(page: Page, targetPage: number): Promise<boolean> {
  return goToPage(page, targetPage);
}

async function clickNextMonth(page: Page): Promise<boolean> {
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
  log(`Advanced calendar via ${clicked}`);
  await sleep(2000);

  // Click the last available date in the datepicker (likely the newest month)
  const dateClicked = await page.evaluate(() => {
    const cells = document.querySelectorAll(
      ".ui-datepicker td:not(.ui-state-disabled) a, .datepicker td:not(.disabled) a"
    );
    if (cells.length > 0) {
      (cells[cells.length - 1] as HTMLElement).click();
      return true;
    }
    return false;
  });

  if (dateClicked) {
    await Promise.race([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 10_000 }).catch(() => {}),
      sleep(5000),
    ]);
  } else {
    await sleep(3000);
  }

  await page.waitForSelector("table tbody tr", { timeout: 15_000 }).catch(() => {
    log("No slots table after advancing month.");
  });
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

  // Helper: scrape all pages in the current table view
  async function scrapeAllPages(label: string): Promise<number> {
    let totalNew = 0;
    const page1Slots = await scrapeCurrentPage(page, 1, 0);
    totalNew += addSlots(page1Slots);

    const { maxPage } = await getPageLinks(page);
    const pageLimit = Math.min(maxPage, MAX_PAGES);
    log(`${label}: pg 1 → ${page1Slots.length} slots [${monthSummary(page1Slots)}], ${pageLimit} pages`);

    for (let p = 2; p <= pageLimit; p++) {
      try {
        const navigated = await goToPage(page, p);
        if (!navigated) break;

        const pageSlots = await scrapeCurrentPage(page, p, 0);
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
  await scrapeAllPages("Default");

  // 2) Try advancing the calendar to find slots in additional months
  for (let m = 0; m < MAX_MONTHS_AHEAD; m++) {
    await navigateToSchedule(page);
    let advanced = true;
    for (let i = 0; i <= m; i++) {
      if (!await clickNextMonth(page)) {
        advanced = false;
        break;
      }
    }
    if (!advanced) {
      log(`Calendar: no more months after +${m}.`);
      break;
    }

    const newFound = await scrapeAllPages(`Calendar +${m + 1}`);
    if (newFound === 0) {
      log(`No new slots after calendar +${m + 1}. Done.`);
      break;
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
      for (let m = 0; m < slot.monthOffset; m++) {
        const advanced = await clickNextMonth(page);
        if (!advanced) {
          log(`Could not advance to month offset ${slot.monthOffset} for booking.`);
          return false;
        }
      }
    }

    if (slot.page > 1) {
      const reached = await clickToPage(page, slot.page);
      if (!reached) {
        log(`Could not navigate to page ${slot.page} for booking.`);
        return false;
      }
    }
    await sleep(1000);

    // Find and click the slot link in the table
    const slotClicked = await page.evaluate((targetDate) => {
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

    // Detailed breakdown for each slot
    const allSlotLines = allSlots.map(s => {
      const { eligible, pickup } = isEligible(s);
      const bo = isBlackedOut(s);
      const tag = bo ? "🚫 BLACKOUT" : eligible ? `✅ ELIGIBLE (${pickup})` : "⏭️ skip";
      return `${tag} — ${s.dateText} | ${s.instructor}`;
    });

    // Build full scan message for log channel
    const months = [...new Set(allSlots.map(s => parseSlotDate(s.dateText)?.month).filter(Boolean))].sort();
    const monthNames = months.map(m => Object.entries(MONTH_MAP).find(([, v]) => v === m)?.[0] ?? "?");

    const scanMsg = [
      `📋 **Scan Complete** — ${new Date().toLocaleString("en-US")}`,
      ``,
      `**Months scanned:** ${monthNames.join(", ") || "none"}`,
      `**Total slots:** ${allSlots.length}`,
      `**Eligible:** ${slotsToBook.length}`,
      `**Blacked out:** ${blackoutCount}`,
      `**Skipped (wrong time):** ${skippedCount}`,
      ``,
      `**All slots:**`,
      ...allSlotLines,
    ].join("\n");

    await notifyLog(scanMsg);

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
