// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import type { UrdfJoint } from "@foxglove/den/urdf";

import {
  applyUrdfJointStateTransforms,
  normalizeUrdfJointState,
} from "./UrdfJointStateTransforms";
import type { UrdfJointTransform } from "./UrdfJointStateTransforms";

const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 };
const IDENTITY_ORIGIN = { xyz: { x: 0, y: 0, z: 0 }, rpy: { x: 0, y: 0, z: 0 } };

function joint(overrides: Partial<UrdfJoint>): UrdfJoint {
  return {
    name: "joint",
    jointType: "revolute",
    parent: "parent",
    child: "child",
    origin: IDENTITY_ORIGIN,
    axis: { x: 1, y: 0, z: 0 },
    ...overrides,
  };
}

describe("URDF JointState normalization and FK", () => {
  // This catches a ROS adapter regression that replaces a missing position with zero or uses
  // receive time even though the source message supplied a valid header timestamp.
  it("uses the ROS header timestamp and ignores a name without a position", () => {
    const normalized = normalizeUrdfJointState(
      {
        header: { stamp: { sec: 8, nsec: 9 } },
        name: ["slide", "missing"],
        position: [0.25],
      },
      { sec: 99, nsec: 0 },
    );

    expect(normalized.timestamp).toBe(8_000_000_009n);
    expect([...normalized.positions]).toEqual([["slide", 0.25]]);
  });

  // This catches multiplication in the wrong coordinate frame and missing URDF mimic support.
  it("translates a prismatic joint along its origin-rotated axis and applies mimic scale and offset", () => {
    const source = joint({ name: "slide", jointType: "prismatic", axis: { x: 0, y: 2, z: 0 } });
    const mimic = joint({
      name: "follower",
      jointType: "prismatic",
      parent: "slide_link",
      child: "follower_link",
      axis: { x: 0, y: 0, z: 1 },
      mimic: { joint: "slide", multiplier: 2, offset: 0.1 },
    });
    const transforms: UrdfJointTransform[] = [
      {
        parent: "root",
        child: "slide_link",
        translation: { x: 1, y: 2, z: 3 },
        // 90 degrees around Z transforms the URDF Y axis into world X.
        rotation: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 },
        joint: source,
      },
      {
        parent: "slide_link",
        child: "follower_link",
        translation: { x: 0, y: 0, z: 0 },
        rotation: IDENTITY_ROTATION,
        joint: mimic,
      },
    ];
    const added: Array<{
      child: string;
      timestamp: bigint;
      translation: { x: number; y: number; z: number };
    }> = [];

    applyUrdfJointStateTransforms(
      transforms,
      { timestamp: 12n, positions: new Map([["slide", 0.25]]) },
      (_parent, child, timestamp, translation) => added.push({ child, timestamp, translation }),
    );

    expect(added).toEqual([
      { child: "slide_link", timestamp: 12n, translation: { x: 0.75, y: 2, z: 3 } },
      { child: "follower_link", timestamp: 12n, translation: { x: 0, y: 0, z: 0.6 } },
    ]);
  });
});
