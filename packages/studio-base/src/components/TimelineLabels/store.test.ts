// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { createLabelsExport } from "./export";
import { LABEL_STORAGE_KEY, createTimelineLabelsStore } from "./store";
import { NewTimelineLabel, formatLabelTime, parseLabelTime } from "./types";

const input: NewTimelineLabel = {
  title: "Wheel slip",
  comment:
    "Observed motion disagrees with wheel velocity.\nInspect video before inferring contact.",
  source: {
    id: "sortie-0109",
    name: "tracking.mcap",
    kind: "mcap",
    startTime: { sec: 1750000000, nsec: 123456789 },
    endTime: { sec: 1750000600, nsec: 0 },
  },
  startTime: { sec: 1750000001, nsec: 123456790 },
  endTime: { sec: 1750000002, nsec: 987654321 },
  signalExpressions: ["/joint_states.position[0]"],
  signalMetadata: [{ expression: "/joint_states.position[0]", timestampMethod: "receiveTime" }],
  originPanelId: "Plot!1",
};

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key),
    setItem: (key: string, value: string) => data.set(key, value),
  };
}

it("round trips all exact label values through persistence and a fresh store", () => {
  const storage = memoryStorage();
  const store = createTimelineLabelsStore(() => storage);
  const added = store.getState().addLabel(input);
  expect(added).toMatchObject(input);
  expect(createTimelineLabelsStore(() => storage).getState().labels).toEqual([added]);
});

it("exports every recording with exact nanoseconds, UTC and provenance", () => {
  const storage = memoryStorage();
  const store = createTimelineLabelsStore(() => storage);
  store.getState().addLabel(input);
  store.getState().addLabel({ ...input, source: { ...input.source, id: "sortie-0111" } });
  const exported = createLabelsExport(store.getState().labels);
  expect(exported.labels).toHaveLength(2);
  expect(exported.labels.map((label) => label.source.id)).toEqual(["sortie-0109", "sortie-0111"]);
  expect(exported.labels[0]).toMatchObject({
    comment: input.comment,
    signalExpressions: input.signalExpressions,
    signalMetadata: input.signalMetadata,
    startTime: { ...input.startTime, unixNs: "1750000001123456790" },
    relativeStartNs: "1000000001",
  });
  expect(exported.labels[0]!.startTime.isoUtc).toMatch(/\.123456790Z$/);
  expect(JSON.parse(JSON.stringify(exported)!)).toEqual(exported);
});

it("edits timestamps and deletes without modifying another recording", () => {
  jest.useFakeTimers().setSystemTime(new Date("2026-09-07T00:00:00Z"));
  const storage = memoryStorage();
  const store = createTimelineLabelsStore(() => storage);
  const first = store.getState().addLabel(input)!;
  const other = store.getState().addLabel({ ...input, source: { ...input.source, id: "other" } });
  jest.setSystemTime(new Date("2026-09-07T00:00:01Z"));
  expect(store.getState().updateLabel(first.id, { title: "Edited note" })).toBe(true);
  expect(store.getState().labels[0]).toMatchObject({
    title: "Edited note",
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:01.000Z",
  });
  expect(store.getState().deleteLabel(first.id)).toBe(true);
  expect(createTimelineLabelsStore(() => storage).getState().labels).toEqual([other]);
  jest.useRealTimers();
});

it("preserves the prior saved state and surfaces a storage write failure", () => {
  const storage = memoryStorage();
  const store = createTimelineLabelsStore(() => storage);
  const added = store.getState().addLabel(input)!;
  const saved = storage.getItem(LABEL_STORAGE_KEY);
  jest.spyOn(storage, "setItem").mockImplementation(() => {
    throw new Error("Quota exceeded");
  });
  expect(store.getState().updateLabel(added.id, { comment: "Must not appear saved" })).toBe(false);
  expect(store.getState().addLabel(input)).toBeUndefined();
  expect(store.getState().deleteLabel(added.id)).toBe(false);
  expect(store.getState().labels).toEqual([added]);
  expect(store.getState().error).toContain("not saved");
  expect(storage.getItem(LABEL_STORAGE_KEY)).toBe(saved);
});

it.each(["{bad json", '{"version":2,"labels":[]}', '{"version":1,"labels":[{}]}'])(
  "preserves malformed or unsupported stored data: %s",
  (raw) => {
    const storage = memoryStorage();
    storage.setItem(LABEL_STORAGE_KEY, raw);
    const store = createTimelineLabelsStore(() => storage);
    expect(store.getState().error).toContain("Cannot load");
    expect(store.getState().addLabel(input)).toBeUndefined();
    expect(storage.getItem(LABEL_STORAGE_KEY)).toBe(raw);
  },
);

it("handles denied storage access without crashing", () => {
  const store = createTimelineLabelsStore(() => {
    throw new Error("Storage access denied");
  });
  expect(store.getState().error).toContain("denied");
  expect(store.getState().addLabel(input)).toBeUndefined();
});

it("reads latest stored labels before changes so sequential tab writes are retained", () => {
  const storage = memoryStorage();
  const first = createTimelineLabelsStore(() => storage);
  const second = createTimelineLabelsStore(() => storage);
  first.getState().addLabel(input);
  second.getState().addLabel({ ...input, title: "Second tab" });
  expect(second.getState().labels).toHaveLength(2);
  expect(first.getState().refresh()).toBe(true);
  expect(first.getState().labels).toHaveLength(2);
});

it("preserves the known saved snapshot when refreshing malformed data", () => {
  const storage = memoryStorage();
  const store = createTimelineLabelsStore(() => storage);
  const added = store.getState().addLabel(input);
  storage.setItem(LABEL_STORAGE_KEY, "bad json");
  expect(store.getState().refresh()).toBe(false);
  expect(store.getState().labels).toEqual([added]);
  expect(store.getState().error).toContain("Cannot load");
});

it.each([
  { title: " " },
  { title: "a".repeat(201) },
  { comment: "a".repeat(20001) },
  { startTime: { sec: 1750000003, nsec: 0 } },
  { endTime: { sec: 1750000002, nsec: 1000000000 } },
])("rejects invalid labels without persisting: %j", (patch) => {
  const storage = memoryStorage();
  const store = createTimelineLabelsStore(() => storage);
  expect(store.getState().addLabel({ ...input, ...patch })).toBeUndefined();
  expect(storage.getItem(LABEL_STORAGE_KEY)).toBeUndefined();
});

it("UTC editors preserve nanoseconds and reject date normalization", () => {
  expect(parseLabelTime(formatLabelTime(input.startTime))).toEqual(input.startTime);
  expect(parseLabelTime("2026-09-07T12:00:00.001Z").nsec).toBe(1000000);
  expect(() => parseLabelTime("2026-02-30T12:00:00Z")).toThrow();
  expect(() => parseLabelTime("2026-09-07T12:00:00.1234567891Z")).toThrow();
  expect(() => parseLabelTime("2026-09-07T12:00:00")).toThrow();
});
