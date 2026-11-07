"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getUser } from "@/lib/services/auth";
import { getMerchantRestaurants, getWithdrawalRequests, getRestaurantSettings } from "@/lib/services/dashboard";
import type { MerchantRestaurant, WithdrawalRequestRow } from "@/lib/dashboard-types";
import DashboardNav from "@/components/dashboard/DashboardNav";
import { resolveRestaurantContext } from "@/lib/dashboard-nav";
import { useRestaurantContextGuard } from "@/lib/restaurant-context-guard";

/**
 * SCANYM — GAP-01 — NOTIFICATION BACKOFFICE MARCHAND (demandes de
 * rétractation).
 *
 * CIO DECISION — GAP-01 ACKNOWLEDGEMENT RECIPIENTS + MERCHANT FOLLOW-
 * UP (issue #11) : "Do not make email the only merchant notification
 * channel." Cette page est ce second canal -- une vue LECTURE SEULE,
 * backoffice, sur les demandes de rétractation reçues par
 * l'établissement courant.
 *
 * DONNÉES : lecture de public.withdrawal_requests via
 * lib/services/dashboard.ts::getWithdrawalRequests (GAP-01 round 3 --
 * remédiation d'audit : la lecture passait auparavant par un appel
 * Supabase direct dans cette page, en violation de la règle
 * d'architecture "archi: l'interface n'appelle jamais Supabase
 * directement", tests/cart-and-price.test.ts). RLS ("restaurant
 * members read own withdrawal requests", DRAFT-lot-gap-01-ack-
 * transport-v1.sql, section E) restreint déjà ce que chaque compte
 * peut voir aux demandes de SON établissement (ou, pour un opérateur
 * Scanym, toutes) -- inchangé, seul le point d'appel a bougé. Aucune
 * nouvelle RPC introduite : `declaration_snapshot` (déjà écrit par
 * submit_withdrawal_request_by_capability) porte tout le contenu
 * nécessaire (référence de commande, identité/contact client,
 * produits/quantités) -- suit le patron déjà établi par les autres
 * pages /dashboard (voir app/dashboard/delivery-pricing/page.tsx pour
 * le patron d'authentification + contexte établissement).
 *
 * ÉCRITURE : ABSENTE de cette page, par construction -- aucune
 * mutation cliente sur withdrawal_requests n'existe (RLS n'accorde que
 * SELECT à authenticated ; seules submit_withdrawal_request_by_
 * capability et les RPC service_role de GAP-01 écrivent cette table).
 */

const ACK_STATUS_LABEL: Record<string, string> = {
  pending: "Accusé en attente d'envoi",
  sending: "Accusé en cours d'envoi ou résultat non confirmé",
  sent: "Accusé envoyé",
  failed: "Échec d'envoi de l'accusé",
  unavailable_no_channel: "Canal d'accusé indisponible",
};

/**
 * Cause lisible d'un échec d'envoi, à partir de la classe d'erreur NORMALISÉE
 * enregistrée (jamais un texte du serveur de messagerie). Une classe inconnue
 * est affichée telle quelle plutôt que d'être devinée.
 */
const ACK_ERROR_HINT: Record<string, string> = {
  PROVIDER_AUTHENTICATION_FAILED: "identifiants de la messagerie refusés — corrigez-les dans l'onglet E-mails",
  PROVIDER_CONFIGURATION_ERROR: "configuration de la messagerie invalide — vérifiez l'onglet E-mails",
  PROVIDER_TIMEOUT: "la messagerie n'a pas répondu à temps",
  PROVIDER_TEMPORARY_UNAVAILABLE: "la messagerie est momentanément indisponible",
  INVALID_RECIPIENT: "adresse refusée par le serveur de messagerie",
  MERCHANT_MAILER_UNAVAILABLE: "messagerie non configurée ou suspendue — onglet E-mails",
  MERCHANT_MAILER_SENDER_UNRESOLVED: "identité d'expéditeur incomplète — onglet E-mails",
  ACK_COPY_RECIPIENT_MISSING: "e-mail de contact absent du profil légal — la copie est obligatoire, aucun accusé n'a été envoyé",
  ACK_COPY_RECIPIENT_INVALID: "e-mail de contact du profil légal invalide — corrigez-le, aucun accusé n'a été envoyé",
  ACK_RECIPIENT_ADDRESS_INVALID: "adresse e-mail du client invalide",
  ACK_DISPATCH_UNKNOWN_ERROR: "erreur technique inattendue lors de l'envoi",
};

export default function WithdrawalRequestsPage() {
  const router = useRouter();
  const guard = useRestaurantContextGuard();

  const [authChecked, setAuthChecked] = useState(false);
  const [mappings, setMappings] = useState<MerchantRestaurant[]>([]);
  const [restaurantId, setRestaurantId] = useState("");
  const [restaurantName, setRestaurantName] = useState("");
  const [staffLanguage, setStaffLanguage] = useState("fr");

  const [rows, setRows] = useState<WithdrawalRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const user = await getUser();
      if (!user) {
        router.replace("/dashboard/login");
        return;
      }
      setAuthChecked(true);
      const list = await getMerchantRestaurants();
      setMappings(list);

      const wanted = new URLSearchParams(window.location.search).get("r");
      const resolution = resolveRestaurantContext({
        requestedId: wanted,
        mappings: list,
        isOperator: false,
      });
      if (resolution.kind === "selected") {
        setRestaurantId(resolution.restaurantId);
      } else {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  const loadFor = useCallback(
    async (id: string) => {
      if (!id) return;
      const token = guard.beginRequest(id);
      setLoading(true);
      setLoadError(null);
      void getRestaurantSettings(id).then((settings) => {
        if (token.isCurrent()) setStaffLanguage(settings.staff_receipt_language ?? "fr");
      }).catch(() => { if (token.isCurrent()) setStaffLanguage("fr"); });
      setRestaurantName(mappings.find((item) => item.restaurant_id === id)?.restaurants?.name ?? "");
      try {
        const data = await getWithdrawalRequests(id);
        if (!token.isCurrent()) return;
        setRows(data);
      } catch (err) {
        if (token.isCurrent()) {
          setLoadError(err instanceof Error ? err.message : "Erreur inconnue");
          setRows([]);
        }
      } finally {
        if (token.isCurrent()) setLoading(false);
      }
    },
    [guard, mappings]
  );

  useEffect(() => {
    if (!authChecked || !restaurantId) return;
    void loadFor(restaurantId);
  }, [authChecked, restaurantId, loadFor]);

  if (!authChecked) return null;

  return (
    <div className="min-h-screen bg-stone-50">
      <DashboardNav
        restaurantName={restaurantName}
        restaurantId={restaurantId}
        mappings={mappings}
        staffLanguage={staffLanguage}
        onSelectRestaurant={(id) => {
          if (id === restaurantId) return;
          guard.enterContext(id);
          setRows([]);
          setRestaurantName("");
          setStaffLanguage("fr");
          setLoadError(null);
          setLoading(true);
          setRestaurantId(id);
          router.replace(`/dashboard/withdrawal-requests?r=${encodeURIComponent(id)}`);
        }}
      />
      <main className="mx-auto max-w-4xl p-4">
        <h1 className="mb-1 text-xl font-bold text-stone-900">Demandes de rétractation</h1>
        <p className="mb-4 text-sm text-stone-500">
          Chaque demande soumise par un client via la fonctionnalité de rétractation en ligne apparaît ici, avec
          l&apos;état réel de l&apos;accusé de réception. Ce canal backoffice est indépendant de l&apos;e-mail :
          consultez cette page même si vous n&apos;avez pas reçu la copie par e-mail. Une demande enregistrée le
          reste même si l&apos;envoi de l&apos;accusé échoue.
        </p>

        {loadError && (
          <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-800">{loadError}</div>
        )}

        {loading ? (
          <p className="text-sm text-stone-500">Chargement…</p>
        ) : loadError ? null : rows.length === 0 ? (
          <p className="text-sm text-stone-500">Aucune demande de rétractation reçue pour le moment.</p>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => {
              const s = row.declaration_snapshot ?? {};
              return (
                <li key={row.id} className="rounded-2xl border border-stone-200 bg-white p-4">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-stone-900">
                      Commande n°{s.order_number ?? "—"}
                    </span>
                    <span className="text-xs text-stone-500">
                      {row.requested_at ? new Date(row.requested_at).toLocaleString("fr-FR") : "—"}
                    </span>
                  </div>
                  <p className="text-sm text-stone-700">
                    {s.customer_first_name} {s.customer_last_name} — {s.acknowledgement_address ?? "—"}
                  </p>
                  {s.lines && s.lines.length > 0 && (
                    <ul className="mt-2 list-disc pl-5 text-sm text-stone-600">
                      {s.lines.map((l, i) => (
                        <li key={i}>
                          {l.quantity} × {l.item_name}
                          {l.option_name ? ` (${l.option_name})` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded-full bg-stone-100 px-2 py-1 text-stone-700">
                      {row.status === "cancelled" ? "Demande annulée" : "Demande enregistrée"}
                    </span>
                    <span
                      className={`rounded-full px-2 py-1 ${
                        row.acknowledgement_status === "sent"
                          ? "bg-green-100 text-green-800"
                          : row.acknowledgement_status === "failed"
                            ? "bg-red-100 text-red-800"
                            : "bg-amber-100 text-amber-900"
                      }`}
                    >
                      {ACK_STATUS_LABEL[row.acknowledgement_status] ?? row.acknowledgement_status}
                    </span>
                    {row.acknowledgement_status === "sent" && row.acknowledgement_cc && (
                      <span className="text-stone-500">Copie envoyée à : {row.acknowledgement_cc}</span>
                    )}
                    {row.acknowledgement_status === "sending" && (
                      <span className="text-amber-900">
                        Si cet état dure : vérifiez le dossier « Envoyés » de la messagerie (identifiant du message :
                        {" "}scanym-withdrawal-ack-{row.id}@mail.scanym.com) avant tout nouvel envoi ; un accusé
                        n&apos;est jamais renvoyé automatiquement.
                      </span>
                    )}
                    {row.acknowledgement_status === "failed" && row.acknowledgement_last_error && (
                      <span className="text-red-800">
                        Cause : {ACK_ERROR_HINT[row.acknowledgement_last_error] ?? row.acknowledgement_last_error}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
