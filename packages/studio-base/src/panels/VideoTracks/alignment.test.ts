// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  eventAlignment,
  inVideoRange,
  matchesAsset,
  mediaTimeAt,
  parseAlignmentTime,
} from "./alignment";

describe("manual alignment time", () => {
  it.each(["Asia/Shanghai", "+08:00", "UTC+08:00"])("preserves milliseconds in %s", (zone) => {
    expect(parseAlignmentTime("2026-09-06 14:30:00.123", zone)).toBe(
      Date.UTC(2026, 8, 6, 6, 30, 0, 123),
    );
  });
  it("uses explicit UTC independently of the browser's local time zone", () => {
    expect(parseAlignmentTime("2026-09-06T14:30:00.123", "UTC")).toBe(
      Date.UTC(2026, 8, 6, 14, 30, 0, 123),
    );
  });
  it.each([
    ["2026-02-30 14:30:00.123", "UTC"],
    ["2026-09-06 24:30:00.123", "UTC"],
    ["2026-09-06 14:30", "UTC"],
    ["2026-09-06 14:30:00.123", "Mars/Base"],
    ["2026-09-06 14:30:00.123", "+14:01"],
    ["2026-09-06 14:30:00.123", "+08:60"],
  ])("rejects invalid date/time or zone %s %s", (time, zone) => {
    expect(() => parseAlignmentTime(time, zone)).toThrow();
  });
  it("rejects a nonexistent DST time", () => {
    expect(() => parseAlignmentTime("2026-03-08 02:30:00.123", "America/New_York")).toThrow(
      "does not exist",
    );
  });
  it("requires explicit offset for an ambiguous DST time", () => {
    expect(() => parseAlignmentTime("2026-11-01 01:30:00.123", "America/New_York")).toThrow(
      "occurs twice",
    );
    expect(
      parseAlignmentTime("2026-11-01 01:30:00.123", "-05:00") -
        parseAlignmentTime("2026-11-01 01:30:00.123", "-04:00"),
    ).toBe(3_600_000);
  });
});

it("aligns full clip beginning to recording event independent of preview position", () => {
  const alignment = eventAlignment(
    { id: "event", timeMs: 123456.789, topic: "/status/camera/status", description: "observed" },
    "source",
  );
  expect(alignment.mediaSeconds).toBe(0);
  expect(mediaTimeAt(123456.789, alignment)).toBe(0);
  expect(mediaTimeAt(124456.789, alignment)).toBe(1);
  expect(alignment.event?.id).toBe("event");
});

it("handles before/after coverage without displaying stale endpoints", () => {
  expect(inVideoRange(-0.001, 2)).toBe(false);
  expect(inVideoRange(0, 2)).toBe(true);
  expect(inVideoRange(1.999, 2)).toBe(true);
  expect(inVideoRange(2, 2)).toBe(false);
  expect(inVideoRange(0, NaN)).toBe(false);
});

it("only restores alignment for a matching local file identity", () => {
  const asset = { name: "camera.mp4", size: 123, lastModified: 456 };
  expect(matchesAsset(asset, { ...asset })).toBe(true);
  expect(matchesAsset(asset, { ...asset, size: 124 })).toBe(false);
  expect(matchesAsset(asset, { ...asset, lastModified: 789 })).toBe(false);
});
