import assert from "node:assert/strict";
import { test } from "node:test";
import { PRESETS, nextSlot, validTimezone } from "../publishing/slots";
const slot = (after: string, zone: string, times: string[], occupied: string[] = []) => nextSlot(new Date(after), zone, times, new Set(occupied)).toISOString();
test("daily presets exactly match requested configurable defaults", () => {
  assert.deepEqual(PRESETS.map((p) => p.slots), [["12:30", "16:30", "20:30"], ["11:30", "15:00", "19:00", "22:00"], ["10:00", "19:30"], ["09:00", "13:00", "17:30", "21:00"]]);
});
test("New York winter/summer offsets and strict future scheduling", () => {
  assert.equal(slot("2026-01-12T16:00:00Z", "America/New_York", ["12:30"]), "2026-01-12T17:30:00.000Z");
  assert.equal(slot("2026-07-12T16:00:00Z", "America/New_York", ["12:30"]), "2026-07-12T16:30:00.000Z");
  assert.equal(slot("2026-07-12T16:30:00Z", "America/New_York", ["12:30"]), "2026-07-13T16:30:00.000Z");
});
test("spring-forward nonexistent times are skipped, not shifted", () => {
  assert.equal(slot("2026-03-08T05:00:00Z", "America/New_York", ["02:30"]), "2026-03-09T06:30:00.000Z");
});
test("fall-back chooses first occurrence and never duplicates repeated wall time", () => {
  assert.equal(slot("2026-11-01T04:00:00Z", "America/New_York", ["01:30"]), "2026-11-01T05:30:00.000Z");
  assert.equal(slot("2026-11-01T05:45:00Z", "America/New_York", ["01:30"]), "2026-11-02T06:30:00.000Z");
  assert.equal(slot("2026-11-01T04:00:00Z", "America/New_York", ["01:30"], ["2026-11-01T05:30:00.000Z"]), "2026-11-02T06:30:00.000Z");
});
test("per-account collisions and timezone validation", () => {
  assert.equal(slot("2026-01-12T00:00:00Z", "UTC", ["09:00", "13:00"], ["2026-01-12T09:00:00.000Z"]), "2026-01-12T13:00:00.000Z");
  assert.equal(validTimezone("Not/AZone"), false);
  assert.throws(() => slot("2026-01-12T00:00:00Z", "UTC", ["25:00"]));
});
