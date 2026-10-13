import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEDULE_FIXED_SLOTS,
  SCHEDULE_FREE_TIME,
  V12_AVAILABLE,
  flush,
  mount,
  teardown,
  window,
} from "./helpers/csdj-bo1-availability-harness.ts";

// ====================================================================
// CSDJ-BO-1 — REMÉDIATION DE L'AUDIT CAT GRECO (PASS WITH RESERVATIONS).
//
// Trois constats MINEURS, trois reproductions déterministes. Chacun de
// ces tests ÉCHOUE sur la page d'avant remédiation (commit
// 5b7ece1c…) et passe après : la preuve est dans
// evidence-pre-remediation.txt livré avec le paquet.
//
//   AUD-01 — un aperçu demandé pour une portée pouvait s'afficher sous
//            une AUTRE portée du même établissement : la garde
//            locataire ne bougeait pas sur un changement de portée.
//   AUD-02 — la page affirmait « Aucun calendrier » même quand le
//            serveur rendait un `holiday_calendar_id` non nul.
//   AUD-04 — le statut `forbidden` de la lecture v1.2 était MUET.
//
// Suite isolée dans son propre fichier, et pas ajoutée à la suite DOM
// principale : monter quatorze fois la page dans un seul processus
// finissait en SIGKILL (mémoire), ce qui ne prouve rien. Un fichier =
// un processus pour le lanceur de tests.
// ====================================================================

const PREVIEW_A = {
  deliveryApplicable: false,
  deliveryEligible: false,
  deliveryBlock: null,
  deliveryCustomerText: null,
  scheduleStatus: "dates_available",
  unfulfillableReason: null,
  scheduleTimezone: "Europe/Paris",
  dateSelectionMode: "customer_selectable",
  slotSelectionMode: "fixed_slots",
  timeGranularityMinutes: null,
  firstEligibleDate: "2026-10-15",
  eligibleDates: ["2026-10-15"],
  offers: {
    "2026-10-15": [
      { slot_key: "creneau-de-la-portee-a", starts_at: "09:00", ends_at: "12:00" },
    ],
  },
};

const PREVIEW_B = {
  ...PREVIEW_A,
  slotSelectionMode: "time_within_window",
  firstEligibleDate: "2026-10-22",
  eligibleDates: ["2026-10-22"],
  offers: { "2026-10-22": [{ slot_key: null, starts_at: "18:00", ends_at: "18:30" }] },
};

function text(container: Element): string {
  return container.textContent ?? "";
}

function clickPreview(container: Element) {
  const refresh = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes("Actualiser")
  );
  assert.ok(refresh, "le bouton d'aperçu doit exister");
  refresh!.dispatchEvent(new window.Event("click", { bubbles: true }));
}

/** Boutons « Consulter cette portée » du tableau, dans l'ordre des lignes. */
function scopeButtons(container: Element): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll("main table tbody button")
  ) as HTMLButtonElement[];
}

function pending(): Array<() => void> {
  return (globalThis as any).__previewPending as Array<() => void>;
}

function previewCalls(): Array<{ modeCode: string }> {
  return (globalThis as any).__previewCalls as Array<{ modeCode: string }>;
}

// --------------------------------------------------------------------
// AUD-01
// --------------------------------------------------------------------

test("[AUD-01] un aperçu demandé pour la portée A ne s'affiche JAMAIS sous la portée B, même dans le même établissement", async () => {
  const { container, cleanup } = mount({
    role: "owner",
    schedules: [SCHEDULE_FIXED_SLOTS, SCHEDULE_FREE_TIME],
    previewByMode: {
      pickup: { result: PREVIEW_A, defer: true },
      delivery: { result: PREVIEW_B },
    },
  });
  await flush();

  const buttons = scopeButtons(container);
  assert.equal(buttons.length, 2, "deux portées doivent être listées");

  // 1. Aperçu demandé pour la portée A (retrait) — laissé EN VOL.
  clickPreview(container);
  await flush();
  assert.equal(pending().length, 1, "l'aperçu de la portée A doit être en vol");
  assert.equal(previewCalls()[0].modeCode, "pickup");

  // 2. Changement de portée : l'aperçu disparaît IMMÉDIATEMENT, sans
  //    attendre la réponse (réinitialisation synchrone).
  buttons[1].dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush();
  assert.ok(container.querySelector("[data-preview-status]") === null,
    "changer de portée doit vider l'aperçu sur-le-champ"
  );

  // 3. La réponse PÉRIMÉE de A arrive maintenant : abandonnée, et
  //    surtout jamais rendue sous la portée B.
  for (const release of pending()) release();
  await flush();
  assert.ok(container.querySelector("[data-preview-status]") === null,
    "une réponse d'aperçu périmée ne doit jamais devenir visible"
  );
  assert.ok(
    !text(container).includes("creneau-de-la-portee-a"),
    "aucune offre de la portée A ne doit apparaître sous la portée B"
  );
  assert.ok(
    !text(container).includes("2026-10-15"),
    "aucune date de la portée A ne doit apparaître sous la portée B"
  );

  cleanup();
});

test("[AUD-01b] la fonctionnalité reste intacte : l'aperçu de la portée courante s'affiche normalement", async () => {
  const { container, cleanup } = mount({
    role: "owner",
    schedules: [SCHEDULE_FIXED_SLOTS, SCHEDULE_FREE_TIME],
    previewByMode: {
      pickup: { result: PREVIEW_A },
      delivery: { result: PREVIEW_B },
    },
  });
  await flush();

  // Portée A : son aperçu s'affiche.
  clickPreview(container);
  await flush();
  assert.ok(container.querySelector("[data-preview-status]"), "l'aperçu de A doit s'afficher");
  assert.ok(text(container).includes("2026-10-15"));

  // Bascule sur B, puis aperçu de B : ce sont bien les données de B.
  scopeButtons(container)[1].dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush();
  clickPreview(container);
  await flush();
  assert.ok(text(container).includes("2026-10-22"), "ce doit être la date de B");
  assert.ok(!text(container).includes("2026-10-15"), "et jamais celle de A");
  assert.equal(previewCalls()[previewCalls().length - 1].modeCode, "delivery");

  cleanup();
});

// --------------------------------------------------------------------
// AUD-02
// --------------------------------------------------------------------

const CALENDAR_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

test("[AUD-02] un calendrier férié rattaché est annoncé avec l'identité rendue par le serveur, jamais « Aucun calendrier »", async () => {
  const { container, cleanup } = mount({
    role: "owner",
    v12: {
      status: "available",
      rows: [{ ...V12_AVAILABLE.rows[0], holidayCalendarId: CALENDAR_ID }],
    },
  });
  await flush();

  assert.ok(
    container.querySelector('[data-holiday-calendar="attached"]'),
    "la page doit annoncer qu'un calendrier est rattaché"
  );
  assert.ok(container.querySelector('[data-holiday-calendar="none"]') === null,
    "elle ne peut pas affirmer en même temps qu'aucun calendrier n'est rattaché"
  );
  assert.ok(
    text(container).includes(CALENDAR_ID),
    "l'identité rendue par le serveur doit être affichée telle quelle"
  );
  assert.ok(
    !text(container).includes("Aucun calendrier"),
    "« Aucun calendrier » serait FAUX ici — c'est exactement le constat de l'audit"
  );
  assert.ok(
    text(container).includes("le catalogue des calendriers n'est pas consultable"),
    "la page doit dire pourquoi elle n'affiche pas de libellé, au lieu d'en inventer un"
  );

  // Aucun catalogue inventé, aucune capacité d'édition : il ne reste
  // aucun sélecteur de calendrier dans la page.
  assert.ok(container.querySelector("#av-holiday-calendar") === null,
    "aucun sélecteur de calendrier ne doit être proposé"
  );
  const selects = Array.from(container.querySelectorAll("main select")) as HTMLSelectElement[];
  for (const select of selects) {
    assert.ok(
      !Array.from(select.options).some((o) => /calendrier|calendar/i.test(o.textContent ?? "")),
      "aucune liste de calendriers ne doit exister"
    );
  }

  cleanup();
});

test("[AUD-02b] sans calendrier rattaché, « Aucun calendrier » est affiché — et c'est alors vrai", async () => {
  const { container, cleanup } = mount({ role: "owner", v12: V12_AVAILABLE });
  await flush();

  assert.ok(container.querySelector('[data-holiday-calendar="none"]'));
  assert.ok(container.querySelector('[data-holiday-calendar="attached"]') === null);
  assert.ok(text(container).includes("Aucun calendrier"));
  assert.ok(
    !text(container).includes(CALENDAR_ID),
    "aucune identité ne doit être inventée quand le serveur n'en rend aucune"
  );

  cleanup();
});

// --------------------------------------------------------------------
// AUD-04
// --------------------------------------------------------------------

test("[AUD-04] un refus de rôle sur la lecture v1.2 est annoncé par une phrase traduite et non technique", async () => {
  const { container, cleanup } = mount({ role: "owner", v12: { status: "forbidden" } });
  await flush();

  const notice = container.querySelector('[data-v12-status="forbidden"]');
  assert.ok(notice, "l'état « refusé » ne doit pas être muet");
  const message = (notice!.textContent ?? "").trim();
  assert.ok(message.length > 40, "le refus doit être expliqué par une phrase");
  assert.ok(
    !/CSDJ12_|CSDJ1_|SQLSTATE|42501|PGRST|rpc|public\.|[0-9a-f]{8}-[0-9a-f]{4}/.test(message),
    `le message doit rester non technique et ne rien révéler : « ${message} »`
  );
  assert.equal(notice!.getAttribute("role"), "status");

  // Sécurité locataire préservée : un refus n'ouvre rien et ne suppose
  // aucune donnée v1.2.
  assert.equal(
    container.querySelector("[data-schedule-method]")!.getAttribute("data-schedule-method"),
    "v1",
    "sans extension lue, la portée reste de méthode v1"
  );
  assert.ok(text(container).includes("pickup"), "les règles du socle restent lisibles");
  assert.ok(container.querySelector('[data-v12-status="error"]') === null,
    "un refus de rôle n'est pas une avarie technique : les deux états restent distincts"
  );
  assert.ok(
    !text(container).includes("pas encore actifs sur ce serveur"),
    "un refus de rôle n'est pas une absence de déploiement : les deux messages ne doivent pas se confondre"
  );

  cleanup();
});

test("[AUD-04b] les quatre statuts de la lecture v1.2 restent distincts, et aucun n'est muet", async () => {
  for (const [status, selector] of [
    ["absent", null],
    ["forbidden", '[data-v12-status="forbidden"]'],
    ["error", '[data-v12-status="error"]'],
  ] as Array<[string, string | null]>) {
    const { container, cleanup } = mount({ role: "owner", v12: { status } });
    await flush();
    if (selector) {
      assert.ok(container.querySelector(selector), `le statut « ${status} » doit être annoncé`);
    } else {
      // `absent` a son propre message, antérieur à cet audit.
      assert.ok(
        text(container).includes("pas encore actifs sur ce serveur"),
        "le statut « absent » garde son message"
      );
    }
    cleanup();
  }
});

after(async () => {
  await teardown();
});
