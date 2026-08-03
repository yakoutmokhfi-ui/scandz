/**
 * Génère le QR code d'un menu, en PNG haute définition (impression)
 * et en SVG (redimensionnable à l'infini, à donner à un imprimeur).
 *
 * Usage :
 *   node scripts/qr.mjs https://exemple.com/r/sanaa-cookies
 *
 * Les fichiers sont écrits dans ./qr/
 */
import QRCode from "qrcode";
import { mkdir, writeFile } from "node:fs/promises";

const url = process.argv[2];
if (!url || !url.startsWith("http")) {
  console.error("Usage : node scripts/qr.mjs <url complète du menu>");
  process.exit(1);
}

const slug = url.replace(/\/$/, "").split("/").pop();
const options = {
  errorCorrectionLevel: "H", // tolère un logo au centre et les salissures
  margin: 2,
  color: { dark: "#221510", light: "#FFFFFF" },
};

await mkdir("qr", { recursive: true });
await QRCode.toFile(`qr/${slug}.png`, url, { ...options, width: 2000 });
await writeFile(`qr/${slug}.svg`, await QRCode.toString(url, { ...options, type: "svg" }));

console.log(`QR généré pour ${url}`);
console.log(`  qr/${slug}.png  (2000 px, impression)`);
console.log(`  qr/${slug}.svg  (vectoriel, imprimeur)`);
console.log("Testez-le avec deux téléphones différents avant toute impression.");
