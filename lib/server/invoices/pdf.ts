import "server-only";
import PDFDocument from "pdfkit";
import path from "node:path";
import type { InvoiceBranding } from "@/lib/server/invoices/branding";
import {
  validateInvoiceSource,
  type InvoiceSource,
} from "@/lib/server/invoices/model";

/** No URLs, tracking capability or mutable catalogue data enter this renderer. */
/** Lines of the "FACTURER À" block. A company buyer's identifier is the SIRET captured at checkout. */
export function buyerLines(s: InvoiceSource): string[] {
  return [
    s.buyer.name,
    s.buyer.address,
    s.buyer.email,
    s.buyer.vat ? `TVA : ${s.buyer.vat}` : null,
    s.buyer.registration
      ? `${s.buyer.company ? "SIRET" : "Immatriculation"} : ${s.buyer.registration}`
      : null,
  ].filter((v): v is string => Boolean(v));
}
export async function renderInvoicePdf(
  input: unknown,
  number: string,
  issuedAt: string,
  branding: InvoiceBranding = { logo: null, phone: null },
): Promise<Buffer> {
  const { source: s, fiscal, lines } = validateInvoiceSource(input);
  if (
    !/^FAC-[A-Z0-9]{2,12}-\d{4}-\d{6,12}$/.test(number) ||
    !Number.isFinite(Date.parse(issuedAt))
  )
    throw new Error("INVOICE_ID_INVALID");
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 44, bottom: 52, left: 44, right: 44 },
    bufferPages: true,
    info: {
      Title: `Facture ${number}`,
      Author: s.seller.name,
      CreationDate: new Date(issuedAt),
      ModDate: new Date(issuedAt),
    },
  });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c) => chunks.push(Buffer.from(c)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.font(path.join(process.cwd(), "assets/invoices/DejaVuSans.ttf"));
  const x = 44,
    w = 507,
    bottom = 748,
    grey = "#e4e4e4",
    ink = "#171717";
  const eur = (n: number, digits = 2) =>
    new Intl.NumberFormat("fr-FR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: digits,
    })
      .format(n)
      .replace(/[\u202f\u00a0]/g, " ") + " €";
  const date = (d: string) =>
    new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris" }).format(
      new Date(d),
    );
  const text = (v: string, px: number, py: number, width: number, size = 9) => {
    doc.fillColor(ink).fontSize(size).text(v, px, py, { width, lineGap: 3 });
  };
  const height = (v: string, width: number, size = 9) => {
    doc.fontSize(size);
    return doc.heightOfString(v, { width, lineGap: 3 });
  };
  const rect = (
    px: number,
    py: number,
    width: number,
    h: number,
    fill?: string,
  ) => {
    doc.save();
    if (fill) doc.rect(px, py, width, h).fill(fill);
    doc.rect(px, py, width, h).lineWidth(0.5).strokeColor("#aaa").stroke();
    doc.restore();
  };
  let y = 44;
  const page = () => {
    doc.addPage();
    y = 60;
    text(`${s.seller.name} - Facture ${number} (suite)`, x, 36, w, 9);
  };
  const ensure = (h: number) => {
    if (y + h > bottom) page();
  };
  try {
    let logoHeight = 0;
    if (branding.logo && branding.logo.length <= 512000) {
      try {
        const image = (
          doc as unknown as {
            openImage(b: Buffer): { width: number; height: number };
          }
        ).openImage(branding.logo);
        if (
          image.width <= 2000 &&
          image.height <= 2000 &&
          image.width > 0 &&
          image.height > 0
        ) {
          doc.image(branding.logo, x + 10, y + 10, { fit: [86, 86] });
          logoHeight = 96;
        }
      } catch {
        /* Missing or unsupported logo: use the merchant name. */
      }
    }
    if (!logoHeight) {
      text(s.seller.name, x + 10, y + 12, 265, 17);
      logoHeight = height(s.seller.name, 265, 17) + 22;
    }
    const contact = [
      s.seller.address,
      branding.phone ? `Tél. : ${branding.phone}` : null,
      s.seller.email,
    ]
      .filter(Boolean)
      .join("\n");
    const contactHeight = height(contact, 265);
    const headerHeight = Math.max(156, logoHeight + contactHeight + 20);
    text(contact, x + 10, y + logoHeight + 8, 265);
    text("FACTURE", x + 300, y + 10, 197, 23);
    const identity = [
      `N° : ${number}`,
      `Émise le : ${date(issuedAt)}`,
      `Commande : SC-${s.order.order_number}`,
      `Commande du : ${date(s.order.created_at)}`,
      `Acquittée le : ${date(s.payment.paidAt)}`,
    ].join("\n");
    text(identity, x + 300, y + 50, 197, 9);
    rect(x, y, 290, headerHeight);
    rect(x + 290, y, 217, headerHeight);
    y += headerHeight + 14;
    const seller = [
      s.seller.name,
      s.seller.legalForm,
      `Immatriculation : ${s.seller.registration}`,
      `TVA : ${s.seller.vat}`,
    ]
      .filter(Boolean)
      .join("\n");
    const buyer = buyerLines(s).join("\n");
    const blockHeight = Math.max(
      110,
      Math.max(height(seller, 235), height(buyer, 235)) + 40,
    );
    ensure(blockHeight + 14);
    rect(x, y, 253.5, blockHeight);
    rect(x + 253.5, y, 253.5, blockHeight, "#f5f5f5");
    text("ÉMETTEUR", x + 9, y + 9, 235, 9);
    text("FACTURÉ À", x + 263, y + 9, 235, 9);
    text(seller, x + 9, y + 31, 235);
    text(buyer, x + 263, y + 31, 235);
    y += blockHeight + 14;
    const cols = [44, 254, 287, 365, 417, 551];
    const tableHead = () => {
      rect(x, y, w, 24, grey);
      ["Désignation", "Qté", "PU HT*", "TVA %", "Total HT"].forEach((v, i) =>
        text(v, cols[i] + 5, y + 6, cols[i + 1] - cols[i] - 10, 8),
      );
      y += 24;
    };
    ensure(60);
    tableHead();
    for (const item of s.order.order_items) {
      const line = lines.find((l) => l.itemId === item.id)!;
      const label =
        item.item_name + (item.option_name ? `\n${item.option_name}` : "");
      const values = [
        label,
        String(item.quantity),
        eur(line.unitNet, 8),
        String(line.rate).replace(".", ","),
        eur(line.net),
      ];
      const rowHeight = Math.max(
        28,
        ...values.map((v, i) => height(v, cols[i + 1] - cols[i] - 10, 8) + 12),
      );
      if (y + rowHeight > bottom) {
        page();
        tableHead();
      }
      values.forEach((v, i) =>
        text(v, cols[i] + 5, y + 6, cols[i + 1] - cols[i] - 10, 8),
      );
      doc
        .save()
        .moveTo(x, y + rowHeight)
        .lineTo(x + w, y + rowHeight)
        .strokeColor("#ddd")
        .lineWidth(0.4)
        .stroke()
        .restore();
      y += rowHeight;
    }
    const totals: [string, string][] = [
      ["Sous-total produits TTC", eur(Number(s.order.subtotal))],
      ["Livraison TTC", eur(fiscal.deliveryFee)],
      ["Total HT", eur(fiscal.totalNet)],
      ...fiscal.rates.map(
        (r) =>
          [
            `TVA ${String(r.rate).replace(".", ",")} % (base ${eur(r.net)})`,
            eur(r.tax),
          ] as [string, string],
      ),
      ["TOTAL TTC", eur(fiscal.totalGross)],
      ["Reste à payer", eur(0)],
    ];
    y += 12;
    ensure(totals.length * 28 + 12);
    for (const [label, value] of totals) {
      const h = Math.max(25, height(label, 170, 8) + 12);
      ensure(h);
      rect(294, y, 257, h, label === "TOTAL TTC" ? grey : undefined);
      text(label, 301, y + 6, 170, 8);
      text(value, 476, y + 6, 70, 8);
      y += h;
    }
    const note =
      "* Prix unitaire HT présenté jusqu’à 8 décimales ; totaux calculés selon les arrondis des groupes de TVA. La livraison est incluse dans les bases HT et TVA ci-dessus.";
    y += 15;
    ensure(height(note, w, 7) + 12);
    text(note, x, y, w, 7);
    y += height(note, w, 7) + 12;
    ensure(height(s.footer, w, 8) + 18);
    text(s.footer, x, y, w, 8);
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      text(`${number} - ${i + 1}/${pages.count}`, x, 779, w, 7);
    }
    doc.end();
  } catch (error) {
    doc.end();
    throw error;
  }
  const pdf = await result;
  if (pdf.length > 2_000_000) throw new Error("INVOICE_PDF_TOO_LARGE");
  return pdf;
}
