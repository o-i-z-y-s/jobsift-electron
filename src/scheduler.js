'use strict';

/**
 * src/scheduler.js
 * setTimeout-based daily scheduler. No external dependencies.
 * Computes ms-to-next-run at each scheduling step so it stays accurate
 * across DST boundaries and system sleep/wake.
 *
 * Usage:
 *   const scheduler = require('./scheduler');
 *   scheduler.setup({ enabled: true, cronHour: 8, cronMinute: 30, daysAgo: 7 }, triggerFn);
 *   scheduler.teardown();  // cancels any pending timer
 */

let _timer  = null;
let _active = false;

/**
 * Set up (or replace) the scheduled task.
 * @param {object} schedule  - { enabled, cronHour, cronMinute, daysAgo }
 * @param {function} trigger - async fn(options) called when the timer fires
 */
function setup(schedule, trigger) {
  teardown();
  if (!schedule?.enabled) return;

  const { cronHour = 8, cronMinute = 0, daysAgo = 7 } = schedule;
  _active = true;

  function scheduleNext() {
    if (!_active) return;

    const now  = new Date();
    const next = new Date(now);
    next.setHours(cronHour, cronMinute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const msUntil = next - now;
    console.log(`  Scheduler: next run at ${next.toLocaleTimeString()} (${Math.round(msUntil / 60000)} min from now)`);

    _timer = setTimeout(async () => {
      if (!_active) return;
      try {
        await trigger({ daysAgo });
      } catch (err) {
        console.error('Scheduler trigger error:', err.message);
      }
      scheduleNext();
    }, msUntil);
  }

  scheduleNext();
}

function teardown() {
  _active = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

function isActive() { return _active; }

module.exports = { setup, teardown, isActive };
