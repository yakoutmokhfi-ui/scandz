import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSmtpMimeMessage } from "../lib/server/ack-mailer.ts";
const base = {
  config: {
    host: "smtp.example.com",
    port: 465,
    user: "marchand@example.com",
    password: "synthetic",
    from: "marchand@example.com",
  },
  to: "client@example.com",
  cc: null,
  subject: "Facture",
  text: "Texte",
  html: "<p>Texte</p>",
};
test("PDF attachment nested as mixed/alternative and exact bytes recoverable", () => {
  const pdf = Buffer.from("%PDF-fixture".repeat(30));
  const mime = buildSmtpMimeMessage({
    ...base,
    attachments: [{ filename: "FAC-DEMO-2026-000001.pdf", content: pdf }],
  });
  assert.match(mime, /Content-Type: multipart\/mixed/);
  assert.match(mime, /Content-Type: multipart\/alternative/);
  assert.match(
    mime,
    /Content-Disposition: attachment; filename="FAC-DEMO-2026-000001.pdf"/,
  );
  const part = mime
    .split("Content-Transfer-Encoding: base64\r\n")[1]
    .split("\r\n\r\n")[1]
    .split("\r\n--")[0];
  assert.deepEqual(Buffer.from(part.replace(/\r\n/g, ""), "base64"), pdf);
  assert.ok(part.split("\r\n").every((l) => l.length <= 76));
});
test("existing messages stay alternative-only", () => {
  assert.match(
    buildSmtpMimeMessage(base),
    /Content-Type: multipart\/alternative/,
  );
  assert.doesNotMatch(buildSmtpMimeMessage(base), /multipart\/mixed/);
});
test("attachment filenames cannot inject MIME headers", () => {
  assert.throws(
    () =>
      buildSmtpMimeMessage({
        ...base,
        attachments: [
          {
            filename: "bad.pdf\r\nBCC:evil@example.com",
            content: Buffer.from("%PDF-test"),
          },
        ],
      }),
    /INVALID_ATTACHMENT/,
  );
});
test("non-PDF and oversized attachments are rejected", () => {
  for (const content of [Buffer.from("<html>"), Buffer.alloc(2000001)])
    assert.throws(
      () =>
        buildSmtpMimeMessage({
          ...base,
          attachments: [{ filename: "a.pdf", content }],
        }),
      /INVALID_ATTACHMENT/,
    );
});
