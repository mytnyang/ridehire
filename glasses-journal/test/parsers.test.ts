import { describe, expect, it } from "vitest";
import { formatTaken, resolveCapture } from "../src/capture";
import { parseJpegExif } from "../src/exif";
import { readMp4Info } from "../src/mp4";
import { buildJpeg, buildMp4 } from "./fixtures";

describe("parseJpegExif", () => {
  it.each([false, true])("reads time, offset, GPS and camera (littleEndian=%s)", (littleEndian) => {
    const jpeg = buildJpeg({
      dateTimeOriginal: "2026:09:27 15:04:05",
      offset: "-05:00",
      lat: 41.878114,
      lon: -87.629798,
      make: "Meta",
      model: "Ray-Ban Meta Smart Glasses",
      littleEndian,
    });
    const info = parseJpegExif(jpeg)!;
    expect(info.dateTimeOriginal).toBe("2026-09-27T15:04:05");
    expect(info.offsetTimeOriginal).toBe("-05:00");
    expect(info.latitude).toBeCloseTo(41.878114, 5);
    expect(info.longitude).toBeCloseTo(-87.629798, 5);
    expect(info.make).toBe("Meta");
    expect(info.model).toBe("Ray-Ban Meta Smart Glasses");
  });

  it("returns what exists when GPS is missing", () => {
    const info = parseJpegExif(buildJpeg({ dateTimeOriginal: "2026:01:02 03:04:05" }))!;
    expect(info.dateTimeOriginal).toBe("2026-01-02T03:04:05");
    expect(info.latitude).toBeUndefined();
  });

  it("returns null for non-JPEG data", () => {
    expect(parseJpegExif(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull();
  });
});

describe("readMp4Info", () => {
  const reader = (bytes: Uint8Array) => async (offset: number, length: number) => bytes.subarray(offset, offset + length);

  it("reads mvhd time/duration and ©xyz location, with moov after mdat", async () => {
    const mp4 = buildMp4({ createdUnix: Date.UTC(2026, 8, 27, 20, 4, 5) / 1000, timescale: 600, duration: 600 * 42, iso6709: "+41.8781-087.6298+180.000/", moovAtEnd: true, mdatBytes: 5000 });
    const info = (await readMp4Info(reader(mp4), mp4.length))!;
    expect(info.createdAt).toBe("2026-09-27T20:04:05Z");
    expect(info.durationSeconds).toBe(42);
    expect(info.latitude).toBeCloseTo(41.8781);
    expect(info.longitude).toBeCloseTo(-87.6298);
  });

  it("reads Apple keys metadata", async () => {
    const mp4 = buildMp4({
      createdUnix: 1_790_000_000,
      appleKeys: {
        "com.apple.quicktime.location.ISO6709": "+34.0522-118.2437/",
        "com.apple.quicktime.make": "Meta",
        "com.apple.quicktime.model": "Oakley Meta HSTN",
      },
    });
    const info = (await readMp4Info(reader(mp4), mp4.length))!;
    expect(info.latitude).toBeCloseTo(34.0522);
    expect(info.longitude).toBeCloseTo(-118.2437);
    expect(info.make).toBe("Meta");
    expect(info.model).toBe("Oakley Meta HSTN");
  });

  it("treats an unset creation time as missing", async () => {
    const mp4 = buildMp4({ duration: 1000 });
    const info = (await readMp4Info(reader(mp4), mp4.length))!;
    expect(info.createdAt).toBeUndefined();
    expect(info.durationSeconds).toBe(1);
  });
});

describe("resolveCapture", () => {
  const now = new Date("2026-09-28T00:00:00Z");
  const tz = "America/Chicago";

  it("prefers EXIF time with offset, and file GPS over phone GPS", () => {
    const c = resolveCapture({
      exif: { dateTimeOriginal: "2026-09-27T15:04:05", offsetTimeOriginal: "-05:00", latitude: 1.5, longitude: 2.5, make: "Meta", model: "Ray-Ban Meta Smart Glasses" },
      phone: { takenAt: "2026-09-27T16:00:00-05:00", latitude: 9, longitude: 9, place: "Lincoln Park Zoo" },
      timeZone: tz,
      now,
    });
    expect(c.taken).toEqual({ start: "2026-09-27T15:04:05-05:00", source: "Camera (EXIF, with UTC offset)" });
    expect([c.latitude, c.longitude, c.locationSource]).toEqual([1.5, 2.5, "Embedded in file"]);
    expect(c.place).toBe("Lincoln Park Zoo");
    expect(c.camera).toBe("Ray-Ban Meta Smart Glasses");
  });

  it("uses the phone's zone-aware time over a zoneless camera clock", () => {
    const c = resolveCapture({ exif: { dateTimeOriginal: "2026-09-27T15:04:05" }, phone: { takenAt: "2026-09-27T15:04:05-05:00" }, timeZone: tz, now });
    expect(c.taken.source).toBe("iPhone Photos library");
  });

  it("falls back to zoneless EXIF with the configured zone, then video header, then upload time", () => {
    expect(resolveCapture({ exif: { dateTimeOriginal: "2026-09-27T15:04:05" }, phone: {}, timeZone: tz, now }).taken).toEqual({
      start: "2026-09-27T15:04:05",
      timeZone: tz,
      source: `Camera (EXIF, assumed ${tz})`,
    });
    expect(resolveCapture({ mp4: { createdAt: "2026-09-27T20:04:05Z" }, phone: {}, timeZone: tz, now }).taken.start).toBe("2026-09-27T20:04:05Z");
    expect(resolveCapture({ phone: {}, timeZone: tz, now }).taken.source).toMatch(/Upload time/);
  });

  it("uses phone GPS when the file has none", () => {
    const c = resolveCapture({ phone: { latitude: 41.9, longitude: -87.6 }, timeZone: tz, now });
    expect(c.locationSource).toBe("iPhone Photos library");
  });
});

describe("formatTaken", () => {
  it("shows zoned times in the display zone and zoneless times as-is", () => {
    expect(formatTaken({ start: "2026-09-27T20:04:05Z", source: "" }, "America/Chicago")).toBe("Sep 27, 2026, 3:04 PM");
    expect(formatTaken({ start: "2026-09-27T15:04:05", timeZone: "America/Chicago", source: "" }, "America/Chicago")).toBe("Sep 27, 2026, 3:04 PM");
  });
});
