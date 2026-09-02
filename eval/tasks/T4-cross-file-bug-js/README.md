# mini-calendar

A dependency-free vanilla JS month-calendar widget. `js/calendar.js`
builds the grid as pure data; `js/app.js` renders it into the DOM and
handles the previous/next buttons. Date maths live in the shared util
module `js/util/date.js` (0-based months, like JS `Date`).

## Layout

```
index.html           page shell
css/style.css        styles
js/util/date.js      shared date helpers (daysInMonth, firstWeekdayOfMonth)
js/calendar.js       buildCalendar(year, month) -> { label, weekdays, cells }
js/app.js            DOM wiring (browser only)
test/node-test.js    node test-suite — run with:  node test/node-test.js
```

The same modules work in the browser (`window.DateUtil`,
`window.CalendarWidget`) and under node (`require`) so the logic is
tested without a browser.

## Known issues

* Support reports: **the widget shows the wrong number of days** — e.g.
  February 2024 renders 31 day cells. Root cause not yet identified;
  the failing checks in `test/node-test.js` pin the expected behaviour.
