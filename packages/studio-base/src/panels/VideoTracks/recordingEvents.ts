// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { RecordingEvent } from "./alignment";

export const CAMERA_STATUS_TOPIC = "/status/camera/status";
const MAX_STATUS_INTERVAL_MS = 2000;
type StatusMessage = { message: unknown; receiveTime: { sec: number; nsec: number } };
type Observation = { timeMs: number; state: number | undefined };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != undefined && typeof value === "object";
}

/** Camera status is a one-Hz observation, not a precise first-exposure event. */
function readObservation(event: StatusMessage): Observation | undefined {
  const { sec, nsec } = event.receiveTime;
  if (!Number.isSafeInteger(sec) || !Number.isInteger(nsec) || nsec < 0 || nsec >= 1e9) {
    return undefined;
  }
  const data =
    isRecord(event.message) && isRecord(event.message.data) ? event.message.data : undefined;
  return {
    timeMs: sec * 1000 + nsec / 1e6,
    state:
      data &&
      Object.prototype.hasOwnProperty.call(data, "rec_state") &&
      (data.rec_state === 0 || data.rec_state === 1)
        ? data.rec_state
        : undefined,
  };
}

/** Source identity deliberately scopes cached events to a player, including equal-timestamp files. */
export class RecordingEventStore {
  #sourceId: string | undefined;
  #observations = new Map<number, Observation>();

  public update(sourceId: string, messages: Iterable<StatusMessage>): RecordingEvent[] {
    if (this.#sourceId !== sourceId) {
      this.#sourceId = sourceId;
      this.#observations.clear();
    }
    for (const message of messages) {
      const observation = readObservation(message);
      if (observation) {
        const existing = this.#observations.get(observation.timeMs);
        if (existing && existing.state !== observation.state) {
          observation.state = undefined;
        }
        this.#observations.set(observation.timeMs, observation);
      }
    }
    const sorted = [...this.#observations.values()].sort((a, b) => a.timeMs - b.timeMs);
    const events: RecordingEvent[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const previous = sorted[i - 1]!;
      const current = sorted[i]!;
      const interval = current.timeMs - previous.timeMs;
      if (
        previous.state === 0 &&
        current.state === 1 &&
        interval > 0 &&
        interval <= MAX_STATUS_INTERVAL_MS
      ) {
        events.push({
          id: `${CAMERA_STATUS_TOPIC}:${current.timeMs}`,
          timeMs: current.timeMs,
          topic: CAMERA_STATUS_TOPIC,
          previousObservedUtcMs: previous.timeMs,
          observationIntervalMs: interval,
          timeBasis: "camera_status_observation",
          description: `Recording start (observed); status interval ${interval.toFixed(
            1,
          )} ms; ${CAMERA_STATUS_TOPIC}`,
        });
      }
    }
    return events;
  }
}
