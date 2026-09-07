/** @jest-environment jsdom */

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { ObjectPool } from "@foxglove/den/collection";

import { Urdfs } from "./Urdfs";
import type { IRenderer } from "../IRenderer";
import { Transform } from "../transforms/Transform";
import { TransformTree } from "../transforms/TransformTree";

// Model rendering loads a WebAssembly asset that Jest cannot execute. The integration below
// exercises the real URDF subscription and TransformTree boundary, so only that external boundary
// is replaced.
jest.mock("./markers/RenderableMeshResource", () => ({
  RenderableMeshResource: jest.fn(),
}));

const URDF = `
<robot name="joint-state-test">
  <link name="root" />
  <link name="arm" />
  <joint name="shoulder" type="revolute">
    <parent link="root" />
    <child link="arm" />
    <origin xyz="1 2 3" rpy="0 0 1.5707963267948966" />
    <axis xyz="2 0 0" />
  </joint>
</robot>`;

type TransformCall = {
  parent: string;
  child: string;
  stamp: bigint;
  translation: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
};

type TestRenderer = IRenderer & { removeTransformsByOwner: jest.Mock };

function makeRenderer(transformCalls: TransformCall[]): TestRenderer {
  const transformTree = new TransformTree(new ObjectPool(Transform.Empty));
  const removeTransformsByOwner = jest.fn((owner: string) => {
    transformTree.removeTransformsByOwner(owner);
  });
  const config = {
    topics: {},
    layers: {
      robot: {
        layerId: "foxglove.Urdf" as const,
        instanceId: "robot",
        sourceType: "topic" as const,
        topic: "/custom_robot_description",
        jointStateTopic: "/robot/joint_states",
        framePrefix: "robot/",
        label: "Robot",
        visible: true,
        frameLocked: true,
        displayMode: "auto" as const,
        fallbackColor: "#ffffff",
      },
    },
  };
  const renderer = {
    config,
    on: jest.fn(),
    addCustomLayerAction: jest.fn(),
    addCoordinateFrame: jest.fn(),
    addTransform: (
      parent: string,
      child: string,
      stamp: bigint,
      translation: { x: number; y: number; z: number },
      rotation: { x: number; y: number; z: number; w: number },
      _errorSettingsPath?: string[],
      owner?: string,
    ) => {
      transformCalls.push({ parent, child, stamp, translation, rotation });
      transformTree.addTransform(
        child,
        parent,
        stamp,
        new Transform(
          [translation.x, translation.y, translation.z],
          [rotation.x, rotation.y, rotation.z, rotation.w],
        ),
        owner,
      );
    },
    removeTransform: (child: string, parent: string, stamp: bigint) => {
      transformTree.removeTransform(child, parent, stamp);
    },
    removeTransformsByOwner,
    updateConfig: (update: (draft: typeof config) => void) => {
      update(config);
    },
    updateCustomLayersCount: jest.fn(),
    queueAnimationFrame: jest.fn(),
    transformTree,
    settings: {
      setNodesForKey: jest.fn(),
      errors: {
        add: jest.fn(),
        remove: jest.fn(),
        clearPath: jest.fn(),
      },
    },
    modelCache: { evict: jest.fn() },
  };
  return renderer as unknown as TestRenderer;
}

async function waitForUrdfParse(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("URDF JointStates animation", () => {
  // This catches a regression where a configured custom URDF either subscribes globally, drops
  // the Foxglove schema, or only displays JointState values without writing timestamped link TFs.
  it("writes a prefixed revolute joint transform from the selected Foxglove topic", async () => {
    const transformCalls: TransformCall[] = [];
    const renderer = makeRenderer(transformCalls);
    const urdfs = new Urdfs(renderer);
    const subscriptions = urdfs.getSubscriptions();
    const robotDescriptionSubscription = subscriptions.find(
      (subscription) =>
        subscription.type === "schema" && subscription.schemaNames.has("std_msgs/String"),
    );
    const jointStateSubscription = subscriptions.find(
      (subscription) =>
        subscription.type === "schema" && subscription.schemaNames.has("sensor_msgs/JointState"),
    );

    expect(jointStateSubscription).toBeDefined();
    if (jointStateSubscription?.type !== "schema" || robotDescriptionSubscription?.type !== "schema") {
      throw new Error("expected URDF and JointState schema subscriptions");
    }
    expect(jointStateSubscription.schemaNames.has("foxglove.JointStates")).toBe(true);
    expect(jointStateSubscription.subscription.shouldSubscribe?.("/robot/joint_states")).toBe(true);
    expect(jointStateSubscription.subscription.shouldSubscribe?.("/robot/gimbal/joint_states")).toBe(
      false,
    );
    expect(jointStateSubscription.subscription.preload).toBe(true);
    expect(jointStateSubscription.subscription.filterQueue).toBeUndefined();

    robotDescriptionSubscription.subscription.handler({
      topic: "/custom_robot_description",
      receiveTime: { sec: 1, nsec: 0 },
      message: { data: URDF },
      schemaName: "std_msgs/String",
      sizeInBytes: 0,
    });

    // The selected JointStates subscription can preload before asynchronous URDF parsing has
    // populated the layer's link transforms.
    jointStateSubscription.subscription.handler({
      topic: "/robot/joint_states",
      receiveTime: { sec: 99, nsec: 0 },
      message: {
        timestamp: { sec: 42, nsec: 7 },
        joints: [
          { name: "shoulder", position: Math.PI / 2 },
          { name: "unknown_joint", position: 123 },
          { name: "missing_position" },
        ],
      },
      schemaName: "foxglove.JointStates",
      sizeInBytes: 0,
    });
    await waitForUrdfParse();

    // q(origin yaw=90deg) * q(axis x=90deg) = (0.5, 0.5, 0.5, 0.5). The
    // non-unit URDF axis verifies that FK normalizes the axis before applying the position.
    const dynamicTransform = transformCalls.find((transform) => transform.stamp === 42_000_000_007n);
    expect(dynamicTransform).toMatchObject({
      parent: "robot/root",
      child: "robot/arm",
      stamp: 42_000_000_007n,
      translation: { x: 1, y: 2, z: 3 },
    });
    expect(dynamicTransform?.rotation.x).toBeCloseTo(0.5);
    expect(dynamicTransform?.rotation.y).toBeCloseTo(0.5);
    expect(dynamicTransform?.rotation.z).toBeCloseTo(0.5);
    expect(dynamicTransform?.rotation.w).toBeCloseTo(0.5);
    expect(transformCalls).not.toContainEqual(
      expect.objectContaining({ child: "robot/unknown_joint" }),
    );
  });

  // This catches synthetic FK transforms surviving a selected JointState topic/source change.
  // The renderer owns the removal; the extension must identify its layer-specific ownership key.
  it("removes synthetic link transforms when the JointState topic or URDF source changes", async () => {
    const transformCalls: TransformCall[] = [];
    const renderer = makeRenderer(transformCalls);
    const urdfs = new Urdfs(renderer);
    const subscriptions = urdfs.getSubscriptions();
    const robotDescriptionSubscription = subscriptions.find(
      (subscription) =>
        subscription.type === "schema" && subscription.schemaNames.has("std_msgs/String"),
    );
    const jointStateSubscription = subscriptions.find(
      (subscription) =>
        subscription.type === "schema" && subscription.schemaNames.has("sensor_msgs/JointState"),
    );
    if (robotDescriptionSubscription?.type !== "schema" || jointStateSubscription?.type !== "schema") {
      throw new Error("expected URDF and JointState schema subscriptions");
    }

    robotDescriptionSubscription.subscription.handler({
      topic: "/custom_robot_description",
      receiveTime: { sec: 1, nsec: 0 },
      message: { data: URDF },
      schemaName: "std_msgs/String",
      sizeInBytes: 0,
    });
    await waitForUrdfParse();
    jointStateSubscription.subscription.handler({
      topic: "/robot/joint_states",
      receiveTime: { sec: 1, nsec: 0 },
      message: { timestamp: { sec: 0, nsec: 0 }, joints: [{ name: "shoulder", position: 1 }] },
      schemaName: "foxglove.JointStates",
      sizeInBytes: 0,
    });

    const layerHandler = urdfs.settingsNodes().find((entry) => entry.path[1] === "robot")?.node
      .handler;
    expect(layerHandler).toBeDefined();
    layerHandler?.({
      action: "update",
      payload: { path: ["layers", "robot", "jointStateTopic"], value: "/robot/next_joint_states" },
    } as never);

    const armFrame = renderer.transformTree.frame("robot/arm");
    expect(armFrame).toBeDefined();
    const lower: [bigint, Transform] = [0n, Transform.Empty()];
    const upper: [bigint, Transform] = [0n, Transform.Empty()];
    expect(armFrame!.findClosestTransforms(lower, upper, 10_000_000_000n, 20_000_000_000n)).toBe(
      true,
    );
    expect(lower[0]).toBe(0n);
    expect(lower[1].rotation()[0]).toBeCloseTo(0);
    expect(lower[1].rotation()[2]).toBeCloseTo(Math.SQRT1_2);

    jointStateSubscription.subscription.handler({
      topic: "/robot/next_joint_states",
      receiveTime: { sec: 1, nsec: 0 },
      message: { timestamp: { sec: 11, nsec: 0 }, joints: [{ name: "shoulder", position: 1 }] },
      schemaName: "foxglove.JointStates",
      sizeInBytes: 0,
    });
    // Forward seek clears scene renderables but leaves the TransformTree intact. The dynamic
    // sample from the old selected topic must retain its owner until the next setting cleanup.
    urdfs.removeAllRenderables();
    layerHandler?.({
      action: "update",
      payload: { path: ["layers", "robot", "jointStateTopic"], value: "/robot/final_joint_states" },
    } as never);
    const afterForwardSeek = renderer.transformTree.frame("robot/arm");
    expect(afterForwardSeek).toBeDefined();
    expect(
      afterForwardSeek!.findClosestTransforms(lower, upper, 11_000_000_000n, 20_000_000_000n),
    ).toBe(true);
    expect(lower[0]).toBe(0n);

    jointStateSubscription.subscription.handler({
      topic: "/robot/final_joint_states",
      receiveTime: { sec: 1, nsec: 0 },
      message: { timestamp: { sec: 12, nsec: 0 }, joints: [{ name: "shoulder", position: 1 }] },
      schemaName: "foxglove.JointStates",
      sizeInBytes: 0,
    });
    layerHandler?.({
      action: "update",
      payload: { path: ["layers", "robot", "topic"], value: "/replacement_robot_description" },
    } as never);

    expect(renderer.removeTransformsByOwner).toHaveBeenCalledTimes(3);
    expect(renderer.removeTransformsByOwner).toHaveBeenNthCalledWith(1, "foxglove.Urdfs:robot");
    expect(renderer.removeTransformsByOwner).toHaveBeenNthCalledWith(2, "foxglove.Urdfs:robot");
    expect(renderer.removeTransformsByOwner).toHaveBeenNthCalledWith(3, "foxglove.Urdfs:robot");
  });
});
