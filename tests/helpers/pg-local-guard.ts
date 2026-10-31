import { isIP } from "node:net";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnSyncReturns } from "node:child_process";

// ====================================================================
// PR #196 R3 (P1) -- GARDE-FOUS DU HARNAIS POSTGRESQL RÉEL
//
// Défaut (audit de 9e38c88) : le harnais ne vérifiait que le NOM D'HÔTE de l'URL
// d'administration (127.0.0.1 / ::1 / localhost) puis lançait `psql` avec
// `process.env` hérité. libpq lit PGHOSTADDR (et PGHOST, PGSERVICE, PGSERVICEFILE,
// PGSYSCONFDIR, PGPORT, PGOPTIONS...) : PGHOSTADDR l'emporte sur l'adresse de l'URL, donc un
// environnement hostile redirigeait `create database` / les scripts DDL vers un AUTRE
// serveur, malgré une URL « locale ». Les paramètres d'URL `hostaddr=` / `host=` /
// `service=` produisent le même effet, et libpq et l'analyseur WHATWG ne découpent pas
// toujours une URL de la même façon (plusieurs « @ »).
//
// Garde-fous (module sans effet de bord, testable sans PostgreSQL) :
//   1. la cible est analysée STRICTEMENT puis passée à psql par DRAPEAUX (-h -p -U -d), jamais
//      comme URL/conninfo : plus aucune ambiguïté d'analyse ni de paramètre caché ;
//   2. l'environnement de chaque processus enfant est CONSTRUIT (liste blanche), jamais
//      `process.env` : aucune variable PG* héritée ;
//   3. l'adresse réellement jointe est vérifiée par le serveur (`inet_server_addr()`) AVANT
//      toute création de base ou exécution de script : boucle locale, sinon refus.
// ====================================================================

export class PgTargetRefused extends Error {
  constructor(message: string) {
    super(`SCANYM_HARNESS_TARGET_REFUSED: ${message}`);
    this.name = "PgTargetRefused";
  }
}

export interface LocalPgTarget {
  host: string; // littéral de boucle locale, tel que passé à -h
  port: string; // chiffres seulement
  user: string;
  password: string | null;
  database: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const PORT = /^[0-9]{1,5}$/;

/**
 * Analyse stricte d'une URL d'administration. Accepte `postgresql://user[:pass]@host[:port]/db`
 * avec un hôte de boucle locale. REFUSE : tout paramètre de requête (host, hostaddr, service,
 * options...), tout fragment, plusieurs « @ » ou plusieurs hôtes, un hôte non local, un port ou
 * un nom de base/rôle qui ne soit pas un simple identifiant (un nom de base contenant « = » ou
 * un préfixe d'URI serait lu par psql comme une chaîne de connexion).
 */
export function parseLocalPgUrl(raw: string): LocalPgTarget {
  if (typeof raw !== "string" || raw.length === 0) throw new PgTargetRefused("URL absente");
  if (!/^postgres(?:ql)?:\/\//.test(raw)) throw new PgTargetRefused("schéma postgresql:// attendu");
  const withoutScheme = raw.replace(/^postgres(?:ql)?:\/\//, "");
  const authority = withoutScheme.split(/[/?#]/, 1)[0] ?? "";
  if ((authority.match(/@/g) ?? []).length > 1) throw new PgTargetRefused("plusieurs « @ » dans l'autorité");
  if (authority.includes(",")) throw new PgTargetRefused("plusieurs hôtes");
  let u: URL;
  try { u = new URL(raw); } catch { throw new PgTargetRefused("URL illisible"); }
  if (u.search !== "" || raw.includes("?")) throw new PgTargetRefused("aucun paramètre de requête n'est admis (host, hostaddr, service...)");
  if (u.hash !== "" || raw.includes("#")) throw new PgTargetRefused("aucun fragment n'est admis");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!LOOPBACK_HOSTS.has(host)) throw new PgTargetRefused(`l'hôte doit être la boucle locale (reçu : ${host === "" ? "(vide)" : host})`);
  const port = u.port === "" ? "5432" : u.port;
  if (!PORT.test(port) || Number(port) < 1 || Number(port) > 65535) throw new PgTargetRefused("port invalide");
  const user = decodeURIComponent(u.username);
  if (!IDENT.test(user)) throw new PgTargetRefused("nom de rôle invalide");
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!IDENT.test(database)) throw new PgTargetRefused("nom de base invalide");
  const password = u.password === "" ? null : decodeURIComponent(u.password);
  return { host, port, user, password, database };
}

/** Même cible, autre base (le nom est validé comme à l'analyse). */
export function withDatabase(target: LocalPgTarget, database: string): LocalPgTarget {
  if (!IDENT.test(database)) throw new PgTargetRefused("nom de base invalide");
  return { ...target, database };
}

/**
 * Environnement ENFANT construit explicitement. Aucune variable PG* n'est héritée : seuls le
 * mot de passe de la cible (le cas échéant) et un délai de connexion court sont posés. HOME et
 * PGSYSCONFDIR pointent un répertoire jetable pour qu'aucun pg_service.conf / .pgpass /
 * psqlrc de l'utilisateur ne soit lu (psql est aussi lancé avec -X).
 */
export function cleanPgEnv(target: LocalPgTarget, base: NodeJS.ProcessEnv, isolatedHome: string): NodeJS.ProcessEnv {
  const env: Record<string, string> = {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: isolatedHome,
    PGSYSCONFDIR: isolatedHome,
    PGCONNECT_TIMEOUT: "10",
    LANG: "C",
    LC_ALL: "C",
  };
  // Le strict nécessaire pour LANCER un binaire (jamais une variable de connexion).
  // Windows : les noms de variables ne respectent pas la casse -- on cherche sans casse.
  for (const key of Object.keys(base)) {
    const upper = key.toUpperCase();
    if (upper === "PATH" || upper === "SYSTEMROOT" || upper === "WINDIR" || upper === "COMSPEC" || upper === "PATHEXT" || upper === "TEMP" || upper === "TMP" || upper === "TMPDIR") {
      const value = base[key];
      if (value !== undefined) env[key] = value;
    }
  }
  if (target.password !== null) env.PGPASSWORD = target.password;
  return env as NodeJS.ProcessEnv;
}

/** Arguments psql qui désignent la cible par DRAPEAUX (jamais par URL ni conninfo). */
export function psqlTargetArgs(target: LocalPgTarget): string[] {
  return ["-h", target.host, "-p", target.port, "-U", target.user, "-d", target.database, "-w"];
}

/** `inet_server_addr()` : true seulement pour une adresse de boucle locale (127.0.0.0/8 ou ::1). */
export function isLoopbackServerAddress(raw: string): boolean {
  const value = raw.trim().replace(/\/\d+$/, ""); // inet peut s'afficher avec un masque
  if (value === "") return false; // socket Unix ou hors réseau : on ne sait pas, on refuse
  const family = isIP(value);
  if (family === 4) return value.split(".")[0] === "127";
  if (family === 6) return value === "::1" || /^::ffff:127\./i.test(value);
  return false;
}

export function assertLoopbackServerAddress(raw: string): void {
  if (!isLoopbackServerAddress(raw)) {
    throw new PgTargetRefused("le serveur joint n'a pas une adresse de boucle locale -- aucune base créée, aucun script exécuté");
  }
}

// --------------------------------------------------------------------
// Lanceur psql : TOUT passe par ici (spawnSync et spawn), jamais `process.env`.
// --------------------------------------------------------------------
export interface PsqlRunnerOptions {
  /** Binaire psql (ou, en test, `process.execPath` avec le faux psql en premier argument). */
  bin: string;
  binPrefixArgs?: string[];
  /** Environnement d'où seuls PATH & co sont repris (voir cleanPgEnv). */
  baseEnv: NodeJS.ProcessEnv;
  /** Répertoire jetable : HOME, PGSYSCONFDIR. */
  isolatedHome: string;
}

export function createPsqlRunner(options: PsqlRunnerOptions) {
  const verified = new Set<string>();
  const baseArgs = options.binPrefixArgs ?? [];

  const spawnArgs = (target: LocalPgTarget, args: string[]) => [...baseArgs, "-X", "-q", ...psqlTargetArgs(target), ...args];
  const envFor = (target: LocalPgTarget) => cleanPgEnv(target, options.baseEnv, options.isolatedHome);

  /** Lecture seule, AVANT toute écriture : le serveur lui-même dit quelle adresse il a jointe. */
  function verifyServer(target: LocalPgTarget): void {
    const key = `${target.host}:${target.port}`;
    if (verified.has(key)) return;
    const r = spawnSync(options.bin, spawnArgs(target, ["-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", "select coalesce(inet_server_addr()::text, '')"]), { encoding: "utf8", env: envFor(target), timeout: 30_000 });
    if (r.status !== 0) throw new PgTargetRefused("le serveur n'a pas pu être identifié (aucune base créée, aucun script exécuté)");
    assertLoopbackServerAddress(r.stdout);
    verified.add(key);
  }

  return {
    /** Exécute psql (synchrone) sur la cible, identité du serveur vérifiée au premier usage. */
    run(url: string, args: string[], extra: { input?: string; timeout?: number } = {}): SpawnSyncReturns<string> {
      const target = parseLocalPgUrl(url);
      verifyServer(target);
      return spawnSync(options.bin, spawnArgs(target, args), { encoding: "utf8", env: envFor(target), input: extra.input, timeout: extra.timeout });
    },
    /** Session interactive (stdin/stdout/stderr en tuyaux), mêmes garde-fous. */
    session(url: string, args: string[]): ChildProcessWithoutNullStreams {
      const target = parseLocalPgUrl(url);
      verifyServer(target);
      return spawn(options.bin, spawnArgs(target, args), { stdio: ["pipe", "pipe", "pipe"], env: envFor(target) });
    },
    verifyServer,
  };
}
