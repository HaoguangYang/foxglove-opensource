// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/** Tracks the latest async source load for each URDF layer. */
export class UrdfLoadGeneration {
  #byInstanceId = new Map<string, number>();

  public begin(instanceId: string): number {
    const generation = (this.#byInstanceId.get(instanceId) ?? 0) + 1;
    this.#byInstanceId.set(instanceId, generation);
    return generation;
  }

  public isCurrent(instanceId: string, generation: number): boolean {
    return this.#byInstanceId.get(instanceId) === generation;
  }
}
