/**
 * Page d'erreur : le slug ne correspond à aucun restaurant actif.
 * Elle s'affiche hors du contexte de langue (aucune donnée chargée),
 * les trois langues sont donc présentées ensemble.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8 text-center">
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-semibold">Restaurant introuvable</h1>
          <p className="mt-1 text-sm text-espresso/60">
            Vérifiez le QR Code ou demandez au personnel.
          </p>
        </div>
        <div>
          <h2 className="text-xl font-semibold">Restaurant not found</h2>
          <p className="mt-1 text-sm text-espresso/60">
            Check the QR code or ask a member of staff.
          </p>
        </div>
        <div dir="rtl">
          <h2 className="text-xl font-semibold">المطعم غير موجود</h2>
          <p className="mt-1 text-sm text-espresso/60">
            تحقق من رمز الاستجابة السريعة أو اسأل أحد العاملين.
          </p>
        </div>
      </div>
    </main>
  );
}
