import "server-only";
import PDFDocument from "pdfkit";
import path from "node:path";
import { validateInvoiceSource } from "@/lib/server/invoices/model";

/** No URLs, tracking capability or mutable catalogue data enter this renderer. */
export async function renderInvoicePdf(
  input: unknown,
  number: string,
  issuedAt: string,
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
  const width = 507;
  const eur = (n: number, digits = 2) =>
    new Intl.NumberFormat("fr-FR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: digits,
    })
      .format(n)
      .replace(/[\u202f\u00a0]/g, " ") + " EUR";
  const date = (d: string) =>
    new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris" }).format(
      new Date(d),
    );
  const text = (v: string, size = 10) => {
    doc.fillColor("#292524").fontSize(size).text(v, 44, doc.y, { width });
    doc.moveDown(0.4);
  };
  const space = (h: number) => {
    if (doc.y + h > 755) {
      doc.addPage();
      doc.y = 44;
    }
  };
  try {
    doc.rect(44, 44, 507, 4).fill("#A4631A");
    doc.y = 65;
    text(s.seller.name, 21);
    text("FACTURE ACQUITTÉE", 14);
    text(
      `${number}  |  Émise le ${date(issuedAt)}  |  Commande SC-${s.order.order_number}`,
    );
    text(
      `Commande du ${date(s.order.created_at)} - Paiement ${s.payment.method} confirmé le ${date(s.payment.paidAt)}`,
      9,
    );
    doc.moveDown();
    text("VENDEUR", 11);
    text(
      [
        s.seller.name,
        s.seller.legalForm,
        s.seller.address,
        `Immatriculation : ${s.seller.registration}`,
        `TVA : ${s.seller.vat}`,
        s.seller.email,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    text("FACTURER À", 11);
    text(
      [
        s.buyer.name,
        s.buyer.address,
        s.buyer.email,
        s.buyer.vat ? `TVA : ${s.buyer.vat}` : null,
        s.buyer.registration
          ? `Immatriculation : ${s.buyer.registration}`
          : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const cols = [44, 267, 310, 388, 447];
    const head = () => {
      doc.fillColor("#F5F5F4").rect(44, doc.y, width, 24).fill();
      const y = doc.y + 6;
      ["Désignation", "Qté", "P.U. HT*", "TVA", "Total TTC"].forEach((v, i) =>
        doc
          .fillColor("#292524")
          .fontSize(9)
          .text(v, cols[i], y, { width: i === 0 ? 215 : 78, lineBreak: false }),
      );
      doc.y = y + 24;
    };
    space(50);
    head();
    for (const item of s.order.order_items) {
      const line = lines.find((l) => l.itemId === item.id)!;
      const label =
        item.item_name + (item.option_name ? `\n${item.option_name}` : "");
      doc.fontSize(9);
      const h = Math.max(30, doc.heightOfString(label, { width: 210 }) + 12);
      if (doc.y + h > 735) {
        doc.addPage();
        doc.y = 44;
        head();
      }
      const y = doc.y;
      doc.fillColor("#292524").text(label, cols[0], y, { width: 210 });
      [
        String(item.quantity),
        eur(line.unitNet, 8),
        `${line.rate} %`,
        eur(line.gross),
      ].forEach((v, i) => {
        const area = (cols[i + 2] ?? 551) - cols[i + 1] - 4;
        doc.fontSize(9);
        const measured = doc.widthOfString(v);
        // Keep large amounts / precise unit prices inside their own column.
        doc.fontSize(Math.min(9, (9 * (area - 1)) / Math.max(1, measured)));
        doc.text(v, cols[i + 1], y, { width: area, lineBreak: false });
      });
      doc
        .moveTo(44, y + h - 5)
        .lineTo(551, y + h - 5)
        .strokeColor("#E7E5E4")
        .stroke();
      doc.y = y + h;
    }
    space(210 + fiscal.rates.length * 18);
    doc.moveDown();
    text(`Sous-total produits TTC : ${eur(Number(s.order.subtotal))}`);
    text(`Livraison TTC : ${eur(fiscal.deliveryFee)}`);
    text(`Total HT : ${eur(fiscal.totalNet)}`, 11);
    for (const rate of fiscal.rates)
      text(
        `TVA ${rate.rate} % : base HT ${eur(rate.net)} - TVA ${eur(rate.tax)}`,
        9,
      );
    text(`TOTAL TTC : ${eur(fiscal.totalGross)}`, 16);
    text("Reste à payer : 0,00 EUR", 11);
    text(
      "* Prix unitaire HT arrondi à 8 décimales maximum ; totaux calculés selon les arrondis des groupes de TVA.",
      8,
    );
    space(doc.heightOfString(s.footer, { width }) + 30);
    text(s.footer, 8);
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(8)
        .fillColor("#78716C")
        .text(`${number} - ${i + 1}/${pages.count}`, 44, 770, {
          width,
          lineBreak: false,
        });
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
