import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { before, describe, it } from "node:test";
import { GeoTiffReader } from "geolibre-wasm";
import { writeArrayBuffer } from "geotiff";
import {
  COG_WASM_COMPRESSIONS,
  convertGeoTiffToCog,
  convertRasterDataToCog,
  initCogWasm,
  isBigEndianTiff,
  isTiledGeoTiff,
  readGeoTiffInfo,
} from "../packages/processing/src/cog-convert";
import { ensureWhiteboxRasterCog } from "../packages/processing/src/wasm-client";

// A tiny 32x32 Int16 GeoTIFF written striped (not tiled) by rasterio, the kind
// of file desktop GIS tools export and that the raster panel cannot render
// until it is converted to a tiled COG. See opengeos/GeoLibre#789.
const stripedTiff = new Uint8Array(
  readFileSync(fileURLToPath(new URL("./fixtures/striped.tif", import.meta.url))),
);

/** A 32x32 Float32 surface: samples ramp as `(i % 500) / 4`, with a 4x4 block
 * of the -9999 GDAL_NODATA sentinel in the top-left corner. */
const BIG_ENDIAN_SIZE = 32;
const bigEndianSamples = (() => {
  const values = new Float32Array(BIG_ENDIAN_SIZE * BIG_ENDIAN_SIZE);
  for (let i = 0; i < values.length; i += 1) values[i] = (i % 500) / 4;
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) values[y * BIG_ENDIAN_SIZE + x] = -9999;
  }
  return values;
})();

// Built here rather than checked in as a fixture because what makes this input
// interesting is one header byte pair (`MM`), which a binary blob hides.
// geotiff.js is the writer behind GeoLibre's own client-side raster tools and
// emits Motorola (big-endian) TIFFs for everything it writes, so it produces
// exactly the kind of file users bring to opengeos/GeoLibre#2410: before the
// byte-order fix GeoTiffReader decoded these samples as little-endian, so every
// value came back byte-swapped and nothing matched nodata.
const bigEndianTiff = new Uint8Array(
  writeArrayBuffer(bigEndianSamples, {
    width: BIG_ENDIAN_SIZE,
    height: BIG_ENDIAN_SIZE,
    ModelPixelScale: [0.25, 0.25, 0],
    ModelTiepoint: [0, 0, 0, -120, 45, 0],
    GDAL_NODATA: "-9999",
    GTModelTypeGeoKey: 2,
    GTRasterTypeGeoKey: 1,
    GeographicTypeGeoKey: 4326,
  } as Parameters<typeof writeArrayBuffer>[1]),
);

// In the browser wasm-bindgen fetches the bundled asset; under node:test we feed
// it the wasm bytes directly so the same converter code runs headless.
const wasmBytes = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL("../node_modules/geolibre-wasm/geolibre_wasm_bg.wasm", import.meta.url)),
  ),
);

describe("convertGeoTiffToCog", () => {
  before(async () => {
    await initCogWasm(wasmBytes);
  });

  it("reads header-only metadata and reports the striped source as non-tiled", async () => {
    const info = await readGeoTiffInfo(stripedTiff);
    assert.equal(info.tiled, false);
    assert.equal(info.width, 32);
    assert.equal(info.height, 32);
    assert.equal(info.bands, 1);
    assert.equal(info.epsg, 4326);
    assert.equal(info.nodata, 0);
    assert.equal(await isTiledGeoTiff(stripedTiff), false);
  });

  it("re-encodes a striped GeoTIFF as a tiled COG, preserving georeferencing", async () => {
    const cog = await convertGeoTiffToCog(stripedTiff);
    const out = await readGeoTiffInfo(cog);
    // The whole point: the output is internally tiled, so the panel can stream it.
    assert.equal(out.tiled, true);
    assert.equal(await isTiledGeoTiff(cog), true);
    // Dimensions, band count, CRS, and nodata survive the round-trip.
    assert.equal(out.width, 32);
    assert.equal(out.height, 32);
    assert.equal(out.bands, 1);
    assert.equal(out.epsg, 4326);
    assert.equal(out.nodata, 0);

    // Pixel values survive (the fixture is row-major `(i % 500) - 11`).
    // read_band_f32 is used here to verify the written COG; the converter itself
    // decodes with read_all_f64 so it handles any source dtype.
    const reader = new GeoTiffReader(cog);
    try {
      const band = reader.read_band_f32(0);
      assert.equal(band.length, 32 * 32);
      assert.equal(band[0], -11);
      assert.equal(band[20], 9);
    } finally {
      reader.free();
    }
  });

  it("encodes in-memory Float32 processing results without corrupting sample bytes", async () => {
    const expected = Float32Array.from([0, 250.25, 282.2, 322.89]);
    const cog = await convertRasterDataToCog({
      bands: [expected],
      width: 4,
      height: 1,
      originX: 2.8,
      originY: 47.35,
      resX: 0.001,
      resY: 0.001,
      nodata: -99999,
      geoKeys: { GTModelTypeGeoKey: 2, GeographicTypeGeoKey: 4326 },
    });
    const reader = new GeoTiffReader(cog);
    try {
      assert.deepEqual(Array.from(reader.read_band_f32(0)), Array.from(expected));
      assert.equal(reader.epsg, 4326);
      assert.deepEqual(Array.from(reader.geo_transform()), [2.8, 0.001, 0, 47.35, 0, -0.001]);
    } finally {
      reader.free();
    }
  });

  for (const crsCode of [32767, 32768, 65535]) {
    it(`rejects user-defined or private CRS code ${crsCode}`, async () => {
      await assert.rejects(
        convertRasterDataToCog({
          bands: [Float32Array.from([1])],
          width: 1,
          height: 1,
          originX: 0,
          originY: 1,
          resX: 1,
          resY: 1,
          nodata: null,
          geoKeys: { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: crsCode },
        }),
        new RegExp(`cannot preserve user-defined or private CRS code ${crsCode}`),
      );
    });
  }

  // Raster to COG lets the user pick a codec on the web, so every advertised
  // choice has to survive an Int16 source — webp/jpeg/jpegxl do not (they reject
  // anything but 8-bit samples) and zstd/raw are not implemented at all, which
  // is why COG_WASM_COMPRESSIONS is narrower than the sidecar's rio-cogeo list.
  for (const compression of COG_WASM_COMPRESSIONS) {
    it(`encodes a valid tiled COG with ${compression} compression`, async () => {
      const cog = await convertGeoTiffToCog(stripedTiff, { compression });
      const out = await readGeoTiffInfo(cog);
      assert.equal(out.ok, true);
      assert.equal(out.tiled, true);
      assert.equal(out.width, 32);
      assert.equal(out.height, 32);

      const reader = new GeoTiffReader(cog);
      try {
        assert.equal(reader.read_band_f32(0)[0], -11);
      } finally {
        reader.free();
      }
    });
  }

  it("defaults to deflate, which compresses better than storing raw", async () => {
    const [deflate, none] = await Promise.all([
      convertGeoTiffToCog(stripedTiff),
      convertGeoTiffToCog(stripedTiff, { compression: "none" }),
    ]);
    assert.ok(
      deflate.byteLength < none.byteLength,
      `deflate (${deflate.byteLength}) should be smaller than none (${none.byteLength})`,
    );
  });

  it("tells a Motorola TIFF from an Intel one by its header magic", () => {
    assert.equal(isBigEndianTiff(bigEndianTiff), true);
    assert.equal(isBigEndianTiff(stripedTiff), false);
    // Too short to carry a byte-order mark at all.
    assert.equal(isBigEndianTiff(new Uint8Array([0x4d])), false);
  });

  it("converts a big-endian GeoTIFF without byte-swapping its samples", async () => {
    const info = await readGeoTiffInfo(bigEndianTiff);
    // The tags of a Motorola TIFF already read correctly; only the samples did
    // not, which is why the corruption was invisible in the metadata.
    assert.equal(info.nodata, -9999);
    assert.equal(info.sample_format, "ieeefloat");
    assert.equal(info.bits_per_sample, 32);

    const cog = await convertGeoTiffToCog(bigEndianTiff);
    const out = await readGeoTiffInfo(cog);
    assert.equal(out.tiled, true);
    assert.equal(out.width, 32);
    assert.equal(out.height, 32);
    assert.equal(out.nodata, -9999);

    const reader = new GeoTiffReader(cog);
    try {
      const band = reader.read_band_f32(0);
      assert.equal(band.length, 32 * 32);
      // The nodata block survives as the exact sentinel, so it still compares
      // equal to GDAL_NODATA and stays masked out of the render and the stats.
      assert.equal(band[0], -9999);
      assert.equal(band[3], -9999);
      // And real samples keep their values instead of decoding to the ~1e-39 /
      // ~1e38 magnitudes a byte-swapped Float32 produces.
      assert.equal(band[4], 1);
      assert.equal(band[31], 31 / 4);
      let max = Number.NEGATIVE_INFINITY;
      for (const value of band) {
        if (value !== -9999) max = Math.max(max, value);
      }
      assert.equal(max, 499 / 4);
    } finally {
      reader.free();
    }
  });

  it("normalizes every Whitebox WASM output because tiling alone does not prove COG conformance", async () => {
    assert.equal(await isTiledGeoTiff(stripedTiff), false);
    const converted = await ensureWhiteboxRasterCog(stripedTiff);

    assert.equal(await isTiledGeoTiff(converted), true);
    assert.notEqual(converted, stripedTiff);
    const revalidated = await ensureWhiteboxRasterCog(converted);
    assert.equal(await isTiledGeoTiff(revalidated), true);
    assert.notEqual(revalidated, converted);
  });
});
