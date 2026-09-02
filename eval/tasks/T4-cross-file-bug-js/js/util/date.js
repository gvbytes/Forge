"use strict";
/**
 * Shared date helpers for the calendar widget.
 *
 * CONVENTION: every `month` argument in this module is 0-based
 * (0 = January … 11 = December), matching JavaScript's Date methods.
 */

var MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Number of days in the given month.
 *
 * Day 0 of a month is its last day, so the length of `month` is the day
 * number of the 0th of the following month (0-based months).
 */
function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/**
 * Weekday of the 1st of the month: 0 = Sunday … 6 = Saturday.
 */
function firstWeekdayOfMonth(year, month) {
  return new Date(year, month, 1).getDay();
}

var DateUtil = {
  MONTH_NAMES: MONTH_NAMES,
  daysInMonth: daysInMonth,
  firstWeekdayOfMonth: firstWeekdayOfMonth,
};

/* Node (tests) and browser both get the same API. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = DateUtil;
}
if (typeof window !== "undefined") {
  window.DateUtil = DateUtil;
}
