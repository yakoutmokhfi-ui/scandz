export const LANGUAGES = [
  // Pas de drapeaux emoji : Windows les affiche en lettres ("FR", "DZ"),
  // ce qui doublonne avec le libellé.
  { code: "fr", label: "Français", dir: "ltr" },
  { code: "en", label: "English", dir: "ltr" },
  { code: "ar", label: "العربية", dir: "rtl" },
] as const;

export type Lang = (typeof LANGUAGES)[number]["code"];

export function dirOf(lang: Lang): "ltr" | "rtl" {
  return lang === "ar" ? "rtl" : "ltr";
}

type Dict = Record<string, string>;

const fr: Dict = {
  welcome: "Bienvenue chez {name}",
  subtitle: "Choisissez vos produits et passez votre commande",
  viewOnMaps: "Voir sur Google Maps",
  labelAddress: "Adresse",
  labelPhone: "Téléphone",
  labelHours: "Horaires",

  add: "Ajouter",
  ourFlavors: "Nos goûts",
  alreadyInCart: "{n} déjà dans votre panier",

  cartBarItems: "{n} article",
  cartBarItemsPlural: "{n} articles",
  cartBarAction: "Voir la commande",
  cartTitle: "Votre commande",
  close: "Fermer",
  cartEmpty: "Votre panier est vide. Ajoutez des articles depuis le menu.",
  total: "Total",
  sendOrder: "Envoyer la commande sur WhatsApp",

  yourTable: "Votre table",
  missingTable: "Choisissez votre numéro de table pour envoyer la commande",
  missingFulfillment:
    "Choisissez le retrait ou la livraison pour envoyer la commande",
  missingCustomer: "Complétez vos coordonnées pour envoyer la commande",

  yourDetails: "Vos coordonnées",
  fieldStreet: "Adresse (numéro et rue)",
  fieldPostalCode: "Code postal",
  fieldCity: "Ville",
  fieldPhone: "Téléphone",
  fieldEmail: "Adresse e-mail",
  privacyNote:
    "Vos coordonnées servent uniquement à traiter votre commande. Elles sont transmises par WhatsApp au commerçant et ne sont pas conservées par l'application.",
  howToReceive: "Comment récupérez-vous votre commande ?",
  pickup: "À emporter",
  delivery: "Livraison",
  pickupNote: "Nous vous confirmons l'heure et le lieu de retrait par message.",
  deliveryNote: "Nous vous confirmons le créneau de livraison par message.",
  deliveryFree: "Livraison offerte — {zone}.",
  deliveryMissing: "Encore {n} gâteau pour bénéficier de la livraison offerte.",
  deliveryMissingPlural:
    "Encore {n} gâteaux pour bénéficier de la livraison offerte.",
  deliveryNoPostal:
    "Renseignez votre code postal pour savoir si nous vous livrons.",
  deliveryOutOfZone:
    "Nous livrons uniquement en {area}. Votre commande est passée en retrait sur place.",
  errStreet: "Indiquez le numéro et la rue",
  errPostalCode: "5 chiffres",
  errCity: "Indiquez votre ville",
  errPhone: "Numéro à 10 chiffres",
  errEmail: "Adresse e-mail invalide",

  howMany: "1. Combien en voulez-vous ?",
  distribute: "2. Répartissez vos goûts",
  distributionDone: "✓ Répartition complète",
  toDistribute: "{n} à répartir",
  tooMany: "{n} en trop",
  distributeRemaining: "Répartissez les {n} restants",
  removeExcess: "Retirez le surplus",
  addTotal: "Ajouter {n} × {name}",
  makeChoice: "Faites votre choix",

  confirmTitle: "Commande envoyée avec succès !",
  confirmSubtitle: "Votre commande a été transmise à {name} via WhatsApp.",
  confirmTable: "🪑 Table {n}",
  confirmPickup: "🛍️ À emporter — retrait sur place",
  confirmDelivery: "🛵 Livraison — {zone}",
  confirmPrepTime: "⏱️ Temps de préparation estimé : 10–15 minutes",
  confirmPickupTime:
    "⏱️ Nous vous confirmons l'heure et le lieu de retrait par message",
  confirmDeliveryTime: "⏱️ Nous vous confirmons le créneau par message",
  confirmStaff: "Un membre de notre équipe va confirmer votre commande.",
  confirmServed:
    "Si vous êtes sur place, elle sera servie directement à votre table.",
  confirmThanks: "Merci d'avoir choisi {name} !",
  confirmEnjoy: "Nous préparons votre commande avec soin. Bonne dégustation !",
  backToMenu: "Retour au menu",
  newOrder: "Passer une autre commande",

  ariaDecrease: "Diminuer la quantité",
  ariaIncrease: "Augmenter la quantité",
  ariaRemoveOne: "Retirer un {name}",
  ariaAddOne: "Ajouter un {name}",
  ariaCloseCart: "Fermer le panier",
  phStreet: "12 rue des Lilas",
  phCity: "Boulogne-Billancourt",
  openEveryDay: "Tous les jours :",
  notFoundTitle: "Restaurant introuvable",
  notFoundText: "Vérifiez le QR Code ou demandez au personnel.",
};

const en: Dict = {
  welcome: "Welcome to {name}",
  subtitle: "Choose your items and place your order",
  viewOnMaps: "View on Google Maps",
  labelAddress: "Address",
  labelPhone: "Phone",
  labelHours: "Opening hours",

  add: "Add",
  ourFlavors: "Our flavours",
  alreadyInCart: "{n} already in your cart",

  cartBarItems: "{n} item",
  cartBarItemsPlural: "{n} items",
  cartBarAction: "View order",
  cartTitle: "Your order",
  close: "Close",
  cartEmpty: "Your cart is empty. Add items from the menu.",
  total: "Total",
  sendOrder: "Send order on WhatsApp",

  yourTable: "Your table",
  missingTable: "Select your table number to send the order",
  missingFulfillment: "Choose pickup or delivery to send the order",
  missingCustomer: "Complete your details to send the order",

  yourDetails: "Your details",
  fieldStreet: "Address (number and street)",
  fieldPostalCode: "Postcode",
  fieldCity: "City",
  fieldPhone: "Phone",
  fieldEmail: "Email address",
  privacyNote:
    "Your details are used only to process your order. They are sent to the shop via WhatsApp and are not stored by the app.",
  howToReceive: "How would you like to receive your order?",
  pickup: "Pickup",
  delivery: "Delivery",
  pickupNote: "We will confirm the pickup time and place by message.",
  deliveryNote: "We will confirm the delivery slot by message.",
  deliveryFree: "Free delivery — {zone}.",
  deliveryMissing: "{n} more cake for free delivery.",
  deliveryMissingPlural: "{n} more cakes for free delivery.",
  deliveryNoPostal: "Enter your postcode to check whether we deliver to you.",
  deliveryOutOfZone:
    "We only deliver in {area}. Your order has been switched to pickup.",
  errStreet: "Enter the number and street",
  errPostalCode: "5 digits",
  errCity: "Enter your city",
  errPhone: "10-digit number",
  errEmail: "Invalid email address",

  howMany: "1. How many would you like?",
  distribute: "2. Split between flavours",
  distributionDone: "✓ All assigned",
  toDistribute: "{n} left to assign",
  tooMany: "{n} too many",
  distributeRemaining: "Assign the remaining {n}",
  removeExcess: "Remove the extras",
  addTotal: "Add {n} × {name}",
  makeChoice: "Make your choice",

  confirmTitle: "Order sent successfully!",
  confirmSubtitle: "Your order has been sent to {name} via WhatsApp.",
  confirmTable: "🪑 Table {n}",
  confirmPickup: "🛍️ Pickup — collect in store",
  confirmDelivery: "🛵 Delivery — {zone}",
  confirmPrepTime: "⏱️ Estimated preparation time: 10–15 minutes",
  confirmPickupTime: "⏱️ We will confirm the pickup time and place by message",
  confirmDeliveryTime: "⏱️ We will confirm the delivery slot by message",
  confirmStaff: "A member of our team will confirm your order.",
  confirmServed: "If you are dining in, it will be brought to your table.",
  confirmThanks: "Thank you for choosing {name}!",
  confirmEnjoy: "We are preparing your order with care. Enjoy!",
  backToMenu: "Back to menu",
  newOrder: "Place another order",

  ariaDecrease: "Decrease quantity",
  ariaIncrease: "Increase quantity",
  ariaRemoveOne: "Remove one {name}",
  ariaAddOne: "Add one {name}",
  ariaCloseCart: "Close cart",
  phStreet: "12 Lilac Street",
  phCity: "Boulogne-Billancourt",
  openEveryDay: "Every day:",
  notFoundTitle: "Restaurant not found",
  notFoundText: "Check the QR code or ask a member of staff.",
};

// Arabe littéraire (arabe standard moderne).
const ar: Dict = {
  welcome: "أهلاً بكم في {name}",
  subtitle: "اختر منتجاتك وأرسل طلبك",
  viewOnMaps: "عرض على خرائط جوجل",
  labelAddress: "العنوان",
  labelPhone: "الهاتف",
  labelHours: "أوقات العمل",

  add: "إضافة",
  ourFlavors: "نكهاتنا",
  alreadyInCart: "{n} في سلتك",

  cartBarItems: "{n} منتج",
  cartBarItemsPlural: "{n} منتجات",
  cartBarAction: "عرض الطلب",
  cartTitle: "طلبك",
  close: "إغلاق",
  cartEmpty: "سلتك فارغة. أضف منتجات من القائمة.",
  total: "المجموع",
  sendOrder: "إرسال الطلب عبر واتساب",

  yourTable: "رقم طاولتك",
  missingTable: "اختر رقم طاولتك لإرسال الطلب",
  missingFulfillment: "اختر الاستلام أو التوصيل لإرسال الطلب",
  missingCustomer: "أكمل بياناتك لإرسال الطلب",

  yourDetails: "بياناتك",
  fieldStreet: "العنوان (الرقم والشارع)",
  fieldPostalCode: "الرمز البريدي",
  fieldCity: "المدينة",
  fieldPhone: "الهاتف",
  fieldEmail: "البريد الإلكتروني",
  privacyNote:
    "تُستخدم بياناتك لمعالجة طلبك فقط. تُرسل إلى التاجر عبر واتساب ولا يحتفظ بها التطبيق.",
  howToReceive: "كيف تودّ استلام طلبك؟",
  pickup: "استلام من المحل",
  delivery: "توصيل",
  pickupNote: "سنؤكد لك وقت ومكان الاستلام برسالة.",
  deliveryNote: "سنؤكد لك موعد التوصيل برسالة.",
  deliveryFree: "التوصيل مجاني — {zone}.",
  deliveryMissing: "قطعة واحدة إضافية للحصول على التوصيل المجاني.",
  deliveryMissingPlural: "{n} قطع إضافية للحصول على التوصيل المجاني.",
  deliveryNoPostal: "أدخل رمزك البريدي لمعرفة ما إذا كنا نوصل إليك.",
  deliveryOutOfZone: "نوصل في {area} فقط. تم تحويل طلبك إلى الاستلام من المحل.",
  errStreet: "أدخل الرقم والشارع",
  errPostalCode: "خمسة أرقام",
  errCity: "أدخل مدينتك",
  errPhone: "رقم من عشرة أرقام",
  errEmail: "بريد إلكتروني غير صالح",

  howMany: "١. كم تريد؟",
  distribute: "٢. وزّع النكهات",
  distributionDone: "✓ اكتمل التوزيع",
  toDistribute: "بقي {n} للتوزيع",
  tooMany: "{n} زائدة",
  distributeRemaining: "وزّع الـ {n} المتبقية",
  removeExcess: "أزل الزائد",
  addTotal: "أضف {n} × {name}",
  makeChoice: "اختر نكهتك",

  confirmTitle: "تم إرسال طلبك بنجاح!",
  confirmSubtitle: "تم إرسال طلبك إلى {name} عبر واتساب.",
  confirmTable: "🪑 الطاولة {n}",
  confirmPickup: "🛍️ استلام من المحل",
  confirmDelivery: "🛵 توصيل — {zone}",
  confirmPrepTime: "⏱️ مدة التحضير المتوقعة: من ١٠ إلى ١٥ دقيقة",
  confirmPickupTime: "⏱️ سنؤكد لك وقت ومكان الاستلام برسالة",
  confirmDeliveryTime: "⏱️ سنؤكد لك موعد التوصيل برسالة",
  confirmStaff: "سيؤكد أحد أفراد فريقنا طلبك.",
  confirmServed: "إن كنت في المحل، سيُقدَّم الطلب إلى طاولتك مباشرة.",
  confirmThanks: "شكراً لاختيارك {name}!",
  confirmEnjoy: "نحضّر طلبك بعناية. بالهناء والشفاء!",
  backToMenu: "العودة إلى القائمة",
  newOrder: "طلب جديد",

  ariaDecrease: "إنقاص الكمية",
  ariaIncrease: "زيادة الكمية",
  ariaRemoveOne: "إزالة {name}",
  ariaAddOne: "إضافة {name}",
  ariaCloseCart: "إغلاق السلة",
  phStreet: "١٢ شارع الليلك",
  phCity: "بولوني بيّانكور",
  openEveryDay: "كل الأيام:",
  notFoundTitle: "المطعم غير موجود",
  notFoundText: "تحقق من رمز الاستجابة السريعة أو اسأل أحد العاملين.",
};

const DICTS: Record<Lang, Dict> = { fr, en, ar };

/** Traduit une clé, avec substitution de {paramètres}. */
export function translate(
  lang: Lang,
  key: string,
  params?: Record<string, string | number>
): string {
  const dict = DICTS[lang] ?? fr;
  let text = dict[key] ?? fr[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}

export type Translator = (
  key: string,
  params?: Record<string, string | number>
) => string;
