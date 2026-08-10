/** Coordonnées saisies par le client (modes retrait / livraison). */
export interface CustomerInfo {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  phone: string;
  email: string;
}

export const EMPTY_CUSTOMER: CustomerInfo = {
  name: "",
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
  required: (keyof CustomerInfo)[]
): Partial<Record<keyof CustomerInfo, string>> {
  const errors: Partial<Record<keyof CustomerInfo, string>> = {};

  for (const field of required) {
    switch (field) {
      case "name":
        if (c.name.trim().length < 2) errors.name = "errName";
        break;
      case "street":
        if (c.street.trim().length < 5) errors.street = "errStreet";
        break;
      case "postalCode":
        if (!isValidPostalCode(c.postalCode)) errors.postalCode = "errPostalCode";
        break;
      case "city":
        if (c.city.trim().length < 2) errors.city = "errCity";
        break;
      case "phone":
        if (!isValidPhone(c.phone)) errors.phone = "errPhone";
        break;
      case "email":
        if (!isValidEmail(c.email)) errors.email = "errEmail";
        break;
    }
  }

  return errors;
}

/** Adresse sur une ligne, pour le message de commande. */
export function formatAddress(c: CustomerInfo): string {
  return `${c.street.trim()}, ${c.postalCode.trim()} ${c.city.trim()}`;
}
