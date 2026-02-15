import puppeteer, { type Page } from "puppeteer";
import http from "http";
import fs from "fs";

// ── Config ──────────────────────────────────────────────────────────────────
const LOGIN_URL =
  "https://www.tds.ms/CentralizeSP/Student/Login/chelmsfordautoschool";
const SCHEDULE_URL =
  "https://www.tds.ms/CentralizeSP/BtwScheduling/Lessons?SchedulingTypeId=1";

const USERNAME = process.env.TDS_USERNAME!;
const PASSWORD = process.env.TDS_PASSWORD!;

const POLL_INTERVAL_MS = 3 * 60_000; // check every 3 minutes
const MAX_PAGES = 20;

// Regular updates (every scan cycle)
const DISCORD_LOG = process.env.DISCORD_WEBHOOK!;
// Important alerts (bookings + errors only)
const DISCORD_ALERT = process.env.DISCORD_WEBHOOK_IMPORTANT!;

// ── Types ───────────────────────────────────────────────────────────────────
interface Slot {
  dateText: string;
  instructor: string;
  rowIndex: number;
  page: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseSlotTime(dateText: string): { dayOfWeek: string; hour: number; minute: number } | null {
  const match = dateText.match(
    /^(\w+),\s+\w+\s+\d+,\s+(\d{1,2}):(\d{2})\s+(AM|PM)/
  );
  if (!match) return null;

  const dayOfWeek = match[1];
  let hour = parseInt(match[2], 10);
  const minute = parseInt(match[3], 10);
  const ampm = match[4];

  if (ampm === "PM" && hour !== 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;

  return { dayOfWeek, hour, minute };
}

function isWeekend(dayOfWeek: string): boolean {
  return dayOfWeek === "Sat" || dayOfWeek === "Sun";
}

function isEligible(slot: Slot): { eligible: boolean; pickup: "Home" | "High School" } {
  const parsed = parseSlotTime(slot.dateText);
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
  if (!webhookUrl) {
    log("Discord webhook not configured");
    return;
  }
  try {
    // Write JSON to a temp file to avoid shell escaping issues
    const tmpFile = `/tmp/discord_${Date.now()}.json`;
    // Discord max message length is 2000 chars
    const truncated = message.length > 1900 ? message.substring(0, 1900) + "\n..." : message;
    fs.writeFileSync(tmpFile, JSON.stringify({ content: truncated }));
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: fs.readFileSync(tmpFile, "utf-8"),
    });
    fs.unlinkSync(tmpFile);
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
  log("Navigating to Schedule My Drive...");
  // Must visit My Schedule first, then click Schedule My Drive tab
  // (sets server-side session state needed for pagination to work)
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

  await sleep(2000);
}

async function scrapeCurrentPage(page: Page, pageNum: number): Promise<Slot[]> {
  return page.evaluate((pn) => {
    const rows = document.querySelectorAll("table tbody tr");
    const slots: Slot[] = [];

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

  // Page 1 is already loaded
  const page1Slots = await scrapeCurrentPage(page, 1);
  addSlots(page1Slots);
  log(`  Page 1: ${page1Slots.length} slots`);

  // Navigate directly to each subsequent page
  for (let p = 2; p <= MAX_PAGES; p++) {
    try {
      await page.goto(`${SCHEDULE_URL}&page=${p}`, { waitUntil: "networkidle2", timeout: 15_000 });
      await sleep(1000);
      const pageSlots = await scrapeCurrentPage(page, p);
      const newCount = addSlots(pageSlots);
      log(`  Page ${p}: ${pageSlots.length} slots (${newCount} new, ${allSlots.length} unique total)`);
      if (pageSlots.length === 0) break;
    } catch {
      log(`  Page ${p}: failed to load, stopping.`);
      break;
    }
  }

  return allSlots;
}

// Returns ms until the next XX:00:05 or XX:30:05
function msUntilNextHourEdge(): number {
  const now = new Date();
  const min = now.getMinutes();
  const sec = now.getSeconds();
  const ms = now.getMilliseconds();

  const currentMs = (min * 60 + sec) * 1000 + ms;

  const target1 = (0 * 60 + 5) * 1000;   // 00:05.000
  const target2 = (30 * 60 + 5) * 1000;  // 30:05.000
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

    // Navigate directly to the page containing this slot
    const url = slot.page > 1 ? `${SCHEDULE_URL}&page=${slot.page}` : SCHEDULE_URL;
    await page.goto(url, { waitUntil: "networkidle2", timeout: 15_000 });
    await sleep(2000);

    // Find and click the slot link
    const slotLinks = await page.$$("table tbody tr td:first-child a");
    let clicked = false;

    for (const link of slotLinks) {
      const text = await link.evaluate((el) => el.textContent?.trim() ?? "");
      if (text === slot.dateText) {
        await link.click();
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      log(`Could not find slot link for: ${slot.dateText}`);
      return false;
    }

    await sleep(1500);

    // Select pickup location
    await page.evaluate((pickupType) => {
      const radios = document.querySelectorAll('input[type="radio"]');
      for (const radio of radios) {
        const label = radio.closest("li")?.textContent?.trim();
        if (label && label.includes(pickupType)) {
          (radio as HTMLInputElement).click();
          break;
        }
      }
    }, pickup);

    await sleep(500);

    // Click "Schedule Lesson"
    const scheduled = await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        if (btn.textContent?.trim() === "Schedule Lesson") {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!scheduled) {
      log("Schedule Lesson button not found.");
      return false;
    }
    await sleep(3000);

    log(`BOOKED: ${slot.dateText} with ${slot.instructor} (pickup: ${pickup})`);
    return true;
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

    const eligibleSlots = allSlots
      .map((slot) => ({ slot, ...isEligible(slot) }))
      .filter((s) => s.eligible);

    // Build scan summary for the log channel
    const eligibleList = eligibleSlots.length > 0
      ? eligibleSlots.map(({ slot, pickup }) =>
          `  • ${slot.dateText} | ${slot.instructor} | ${pickup}`
        ).join("\n")
      : "  None";

    const scanMsg = [
      `📋 **Scan Complete** — ${new Date().toLocaleString("en-US")}`,
      `Total slots: ${allSlots.length} | Eligible: ${eligibleSlots.length}`,
      `\nEligible slots:\n${eligibleList}`,
    ].join("\n");

    await notifyLog(scanMsg);
    log(`Found ${allSlots.length} total, ${eligibleSlots.length} eligible.`);

    if (eligibleSlots.length === 0) {
      log("No eligible slots right now. Will keep checking...");
      return;
    }

    // Book all eligible slots
    for (const { slot, pickup } of eligibleSlots) {
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
      }
    }
  } finally {
    await browser.close();
    log("Browser closed.");
  }
}

async function main(): Promise<void> {
  // Health check server so Railway doesn't kill the container
  const port = process.env.PORT || 3000;
  http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("running");
  }).listen(port, () => log(`Health server listening on port ${port}`));

  log("Starting driving lesson booker...");

  // Startup notification
  await notifyAlert(
    `🟢 **Driving Booker Started**\nPolling every ${POLL_INTERVAL_MS / 60_000} minutes.\nTime: ${new Date().toLocaleString("en-US")}`
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
