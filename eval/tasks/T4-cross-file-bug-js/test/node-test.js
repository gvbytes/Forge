"use strict";
/**
 * Node test-suite for the calendar widget (plain asserts, no framework).
 * Run with: node test/node-test.js
 *
 * Pins the true lengths of representative months and the grid the
 * widget must render for them.
 */
const assert = require("assert");
const { MONTH_NAMES, daysInMonth, firstWeekdayOfMonth } = require("../js/util/date.js");
const { buildCalendar } = require("../js/calendar.js");

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (err) {
    failures.push(name);
    const msg = err && err.message ? err.message.split("\n")[0] : String(err);
    console.log(`not ok ${passed + failures.length} - ${name}: ${msg}`);
  }
}

check("MONTH_NAMES has the twelve months in order", () => {
  assert.deepEqual(MONTH_NAMES[0], "January");
  assert.deepEqual(MONTH_NAMES[11], "December");
});

check("firstWeekdayOfMonth: 2024-01-01 falls on a Monday", () => {
  assert.strictEqual(firstWeekdayOfMonth(2024, 0), 1);
});

check("daysInMonth: February 2024 (leap) has 29 days", () => {
  assert.strictEqual(daysInMonth(2024, 1), 29);
});

check("daysInMonth: September 2023 has 30 days", () => {
  assert.strictEqual(daysInMonth(2023, 8), 30);
});

check("daysInMonth: December 2024 has 31 days", () => {
  assert.strictEqual(daysInMonth(2024, 11), 31);
});

check("buildCalendar(2024,1) labels itself February 2024", () => {
  assert.strictEqual(buildCalendar(2024, 1).label, "February 2024");
});

check("buildCalendar(2024,1) renders day cells exactly 1..29 on whole weeks", () => {
  const cal = buildCalendar(2024, 1);
  const days = cal.cells.filter((c) => c).map((c) => c.day);
  assert.deepEqual(days, Array.from({ length: 29 }, (_, i) => i + 1));
  assert.strictEqual(cal.cells.length % 7, 0);
});

check("buildCalendar(2023,8) renders day cells exactly 1..30", () => {
  const cal = buildCalendar(2023, 8);
  const days = cal.cells.filter((c) => c).map((c) => c.day);
  assert.deepEqual(days, Array.from({ length: 30 }, (_, i) => i + 1));
});

if (failures.length > 0) {
  console.log(`FAILED: ${failures.length} check(s): ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`PASSED: all ${passed} checks`);
