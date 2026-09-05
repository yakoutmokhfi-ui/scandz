import "server-only";

/**
 * DELIVERY STREAM C — STUART FOUNDATION / SANDBOX v1.2.1
 * (ferme STUART-V1-PAYLOAD-SCHEMA-01, STUART-V11-PAYLOAD-REQUIREDNESS-01).
 *
 * CORRECTIF v1.1 :
 *
 * 1. `pickup_at` DÉPLACÉ vers `job.pickup_at` (niveau racine du job),
 *    RETIRÉ de `StuartPickup` -- classification exacte par champ,
 *    conforme au contrat Create Job ACTUEL confirmé (documentation
 *    Stuart/Postman officielle) :
 *
 *    | Champ | Source |
 *    |---|---|
 *    | job.pickup_at | CURRENT OFFICIAL DOC (POST /oauth/token, POST /v2/jobs) |
 *    | job.transport_type | ARCHIVED OFFICIAL SDK (stuart-client-js/php/csharp/ruby) |
 *    | pickups[].address/contact/comment | ARCHIVED OFFICIAL SDK (cohérent entre tous les SDK consultés) |
 *    | dropoffs[].client_reference | CURRENT OFFICIAL DOC (setup-for-success, littéral) |
 *    | dropoffs[].package_type | CURRENT OFFICIAL DOC -- ensemble xsmall/small/medium/large/xlarge, champ OBLIGATOIRE |
 *    | dropoffs[].end_customer_time_window_start/end | CURRENT OFFICIAL DOC (setup-for-success) + ARCHIVED OFFICIAL SDK (PHP) |
 *    | partner_data.integrator/marketplace | CURRENT OFFICIAL DOC (annonce officielle community.stuart.engineering) |
 *    | pickups[].pickup_at (ANCIEN emplacement v1) | REMOVED -- déplacé vers job.pickup_at |
 *
 *    Ces faits reflètent le contrat Create Job ACTUEL confirmé par la
 *    documentation Stuart/Postman officielle. Une divergence
 *    historique avec un SDK Ruby officiel archivé sur l'URL Sandbox
 *    exacte (mentionnée dans environment.ts) reste un contexte
 *    HISTORIQUE distinct, sans rapport avec le schéma de charge utile
 *    documenté ici.
 *
 * 2. `package_type` : UNION TYPE FERMÉ (`StuartPackageType`), REJETÉ
 *    AU NIVEAU COMPILATION pour toute valeur hors de l'ensemble
 *    prescrit.
 *
 * CORRECTIF v1.2 -- audit Work indépendant (STUART-V11-PAYLOAD-
 * REQUIREDNESS-01, HIGH) :
 *
 * 3. `package_type` devient un champ OBLIGATOIRE (`package_type:
 *    StuartPackageType`, plus `?`) -- le contrat Create Job actuel
 *    exige ce champ pour chaque dropoff, il n'était PAS
 *    correctement modélisé comme optionnel en v1.1. AUCUNE valeur
 *    par défaut n'est fournie par ce module -- l'appelant DOIT
 *    fournir une valeur dérivée de données de colis validées / règles
 *    métier réelles, jamais une valeur générique arbitraire (ex.
 *    "small" comme "valeur sûre par défaut", explicitement RETIRÉE
 *    de toute documentation par ce lot). Si un tel mapping n'existe
 *    pas encore côté appelant : `STUART-PACKAGE-SIZE-MAPPING` reste
 *    `OPEN` -- voir STUART-OFFICIAL-DOC-GAP-MATRIX.md.
 */

export type StuartPackageType = "xsmall" | "small" | "medium" | "large" | "xlarge";

export interface StuartContact {
  firstname?: string;
  lastname?: string;
  /** DOIT être au format E.164 (confirmé, setup-for-success +
   *  general-troubleshooting-guide, code d'erreur PHONE_INVALID). */
  phone: string;
  /** Confirmé : identifiant de point de vente si plusieurs
   *  établissements partagent le même nom commercial. */
  company?: string;
}

export interface StuartPickup {
  address: string;
  contact: StuartContact;
  comment?: string;
}

export interface StuartPartnerData {
  /** OBLIGATOIRE si cet objet est inclus -- nom de l'organisation
   *  intégratrice, minuscules/ASCII recommandé (confirmé,
   *  community.stuart.engineering, annonce officielle du champ). */
  integrator: string;
  marketplace?: string;
}

export interface StuartDropoff {
  address: string;
  contact: StuartContact;
  /** OBLIGATOIRE et UNIQUE par livraison active (confirmé,
   *  setup-for-success) -- voir client-reference.ts pour la limite
   *  IMPORTANTE : la fonction actuellement disponible ne fournit
   *  qu'une référence CANDIDATE, jamais une garantie d'unicité
   *  persistée (STUART-CLIENT-REFERENCE-01 reste OPEN). */
  client_reference: string;
  package_description?: string;
  comment?: string;
  /** OBLIGATOIRE -- STUART-V11-PAYLOAD-REQUIREDNESS-01 (v1.2) : le
   *  contrat Create Job actuel exige `package_type` pour chaque
   *  dropoff, ce champ n'est PLUS optionnel. AUCUNE valeur par
   *  défaut n'est fournie par ce module (jamais "small" ni aucune
   *  autre valeur générique) -- l'appelant DOIT fournir une valeur
   *  dérivée de données de colis validées / règles métier réelles.
   *  Si un tel mapping n'existe pas encore côté appelant :
   *  STUART-PACKAGE-SIZE-MAPPING reste OPEN (voir gap matrix). */
  package_type: StuartPackageType;
  end_customer_time_window_start?: string;
  end_customer_time_window_end?: string;
  partner_data?: StuartPartnerData;
}

export interface StuartCreateJobPayload {
  job: {
    /** Confirmé via SDK officiels archivés : ex. "bike". Ensemble
     *  exhaustif des valeurs NON confirmé dans ce lot -- transmis tel
     *  que fourni par l'appelant, jamais choisi arbitrairement. */
    transport_type?: string;
    /** DÉPLACÉ ici depuis StuartPickup en v1.1 (ferme
     *  STUART-V1-PAYLOAD-SCHEMA-01). ISO 8601 avec décalage horaire
     *  explicite, minimum 3 minutes dans le futur (confirmé,
     *  general-troubleshooting-guide). Absent = livraison "instant"
     *  (confirmé, setup-for-success). */
    pickup_at?: string;
    pickups: StuartPickup[];
    dropoffs: StuartDropoff[];
  };
}
