/** Coordonnées saisies par le client (modes retrait / livraison). */
export interface CustomerInfo {
  street: string;
  postalCode: string;
  city: string;
  phone: string;
  email: string;
}

export const EMPTY_CUSTOMER: CustomerInfo = {
  street: "",
  postalCode: "",
  city: "",
  phone: "",
  email: "",
};

/** Numéro français : 10 chiffres, ou +33 suivi de 9 chiffres. */
export function isValidPhone(value: string): boolean {
  const digits = value.replace(/[\s.\-]/g, "");
  return /^(?:0\d{9}|\+33\d{9})$/.test(digits);
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value.trim());
}

export function isValidPostalCode(value: string): boolean {
  return /^\d{5}$/.test(value.trim());
}

/** Clés de traduction des erreurs, par champ. */
export function getCustomerErrors(
  c: CustomerInfo,
  needsAddress: boolean
): Partial<Record<keyof CustomerInfo, string>> {
  const errors: Partial<Record<keyof CustomerInfo, string>> = {};

  if (needsAddress) {
    if (c.street.trim().length < 5) errors.street = "errStreet";
    if (!isValidPostalCode(c.postalCode)) errors.postalCode = "errPostalCode";
    if (c.city.trim().length < 2) errors.city = "errCity";
  }
  if (!isValidPhone(c.phone)) errors.phone = "errPhone";
  if (!isValidEmail(c.email)) errors.email = "errEmail";

  return errors;
}

/** Adresse sur une ligne, pour le message de commande. */
export function formatAddress(c: CustomerInfo): string {
  return `${c.street.trim()}, ${c.postalCode.trim()} ${c.city.trim()}`;
}
