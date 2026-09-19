import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import {
  consumePendingIdentifyRestore,
  restoreIdentifySelection,
  type IdentifyPopupState,
} from "../packages/map/src/map-identify-lifecycle";
import { applySelectionHighlight, selectionFitKey } from "../packages/map/src/map-selection";
import { geojsonLayer } from "./helpers/layer-fixtures";

// This file pins the contract between the shared Identify-restore marker
// (map-identify-lifecycle) and the selection effect both 2D canvases run
// (map-selection.ts): restoreIdentifySelection must set the marker BEFORE it
// calls selectFeatures, so that whichever engine observes it — MapboxCanvas
// through a synchronous store subscription (fires inside that write), or
// MapCanvas through a React effect that runs after the restore returned — sees
// exactly one `fit: false` write for the restored selection, and only for that
// selection.

const originalSelectLayer = useAppStore.getState().selectLayer;
const originalSelectFeatures = useAppStore.getState().selectFeatures;

// A zustand-style subscription, exactly as MapboxCanvas installs it: invoked
// synchronously inside the store's set() for the write that changed the selection.
function subscribeNextSelection(fn: () => unknown): () => void {
  return useAppStore.subscribe((state, prev) => {
    if (
      state.selectedLayerId !== prev.selectedLayerId ||
      state.selectedFeatureId !== prev.selectedFeatureId ||
      state.selectedFeatureIds !== prev.selectedFeatureIds
    ) {
      fn();
    }
  });
}

afterEach(() => {
  useAppStore.setState({
    layers: [],
    selectedLayerId: null,
    selectedFeatureId: null,
    selectedFeatureIds: [],
    selectLayer: originalSelectLayer,
    selectFeatures: originalSelectFeatures,
  });
  // Drop any marker a test left behind so it can't leak into the next test.
  consumePendingIdentifyRestore("__drain__");
});

function seedIdentifyHit(): void {
  // "previous" is the selection the user had before Identify; "identified" is
  // what the popup opened on.
  useAppStore.setState({
    layers: [geojsonLayer({ id: "identified" }), geojsonLayer({ id: "previous" })],
    selectedLayerId: "identified",
    selectedFeatureId: "hit",
    selectedFeatureIds: ["hit"],
    selectLayer: originalSelectLayer,
    selectFeatures: originalSelectFeatures,
  });
}

function popupState(patch: Partial<IdentifyPopupState> = {}): IdentifyPopupState {
  return {
    identifiedLayerId: "identified",
    identifiedFeatureId: "hit",
    previousSelectedLayerId: "previous",
    previousSelectedFeatureId: "b",
    previousSelectedFeatureIds: ["a", "b"],
    onClose: () => {},
    ...patch,
  };
}

/** A recording stand-in for MapEngine — we only call it the way applySelectionHighlight does. */
function recordingEngine() {
  type Call = { featureId: string | string[] | null; fit: boolean | undefined };
  const calls: Call[] = [];
  const engine = {
    highlightFeature(
      _layer: unknown,
      featureId: string | string[] | null,
      options?: { fit?: boolean },
    ) {
      calls.push({ featureId: featureId ?? null, fit: options?.fit });
    },
  } as unknown as Parameters<typeof applySelectionHighlight>[0];
  return { engine, calls };
}

describe("selectionFitKey", () => {
  it("returns null when there is no layer or no highlighted features", () => {
    assert.equal(
      selectionFitKey({ selectedLayerId: null, selectedFeatureId: "a", selectedFeatureIds: [] }),
      null,
    );
    assert.equal(
      selectionFitKey({
        selectedLayerId: "layer",
        selectedFeatureId: null,
        selectedFeatureIds: [],
      }),
      null,
    );
  });

  it("uses the multi-select set when present, else the anchor, under a collision-proof shape", () => {
    const withMulti = selectionFitKey({
      selectedLayerId: "layer",
      selectedFeatureId: "a",
      selectedFeatureIds: ["a", "b"],
    });
    assert.equal(withMulti, JSON.stringify(["layer", ["a", "b"]]));

    const anchorOnly = selectionFitKey({
      selectedLayerId: "layer",
      selectedFeatureId: "solo",
      selectedFeatureIds: [],
    });
    assert.equal(anchorOnly, JSON.stringify(["layer", ["solo"]]));

    // Delimiter-free serialization keeps ["a,b"] distinct from ["a", "b"].
    const embedded = selectionFitKey({
      selectedLayerId: "layer",
      selectedFeatureId: "a,b",
      selectedFeatureIds: [],
    });
    assert.notEqual(embedded, withMulti);
    assert.equal(embedded, JSON.stringify(["layer", ["a,b"]]));
  });
});

describe("restore marker -> fit suppression (both canvas call shapes)", () => {
  it("expose the marker synchronously to a Mapbox subscriber during selectFeatures", () => {
    seedIdentifyHit();
    const { engine, calls } = recordingEngine();

    // Reproduce MapboxCanvas's subscription: whenever the store reports a new
    // selection, read the marker for that exact state and apply the highlight.
    // Because this subscriber is installed via useAppStore.subscribe, zustand
    // invokes it synchronously inside the set() that changed the selection.
    let appliedRestoredKey: string | null = null;
    const unsubscribe = subscribeNextSelection(() => {
      const state = useAppStore.getState();
      // Mirror MapboxCanvas.tsx byte-for-byte: it consumes the marker on
      // EVERY qualifying store write (even a null-key intermediate write, e.g.
      // the layer-only state right after selectLayer before selectFeatures),
      // then applies the highlight with that state's restoring argument.
      const key = selectionFitKey({
        selectedLayerId: state.selectedLayerId,
        selectedFeatureId: state.selectedFeatureId,
        selectedFeatureIds: state.selectedFeatureIds,
      });
      const restoring = consumePendingIdentifyRestore(key);
      applySelectionHighlight(
        engine,
        state.layers,
        state.selectedLayerId,
        state.selectedFeatureId,
        state.selectedFeatureIds,
        true,
        null,
        restoring,
      );
      if (restoring) appliedRestoredKey = key;
    });

    const restoredKey = JSON.stringify(["previous", ["a", "b"]]);

    restoreIdentifySelection(popupState());
    unsubscribe();

    // The restored selection must have been applied while restoring=true, so
    // its write was fit-suppressed and the full multi-select set highlighted.
    // (The intermediate selectLayer null-key write is also present and is
    // correctly NOT the one keyed to the restored selection.)
    const restoredCall = calls.find(
      (c) =>
        Array.isArray(c.featureId) &&
        c.featureId.length === 2 &&
        c.featureId[0] === "a" &&
        c.featureId[1] === "b",
    );
    assert.ok(restoredCall, "the restored multi-selection must be highlighted");
    assert.equal(restoredCall.fit, false, "the restored selection must not re-fit");
    assert.equal(
      appliedRestoredKey,
      restoredKey,
      "the marker was consumed as a match on exactly the restored selection",
    );

    // After the restore returned, no marker is left behind — the marker was
    // consumed by the subscriber (or a superseding write), not left to be
    // re-used by the deferred MapCanvas effect.
    assert.equal(
      consumePendingIdentifyRestore(restoredKey),
      false,
      "marker must not survive the restore + consumption",
    );
  });

  it("defers the marker to the MapCanvas (React effect) path when no sync subscriber is present", () => {
    seedIdentifyHit();
    const { engine, calls } = recordingEngine();

    // No subscriber, so the marker is not consumed inside the store write.
    // React's effect runs later — simulate that by reading the key after the
    // restore returns, exactly as MapCanvas's effect does.
    restoreIdentifySelection(popupState());

    // The effect reads the CURRENT store selection (not a hard-coded one), so
    // this also locks that restoreIdentifySelection wrote the right state:
    // the effect consumes the marker for the selection the store actually has.
    const state = useAppStore.getState();
    assert.equal(state.selectedLayerId, "previous");
    assert.equal(state.selectedFeatureId, "b");
    assert.deepEqual(state.selectedFeatureIds, ["a", "b"]);

    const key = selectionFitKey({
      selectedLayerId: state.selectedLayerId,
      selectedFeatureId: state.selectedFeatureId,
      selectedFeatureIds: state.selectedFeatureIds,
    });
    const restoring = consumePendingIdentifyRestore(key);
    assert.equal(restoring, true, "deferred effect must still see the marker");

    const nextKey = applySelectionHighlight(
      engine,
      state.layers,
      state.selectedLayerId,
      state.selectedFeatureId,
      state.selectedFeatureIds,
      true,
      null,
      restoring,
    );
    assert.equal(nextKey, key);
    const restoredCall = calls.at(-1);
    assert.ok(restoredCall);
    assert.equal(restoredCall.fit, false, "restored selection must not re-fit (MapLibre shape)");
    assert.deepEqual(restoredCall.featureId, ["a", "b"]);

    // And the marker is now gone.
    assert.equal(consumePendingIdentifyRestore(key), false);
  });

  it("does not suppress fit for a different (non-restored) selection", () => {
    seedIdentifyHit();

    restoreIdentifySelection(popupState());
    // A different selection arrives (not the restored one) before the effect
    // reads the marker — e.g. a user clicks another feature right after the
    // popup closes.
    const store = useAppStore.getState();
    store.selectFeatures(["z"], "z");

    const restoring = consumePendingIdentifyRestore(
      selectionFitKey({
        selectedLayerId: "previous",
        selectedFeatureId: "z",
        selectedFeatureIds: ["z"],
      }),
    );
    assert.equal(restoring, false, "a superseding selection is not the restore");

    // The marker should still be cleared by that non-matching read — it is
    // one-shot either way.
    assert.equal(
      consumePendingIdentifyRestore(
        selectionFitKey({
          selectedLayerId: "previous",
          selectedFeatureId: "b",
          selectedFeatureIds: ["a", "b"],
        }),
      ),
      false,
    );
  });

  it("a skipped restore (guard: user already changed selection) leaves no marker and no suppression", () => {
    seedIdentifyHit();
    const { engine, calls } = recordingEngine();

    // The user independently changed the selection while the popup was open.
    const store = useAppStore.getState();
    store.selectLayer("previous");
    store.selectFeature("user");
    store.selectFeatures(["user"], "user");

    restoreIdentifySelection(popupState());

    const currentRestoring = consumePendingIdentifyRestore(
      selectionFitKey({
        selectedLayerId: "previous",
        selectedFeatureId: "user",
        selectedFeatureIds: ["user"],
      }),
    );
    assert.equal(currentRestoring, false, "no restore happened, so no marker to consume");

    const nextKey = applySelectionHighlight(
      engine,
      useAppStore.getState().layers,
      "previous",
      "user",
      ["user"],
      true,
      null,
      currentRestoring,
    );
    assert.equal(nextKey, JSON.stringify(["previous", ["user"]]));
    const call = calls.at(-1);
    assert.ok(call);
    assert.equal(call.fit, true, "a user selection must still fit normally");
  });
});
