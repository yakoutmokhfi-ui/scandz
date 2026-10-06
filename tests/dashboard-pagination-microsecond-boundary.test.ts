import assert from "node:assert/strict";
import test from "node:test";
import { compareOrderKeys } from "../lib/dashboard-pagination.ts";

const lowId = "00000000-0000-0000-0000-000000000001";
const highId = "ffffffff-ffff-ffff-ffff-ffffffffffff";

// Explicit PostgreSQL microsecond order, including the half-millisecond
// boundaries where rounding instead of truncation would reverse some pairs.
for (const fractions of [
  ["000499", "0005", "000501", "000999", "001"],
  ["123499", "1235", "123501", "123999", "124"],
  ["999499", "9995", "999501", "999999"],
]) {
  test(`microsecond boundary ordering: ${fractions.join(" < ")}`, () => {
    const timestamps = fractions.map(f => `2026-10-06T12:00:00.${f}Z`);
    timestamps.push("2026-10-06T12:00:01.000000Z");
    for (let i = 0; i < timestamps.length; i++) {
      for (let j = i + 1; j < timestamps.length; j++) {
        // Opposing UUID order ensures timestamp precedence is actually tested.
        const earlier = { created_at: timestamps[i], id: highId };
        const later = { created_at: timestamps[j], id: lowId };
        assert.equal(compareOrderKeys(earlier, later), -1);
        assert.equal(compareOrderKeys(later, earlier), 1);
      }
    }
  });
}

for (const fraction of ["0005", "1235", "9995"]) {
  test(`microsecond boundary ${fraction}: equivalent precision and timezone tie-break`, () => {
    const a = { created_at: `2026-10-06T12:00:00.${fraction}Z`, id: lowId };
    const b = { created_at: `2026-10-06T14:00:00.${fraction}00+02:00`, id: lowId };
    assert.equal(compareOrderKeys(a, b), 0);
    assert.equal(compareOrderKeys(a, { ...b, id: highId }), -1);
    assert.equal(compareOrderKeys({ ...a, id: highId }, b), 1);
  });
}
