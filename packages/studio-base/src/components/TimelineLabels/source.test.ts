// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { PlayerStateActiveData } from "@foxglove/studio-base/players/types";

import { createSourceDescriptor } from "./source";

const player = {
  name: "sortie_0109.mcap",
  urlState: { sourceId: "mcap" },
  activeData: {
    startTime: { sec: 1750000000, nsec: 0 },
    endTime: { sec: 1750000600, nsec: 0 },
  } as PlayerStateActiveData,
};

it("uses stable metadata across reopen while isolating other names and bounds", () => {
  const source = createSourceDescriptor(player)!;
  expect(createSourceDescriptor({ ...player })).toEqual(source);
  expect(createSourceDescriptor({ ...player, name: "sortie_0111.mcap" })?.id).not.toBe(source.id);
  expect(
    createSourceDescriptor({
      ...player,
      activeData: { ...player.activeData, endTime: { sec: 1750000601, nsec: 0 } },
    })?.id,
  ).not.toBe(source.id);
});

it("does not export credentials or signed query tokens in the name, locator or identity", () => {
  const url = "https://user:password@host/recording.mcap?token=secret#private";
  const source = createSourceDescriptor({
    ...player,
    name: url,
    urlState: { sourceId: "mcap", parameters: { url } },
  });
  expect(source?.locator).toBe("https://host/recording.mcap");
  expect(JSON.stringify(source)).not.toMatch(/password|token|secret|private|user/);
});

it("does not attach labels to a source before metadata is known", () => {
  expect(createSourceDescriptor({})).toBeUndefined();
  expect(createSourceDescriptor({ ...player, name: undefined })).toBeUndefined();
});
