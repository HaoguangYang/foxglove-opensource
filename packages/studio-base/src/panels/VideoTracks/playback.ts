// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { inVideoRange } from "./alignment";

/** Keep the MCAP clock authoritative, including buffering and unsupported browser rates. */
export function syncVideo(
  video: HTMLVideoElement,
  target: number,
  { isPlaying, speed, forceSeek }: { isPlaying: boolean; speed: number; forceSeek: boolean },
): boolean {
  if (!inVideoRange(target, video.duration)) {
    video.pause();
    return false;
  }
  let canPlay = isPlaying && speed > 0;
  try {
    if (canPlay && video.playbackRate !== speed) {
      video.playbackRate = speed;
    }
  } catch {
    // Browsers reject some MCAP rates; follow those by seeking on each master update.
    canPlay = false;
  }
  if (!canPlay) {
    video.pause();
  }
  const tolerance = canPlay && !forceSeek ? 0.1 : 0.0005;
  if (Math.abs(video.currentTime - target) > tolerance) {
    video.currentTime = target;
  }
  if (canPlay && video.paused) {
    void video.play().catch(() => {
      // Muted playback can still be blocked; master-clock seeks remain available.
    });
  }
  return true;
}
