import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { GET } from "../app/api/internal/invoices/send/route.ts";
test("invoice cron authenticates before inspecting gates", async () => {
  process.env.CRON_SECRET = "synthetic-cron";
  for (const header of ["", "Bearer wrong", "Basic synthetic-cron"])
    assert.equal(
      (
        await GET(
          new NextRequest("http://localhost/api/internal/invoices/send", {
            headers: { authorization: header },
          }),
        )
      ).status,
      401,
    );
});
test("invoice generation disabled by default, no SQL or SMTP needed", async () => {
  process.env.CRON_SECRET = "synthetic-cron";
  delete process.env.INVOICE_PDF_ENABLED;
  const response = await GET(
    new NextRequest("http://localhost/api/internal/invoices/send", {
      headers: { authorization: "Bearer synthetic-cron" },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "disabled" });
});
test("independent two-minute invoice cron; existing notification/Monetico cadence untouched", () => {
  const crons = JSON.parse(readFileSync("vercel.json", "utf8")).crons;
  assert.equal(
    crons.find((c: any) => c.path === "/api/internal/invoices/send").schedule,
    "*/2 * * * *",
  );
  assert.equal(
    crons.find((c: any) => c.path === "/api/internal/notifications/send")
      .schedule,
    "*/2 * * * *",
  );
  assert.equal(
    crons.find((c: any) => c.path === "/api/internal/payments/monetico/recover")
      .schedule,
    "*/5 * * * *",
  );
});
