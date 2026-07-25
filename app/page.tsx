// Page racine volontairement minimale : les clients arrivent
// toujours par le QR Code sur /r/[slug].
export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <p className="text-sm text-espresso/60">
        ScanDZ — scannez le QR Code de votre table pour voir le menu.
      </p>
    </main>
  );
}
