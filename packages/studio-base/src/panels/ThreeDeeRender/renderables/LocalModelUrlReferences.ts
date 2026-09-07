// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/**
 * Tracks embedded model URLs held by each URDF layer and returns URLs that no
 * remaining layer can use. This deliberately owns references by layer, rather
 * than by mesh renderable: a layer may still be parsing while another layer is
 * removed or replaced.
 */
export class LocalModelUrlReferences {
  #urlsByInstanceId = new Map<string, Set<string>>();

  /** Replaces one layer's reservations and returns URLs that became unused. */
  public replace(instanceId: string, urls: Iterable<string>): Set<string> {
    const previous = this.#urlsByInstanceId.get(instanceId) ?? new Set<string>();
    const next = new Set(urls);
    if (next.size === 0) {
      this.#urlsByInstanceId.delete(instanceId);
    } else {
      this.#urlsByInstanceId.set(instanceId, next);
    }
    return this.#unreferenced(previous);
  }

  /** Releases one layer and returns URLs that no remaining layer can use. */
  public release(instanceId: string): Set<string> {
    return this.replace(instanceId, []);
  }

  /** Releases every layer and returns all URLs that had been reserved. */
  public clear(): Set<string> {
    const urls = new Set<string>();
    for (const instanceUrls of this.#urlsByInstanceId.values()) {
      for (const url of instanceUrls) {
        urls.add(url);
      }
    }
    this.#urlsByInstanceId.clear();
    return urls;
  }

  #unreferenced(previous: ReadonlySet<string>): Set<string> {
    const referenced = new Set<string>();
    for (const urls of this.#urlsByInstanceId.values()) {
      for (const url of urls) {
        referenced.add(url);
      }
    }
    return new Set([...previous].filter((url) => !referenced.has(url)));
  }
}
