/** ZIP primitives: callers validate the manifest before targeted extraction.
 * The error factory keeps format-specific public errors at the caller boundary. */
// WINDOWS/FFLATE HARNESS FIX (W1 SECOND REMEDIATION) -- imports the
// EXPLICIT "fflate/browser" subpath rather than the bare "fflate"
// specifier. See this file's own module-resolution rationale in
// lib/docx/docx-writer.ts's matching import (same fix, same reason) --
// duplicated there rather than re-explained, so each file stays
// independently readable.
import { unzipSync } from "fflate/browser";

export type OoxmlZipFailure =
  | "FILE_TOO_LARGE"
  | "NOT_A_ZIP_CONTAINER"
  | "MALFORMED_CONTAINER"
  | "ENTRY_TOO_LARGE"
  | "DUPLICATE_ZIP_ENTRY";

export type OoxmlZipErrorFactory = (code: OoxmlZipFailure, message: string) => Error;

export const MAX_IMPORT_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export const MAX_METADATA_ENTRY_UNCOMPRESSED_BYTES = 2 * 1024 * 1024;

export const MAX_CONTENT_ENTRY_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

export const MAX_TOTAL_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

const ZIP_LOCAL_FILE_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

const ZIP_EMPTY_SIGNATURE = [0x50, 0x4b, 0x05, 0x06];

export function checkZipSignature(bytes: Uint8Array): boolean {
  const matches = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  return matches(ZIP_LOCAL_FILE_SIGNATURE) || matches(ZIP_EMPTY_SIGNATURE);
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

export function unescapeXmlEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export interface ZipEntryInfo {
  size: number;
  originalSize: number;
  compression: number;
  occurrences: number;
}

export function buildZipManifest(makeError: OoxmlZipErrorFactory, bytes: Uint8Array): Map<string, ZipEntryInfo> {
  const manifest = new Map<string, ZipEntryInfo>();
  try {
    unzipSync(bytes, {
      filter: (file) => {
        const existing = manifest.get(file.name);
        if (existing) {
          existing.occurrences += 1;
        } else {
          manifest.set(file.name, { size: file.size, originalSize: file.originalSize, compression: file.compression, occurrences: 1 });
        }
        return false;
      },
    });
  } catch {
    throw makeError("MALFORMED_CONTAINER", "Répertoire central de l'archive ZIP illisible.");
  }
  return manifest;
}

export function assertNoDuplicateRelevantEntry(makeError: OoxmlZipErrorFactory, manifest: Map<string, ZipEntryInfo>, name: string): void {
  const info = manifest.get(name);
  if (info && info.occurrences > 1) {
    throw makeError(
      "DUPLICATE_ZIP_ENTRY",
      `Entrée « ${name} » présente ${info.occurrences} fois dans l'archive -- rejetée avant tout désarchivage, aucune résolution automatique entre occurrences.`
    );
  }
}

export function assertEntryDecompressionSafe(
  makeError: OoxmlZipErrorFactory,
  manifest: Map<string, ZipEntryInfo>,
  name: string,
  maxEntryBytes: number,
  runningTotal: { bytes: number }
): void {
  const info = manifest.get(name);
  if (!info) return;
  if (info.compression !== 0 && info.compression !== 8) {
    throw makeError("MALFORMED_CONTAINER", `Méthode de compression non prise en charge pour « ${name} ».`);
  }
  if (info.originalSize > maxEntryBytes) {
    throw makeError(
      "ENTRY_TOO_LARGE",
      `Entrée « ${name} » trop volumineuse une fois décompressée (${info.originalSize} octets déclarés, limite ${maxEntryBytes} octets) -- rejetée avant désarchivage.`
    );
  }
  const total = runningTotal.bytes + info.originalSize;
  if (total > MAX_TOTAL_UNCOMPRESSED_BYTES) {
    throw makeError(
      "ENTRY_TOO_LARGE",
      `Volume total décompressé requis (${total} octets) dépasse la limite globale ${MAX_TOTAL_UNCOMPRESSED_BYTES} octets -- rejeté avant désarchivage de « ${name} ».`
    );
  }
  runningTotal.bytes = total;
}

export function extractOnly(makeError: OoxmlZipErrorFactory, bytes: Uint8Array, names: ReadonlySet<string>): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes, { filter: (file) => names.has(file.name) });
  } catch {
    throw makeError("MALFORMED_CONTAINER", "Le conteneur ZIP est corrompu ou illisible.");
  }
}
