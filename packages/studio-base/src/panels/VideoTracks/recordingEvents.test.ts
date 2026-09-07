// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { RecordingEventStore } from "./recordingEvents";

function status(sec: number, state?: number) {
  return {
    receiveTime: { sec, nsec: 123_000_000 },
    message: { data: state == undefined ? {} : { rec_state: state } },
  };
}

describe("camera recording start observations", () => {
  it("finds starts in full preloaded data irrespective of playhead or chunk arrival order", () => {
    const store = new RecordingEventStore();
    expect(store.update("source", [status(20, 1)])).toEqual([]);
    const events = store.update("source", [status(19, 0), status(1, 0), status(2, 1)]);
    expect(events.map((event) => event.timeMs)).toEqual([2123, 20123]);
    expect(events[0]?.description).toContain("1000.0 ms");
    expect(store.update("source", [status(2, 1)])).toHaveLength(2);
  });
  it.each([
    [status(1, 1), status(2, 1)],
    [status(1), status(2, 1)],
    [status(1, 0), status(4, 1)],
    [status(1, 0), status(2), status(3, 1)],
    [status(1, 0), status(2, 2), status(3, 1)],
  ])(
    "does not fabricate a start from initial, unknown or discontinuous status %j",
    (...samples) => {
      expect(new RecordingEventStore().update("source", samples)).toEqual([]);
    },
  );
  it("clears events and prior status when switching sources", () => {
    const store = new RecordingEventStore();
    expect(store.update("one", [status(1, 0), status(2, 1)])).toHaveLength(1);
    expect(store.update("two", [status(2, 1)])).toEqual([]);
  });
  it("treats conflicting same-time samples as unknown", () => {
    const store = new RecordingEventStore();
    expect(
      store.update("source", [status(1, 0), status(2, 0), status(2, 1), status(3, 1)]),
    ).toEqual([]);
  });
  it("does not use inherited protobuf defaults as explicit idle state", () => {
    const absent = status(1);
    absent.message.data = Object.create({ rec_state: 0 }) as { rec_state?: number };
    expect(new RecordingEventStore().update("source", [absent, status(2, 1)])).toEqual([]);
  });
  it("keeps source precision and admits a bounded two-second heartbeat interval", () => {
    expect(
      new RecordingEventStore().update("source", [status(1, 0), status(3, 1)])[0]?.timeMs,
    ).toBe(3123);
  });
});
