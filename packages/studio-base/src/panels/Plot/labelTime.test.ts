// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { formatLabelTime, parseLabelTime, pixelsForRange, rangeFromPixels } from "./labelTime";

const scale = { min: 10, max: 20, left: 50, right: 550, top: 12, bottom: 200 };
const start = { sec: 1700000000, nsec: 123456789 };
const end = { sec: 1700000100, nsec: 123456789 };

it("maps CSS chart coordinates with axis margins and normalizes reverse drags", () => {
  const range = rangeFromPixels(scale, 450, 150, start, end);
  expect(range).toEqual({
    startTime: { sec: 1700000012, nsec: 123456789 },
    endTime: { sec: 1700000018, nsec: 123456789 },
  });
  expect(pixelsForRange(scale, range!, start)).toEqual({ left: 150, right: 450 });
});

it("clamps releases outside the chart and outside source bounds", () => {
  expect(rangeFromPixels({ ...scale, min: -10, max: 200 }, -100, 900, start, end)).toEqual({
    startTime: start,
    endTime: end,
  });
});

it("keeps absolute label times fixed while zoomed, panned, and resized", () => {
  const range = rangeFromPixels(scale, 150, 450, start, end)!;
  expect(pixelsForRange({ ...scale, min: 11, max: 19, right: 850 }, range, start)).toEqual({
    left: 150,
    right: 750,
  });
  expect(pixelsForRange({ ...scale, min: 19, max: 25 }, range, start)).toBeUndefined();
  expect(pixelsForRange({ ...scale, min: 13, max: 17 }, range, start)).toEqual({
    left: 50,
    right: 550,
  });
});

it("rejects uninitialized or degenerate scales", () => {
  expect(rangeFromPixels({ ...scale, right: scale.left }, 10, 20, start, end)).toBeUndefined();
  expect(rangeFromPixels({ ...scale, min: scale.max }, 10, 20, start, end)).toBeUndefined();
});

it("roundtrips nanoseconds and accepts explicit milliseconds without timezone ambiguity", () => {
  expect(parseLabelTime(formatLabelTime(start))).toEqual(start);
  expect(parseLabelTime("2026-09-07 01:02:03.123")).toEqual({
    sec: Date.UTC(2026, 8, 7, 1, 2, 3) / 1000,
    nsec: 123000000,
  });
});

it.each([
  "2026-02-30 01:02:03.123",
  "2026-09-07 25:00:00",
  "2026-09-07 01:02:03.1234567891",
  "01:02:03",
  "2026-09-07 01:02:03+08:00",
])("rejects invalid UTC input %s", (input) => {
  expect(parseLabelTime(input)).toBeUndefined();
});
