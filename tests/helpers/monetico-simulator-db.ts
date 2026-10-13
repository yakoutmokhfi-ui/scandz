/**
 * MONETICO PAYMENT SIMULATOR v1 — IN-MEMORY RPC MODEL (TEST ONLY).
 *
 * Mirrors, condition by condition, the PostgreSQL functions the
 * payment pipeline calls (P1 `initiate_payment_attempt` /
 * `confirm_payment_attempt`, P3-B0 correlation, P3-B4 environment,
 * P3-A0 credential, P3-B5 inbox record/claim/update) so that the REAL
 * TypeScript pipeline (checkout runtime -> simulator -> callback route
 * -> Stage A/B -> confirm) can be exercised end to end under
 * `node --test` with `client.rpc` mocked. Same approach as
 * tests/v137 (which was cross-checked against the real SQL harness).
 *
 * It models SEVERAL merchants so cross-merchant isolation can be
 * asserted: each merchant has its own mode, credential and orders.
 */

export interface Merchant {
  id: string;
  mode: "test" | "live";
  isEnabled: boolean;
  configurationStatus: "not_configured" | "configured" | "verified";
  credential: { tpe: string; societe: string; securityKey: string };
}

export interface OrderRow {
  id: string;
  restaurantId: string;
  publicToken: string;
  paymentStatus: "not_required" | "pending" | "paid" | "failed" | "cancelled";
  currentTransactionId: string | null;
  total: string;
  currency: string;
  /** v1.1 (MSIM-SIDE-04): delivery orders exercise the Stuart post-payment hook. */
  serviceMode?: "pickup" | "delivery";
}

export interface StuartJobRow {
  id: string;
  orderId: string;
  restaurantId: string;
  environment: string;
  clientReference: string;
  sendState: "allocated" | "send_started" | "send_ambiguous" | "created_confirmed" | "terminal_failure";
  stuartJobId: string | null;
}

export interface TransactionRow {
  id: string;
  orderId: string;
  restaurantId: string;
  providerCode: string;
  providerReference: string;
  status: "pending" | "paid" | "failed" | "cancelled";
  amount: string;
  currency: string;
  authorizationReference: string | null;
}

export interface EventRow {
  id: string;
  restaurantId: string;
  orderId: string;
  paymentTransactionId: string;
  providerCode: string;
  providerReference: string;
  fingerprint: string;
  providerEventType: string;
  providerEventCode: string;
  amount: string | null;
  currency: string | null;
  authorizationReference: string | null;
  processingStatus: "received" | "applied" | "ignored" | "failed_retryable" | "failed_terminal";
  errorClass: string | null;
  retryCount: number;
  claimToken: string | null;
  nextAttemptAt: number | null;
}

const MAX_RETRY_ATTEMPTS_SQL = 5;
const BACKOFF_SECONDS = [30, 120, 600, 1800];

type RpcResult = { data: unknown; error: null | { code: string; message: string } };
const ok = (row: unknown): RpcResult => ({ data: [row], error: null });
const empty = (): RpcResult => ({ data: [], error: null });
const reject = (code: string, message: string): RpcResult => ({ data: null, error: { code, message } });

export class InMemoryPaymentDb {
  merchants = new Map<string, Merchant>();
  orders = new Map<string, OrderRow>();
  transactions = new Map<string, TransactionRow>();
  events = new Map<string, EventRow>();
  stuartJobs = new Map<string, StuartJobRow>();
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  nowMs = 1_700_000_000_000;
  private seq = 0;

  addMerchant(m: Merchant) {
    this.merchants.set(m.id, m);
  }

  addOrder(o: Omit<OrderRow, "currentTransactionId"> & { currentTransactionId?: string | null }) {
    this.orders.set(o.id, { currentTransactionId: null, ...o });
  }

  txnByReference(providerCode: string, providerReference: string): TransactionRow | undefined {
    for (const t of this.transactions.values()) {
      if (t.providerCode === providerCode && t.providerReference === providerReference) return t;
    }
    return undefined;
  }

  eventsFor(reference: string): EventRow[] {
    return [...this.events.values()].filter((e) => e.providerReference === reference);
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  /** Install on a node:test context: `db.install(t, client)`. */
  install(t: { mock: { method: Function } }, client: { rpc: unknown }) {
    t.mock.method(client, "rpc", async (name: string, args: Record<string, unknown>) => {
      this.calls.push({ name, args });
      return this.handle(name, args);
    });
  }

  handle(name: string, a: Record<string, unknown>): RpcResult {
    switch (name) {
      case "get_order_payment_context": {
        const o = this.orders.get(String(a.p_order_id));
        if (!o || o.publicToken !== a.p_public_token) return empty();
        return ok({ restaurant_id: o.restaurantId, payment_status: o.paymentStatus });
      }
      case "get_order_currency_preflight": {
        const o = this.orders.get(String(a.p_order_id));
        if (!o || o.publicToken !== a.p_public_token) return empty();
        return ok({ currency: o.currency });
      }
      case "get_order_service_mode": {
        const o = this.orders.get(String(a.p_order_id));
        return ok({ service_mode: o?.serviceMode ?? "pickup" });
      }
      case "get_order_billing_context": {
        const o = this.orders.get(String(a.p_order_id));
        return ok({
          source: o?.serviceMode === "delivery" ? "delivery_reuse" : "manual",
          address_line_1: "1 rue de Test",
          address_line_2: null,
          city: "Paris",
          postal_code: "75001",
          country: "FR",
          state_or_province: null,
          customer_name: "Test Client",
          customer_email: null,
          customer_phone: null,
        });
      }
      case "get_order_active_payment_attempt": {
        const o = this.orders.get(String(a.p_order_id));
        if (!o || o.publicToken !== a.p_public_token || o.paymentStatus !== "pending") return empty();
        for (const t of this.transactions.values()) {
          if (t.orderId === o.id && t.status === "pending" && t.providerCode === a.p_provider_code) {
            return ok({ provider_reference: t.providerReference, amount: t.amount, currency: t.currency });
          }
        }
        return empty();
      }
      case "initiate_payment_attempt": {
        const o = this.orders.get(String(a.p_order_id));
        if (!o) return reject("P0002", "commande introuvable");
        if (o.paymentStatus === "paid") return reject("42501", "déjà payée");
        for (const t of this.transactions.values()) {
          if (t.orderId === o.id && (t.status === "pending" || t.status === "paid")) {
            return reject("42501", "tentative active/payée existante");
          }
        }
        const id = this.nextId("txn");
        this.transactions.set(id, {
          id,
          orderId: o.id,
          restaurantId: o.restaurantId,
          providerCode: String(a.p_provider_code),
          providerReference: String(a.p_provider_reference),
          status: "pending",
          amount: o.total,
          currency: o.currency,
          authorizationReference: null,
        });
        o.paymentStatus = "pending";
        o.currentTransactionId = id;
        return ok({ transaction_id: id, amount: Number(o.total), currency: o.currency });
      }
      case "get_payment_transaction_correlation": {
        const t = this.txnByReference(String(a.p_provider_code), String(a.p_provider_reference));
        if (!t) return reject("P0002", "tentative introuvable");
        return ok({
          restaurant_id: t.restaurantId,
          order_id: t.orderId,
          transaction_id: t.id,
          status: t.status,
          amount: t.amount,
          currency: t.currency,
        });
      }
      case "get_payment_runtime_provider_environment": {
        const m = this.merchants.get(String(a.p_restaurant_id));
        if (!m) return reject("P0002", "aucune configuration");
        return ok({
          provider_code: "monetico",
          is_enabled: m.isEnabled,
          configuration_status: m.configurationStatus,
          mode: m.mode,
        });
      }
      case "get_payment_provider_credential": {
        const m = this.merchants.get(String(a.p_restaurant_id));
        if (!m) return reject("P0002", "aucune configuration");
        return { data: JSON.stringify(m.credential), error: null };
      }
      case "record_payment_provider_event": {
        const t = this.txnByReference(String(a.p_provider_code), String(a.p_provider_reference));
        if (!t) return reject("P0002", "corrélation impossible");
        const fp = String(a.p_event_fingerprint);
        for (const e of this.events.values()) {
          if (e.providerReference === t.providerReference && e.fingerprint === fp) {
            return ok({
              id: e.id,
              restaurant_id: e.restaurantId,
              order_id: e.orderId,
              payment_transaction_id: e.paymentTransactionId,
              provider_event_type: e.providerEventType,
              processing_status: e.processingStatus,
              created_at: new Date(this.nowMs).toISOString(),
              is_new_event: false,
            });
          }
        }
        const id = this.nextId("evt");
        const e: EventRow = {
          id,
          restaurantId: t.restaurantId,
          orderId: t.orderId,
          paymentTransactionId: t.id,
          providerCode: t.providerCode,
          providerReference: t.providerReference,
          fingerprint: fp,
          providerEventType: String(a.p_provider_event_type),
          providerEventCode: String(a.p_provider_event_code),
          amount: a.p_amount == null ? null : String(a.p_amount),
          currency: a.p_currency == null ? null : String(a.p_currency),
          authorizationReference: a.p_authorization_reference == null ? null : String(a.p_authorization_reference),
          processingStatus: "received",
          errorClass: null,
          retryCount: 0,
          claimToken: null,
          nextAttemptAt: null,
        };
        this.events.set(id, e);
        return ok({
          id,
          restaurant_id: e.restaurantId,
          order_id: e.orderId,
          payment_transaction_id: e.paymentTransactionId,
          provider_event_type: e.providerEventType,
          processing_status: "received",
          created_at: new Date(this.nowMs).toISOString(),
          is_new_event: true,
        });
      }
      case "claim_payment_provider_event_by_id": {
        const e = this.events.get(String(a.p_event_id));
        if (!e) return empty();
        if (!(e.processingStatus === "received" || e.processingStatus === "failed_retryable")) return empty();
        if (e.claimToken !== null) return empty();
        if (!(e.nextAttemptAt === null || e.nextAttemptAt <= this.nowMs)) return empty();
        e.claimToken = `token-${e.id}-${this.nowMs}`;
        return ok(this.claimedRow(e));
      }
      case "claim_payment_provider_events": {
        const batch = Number(a.p_batch_size ?? 20);
        const eligible = [...this.events.values()].filter(
          (e) =>
            (e.processingStatus === "received" || e.processingStatus === "failed_retryable") &&
            e.claimToken === null &&
            (e.nextAttemptAt === null || e.nextAttemptAt <= this.nowMs)
        );
        const claimed = eligible.slice(0, batch);
        for (const e of claimed) e.claimToken = `token-${e.id}-${this.nowMs}`;
        return { data: claimed.map((e) => this.claimedRow(e)), error: null };
      }
      case "update_payment_provider_event_processing_status": {
        const e = this.events.get(String(a.p_event_id));
        if (!e) return reject("P0002", "évènement introuvable");
        if (e.claimToken !== a.p_claim_token) return reject("P0004", "jeton invalide");
        if (["applied", "ignored", "failed_terminal"].includes(e.processingStatus)) {
          return reject("42501", "déjà terminal");
        }
        let effective = String(a.p_new_status);
        if (effective === "failed_retryable" && e.retryCount >= MAX_RETRY_ATTEMPTS_SQL) effective = "failed_terminal";
        const retry = effective === "failed_retryable" ? e.retryCount + 1 : e.retryCount;
        e.processingStatus = effective as EventRow["processingStatus"];
        e.errorClass = a.p_error_class == null ? null : String(a.p_error_class);
        e.retryCount = retry;
        e.claimToken = null;
        e.nextAttemptAt =
          effective === "failed_retryable"
            ? this.nowMs + BACKOFF_SECONDS[Math.min(retry - 1, BACKOFF_SECONDS.length - 1)] * 1000
            : null;
        return ok({
          id: e.id,
          processing_status: effective,
          retry_count: retry,
          processed_at: new Date(this.nowMs).toISOString(),
        });
      }
      case "confirm_payment_attempt": {
        const t = this.txnByReference(String(a.p_provider_code), String(a.p_provider_reference));
        if (!t) return reject("P0002", "tentative introuvable");
        const status = String(a.p_status) as TransactionRow["status"];
        if (!["paid", "failed", "cancelled"].includes(status)) return reject("22023", "statut invalide");
        const o = this.orders.get(t.orderId)!;
        if (t.status === status) return ok({ transaction_id: t.id, order_id: t.orderId, status: t.status });
        if (t.status !== "pending") return reject("42501", `déjà terminal (${t.status})`);
        t.status = status;
        if (a.p_authorization_reference != null) t.authorizationReference = String(a.p_authorization_reference);
        if (o.currentTransactionId === t.id) o.paymentStatus = status;
        return ok({ transaction_id: t.id, order_id: t.orderId, status });
      }
      case "get_stuart_delivery_eligibility": {
        // Post-payment Stuart hook (D1 v1.1) read-only first step.
        const o = this.orders.get(String(a.p_order_id));
        if (!o || o.restaurantId !== a.p_restaurant_id) return ok({ eligible: false, reason_code: "ORDER_NOT_FOUND", merchant_environment: null });
        if (o.paymentStatus !== "paid") return ok({ eligible: false, reason_code: "PAYMENT_NOT_CONFIRMED", merchant_environment: null });
        if (o.serviceMode !== "delivery") return ok({ eligible: false, reason_code: "FULFILLMENT_MODE_NOT_DELIVERY", merchant_environment: null });
        return ok({ eligible: true, reason_code: "ELIGIBLE", merchant_environment: "sandbox" });
      }
      case "allocate_stuart_delivery_job": {
        for (const j of this.stuartJobs.values()) {
          if (j.orderId === a.p_order_id) {
            return ok({ id: j.id, client_reference: j.clientReference, is_new_allocation: false, send_state: j.sendState, stuart_job_id: j.stuartJobId, collision: false });
          }
        }
        const id = this.nextId("stuart-job");
        const j: StuartJobRow = { id, orderId: String(a.p_order_id), restaurantId: String(a.p_restaurant_id), environment: String(a.p_environment), clientReference: String(a.p_candidate_reference), sendState: "allocated", stuartJobId: null };
        this.stuartJobs.set(id, j);
        return ok({ id, client_reference: j.clientReference, is_new_allocation: true, send_state: "allocated", stuart_job_id: null, collision: false });
      }
      case "mark_stuart_delivery_job_send_started":
      case "mark_stuart_delivery_job_ambiguous":
      case "mark_stuart_delivery_job_terminal_failure":
      case "confirm_stuart_delivery_job_created": {
        const j = this.stuartJobs.get(String(a.p_id));
        if (!j) return reject("P0002", "job introuvable");
        j.sendState =
          name === "mark_stuart_delivery_job_send_started" ? "send_started"
          : name === "mark_stuart_delivery_job_ambiguous" ? "send_ambiguous"
          : name === "mark_stuart_delivery_job_terminal_failure" ? "terminal_failure"
          : "created_confirmed";
        if (name === "confirm_stuart_delivery_job_created") j.stuartJobId = String(a.p_stuart_job_id);
        return { data: null, error: null };
      }
      case "get_order_payment_status_snapshot": {
        const o = this.orders.get(String(a.p_order_id));
        if (!o || o.publicToken !== a.p_public_token) return empty();
        return ok({ payment_status: o.paymentStatus });
      }
      default:
        throw new Error(`RPC inattendue dans ce modèle de test : ${name}`);
    }
  }

  private claimedRow(e: EventRow) {
    return {
      id: e.id,
      restaurant_id: e.restaurantId,
      order_id: e.orderId,
      payment_transaction_id: e.paymentTransactionId,
      provider_code: e.providerCode,
      provider_reference: e.providerReference,
      event_fingerprint: e.fingerprint,
      provider_event_type: e.providerEventType,
      provider_event_code: e.providerEventCode,
      amount: e.amount,
      currency: e.currency,
      authorization_reference: e.authorizationReference,
      processing_status: e.processingStatus,
      retry_count: e.retryCount,
      claim_token: e.claimToken,
      claim_expires_at: new Date(this.nowMs + 60_000).toISOString(),
    };
  }
}
