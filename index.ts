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

const POLL_INTERVAL_MS = 3 * 60_000;
const MAX_PAGES = 20;

// Set to true to book the first available slot regardless of eligibility (for testing)
const TEST_MODE = process.env.TEST_MODE === "true";

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
  if (!webhookUrl) {
    log("Discord webhook not configured");
    return;
  }
  try {
    const tmpFile = `/tmp/discord_${Date.now()}.json`;
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

  const page1Slots = await scrapeCurrentPage(page, 1);
  addSlots(page1Slots);
  log(`  Page 1: ${page1Slots.length} slots`);

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

    // Navigate directly to the page containing this slot
    const url = slot.page > 1 ? `${SCHEDULE_URL}&page=${slot.page}` : SCHEDULE_URL;
    await page.goto(url, { waitUntil: "networkidle2", timeout: 15_000 });
    await sleep(2000);

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

    log("Clicked slot link, waiting for booking dialog...");
    await sleep(3000);

    // Debug: log what's visible in the dialog
    const dialogInfo = await page.evaluate(() => {
      const radios = document.querySelectorAll('input[type="radio"]');
      const radioInfo: string[] = [];
      radios.forEach((r) => {
        const input = r as HTMLInputElement;
        const label = r.closest("label")?.textContent?.trim()
          || r.closest("li")?.textContent?.trim()
          || r.closest("div")?.textContent?.trim()?.substring(0, 50)
          || "no label";
        radioInfo.push(`name=${input.name} value=${input.value} checked=${input.checked} label="${label}"`);
      });

      const selects = document.querySelectorAll("select");
      const selectInfo: string[] = [];
      selects.forEach((s) => {
        const opts = Array.from(s.options).map(o => `${o.value}="${o.text}"`);
        selectInfo.push(`select#${s.id}: ${opts.join(", ")}`);
      });

      const buttons = document.querySelectorAll("button, input[type='submit']");
      const buttonInfo: string[] = [];
      buttons.forEach((b) => {
        const text = b.textContent?.trim() || (b as HTMLInputElement).value || "";
        if (text) buttonInfo.push(text);
      });

      // Check for modal/dialog
      const modals = document.querySelectorAll(".modal, [class*='dialog'], [class*='popup'], [role='dialog']");

      return {
        radios: radioInfo,
        selects: selectInfo,
        buttons: buttonInfo,
        modalCount: modals.length,
        bodyText: document.body.innerText.substring(document.body.innerText.length - 2000),
      };
    });

    log(`Dialog debug - radios: ${JSON.stringify(dialogInfo.radios)}`);
    log(`Dialog debug - selects: ${JSON.stringify(dialogInfo.selects)}`);
    log(`Dialog debug - buttons: ${JSON.stringify(dialogInfo.buttons)}`);
    log(`Dialog debug - modals: ${dialogInfo.modalCount}`);

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

    log(`Radio selection: ${radioSelected}`);
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

    let slotsToBook: { slot: Slot; pickup: "Home" | "High School" }[];

    if (TEST_MODE) {
      // In test mode: book the first available slot regardless of eligibility
      log("⚠️ TEST MODE: will book the first available slot!");
      slotsToBook = allSlots.length > 0 ? [{ slot: allSlots[0], pickup: "Home" }] : [];
    } else {
      slotsToBook = allSlots
        .map((slot) => ({ slot, ...isEligible(slot) }))
        .filter((s) => s.eligible);
    }

    // Build scan summary
    const eligibleList = slotsToBook.length > 0
      ? slotsToBook.map(({ slot, pickup }) =>
          `  • ${slot.dateText} | ${slot.instructor} | ${pickup}`
        ).join("\n")
      : "  None";

    const blackoutCount = allSlots.filter(s => isBlackedOut(s)).length;

    const scanMsg = [
      `📋 **Scan Complete** — ${new Date().toLocaleString("en-US")}`,
      `Total: ${allSlots.length} | Eligible: ${slotsToBook.length} | Blacked out: ${blackoutCount}`,
      `${TEST_MODE ? "⚠️ **TEST MODE ON**\n" : ""}`,
      `Eligible slots:\n${eligibleList}`,
    ].join("\n");

    await notifyLog(scanMsg);
    log(`Found ${allSlots.length} total, ${slotsToBook.length} eligible, ${blackoutCount} blacked out.`);

    if (slotsToBook.length === 0) {
      log("No eligible slots right now. Will keep checking...");
      return;
    }

    for (const { slot, pickup } of slotsToBook) {
      const success = await bookSlot(page, slot, pickup);
      if (success) {
        log("Lesson booked successfully!");
        await notifyAlert(
          `✅ **Driving Lesson Booked!**\n\n` +
          `📅 ${slot.dateText}\n` +
          `👤 Instructor: ${slot.instructor}\n` +
          `📍 Pickup: ${pickup}\n` +
          `🕐 ${new Date().toLocaleString("en-US")}` +
          `${TEST_MODE ? "\n⚠️ TEST MODE — cancel this booking!" : ""}`
        );
      }

      // In test mode, only book one slot
      if (TEST_MODE) break;
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
  if (TEST_MODE) log("⚠️ TEST MODE ENABLED — will book first available slot!");

  await notifyAlert(
    `🟢 **Driving Booker Started**\nPolling every ${POLL_INTERVAL_MS / 60_000} minutes.` +
    `${TEST_MODE ? "\n⚠️ **TEST MODE ON** — will book first available slot!" : ""}` +
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

    // In test mode, stop after one scan
    if (TEST_MODE) {
      log("Test mode: stopping after one scan.");
      await notifyAlert("🔵 **Test mode complete** — remove TEST_MODE env var to run normally.");
      break;
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
