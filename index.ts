import puppeteer, { type Page } from "puppeteer";
import nodemailer from "nodemailer";

// ── Config ──────────────────────────────────────────────────────────────────
const LOGIN_URL =
  "https://www.tds.ms/CentralizeSP/Student/Login/chelmsfordautoschool";
const SCHEDULE_URL =
  "https://www.tds.ms/CentralizeSP/BtwScheduling/Lessons?SchedulingTypeId=-1";

const USERNAME = process.env.TDS_USERNAME!;
const PASSWORD = process.env.TDS_PASSWORD!;

const POLL_INTERVAL_MS = 3 * 60_000; // check every 3 minutes
const MAX_PAGES = 20; // scan all pagination pages

const ALERT_EMAIL = process.env.ALERT_EMAIL!;
const EMAIL_USER = process.env.EMAIL_USER!;
const EMAIL_PASS = process.env.EMAIL_PASS!;

// ── Types ───────────────────────────────────────────────────────────────────
interface Slot {
  dateText: string; // e.g. "Mon, Mar 16, 3:00 PM - 4:30 PM"
  instructor: string;
  rowIndex: number;
  page: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseSlotTime(dateText: string): { dayOfWeek: string; hour: number; minute: number } | null {
  // Format: "Mon, Mar 16, 3:00 PM - 4:30 PM"
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
    // Weekends: any time, pickup = Home
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

// ── Email failsafe ──────────────────────────────────────────────────────────

async function sendEmail(subject: string, body: string): Promise<void> {
  if (!EMAIL_USER || !EMAIL_PASS) {
    log(`EMAIL NOT CONFIGURED — would have sent: "${subject}"`);
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    });

    await transporter.sendMail({
      from: EMAIL_USER,
      to: ALERT_EMAIL,
      subject,
      text: body,
    });

    log(`Email sent: "${subject}"`);
  } catch (emailErr) {
    log(`Failed to send email: ${emailErr}`);
  }
}

async function sendErrorAlert(error: unknown, context: string): Promise<void> {
  const msg = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack ?? "" : "";

  await sendEmail(
    `Driving Booker Error: ${context}`,
    `An error occurred in the driving lesson booker.\n\nContext: ${context}\nError: ${msg}\n\nStack:\n${stack}\n\nTime: ${new Date().toISOString()}`
  );
}

// ── Browser actions ─────────────────────────────────────────────────────────

async function login(page: Page): Promise<void> {
  log("Navigating to login page...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Wait for login form to be ready
  await page.waitForSelector("#username", { visible: true, timeout: 15_000 });

  // Clear fields first (in case of re-login) then fill
  await page.$eval("#username", (el) => ((el as HTMLInputElement).value = ""));
  await page.$eval("#password", (el) => ((el as HTMLInputElement).value = ""));
  await page.type("#username", USERNAME);
  await page.type("#password", PASSWORD);

  // Click login button and wait for navigation
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
  await page.goto(SCHEDULE_URL, { waitUntil: "networkidle2" });

  // Click the "Schedule My Drive" tab
  await page.evaluate(() => {
    const links = document.querySelectorAll("a");
    for (const link of links) {
      if (link.textContent?.includes("Schedule My Drive")) {
        link.click();
        return;
      }
    }
  });

  // Wait for the slots table to appear
  await page.waitForSelector("table tbody tr", { timeout: 15_000 }).catch(() => {
    log("No slots table found (may be empty).");
  });

  // Small delay for dynamic content
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
        // Only include real slots (format: "Day, Mon DD, H:MM AM/PM - H:MM AM/PM")
        if (dateText && /^\w{3},\s+\w{3}\s+\d/.test(dateText)) {
          slots.push({ dateText, instructor, rowIndex: idx, page: pn });
        }
      }
    });

    return slots;
  }, pageNum);
}

async function goToPage(page: Page, pageNum: number): Promise<boolean> {
  try {
    const pageLink = await page.$(`a[href*="RefineSearch?page=${pageNum}"]`);
    if (!pageLink) return false;
    await pageLink.click();
    await sleep(2000);
    return true;
  } catch {
    return false;
  }
}

async function scrapeAllSlots(page: Page): Promise<Slot[]> {
  const allSlots: Slot[] = [];

  // Scrape page 1 (already loaded)
  const page1Slots = await scrapeCurrentPage(page, 1);
  allSlots.push(...page1Slots);

  // Scrape all remaining pages
  for (let p = 2; p <= MAX_PAGES; p++) {
    const navigated = await goToPage(page, p);
    if (!navigated) break;
    const pageSlots = await scrapeCurrentPage(page, p);
    if (pageSlots.length === 0) break;
    allSlots.push(...pageSlots);
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

  // Targets: 00:05 (5s into hour) and 30:05 (30m 5s into hour)
  const target1 = (0 * 60 + 5) * 1000;   // 00:05.000
  const target2 = (30 * 60 + 5) * 1000;  // 30:05.000
  const hourMs = 60 * 60 * 1000;

  const candidates = [
    target1 - currentMs,
    target2 - currentMs,
    target1 + hourMs - currentMs, // next hour's :00:05
  ];

  const positive = candidates.filter((c) => c > 0);
  return Math.min(...positive);
}

async function bookSlot(page: Page, slot: Slot, pickup: "Home" | "High School"): Promise<boolean> {
  try {
    log(`Attempting to book: ${slot.dateText} with ${slot.instructor} (pickup: ${pickup})`);

    // If not on the right page, navigate to it
    if (slot.page > 1) {
      await goToPage(page, slot.page);
    } else {
      // Go back to page 1
      const page1Link = await page.$('a[href*="RefineSearch?page=1"]');
      if (page1Link) {
        await page1Link.click();
        await sleep(2000);
      }
    }

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

    // Wait for dialog to appear
    await sleep(1500);

    // Select pickup location
    if (pickup === "Home") {
      await page.evaluate(() => {
        const radios = document.querySelectorAll('input[type="radio"]');
        for (const radio of radios) {
          const label = radio.closest("li")?.textContent?.trim();
          if (label && label.includes("Home")) {
            (radio as HTMLInputElement).click();
            break;
          }
        }
      });
    } else {
      await page.evaluate(() => {
        const radios = document.querySelectorAll('input[type="radio"]');
        for (const radio of radios) {
          const label = radio.closest("li")?.textContent?.trim();
          if (label && label.includes("High School")) {
            (radio as HTMLInputElement).click();
            break;
          }
        }
      });
    }

    await sleep(500);

    // Click "Schedule Lesson"
    const clicked2 = await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        if (btn.textContent?.trim() === "Schedule Lesson") {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!clicked2) {
      log("Schedule Lesson button not found.");
      return false;
    }
    await sleep(3000);

    log(`BOOKED: ${slot.dateText} with ${slot.instructor} (pickup: ${pickup})`);
    return true;
  } catch (err) {
    log(`Failed to book slot: ${err}`);
    await sendErrorAlert(err, `booking slot: ${slot.dateText}`);
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Main loop ───────────────────────────────────────────────────────────────

async function openBrowserAndScan(): Promise<boolean> {
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
    log(`Found ${allSlots.length} total slots across ${Math.max(...allSlots.map(s => s.page), 0)} page(s).`);

    if (allSlots.length > 0) {
      log("All available slots:");
      for (const slot of allSlots) {
        const { eligible, pickup } = isEligible(slot);
        const tag = eligible ? `ELIGIBLE (${pickup})` : "skip (wrong time)";
        log(`  [${tag}] ${slot.dateText} | ${slot.instructor}`);
      }
    }

    const eligibleSlots = allSlots
      .map((slot) => ({ slot, ...isEligible(slot) }))
      .filter((s) => s.eligible);

    if (eligibleSlots.length === 0) {
      log("No eligible slots right now. Will keep checking...");
      return false;
    }

    log(`Found ${eligibleSlots.length} eligible slot(s):`);
    for (const { slot, pickup } of eligibleSlots) {
      log(`  - ${slot.dateText} | ${slot.instructor} | pickup: ${pickup}`);
    }

    const first = eligibleSlots[0];
    const success = await bookSlot(page, first.slot, first.pickup);
    if (success) {
      log("Lesson booked successfully!");
      await sendEmail(
        "Driving Lesson Booked!",
        `Successfully booked:\n\n${first.slot.dateText}\nInstructor: ${first.slot.instructor}\nPickup: ${first.pickup}\n\nTime: ${new Date().toISOString()}`
      );
    }
    return success;
  } finally {
    await browser.close();
    log("Browser closed.");
  }
}

async function main(): Promise<void> {
  log("Starting driving lesson booker...");

  let booked = false;

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

  while (!booked) {
    try {
      booked = await openBrowserAndScan();
      if (booked) break;
    } catch (err) {
      log(`Error during scan: ${err}`);
      await sendErrorAlert(err, "scan/book cycle");
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
  await sendErrorAlert(err, "fatal crash");
  process.exit(1);
});
