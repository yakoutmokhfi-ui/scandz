export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8 text-center">
      <div>
        <h1 className="text-xl font-semibold">Restaurant introuvable</h1>
        <p className="mt-2 text-sm text-espresso/60">
          Vérifiez le QR Code ou demandez au personnel.
        </p>
      </div>
    </main>
  );
}
