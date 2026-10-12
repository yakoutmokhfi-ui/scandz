import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveWallTime } from "../lib/scheduling/eligibility.ts";
import { CHECKOUT_WALL_TIME_STATUSES } from "../lib/scheduling/schedule-model.ts";

/**
 * Scanym — CSDJ-1 — INDÉPENDANCE DE L'ORACLE (CSDJ1-AUD-PYTHON-01)
 *
 * Ce fichier ne teste pas une politique : il teste la VALEUR DE PREUVE
 * de l'accord entre trois implémentations.
 *
 * Le re-audit a relevé un défaut qui n'en est pas un de comportement :
 * le générateur Python reproduisait l'algorithme des deux
 * implémentations livrées. Trois implémentations qui partagent une
 * hypothèse ne se vérifient pas mutuellement -- elles se trompent
 * ensemble, et leur accord n'établit rien.
 *
 * Deux choses sont donc à prouver, et la seconde est la seule qui
 * compte vraiment :
 *
 *   1. l'oracle Python n'emploie PLUS le mécanisme des deux autres
 *      (vérification de source -- nécessaire, pas suffisante) ;
 *
 *   2. l'oracle DISCRIMINE : confronté à des classificateurs
 *      délibérément faux -- et faux de la façon exacte dont l'histoire
 *      de ce lot l'a été -- il les contredit, sur des cas nommés.
 *
 * Le point 2 est ce qui distingue une indépendance CONCEPTUELLE d'une
 * simple différence de syntaxe.
 */

const GENERATOR_PATH = "tests/fixtures/build-checkout-scheduling-cases.py";
const FIXTURE_PATH = "tests/fixtures/checkout-scheduling-cases.json";
const ELIGIBILITY_PATH = "lib/scheduling/eligibility.ts";
const SQL_PATH = "supabase/DRAFT-lot-checkout-scheduling-foundation-v1.sql";

const generatorSrc = readFileSync(GENERATOR_PATH, "utf8");
const eligibilitySrc = readFileSync(ELIGIBILITY_PATH, "utf8");
const sqlSrc = readFileSync(SQL_PATH, "utf8");

type WallTimeCase = {
  zone: string;
  date: string;
  time: string;
  expected: (typeof CHECKOUT_WALL_TIME_STATUSES)[number];
};
type Fixture = {
  oracleMethod?: { name?: string; steps?: string[]; independence?: string };
  wallTimeCases?: WallTimeCase[];
};
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

/** Corps Python de `resolve_wall`, sans sa docstring : c'est la
 *  DÉCISION qui doit être indépendante, pas le commentaire qui la
 *  décrit. Un texte explicatif peut légitimement nommer la méthode de
 *  l'autre camp, précisément pour dire qu'il ne l'emploie pas. */
function pythonOracleBody(): string {
  const start = generatorSrc.indexOf("def resolve_wall(");
  assert.ok(start > 0, "resolve_wall doit exister dans le générateur");
  const afterSig = generatorSrc.indexOf("\n", start);
  const docOpen = generatorSrc.indexOf('"""', afterSig);
  const docClose = generatorSrc.indexOf('"""', docOpen + 3);
  const nextDef = generatorSrc.indexOf("\ndef ", docClose);
  assert.ok(docOpen > 0 && docClose > docOpen && nextDef > docClose);
  return generatorSrc.slice(docClose + 3, nextDef);
}

function splitDateParts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split("-").map(Number);
  return [y!, m!, d!];
}
function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}
function caseLabel(c: WallTimeCase): string {
  return `${c.zone} ${c.date} ${c.time}`;
}

// ====================================================================
// 1. L'ORACLE N'EST PLUS UN MIROIR  (nécessaire, pas suffisant)
// ====================================================================

test("[ORACLE-1] l'oracle Python emploie fold et un ALLER-RETOUR, pas l'échantillonnage des deux autres", () => {
  const body = pythonOracleBody();

  // Ce qu'il DOIT employer : la sémantique de PEP 495 et la
  // vérification par aller-retour.
  assert.ok(
    /fold\s*=\s*fold/.test(body) && /for fold in \(0, 1\)/.test(body),
    "l'oracle doit lire les deux plis (fold=0 et fold=1) de la bibliothèque standard"
  );
  assert.ok(
    /astimezone\(dt\.timezone\.utc\)/.test(body),
    "l'oracle doit convertir chaque pli en instant UTC par astimezone"
  );
  assert.ok(
    /round_trip\s*==\s*naive/.test(body),
    "l'oracle doit valider par ALLER-RETOUR : une conversion n'est pas une preuve"
  );

  // Ce qu'il ne doit PLUS employer : le mécanisme des deux autres.
  for (const forbidden of [
    "PROBE_SECONDS",
    "OFFSET_PROBES",
    "utcoffset()",
    "86400",
    "14400",
  ]) {
    assert.ok(
      !body.includes(forbidden),
      `« ${forbidden} » dans la décision Python ramènerait l'oracle au mécanisme des deux implémentations jugées`
    );
  }
  assert.ok(
    !/offsets\s*=\s*\[\]/.test(body) && !/survivors\s*=\s*\[\]/.test(body),
    "l'oracle ne doit ni collecter des décalages ni reconstruire des candidats : c'est la méthode de l'autre camp"
  );

  // Et la fixture DÉCLARE la méthode, pour qui la lit sans lire le code.
  assert.ok(
    fixture.oracleMethod?.name?.includes("fold"),
    "la fixture doit déclarer la méthode de son oracle"
  );
  assert.equal(fixture.oracleMethod?.steps?.length, 6);
});

test("[ORACLE-2] les deux implémentations JUGÉES emploient bien, elles, l'échantillonnage", () => {
  // Sans ce test, l'indépendance pourrait disparaître par l'autre bout :
  // si TypeScript et SQL migraient un jour vers la méthode des plis,
  // les trois convergeraient de nouveau et [ORACLE-1] resterait vert
  // sans rien garantir.
  assert.ok(
    eligibilitySrc.includes("OFFSET_PROBES_MS"),
    "le TypeScript doit toujours classer par échantillonnage de décalages"
  );
  assert.ok(
    sqlSrc.includes("make_interval(hours => 4)") &&
      sqlSrc.includes("make_interval(days => -1)"),
    "le SQL doit toujours classer par échantillonnage de décalages"
  );
  // Et aucun des deux n'emploie la notion de pli : elle n'existe qu'en
  // Python. C'est bien deux chemins distincts, et non deux écritures du
  // même chemin.
  assert.ok(
    !/\bfold\b/.test(eligibilitySrc),
    "le TypeScript n'a pas accès à la notion de pli : s'il l'imitait, l'indépendance serait perdue"
  );
});

// ====================================================================
// 2. L'ORACLE DISCRIMINE  (la preuve qui compte)
// ====================================================================

/**
 * Classificateurs DÉLIBÉRÉMENT FAUX. Chacun reproduit une erreur
 * réellement commise, ou réellement tentante, dans l'histoire de ce
 * lot. Ce ne sont pas des épouvantails : ce sont les trois façons dont
 * ce code a été, ou aurait pu être, faux.
 */
type Classifier = (
  y: number,
  mo: number,
  d: number,
  minutes: number,
  tz: string
) => string;

function zoneOffsetMs(instantMs: number, tz: string): number {
  // Décalage du fuseau à un instant donné, par la voie ICU.
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const { type, value } of f.formatToParts(new Date(instantMs))) {
    p[type] = value;
  }
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) === 24 ? 0 : Number(p.hour),
    Number(p.minute),
    Number(p.second)
  );
  return asUtc - instantMs;
}

/** FAUX n° 1 — l'ambiguïté cherchée « à plus ou moins une heure ».
 *  C'est le défaut exact que le re-audit delta a trouvé : il ne peut
 *  pas voir un recouvrement de trente minutes. */
const brokenPlusMinusOneHour: Classifier = (y, mo, d, minutes, tz) => {
  const naiveAsUtc = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  const off = zoneOffsetMs(naiveAsUtc, tz);
  const candidate = naiveAsUtc - off;
  const back = naiveAsUtc - zoneOffsetMs(candidate, tz) === candidate;
  if (!back) return "nonexistent";
  // « ambiguë si l'instant d'une heure plus tôt rend la même heure murale »
  const earlier = candidate - 3_600_000;
  const sameWall =
    earlier - zoneOffsetMs(earlier, tz) * 0 === earlier &&
    naiveAsUtc - zoneOffsetMs(earlier, tz) === earlier;
  return sameWall ? "ambiguous" : "valid_unique";
};

/** FAUX n° 2 — faire confiance à la conversion du moteur, sans
 *  aller-retour. C'est le défaut du premier candidat : PostgreSQL
 *  normalisait une heure inexistante en silence, et le code l'acceptait. */
const brokenTrustsNormalization: Classifier = (y, mo, d, minutes, tz) => {
  const naiveAsUtc = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  const off = zoneOffsetMs(naiveAsUtc, tz);
  // Un instant est toujours produit, donc l'heure est toujours « valide ».
  void (naiveAsUtc - off);
  return "valid_unique";
};

/** FAUX n° 3 — une seule sonde, au point lui-même. Autour d'une
 *  transition, le décalage lu n'est pas forcément celui qui s'applique
 *  à l'heure demandée. */
const brokenSingleProbe: Classifier = (y, mo, d, minutes, tz) => {
  const naiveAsUtc = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  const candidate = naiveAsUtc - zoneOffsetMs(naiveAsUtc, tz);
  const rendersBack = candidate + zoneOffsetMs(candidate, tz) === naiveAsUtc;
  return rendersBack ? "valid_unique" : "nonexistent";
};

const BROKEN: ReadonlyArray<{
  name: string;
  classify: Classifier;
  mustBeCaughtOn: string;
}> = [
  {
    name: "ambiguïté cherchée à ±1 heure",
    classify: brokenPlusMinusOneHour,
    mustBeCaughtOn: "Australia/Lord_Howe 2026-04-05 01:45",
  },
  {
    name: "confiance à la normalisation du moteur",
    classify: brokenTrustsNormalization,
    mustBeCaughtOn: "Europe/Paris 2026-03-29 02:30",
  },
  {
    name: "sonde unique au point demandé",
    classify: brokenSingleProbe,
    mustBeCaughtOn: "Europe/Paris 2026-10-25 02:30",
  },
];

test("[ORACLE-3] l'implémentation livrée s'accorde avec l'oracle sur les 38 points", () => {
  const cases = fixture.wallTimeCases ?? [];
  assert.ok(cases.length >= 38, `attendu au moins 38 points, vu ${cases.length}`);
  const divergences: string[] = [];
  for (const c of cases) {
    const [y, mo, d] = splitDateParts(c.date);
    const got = resolveWallTime(y, mo, d, minutesOf(c.time), c.zone).status;
    if (got !== c.expected) {
      divergences.push(`${caseLabel(c)} : oracle=${c.expected}, TypeScript=${got}`);
    }
  }
  assert.deepEqual(divergences, []);
});

test("[ORACLE-4] l'oracle CONTREDIT chaque classificateur faux, sur le cas nommé", () => {
  // C'est ici que l'indépendance devient démontrable : si l'oracle
  // était un miroir de l'implémentation, il validerait les mêmes
  // erreurs. On exige donc qu'il les voie, et qu'il les voie LÀ où
  // l'audit a dit qu'elles se manifestent.
  const cases = fixture.wallTimeCases ?? [];
  assert.ok(cases.length > 0);

  for (const broken of BROKEN) {
    const named = cases.find((c) => caseLabel(c) === broken.mustBeCaughtOn);
    assert.ok(
      named,
      `le point ${broken.mustBeCaughtOn} doit figurer dans les points de classement`
    );

    const [y, mo, d] = splitDateParts(named.date);
    const verdict = broken.classify(y, mo, d, minutesOf(named.time), named.zone);
    assert.notEqual(
      verdict,
      named.expected,
      `le classificateur faux « ${broken.name} » devrait se tromper sur ${broken.mustBeCaughtOn} ` +
        `(oracle : ${named.expected}) -- s'il tombe juste, ce contrôle ne prouve rien`
    );

    // Et l'implémentation livrée, elle, est du côté de l'oracle.
    assert.equal(
      resolveWallTime(y, mo, d, minutesOf(named.time), named.zone).status,
      named.expected,
      `l'implémentation livrée doit s'accorder avec l'oracle sur ${broken.mustBeCaughtOn}`
    );
  }
});

test("[ORACLE-5] chaque classificateur faux diverge sur AU MOINS un point, et pas partout", () => {
  // Un classificateur qui se tromperait sur TOUS les points ne
  // prouverait rien non plus : il faut qu'il soit plausible, c'est-à-dire
  // juste la plupart du temps et faux précisément là où l'hypothèse
  // casse. C'est ce qui rend ces défauts dangereux dans la vraie vie.
  const cases = fixture.wallTimeCases ?? [];
  for (const broken of BROKEN) {
    let agree = 0;
    const disagree: string[] = [];
    for (const c of cases) {
      const [y, mo, d] = splitDateParts(c.date);
      const got = broken.classify(y, mo, d, minutesOf(c.time), c.zone);
      if (got === c.expected) agree += 1;
      else disagree.push(caseLabel(c));
    }
    assert.ok(
      disagree.length > 0,
      `le classificateur faux « ${broken.name} » ne diverge nulle part : il n'est pas faux, ou les points ne couvrent pas assez`
    );
    assert.ok(
      agree > 0,
      `le classificateur faux « ${broken.name} » se trompe PARTOUT : un tel défaut serait trouvé le premier jour, il ne prouve rien sur la finesse de l'oracle`
    );
  }
});

test("[ORACLE-6] les trois statuts du catalogue sont tous exercés par les points", () => {
  // Un jeu de points qui n'exercerait qu'un seul statut laisserait deux
  // tiers de la politique sans témoin.
  const seen = new Set((fixture.wallTimeCases ?? []).map((c) => c.expected));
  for (const status of CHECKOUT_WALL_TIME_STATUSES) {
    assert.ok(seen.has(status), `aucun point ne produit le statut « ${status} »`);
  }
});

test("[ORACLE-7] les zones exigées par le mandat sont toutes couvertes", () => {
  const zones = new Set((fixture.wallTimeCases ?? []).map((c) => c.zone));
  for (const zone of [
    "Europe/Paris",
    "Australia/Lord_Howe",
    "UTC",
    "Pacific/Kiritimati",
    "America/Los_Angeles",
    "America/New_York",
    "Pacific/Chatham",
    "Asia/Kathmandu",
  ]) {
    assert.ok(zones.has(zone), `la zone ${zone} doit être couverte`);
  }
  // Lord Howe dans les DEUX sens : c'est la zone dont la transition de
  // trente minutes a fait tomber la méthode précédente.
  const lordHowe = (fixture.wallTimeCases ?? []).filter(
    (c) => c.zone === "Australia/Lord_Howe"
  );
  assert.ok(lordHowe.some((c) => c.expected === "ambiguous"));
  assert.ok(lordHowe.some((c) => c.expected === "nonexistent"));
  assert.ok(lordHowe.some((c) => c.expected === "valid_unique"));
});

test("[ORACLE-8] l'oracle ne lit ni n'exécute les implémentations qu'il juge", () => {
  // Indépendance de SOURCE. La formulation importe : NOMMER un fichier
  // dans une phrase explicative ou dans une métadonnée est légitime --
  // le contrat de la fixture dit précisément quelles implémentations
  // elle juge. Ce qui est interdit, c'est le MÉCANISME qui permettrait
  // de les lire ou de les exécuter.
  for (const mechanism of [
    "subprocess",
    "os.system",
    "os.popen",
    "importlib",
    "runpy",
    "exec(",
    "eval(",
    "urllib",
    "requests",
  ]) {
    assert.ok(
      !generatorSrc.includes(mechanism),
      `le générateur ne doit pas disposer du mécanisme « ${mechanism} » : il pourrait alors consulter ce qu'il juge`
    );
  }

  // Et ses imports sont ceux de la bibliothèque standard, aucun module
  // du dépôt : un oracle qui importerait l'un des deux camps n'en serait
  // plus un.
  const imports = [...generatorSrc.matchAll(/^(?:import|from) ([A-Za-z0-9_.]+)/gm)].map(
    (m) => m[1]!
  );
  assert.ok(imports.length > 0, "le générateur doit déclarer ses imports");
  const STDLIB = new Set([
    "datetime",
    "json",
    "platform",
    "re",
    "sys",
    "zoneinfo",
    "pathlib",
  ]);
  for (const name of imports) {
    assert.ok(
      STDLIB.has(name.split(".")[0]!),
      `import « ${name} » : l'oracle ne doit dépendre que de la bibliothèque standard`
    );
  }

  // La seule lecture de fichier admise est la base de fuseaux du
  // système (provenance de tzdata) ; tout chemin du dépôt serait une
  // consultation de ce qu'il juge.
  for (const read of [...generatorSrc.matchAll(/read_text\(|open\(/g)]) {
    void read;
  }
  const readPaths = [...generatorSrc.matchAll(/Path\("([^"]+)"\)/g)].map((m) => m[1]!);
  for (const p of readPaths) {
    assert.ok(
      p.startsWith("/usr/share/zoneinfo/"),
      `le générateur ne lit que la base de fuseaux du système, pas « ${p} »`
    );
  }
  assert.ok(generatorSrc.includes("import zoneinfo"));
});
