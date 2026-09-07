/** @jest-environment jsdom */
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { fireEvent, render, screen } from "@testing-library/react";
import { ComponentProps } from "react";

import { TrackCard } from "./TrackCard";

const OriginalURL = URL;
const createURLMock = jest.fn().mockReturnValue("blob:clip");
const revokeURLMock = jest.fn();
beforeAll(() => {
  globalThis.URL = class extends OriginalURL {
    public static override createObjectURL = createURLMock;
    public static override revokeObjectURL = revokeURLMock;
  };
});
afterAll(() => {
  globalThis.URL = OriginalURL;
});

function props(): ComponentProps<typeof TrackCard> {
  return {
    track: { id: "one", asset: { name: "one.mp4", size: 4, lastModified: 1 } },
    file: new File(["clip"], "one.mp4", { lastModified: 1 }),
    clock: {
      utcMs: Date.UTC(2026, 8, 6, 0, 0, 0, 123),
      isPlaying: false,
      speed: 1,
      lastSeekTime: 0,
      sourceKey: "source",
      sourceId: "player-one",
    },
    events: [
      {
        id: "event",
        timeMs: 100123,
        topic: "/status/camera/status",
        description: "Recording start (observed)",
      },
    ],
    onAlign: jest.fn(),
    onRemove: jest.fn(),
    onReselect: jest.fn(),
    onPause: jest.fn(),
  };
}

function loadedVideo(container: HTMLElement) {
  const video = container.querySelector("video")!;
  Object.defineProperty(video, "duration", { configurable: true, value: 20 });
  Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
  fireEvent.loadedMetadata(video);
  return video;
}

beforeEach(() => {
  createURLMock.mockReturnValue("blob:clip");
  revokeURLMock.mockClear();
  jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
});

it("captures an independently chosen frame and saves explicit zone milliseconds", () => {
  const initial = props();
  const { container, rerender } = render(<TrackCard {...initial} />);
  const video = loadedVideo(container);
  video.currentTime = 5.25;
  rerender(
    <TrackCard {...initial} clock={{ ...initial.clock!, utcMs: initial.clock!.utcMs + 1000 }} />,
  );
  expect(video.currentTime).toBe(5.25);
  fireEvent.click(screen.getByRole("button", { name: "Align this frame with time" }));
  expect(video.controls).toBe(false);
  fireEvent.change(screen.getByLabelText("Date and time (milliseconds)"), {
    target: { value: "2026-09-06 14:30:00.123" },
  });
  fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "Asia/Shanghai" } });
  fireEvent.click(screen.getByRole("button", { name: "Save manual alignment" }));
  expect(initial.onAlign).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "manual",
      mediaSeconds: 5.25,
      utcMs: Date.UTC(2026, 8, 6, 6, 30, 0, 123),
      timeZone: "Asia/Shanghai",
    }),
  );
});

it("uses actual presented frame time when requestVideoFrameCallback is available", () => {
  let callback: VideoFrameRequestCallback | undefined;
  Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", {
    configurable: true,
    value: jest.fn((next: VideoFrameRequestCallback) => {
      callback = next;
      return 1;
    }),
  });
  Object.defineProperty(HTMLVideoElement.prototype, "cancelVideoFrameCallback", {
    configurable: true,
    value: jest.fn(),
  });
  try {
    const initial = props();
    const { container, unmount } = render(<TrackCard {...initial} />);
    const video = loadedVideo(container);
    video.currentTime = 5.123;
    callback?.(0, { mediaTime: 5.1 } as VideoFrameCallbackMetadata);
    fireEvent.click(screen.getByRole("button", { name: "Align this frame with time" }));
    fireEvent.click(screen.getByRole("button", { name: "Save manual alignment" }));
    expect(initial.onAlign).toHaveBeenCalledWith(expect.objectContaining({ mediaSeconds: 5.1 }));
    unmount();
  } finally {
    Reflect.deleteProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback");
    Reflect.deleteProperty(HTMLVideoElement.prototype, "cancelVideoFrameCallback");
  }
});

it("aligns recording event to full clip beginning even after preview seeking", () => {
  const initial = props();
  const { container } = render(<TrackCard {...initial} />);
  loadedVideo(container).currentTime = 8;
  fireEvent.mouseDown(screen.getByLabelText("Recording start event"));
  fireEvent.click(screen.getByRole("option", { name: /Recording start \(observed\)/ }));
  fireEvent.click(
    screen.getByRole("button", { name: "Align clip beginning with recording event" }),
  );
  expect(initial.onAlign).toHaveBeenCalledWith(
    expect.objectContaining({ method: "recording-event", mediaSeconds: 0, utcMs: 100123 }),
  );
});

it("clears a pending manual capture when the player changes even with the same recording descriptor", () => {
  const initial = props();
  const { container, rerender } = render(<TrackCard {...initial} />);
  loadedVideo(container);
  fireEvent.click(screen.getByRole("button", { name: "Align this frame with time" }));
  expect(screen.getByRole("button", { name: "Save manual alignment" })).toBeTruthy();
  rerender(<TrackCard {...initial} clock={{ ...initial.clock!, sourceId: "player-two" }} />);
  expect(screen.queryByRole("button", { name: "Save manual alignment" })).toBeNull();
});

it("hides out-of-range and changed-source frames and revokes file URLs on removal", () => {
  const initial = props();
  initial.track.alignment = {
    method: "manual",
    utcMs: initial.clock!.utcMs + 1000,
    mediaSeconds: 0,
    sourceKey: "source",
  };
  const { container, rerender, unmount } = render(<TrackCard {...initial} />);
  const video = loadedVideo(container);
  expect(video.style.visibility).toBe("hidden");
  expect(screen.getByText("Outside this video's time range")).toBeTruthy();
  rerender(<TrackCard {...initial} clock={{ ...initial.clock!, sourceKey: "different" }} />);
  expect(screen.getByText(/Alignment belongs to another recording/)).toBeTruthy();
  unmount();
  expect(revokeURLMock).toHaveBeenCalledWith("blob:clip");
});
