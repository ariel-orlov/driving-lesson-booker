import puppeteer, { type Page } from "puppeteer";
import nodemailer from "nodemailer";
import http from "http";

// ── Config ──────────────────────────────────────────────────────────────────
const LOGIN_URL =
  "https://www.tds.ms/CentralizeSP/Student/Login/chelmsfordautoschool";
const SCHEDULE_URL =
  "https://www.tds.ms/CentralizeSP/BtwScheduling/Lessons?SchedulingTypeId=1";

const USERNAME = process.env.TDS_USERNAME!;
const PASSWORD = process.env.TDS_PASSWORD!;

const POLL_INTERVAL_MS = 3 * 60_000; // check every 3 minutes
const MAX_PAGES = 20; // scan all pagination pages

const ALERT_EMAIL = process.env.ALERT_EMAIL!;
const EMAIL_USER = process.env.EMAIL_USER!;
const EMAIL_PASS = process.env.EMAIL_PASS!;

// Unique topic for push notifications (fallback when SMTP blocked)
const NTFY_TOPIC = process.env.NTFY_TOPIC || "driving-booker-ariel-orlov";

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

// ── Notifications ──────────────────────────────────────────────────────────

async function sendPushNotification(title: string, body: string): Promise<boolean> {
  try {
    const resp = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: { "Title": title, "Priority": "high" },
      body,
    });
    if (resp.ok) {
      log(`Push notification sent: "${title}"`);
      return true;
    }
    log(`Push notification failed: ${resp.status}`);
    return false;
  } catch (err) {
    log(`Push notification error: ${err}`);
    return false;
  }
}

async function sendEmail(subject: string, body: string): Promise<boolean> {
  if (!EMAIL_USER || !EMAIL_PASS) return false;

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: EMAIL_USER, pass: EMAIL_PASS },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });

    await transporter.sendMail({
      from: EMAIL_USER,
      to: ALERT_EMAIL,
      subject,
      text: body,
    });

    log(`Email sent: "${subject}"`);
    return true;
  } catch (emailErr) {
    log(`Email failed (SMTP blocked?): ${emailErr}`);
    return false;
  }
}

async function notify(title: string, body: string): Promise<void> {
  // Try email first, fall back to push notification
  const emailSent = await sendEmail(title, body);
  if (!emailSent) {
    await sendPushNotification(title, body);
  }
}

async function sendErrorAlert(error: unknown, context: string): Promise<void> {
  const msg = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack ?? "" : "";

  await notify(
    `Driving Booker Error: ${context}`,
    `Error: ${msg}\n\nContext: ${context}\nStack:\n${stack}\nTime: ${new Date().toISOString()}`
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
  await page.goto(SCHEDULE_URL, { waitUntil: "networkidle2", timeout: 30_000 });

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

  // Navigate directly to each subsequent page via URL
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

    // Wait for dialog to appear
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
    log(`Found ${allSlots.length} unique slots across all pages.`);

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

    for (const { slot, pickup } of eligibleSlots) {
      const success = await bookSlot(page, slot, pickup);
      if (success) {
        log("Lesson booked successfully!");
        await notify(
          "Driving Lesson Booked!",
          `Successfully booked:\n\n${slot.dateText}\nInstructor: ${slot.instructor}\nPickup: ${pickup}\n\nTime: ${new Date().toISOString()}`
        );
      }
    }
    return false; // keep polling for more slots
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

  // Verify notifications work on startup
  await notify(
    "Driving Booker Started",
    `The driving lesson booker is now running.\n\nTime: ${new Date().toISOString()}`
  );

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
