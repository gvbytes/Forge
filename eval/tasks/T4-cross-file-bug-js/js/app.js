"use strict";
/**
 * DOM wiring for the calendar widget. Browser-only: skipped under node.
 * Renders the current month and lets the user step backwards/forwards.
 */
(function () {
  if (typeof document === "undefined") {
    return; // running under node (tests) — no DOM to touch
  }

  var DateUtil = window.DateUtil;
  var CalendarWidget = window.CalendarWidget;

  var cursor = new Date();
  var year = cursor.getFullYear();
  var month = cursor.getMonth(); // 0-based

  function render() {
    var cal = CalendarWidget.buildCalendar(year, month);
    document.getElementById("cal-label").textContent = cal.label;

    var grid = document.getElementById("cal-grid");
    grid.innerHTML = "";

    cal.weekdays.forEach(function (name) {
      var head = document.createElement("div");
      head.className = "cal-weekday";
      head.textContent = name;
      grid.appendChild(head);
    });

    cal.cells.forEach(function (cell) {
      var box = document.createElement("div");
      box.className = cell ? "cal-day" : "cal-pad";
      if (cell) {
        box.textContent = String(cell.day);
      }
      grid.appendChild(box);
    });
  }

  document.getElementById("cal-prev").addEventListener("click", function () {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
    render();
  });

  document.getElementById("cal-next").addEventListener("click", function () {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
    render();
  });

  render();
})();
