'use strict';

/**
 * src/scheduler.js
 * setTimeout-based recurring scheduler. No external dependencies.
 * Computes ms-to-next-run at each step so it stays accurate across DST
 * boundaries and system sleep/wake.
 *
 * Schedule shape:
 *   {
 *     enabled:       boolean,
 *     frequencyDays: number,   // interval between runs in days (1 = daily, 7 = weekly)
 *     hour:          number,   // 0-23 local time-of-day for the run
 *     minute:        number,   // 0-59
 *     daysAgo:       number,   // scrape window passed to the run (1/3/7/30)
 *   }
 *
 * Usage:
 *   const scheduler = require('./scheduler');
 *   scheduler.setup({ enabled: true, frequencyDays: 1, hour: 8, minute: 30, daysAgo: 7 }, triggerFn);
 *   scheduler.teardown();  // cancels any pending timer
 */

let _timer  = null;
let _active = false;

const clamp = (v, lo, hi, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

// setTimeout overflows past ~24.8 days; cap a single wait and re-chain if needed.
const MAX_DELAY = 2_000_000_000; // ~23 days

/**
 * Set up (or replace) the scheduled task.
 * @param {object} schedule  - see shape above
 * @param {function} trigger - async fn(options) called when the timer fires
 */
function setup(schedule, trigger) {
  teardown();
  if (!schedule?.enabled) return;

  const frequencyDays = Math.max(1, clamp(schedule.frequencyDays, 1, 365, 1));
  const hour    = clamp(schedule.hour,   0, 23, 8);
  const minute  = clamp(schedule.minute, 0, 59, 0);
  const daysAgo = clamp(schedule.daysAgo, 1, 365, 7);
  _active = true;

  // Next occurrence of hour:minute strictly after `after`.
  function nextTimeOfDay(after) {
    const next = new Date(after);
    next.setHours(hour, minute, 0, 0);
    while (next <= after) next.setDate(next.getDate() + 1);
    return next;
  }

  // Arm a timer for `target` (a Date), re-chaining across the setTimeout cap.
  function armUntil(target, onFire) {
    if (!_active) return;
    const ms = target - new Date();
    if (ms > MAX_DELAY) {
      _timer = setTimeout(() => armUntil(target, onFire), MAX_DELAY);
    } else {
      _timer = setTimeout(onFire, Math.max(0, ms));
    }
  }

  function scheduleRun(target) {
    armUntil(target, async () => {
      if (!_active) return;
      try {
        await trigger({ daysAgo, background: true });
      } catch (err) {
        console.error('Scheduler trigger error:', err.message);
      }
      // Schedule the next run frequencyDays after this fire, at hour:minute.
      const after = new Date();
      after.setDate(after.getDate() + frequencyDays);
      after.setHours(hour, minute, 0, 0);
      scheduleRun(after);
    });
  }

  // First run: the next time-of-day occurrence (today if still ahead, else tomorrow).
  const first = nextTimeOfDay(new Date());
  console.log(`  Scheduler: enabled, every ${frequencyDays} day(s) at ` +
    `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}, ` +
    `scraping past ${daysAgo} day(s). First run ${first.toLocaleString()}.`);
  scheduleRun(first);
}

function teardown() {
  _active = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

function isActive() { return _active; }

module.exports = { setup, teardown, isActive };
