// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { syncVideo } from "./playback";

function video() {
  return {
    duration: 10,
    currentTime: 2,
    paused: true,
    playbackRate: 1,
    pause: jest.fn(),
    play: jest.fn().mockResolvedValue(undefined),
  } as unknown as HTMLVideoElement & { pause: jest.Mock; play: jest.Mock };
}

it("tracks master seek, play and playback rate", () => {
  const media = video();
  expect(syncVideo(media, 5.123, { isPlaying: true, speed: 2, forceSeek: true })).toBe(true);
  expect(media.currentTime).toBe(5.123);
  expect(media.playbackRate).toBe(2);
  expect(media.play).toHaveBeenCalledTimes(1);
});

it("pauses and seeks precisely when the master is paused", () => {
  const media = video();
  syncVideo(media, 2.012, { isPlaying: false, speed: 1, forceSeek: false });
  expect(media.pause).toHaveBeenCalled();
  expect(media.currentTime).toBe(2.012);
  expect(media.play).not.toHaveBeenCalled();
});

it("does not seek repeatedly while playing within drift tolerance", () => {
  const media = video();
  syncVideo(media, 2.02, { isPlaying: true, speed: 1, forceSeek: false });
  expect(media.currentTime).toBe(2);
});

it.each([-1, 10, 11, NaN])("pauses and hides media outside coverage %s", (target) => {
  const media = video();
  expect(syncVideo(media, target, { isPlaying: true, speed: 1, forceSeek: false })).toBe(false);
  expect(media.pause).toHaveBeenCalled();
  expect(media.play).not.toHaveBeenCalled();
});

it("falls back to master seeks if the browser rejects a playback rate", () => {
  const media = video();
  Object.defineProperty(media, "playbackRate", {
    get: () => 1,
    set: () => {
      throw new Error("Unsupported rate");
    },
  });
  syncVideo(media, 2.012, { isPlaying: true, speed: 100, forceSeek: false });
  expect(media.pause).toHaveBeenCalled();
  expect(media.currentTime).toBe(2.012);
  expect(media.play).not.toHaveBeenCalled();
});
