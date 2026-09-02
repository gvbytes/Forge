"use strict";
/**
 * Calendar grid builder.
 *
 * Pure logic only — the DOM layer in app.js consumes this. Works both in
 * the browser (window.CalendarWidget) and under node (require).
 */
var DateUtil =
  typeof require === "function" && typeof module !== "undefined"
    ? require("./util/date.js")
    : typeof window !== "undefined"
      ? window.DateUtil
      : null;

var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Build a month grid for `year`/`month` (0-based month).
 *
 * Returns { label, year, month, weekdays, cells } where cells is a flat
 * array whose length is a multiple of 7: leading nulls pad the first
 * week up to the weekday of the 1st, then one entry {day} per day of
 * the month, then trailing nulls to complete the final week.
 */
function buildCalendar(year, month) {
  var days = DateUtil.daysInMonth(year, month);
  var lead = DateUtil.firstWeekdayOfMonth(year, month);

  var cells = [];
  for (var i = 0; i < lead; i++) {
    cells.push(null);
  }
  for (var day = 1; day <= days; day++) {
    cells.push({ day: day });
  }
  while (cells.length % 7 !== 0) {
    cells.push(null);
  }

  return {
    label: DateUtil.MONTH_NAMES[month] + " " + year,
    year: year,
    month: month,
    weekdays: WEEKDAYS.slice(),
    cells: cells,
  };
}

var CalendarWidget = { buildCalendar: buildCalendar };

if (typeof module !== "undefined" && module.exports) {
  module.exports = CalendarWidget;
}
if (typeof window !== "undefined") {
  window.CalendarWidget = CalendarWidget;
}
