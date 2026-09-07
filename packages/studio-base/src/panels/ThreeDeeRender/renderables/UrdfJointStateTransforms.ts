// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import type { UrdfJoint, Vector3 as UrdfVector3 } from "@foxglove/den/urdf";
import { toNanoSec } from "@foxglove/rostime";

export type UrdfJointTransform = {
  parent: string;
  child: string;
  translation: UrdfVector3;
  rotation: { x: number; y: number; z: number; w: number };
  joint: UrdfJoint;
};

export type JointPosition = {
  timestamp: bigint;
  position: number;
};

export type NormalizedJointState = {
  timestamp: bigint;
  positions: Map<string, number>;
};

type TimeLike = { sec: number; nsec: number };
type RecordLike = Record<string, unknown>;

type AddTransform = (
  parent: string,
  child: string,
  timestamp: bigint,
  translation: UrdfVector3,
  rotation: { x: number; y: number; z: number; w: number },
) => void;

/**
 * Converts the ROS sensor_msgs/JointState and Foxglove JointStates payloads into the single
 * representation used by URDF animation. A payload timestamp is preferred only when it is a
 * well-formed ROS time; receiveTime is the event-time fallback for malformed or absent stamps.
 */
export function normalizeUrdfJointState(message: unknown, receiveTime: TimeLike): NormalizedJointState {
  const record = asRecord(message);
  const timestamp =
    toValidNanoSec(record?.timestamp) ??
    toValidNanoSec(asRecord(record?.header)?.stamp) ??
    toNanoSec(receiveTime);
  const positions = new Map<string, number>();

  const foxgloveJoints = record?.joints;
  if (Array.isArray(foxgloveJoints)) {
    for (const entry of foxgloveJoints) {
      const joint = asRecord(entry);
      const name = joint?.name;
      const position = joint?.position;
      if (typeof name === "string" && typeof position === "number" && Number.isFinite(position)) {
        positions.set(name, position);
      }
    }
    return { timestamp, positions };
  }

  const names = record?.name;
  const rosPositions = record?.position;
  if (Array.isArray(names) && Array.isArray(rosPositions)) {
    for (let index = 0; index < names.length; index++) {
      const name = names[index];
      const position = rosPositions[index];
      if (typeof name === "string" && typeof position === "number" && Number.isFinite(position)) {
        positions.set(name, position);
      }
    }
  }

  return { timestamp, positions };
}

/**
 * Writes the dynamic parent-to-child link transforms described by one JointState event. Frame
 * names have already had any URDF framePrefix applied; joint names intentionally remain unprefixed
 * because JointState names refer to URDF joint names.
 */
export function applyUrdfJointStateTransforms(
  transforms: readonly UrdfJointTransform[],
  jointState: NormalizedJointState,
  addTransform: AddTransform,
): number {
  let addedCount = 0;
  const transformsByJointName = new Map(
    transforms.map((transform) => [transform.joint.name, transform] as const),
  );

  for (const transform of transforms) {
    const { joint } = transform;
    if (joint.jointType === "fixed") {
      continue;
    }
    const position = resolveJointPosition(joint, jointState.positions, transformsByJointName, new Set());
    if (position == undefined) {
      continue;
    }

    const dynamicTransform = jointMotionTransform(transform, position);
    if (dynamicTransform) {
      addTransform(
        transform.parent,
        transform.child,
        jointState.timestamp,
        dynamicTransform.translation,
        dynamicTransform.rotation,
      );
      addedCount++;
    }
  }
  return addedCount;
}

function asRecord(value: unknown): RecordLike | undefined {
  return typeof value === "object" && value != undefined ? (value as RecordLike) : undefined;
}

function toValidNanoSec(value: unknown): bigint | undefined {
  const timestamp = asRecord(value);
  const sec = timestamp?.sec;
  const nsec = timestamp?.nsec;
  if (
    typeof sec !== "number" ||
    typeof nsec !== "number" ||
    !Number.isSafeInteger(sec) ||
    !Number.isSafeInteger(nsec) ||
    nsec < 0 ||
    nsec >= 1_000_000_000
  ) {
    return undefined;
  }
  return toNanoSec({ sec, nsec });
}

function resolveJointPosition(
  joint: UrdfJoint,
  positions: ReadonlyMap<string, number>,
  transformsByJointName: ReadonlyMap<string, UrdfJointTransform>,
  resolving: Set<string>,
): number | undefined {
  const directPosition = positions.get(joint.name);
  if (directPosition != undefined) {
    return directPosition;
  }
  if (!joint.mimic || resolving.has(joint.name)) {
    return undefined;
  }

  resolving.add(joint.name);
  const sourceJoint = transformsByJointName.get(joint.mimic.joint)?.joint;
  const sourcePosition =
    sourceJoint == undefined
      ? positions.get(joint.mimic.joint)
      : resolveJointPosition(sourceJoint, positions, transformsByJointName, resolving);
  resolving.delete(joint.name);
  const mimickedPosition =
    sourcePosition == undefined
      ? undefined
      : sourcePosition * joint.mimic.multiplier + joint.mimic.offset;
  return mimickedPosition != undefined && Number.isFinite(mimickedPosition)
    ? mimickedPosition
    : undefined;
}

function jointMotionTransform(
  transform: UrdfJointTransform,
  position: number,
): Pick<UrdfJointTransform, "translation" | "rotation"> | undefined {
  const { joint } = transform;
  const originRotation = transform.rotation;
  const axisLength = Math.hypot(joint.axis.x, joint.axis.y, joint.axis.z);
  if (!Number.isFinite(axisLength) || axisLength === 0) {
    return undefined;
  }
  const axis = {
    x: joint.axis.x / axisLength,
    y: joint.axis.y / axisLength,
    z: joint.axis.z / axisLength,
  };

  switch (joint.jointType) {
    case "continuous":
    case "revolute": {
      const halfAngle = position / 2;
      const axisRotation = {
        x: axis.x * Math.sin(halfAngle),
        y: axis.y * Math.sin(halfAngle),
        z: axis.z * Math.sin(halfAngle),
        w: Math.cos(halfAngle),
      };
      return {
        translation: transform.translation,
        rotation: multiplyQuaternions(originRotation, axisRotation),
      };
    }
    case "prismatic": {
      const offset = rotateVector(originRotation, {
        x: axis.x * position,
        y: axis.y * position,
        z: axis.z * position,
      });
      return {
        translation: {
          x: transform.translation.x + offset.x,
          y: transform.translation.y + offset.y,
          z: transform.translation.z + offset.z,
        },
        rotation: originRotation,
      };
    }
    case "fixed":
    case "floating":
    case "planar":
      return undefined;
  }
}

function multiplyQuaternions(
  first: { x: number; y: number; z: number; w: number },
  second: { x: number; y: number; z: number; w: number },
): { x: number; y: number; z: number; w: number } {
  return {
    x: first.w * second.x + first.x * second.w + first.y * second.z - first.z * second.y,
    y: first.w * second.y - first.x * second.z + first.y * second.w + first.z * second.x,
    z: first.w * second.z + first.x * second.y - first.y * second.x + first.z * second.w,
    w: first.w * second.w - first.x * second.x - first.y * second.y - first.z * second.z,
  };
}

function rotateVector(
  rotation: { x: number; y: number; z: number; w: number },
  vector: UrdfVector3,
): UrdfVector3 {
  const doubledCross = {
    x: 2 * (rotation.y * vector.z - rotation.z * vector.y),
    y: 2 * (rotation.z * vector.x - rotation.x * vector.z),
    z: 2 * (rotation.x * vector.y - rotation.y * vector.x),
  };
  return {
    x: vector.x + rotation.w * doubledCross.x + rotation.y * doubledCross.z - rotation.z * doubledCross.y,
    y: vector.y + rotation.w * doubledCross.y + rotation.z * doubledCross.x - rotation.x * doubledCross.z,
    z: vector.z + rotation.w * doubledCross.z + rotation.x * doubledCross.y - rotation.y * doubledCross.x,
  };
}
