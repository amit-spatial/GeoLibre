import assert from "node:assert/strict";
import { it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import type { CustomLayerAdapter } from "maplibre-gl-layer-control";
import {
  LayerControlHost,
  type LayerControlHostAdapter,
} from "../packages/map/src/layer-control-host";
import { geojsonLayer } from "./helpers/layer-fixtures";

it("lists all 85 project layers before any native style layer is mounted", () => {
  const layers = Array.from({ length: 85 }, (_, index) =>
    geojsonLayer({ id: `layer-${index}`, name: `Layer ${index}`, visible: false }),
  );
  const adapter: LayerControlHostAdapter = {
    getMap: () => ({
      getLayer: () => undefined,
      getStyle: () => ({ layers: [] }),
      getSource: () => undefined,
      getContainer: () => document.createElement("div"),
    }),
    addControl: () => {},
    removeControl: () => {},
    getLayers: () => layers,
    getNativeLayerIds: () => [],
    getCandidateNativeLayerIds: (layer) => [`native-${layer.id}`],
    getSourceIds: () => [],
    excludedLayerIds: [],
    getBasemapStyleUrl: () => null,
    getBasemapLayerIds: () => [],
    getBasemapState: () => ({ visible: true, opacity: 1 }),
  };
  const host = new LayerControlHost(adapter);
  const config = (
    host as unknown as {
      createConfig: (layers: GeoLibreLayer[]) => { customLayerAdapters?: CustomLayerAdapter[] };
    }
  ).createConfig(layers);
  const controlAdapter = config.customLayerAdapters?.[0];
  assert.ok(controlAdapter);
  assert.deepEqual(
    controlAdapter.getLayerIds(),
    layers.map((layer) => layer.id),
  );
  assert.equal(controlAdapter.getLayerState("layer-0")?.visible, false);
  assert.equal(controlAdapter.getLayerState("layer-84")?.name, "Layer 84");
});
