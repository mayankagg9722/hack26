/* Timezone-aware date helpers (no dependencies). Schedules are expressed in
   the customer's local time ("Saturday 11 PM") and stored as UTC ISO strings
   alongside the IANA timezone they were resolved in. */

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_ABBR = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch (err) {
    return false;
  }
}

/** Local calendar parts of an instant in a timezone. weekday: 0 = Sunday. */
function zonedParts(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    year: +get("year"), month: +get("month"), day: +get("day"),
    hour: +get("hour") % 24, minute: +get("minute"),
    weekday: DAY_ABBR.indexOf(get("weekday").toLowerCase()),
  };
}

function tzOffsetMs(ts, tz) {
  const p = zonedParts(new Date(ts), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(ts / 60000) * 60000;
}

/** The instant at local wall-clock time y-m-d h:mi in tz. */
function zonedToUtc(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - tzOffsetMs(guess, tz);
  const second = guess - tzOffsetMs(t, tz);
  if (second !== t) t = second;
  return new Date(t);
}

/** Local date arithmetic on {year, month, day}. */
function addDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function weekdayOf({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const h = +m[1];
  const mi = +m[2];
  return h < 24 && mi < 60 ? { h, mi } : null;
}

function hhmm(h, mi) {
  return String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0");
}

/**
 * Is the instant inside any blackout period?
 * blackout: { days: ["mon", ...], start: "09:00", end: "18:00" } in local time.
 */
function inBlackout(date, blackouts, tz) {
  if (!blackouts || !blackouts.length) return null;
  const p = zonedParts(date, tz);
  const minutes = p.hour * 60 + p.minute;
  for (const b of blackouts) {
    const s = parseHHMM(b.start);
    const e = parseHHMM(b.end);
    if (!s || !e) continue;
    if (!(b.days || []).includes(DAY_ABBR[p.weekday])) continue;
    const sm = s.h * 60 + s.mi;
    const em = e.h * 60 + e.mi;
    if (minutes >= sm && minutes < em) return b;
  }
  return null;
}

/** First blackout the interval [start, end) touches, checked every 15 minutes. */
function windowBlackoutConflict(start, end, blackouts, tz) {
  if (!blackouts || !blackouts.length) return null;
  for (let t = start.getTime(); t < end.getTime(); t += 15 * 60000) {
    const hit = inBlackout(new Date(t), blackouts, tz);
    if (hit) return { at: new Date(t).toISOString(), blackout: hit };
  }
  return null;
}

module.exports = {
  DAYS,
  DAY_ABBR,
  isValidTimeZone,
  zonedParts,
  zonedToUtc,
  addDays,
  weekdayOf,
  parseHHMM,
  hhmm,
  inBlackout,
  windowBlackoutConflict,
};
