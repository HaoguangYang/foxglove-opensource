// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useCallback, useContext, useLayoutEffect, useMemo, useRef } from "react";

import CurrentLayoutContext from "@foxglove/studio-base/context/CurrentLayoutContext";

type SignalContext = {
  signalExpressions: string[];
  signalMetadata: { expression: string; timestampMethod: "receiveTime" | "headerStamp" }[];
};
type Contribution = SignalContext & { sourceId: string };

// Transient per-app state. Weak ownership prevents cross-app mixing and needs no persistence.
const registries = new WeakMap<object, Map<object, Contribution>>();

/** Read the current committed union on Save, rather than capturing it when an editor opens. */
export function usePlotLabelSignals(
  sourceId: string | undefined,
  signalExpressions: SignalContext["signalExpressions"],
  signalMetadata: SignalContext["signalMetadata"],
): () => SignalContext {
  const standaloneOwner = useRef({});
  const owner = useContext(CurrentLayoutContext) ?? standaloneOwner.current;
  const token = useRef({});
  const registry = useMemo(() => {
    let entries = registries.get(owner);
    if (!entries) {
      entries = new Map();
      registries.set(owner, entries);
    }
    return entries;
  }, [owner]);

  useLayoutEffect(() => {
    const key = token.current;
    if (sourceId != undefined) {
      registry.set(key, { sourceId, signalExpressions, signalMetadata });
    }
    return () => {
      registry.delete(key);
    };
  }, [registry, sourceId, signalExpressions, signalMetadata]);

  return useCallback(() => {
    const expressions = new Set<string>();
    const metadata = new Map<string, SignalContext["signalMetadata"][number]>();
    for (const entry of registry.values()) {
      if (entry.sourceId !== sourceId) {
        continue;
      }
      for (const expression of entry.signalExpressions) {
        expressions.add(expression);
      }
      for (const signal of entry.signalMetadata) {
        metadata.set(JSON.stringify([signal.expression, signal.timestampMethod])!, signal);
      }
    }
    return { signalExpressions: [...expressions], signalMetadata: [...metadata.values()] };
  }, [registry, sourceId]);
}
