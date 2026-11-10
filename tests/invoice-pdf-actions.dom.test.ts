import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";
const dom = new JSDOM("<html><body></body></html>", {
  url: "http://localhost/dashboard",
  pretendToBeVisual: true,
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Event: dom.window.Event,
});
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const plugin: esbuild.Plugin = {
  name: "aliases",
  setup(b) {
    b.onResolve({ filter: /^@\/lib\/supabase$/ }, () => ({
      path: "supabase",
      namespace: "fake",
    }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({
      contents:
        'export const supabase={auth:{getSession:async()=>({data:{session:{access_token:"synthetic"}}})}}',
      loader: "ts",
    }));
    b.onResolve({ filter: /^@\// }, (a) => ({
      path: path.join(
        process.cwd(),
        a.path.slice(2) + (a.path.endsWith("InvoiceActions") ? ".tsx" : ".ts"),
      ),
    }));
  },
};
const build = await esbuild.build({
  stdin: {
    contents:
      'export {default as Actions} from "@/components/dashboard/InvoiceActions";',
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  plugins: [plugin],
  external: ["react", "react-dom/client"],
});
const dir = mkdtempSync(path.join(process.cwd(), "tests/tmp-invoice-ui-"));
writeFileSync(path.join(dir, "ui.mjs"), build.outputFiles[0].text);
const { Actions } = await import(pathToFileURL(path.join(dir, "ui.mjs")).href);
rmSync(dir, { recursive: true, force: true });
async function waitUntil(fn: () => boolean) {
  const end = Date.now() + 2000;
  while (!fn()) {
    if (Date.now() > end) throw Error("state did not settle");
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function mount(lang = "fr") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  root.render(React.createElement(Actions, { orderId: "order-a", lang }));
  await waitUntil(() => container.querySelectorAll("button").length === 3);
  return { container, root };
}
test("UI does not fetch invoice data on mount; four languages have explicit labels", async () => {
  let fetches = 0;
  const old = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches++;
    throw Error();
  };
  try {
    for (const lang of ["fr", "en", "ar", "nl"]) {
      const { container, root } = await mount(lang);
      assert.equal(container.querySelectorAll("button").length, 3);
      assert.doesNotMatch(container.textContent!, /invPdf/);
      root.unmount();
      container.remove();
    }
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = old;
  }
});
test("resend requires confirmation; never triggered by displaying the card", async () => {
  let fetches = 0;
  const old = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches++;
    throw Error();
  };
  dom.window.confirm = () => false;
  const { container, root } = await mount();
  try {
    (container.querySelectorAll("button")[2] as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fetches, 0);
  } finally {
    root.unmount();
    container.remove();
    globalThis.fetch = old;
  }
});
test("uncertain HTTP retry keeps the same idempotency key and never accepts a recipient from UI", async () => {
  const old = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = async (_url, opts) => {
    bodies.push(JSON.parse(String(opts?.body)));
    if (bodies.length === 1) throw Error("connection lost");
    return new Response(JSON.stringify({ outcome: "already_claimed" }), {
      headers: { "content-type": "application/json" },
    });
  };
  dom.window.confirm = () => true;
  const { container, root } = await mount();
  try {
    (container.querySelectorAll("button")[2] as HTMLElement).click();
    await waitUntil(() => !!container.querySelector("[role=status]"));
    (container.querySelectorAll("button")[2] as HTMLElement).click();
    await waitUntil(
      () =>
        bodies.length === 2 &&
        !(container.querySelector("button") as HTMLButtonElement).disabled,
    );
    assert.equal(bodies[0].requestId, bodies[1].requestId);
    assert.deepEqual(Object.keys(bodies[0]).sort(), [
      "action",
      "orderId",
      "requestId",
    ]);
    assert.match(container.textContent!, /non confirmé/);
  } finally {
    root.unmount();
    container.remove();
    globalThis.fetch = old;
  }
});
test("download uses private bearer header and archived bytes without requesting an email", async () => {
  const old = globalThis.fetch;
  const calls: any[] = [];
  let downloaded = 0;
  const original = dom.window.HTMLAnchorElement.prototype.click;
  dom.window.HTMLAnchorElement.prototype.click = function () {
    downloaded++;
  };
  const originalCreate = URL.createObjectURL,
    originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:synthetic";
  URL.revokeObjectURL = () => {};
  // Avoid holding a two-minute object-URL timer in this test process.
  const timeout = globalThis.setTimeout;
  globalThis.fetch = async (url, opts) => {
    calls.push([url, opts]);
    return new Response("%PDF-synthetic", {
      headers: { "content-type": "application/pdf" },
    });
  };
  const { container, root } = await mount();
  try {
    globalThis.setTimeout = ((fn: any, ms: any, ...args: any[]) => {
      if (ms === 120000) {
        fn();
        return 0;
      }
      return timeout(fn, ms, ...args);
    }) as any;
    (container.querySelectorAll("button")[0] as HTMLElement).click();
    await waitUntil(() => downloaded === 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].headers.Authorization, "Bearer synthetic");
    assert.equal(calls[0][1].method, undefined);
  } finally {
    root.unmount();
    container.remove();
    globalThis.fetch = old;
    globalThis.setTimeout = timeout;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    dom.window.HTMLAnchorElement.prototype.click = original;
  }
});
