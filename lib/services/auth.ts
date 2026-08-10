import { supabase } from "@/lib/supabase";
import type { Session, User } from "@supabase/supabase-js";

/**
 * Authentification côté navigateur.
 *
 * Seul point du projet à connaître Supabase Auth. L'encapsulation
 * vise à isoler la dépendance, pas à masquer les différences entre
 * authentification navigateur et authentification serveur : si le
 * projet ajoute un jour une session côté serveur, elle aura son
 * propre module plutôt que d'être fondue ici.
 */
export async function signIn(
  email: string,
  password: string
): Promise<{ error: string | null }> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return { error: error?.message ?? null };
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

/**
 * Envoie un e-mail de réinitialisation de mot de passe.
 *
 * Ne révèle jamais si l'adresse existe ou non côté appelant : la
 * page qui utilise cette fonction doit afficher un message générique
 * quel que soit le résultat, pour ne pas permettre l'énumération
 * des comptes commerçants.
 */
export async function requestPasswordReset(
  email: string
): Promise<{ error: string | null }> {
  const redirectTo = `${window.location.origin}/dashboard/reset-password`;
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo,
  });
  return { error: error?.message ?? null };
}

/**
 * Définit un nouveau mot de passe.
 *
 * L'appelant doit avoir confirmé au préalable, via onPasswordRecovery,
 * que la session active provient bien d'un lien de récupération —
 * jamais d'une simple session déjà connectée.
 */
export async function updatePassword(
  newPassword: string
): Promise<{ error: string | null }> {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  return { error: error?.message ?? null };
}

/**
 * Écoute exclusivement l'événement PASSWORD_RECOVERY de Supabase Auth,
 * déclenché uniquement quand la page vient de traiter un vrai lien de
 * récupération (fragment #access_token=...&type=recovery). Une session
 * ordinaire (utilisateur déjà connecté) ne déclenche jamais cet
 * événement : c'est ce qui distingue un accès légitime à la page de
 * réinitialisation d'un accès via une session existante sans rapport.
 *
 * Renvoie une fonction de désabonnement.
 */
export function onPasswordRecovery(callback: () => void): () => void {
  const { data } = supabase.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") callback();
  });
  return () => data.subscription.unsubscribe();
}

export async function getSession(): Promise<Session | null> {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function getUser(): Promise<User | null> {
  const { data } = await supabase.auth.getUser();
  return data.user;
}

/** Renvoie une fonction de désabonnement. */
export function onAuthStateChange(callback: (user: User | null) => void): () => void {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null);
  });
  return () => data.subscription.unsubscribe();
}
