import "server-only";
import {
  evaluateSimulatorEnvironmentPreconditions,
  evaluateSimulatorEnvironment,
  isSimulatorRoutingActive,
  type SimulatorEnvironmentVerdict,
  type SimulatorRoutingVerdict,
  type TrustedAuthority,
} from "@/lib/server/payment-providers/monetico/simulator/policy";
import { getSimulatorAuthority, type SimulatorAuthority } from "@/lib/server/payment-simulator-authority-service";

/**
 * MONETICO PAYMENT SIMULATOR v1.2 — GATE RESOLVER (the only I/O of the
 * policy). Two stages, in this order, always:
 *   1. pure environment preconditions (no RPC when closed);
 *   2. `get_simulator_authority()` on the current service-role client --
 *      absent/failing on production => closed; then the pure verdict.
 * Returns the authority alongside the verdict so callers can enforce
 * the per-merchant TPE allowlist without a second read.
 */

export interface ResolvedSimulatorGate {
  verdict: SimulatorEnvironmentVerdict;
  authority: SimulatorAuthority | null;
}

export async function resolveSimulatorGate(env: Readonly<Record<string, string | undefined>> = process.env): Promise<ResolvedSimulatorGate> {
  const pre = evaluateSimulatorEnvironmentPreconditions(env);
  if (!pre.active) return { verdict: pre, authority: null };
  let authority: SimulatorAuthority | null = null;
  try {
    authority = await getSimulatorAuthority();
  } catch {
    authority = null;
  }
  const trusted: TrustedAuthority | null = authority ? { projectRef: authority.projectRef, allowedTpes: authority.allowedTpes } : null;
  return { verdict: evaluateSimulatorEnvironment(env, trusted), authority };
}

export async function resolveSimulatorRouting(mode: unknown, env: Readonly<Record<string, string | undefined>> = process.env): Promise<{ verdict: SimulatorRoutingVerdict; authority: SimulatorAuthority | null }> {
  const gate = await resolveSimulatorGate(env);
  if (!gate.verdict.active) return gate;
  const trusted: TrustedAuthority | null = gate.authority ? { projectRef: gate.authority.projectRef, allowedTpes: gate.authority.allowedTpes } : null;
  return { verdict: isSimulatorRoutingActive(mode, env, trusted), authority: gate.authority };
}
