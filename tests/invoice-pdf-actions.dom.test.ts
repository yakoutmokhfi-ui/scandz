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
    b.onResolve({ filter: /^@\/lib\/services\/auth$/ }, () => ({
      path: "supabase",
      namespace: "fake",
    }));
    b.onLoad({ filter: /.*/, namespace: "fake" }, () => ({
      contents: 'export const getSession=async()=>({access_token:"synthetic"})',
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
const ready = {
  generated: true,
  invoiceNumber: "FAC-DEMO-2026-000001",
  recipient: "client@example.com",
  lastDelivery: null,
};
async function mount(generated = true, lang = "fr") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  root.render(React.createElement(Actions, { orderId: "order-a", lang }));
  await waitUntil(
    () =>
      container.querySelectorAll("button").length === 3 &&
      !(container.querySelector("button") as HTMLButtonElement).disabled,
  );
  return {
    container,
    root,
    clean: () => {
      root.unmount();
      container.remove();
    },
  };
}
const statusResponse = (s: any = ready) =>
  new Response(JSON.stringify(s), {
    headers: { "content-type": "application/json" },
  });
test("mount loads status only, never generates or sends; four languages", async () => {
  const old = fetch;
  const calls: any[] = [];
  globalThis.fetch = async (url, opts) => {
    calls.push([url, opts]);
    return statusResponse({ generated: false });
  };
  try {
    for (const lang of ["fr", "en", "ar", "nl"]) {
      const m = await mount(false, lang);
      assert.doesNotMatch(m.container.textContent!, /invPdf/);
      assert.equal(
        (m.container.querySelectorAll("button")[1] as HTMLButtonElement)
          .disabled,
        true,
      );
      m.clean();
    }
    assert.equal(calls.length, 4);
    assert.ok(
      calls.every((c) => String(c[0]).includes("view=status") && !c[1].method),
    );
  } finally {
    globalThis.fetch = old;
  }
});
test("send confirms archived recipient and sends no browser-supplied identity", async () => {
  const old = fetch,
    calls: any[] = [];
  let confirm = "";
  dom.window.confirm = (s: string) => {
    confirm = s;
    return true;
  };
  globalThis.fetch = async (url, opts) => {
    if (!opts?.method) return statusResponse();
    calls.push(JSON.parse(String(opts.body)));
    return statusResponse({ outcome: "accepted" });
  };
  const m = await mount();
  try {
    (m.container.querySelectorAll("button")[1] as HTMLElement).click();
    await waitUntil(() => !!m.container.querySelector("[role=status]"));
    assert.match(confirm, /client@example.com/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "send");
    assert.deepEqual(Object.keys(calls[0]).sort(), [
      "action",
      "orderId",
      "requestId",
    ]);
    assert.match(m.container.textContent!, /acceptée/);
  } finally {
    m.clean();
    globalThis.fetch = old;
  }
});
test("cancelled send never posts", async () => {
  const old = fetch;
  let posts = 0;
  dom.window.confirm = () => false;
  globalThis.fetch = async (url, opts) => {
    if (opts?.method) posts++;
    return statusResponse();
  };
  const m = await mount();
  try {
    (m.container.querySelectorAll("button")[1] as HTMLElement).click();
    assert.equal(posts, 0);
  } finally {
    m.clean();
    globalThis.fetch = old;
  }
});
test("uncertain send retry, including already_claimed, keeps same idempotency key", async () => {
  const old = fetch;
  const bodies: any[] = [];
  dom.window.confirm = () => true;
  globalThis.fetch = async (url, opts) => {
    if (!opts?.method) return statusResponse();
    bodies.push(JSON.parse(String(opts.body)));
    if (bodies.length === 1) throw Error("lost");
    return statusResponse({ outcome: "already_claimed" });
  };
  const m = await mount();
  try {
    for (let i = 1; i <= 3; i++) {
      (m.container.querySelectorAll("button")[1] as HTMLElement).click();
      await waitUntil(
        () =>
          bodies.length === i &&
          !(m.container.querySelector("button") as HTMLButtonElement).disabled,
      );
    }
    assert.equal(new Set(bodies.map((b) => b.requestId)).size, 1);
    assert.match(m.container.textContent!, /non confirmé/);
  } finally {
    m.clean();
    globalThis.fetch = old;
  }
});
test("generation downloads PDF, refreshes status and never sends an email", async () => {
  const old = fetch;
  let generated = false,
    downloads = 0;
  const methods: string[] = [];
  const click = dom.window.HTMLAnchorElement.prototype.click;
  dom.window.HTMLAnchorElement.prototype.click = function () {
    downloads++;
  };
  const create = URL.createObjectURL,
    revoke = URL.revokeObjectURL,
    timeout = globalThis.setTimeout;
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};
  globalThis.fetch = async (url, opts) => {
    if (!opts?.method)
      return statusResponse(generated ? ready : { generated: false });
    methods.push(JSON.parse(String(opts.body)).action);
    generated = true;
    return new Response("%PDF-test", {
      headers: { "content-type": "application/pdf" },
    });
  };
  const m = await mount(false);
  try {
    globalThis.setTimeout = ((fn: any, ms: any, ...args: any[]) =>
      ms === 120000 ? 0 : timeout(fn, ms, ...args)) as any;
    (m.container.querySelector("button") as HTMLElement).click();
    await waitUntil(
      () =>
        downloads === 1 &&
        !(m.container.querySelectorAll("button")[1] as HTMLButtonElement)
          .disabled,
    );
    assert.deepEqual(methods, ["prepare"]);
    assert.match(m.container.textContent!, /Facture générée/);
  } finally {
    m.clean();
    globalThis.fetch = old;
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    globalThis.setTimeout = timeout;
    dom.window.HTMLAnchorElement.prototype.click = click;
  }
});
test("changing order clears previous recipient, ignores late responses", async () => {
  const old = fetch;
  let resolveA: (v: Response) => void = () => {};
  globalThis.fetch = async (url) =>
    String(url).includes("order-a")
      ? new Promise((r) => {
          resolveA = r;
        })
      : statusResponse({ ...ready, recipient: "b@example.com" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    root.render(
      React.createElement(Actions, { orderId: "order-a", lang: "fr" }),
    );
    await waitUntil(() => container.querySelectorAll("button").length === 3);
    root.render(
      React.createElement(Actions, { orderId: "order-b", lang: "fr" }),
    );
    await waitUntil(() => !!container.textContent?.includes("b@example.com"));
    resolveA(statusResponse(ready));
    await new Promise((r) => setTimeout(r, 20));
    assert.doesNotMatch(container.textContent!, /client@example.com/);
    assert.match(container.textContent!, /b@example.com/);
  } finally {
    root.unmount();
    container.remove();
    globalThis.fetch = old;
  }
});
