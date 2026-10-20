import subprocess,sys,os,re
os.chdir('/tmp/claude-0/-home-claude/2499d641-6765-5ef0-9d27-bf4f052dd788/scratchpad/chk158')
env=dict(os.environ,NEXT_PUBLIC_SUPABASE_URL='https://placeholder.supabase.co',NEXT_PUBLIC_SUPABASE_ANON_KEY='placeholder',SUPABASE_SERVICE_ROLE_KEY='placeholder')
M='lib/checkout-schedule/map-row.ts'; D='lib/checkout-schedule/model.ts'; O='lib/services/order-payload.ts'; V='components/MenuView.tsx'
muts=[
 ('M01 mapper accepte un objet nu',M,'if (!Array.isArray(data) || data.length !== 1) return INVALID_VIEW;','if (Array.isArray(data) && data.length !== 1) return INVALID_VIEW; if (!Array.isArray(data)) return mapCheckoutScheduleRow(data);'),
 ('M02 mapper sans contrôle de types bruts',M,'if (!rawAvailableTypesValid(r)) return INVALID_VIEW;',''),
 ('M03 mapper sans contrôle de présence de slot_key',M,'if (!Object.prototype.hasOwnProperty.call(o, "slot_key")) return false;',''),
 ('M04 mapper sans cohérence des statuts sans dates',M,'if (!isNullish(r.first_eligible_date) || !noList || !noOffers) return INVALID_VIEW;',''),
 ('M05 mapper sans contrôle du fuseau',M,'if (!(isNullish(r.schedule_timezone) || (typeof r.schedule_timezone === "string" && r.schedule_timezone.length > 0))) return false;',''),
 ('M06 mapper sans contrôle de la granularité',M,'if (!(isNullish(g) || (typeof g === "number" && Number.isFinite(g)))) return false;',''),
 ('M07 mapper sans contrôle du type des listes d\'offres',M,'    if (!Array.isArray(list)) return false;\n    for (const o of list) {','    for (const o of (Array.isArray(list) ? list : [])) {'),
 ('M08 mapper sans contrôle de type des heures',M,'if (typeof o.starts_at !== "string" || typeof o.ends_at !== "string") return false;',''),
 ('M09 modèle sans contrôle de types',D,'  if (!isWellTypedView(view)) {\n    return { kind: "unreadable", reason: "response" };\n  }\n',''),
 ('M10 modèle sans égalité première date / dates',D,'if (view.firstEligibleDate !== view.eligibleDates[0]) {','if (false) {'),
 ('M11 modèle sans égalité clés d\'offres / dates',D,'if (offerDates.length !== view.eligibleDates.length || !offerDates.every((d) => view.eligibleDates.includes(d))) {','if (false) {'),
 ('M12 modèle : date dérivée sans offre acceptée',D,'if (derivedOffers.length === 0) {','if (false) {'),
 ('M13 modèle : offres mal formées d\'autres dates acceptées',D,'if (!Array.isArray(list) || !list.every(isWellFormedDateOnlyOffer)) {','if (false) {'),
 ('M14 modèle sans contrôle d\'intervalle',D,'!(timeToMinutes(o.startsAt) < timeToMinutes(o.endsAt))) {\n        return { kind: "unreadable", reason: "interval" };','false) {\n        return { kind: "unreadable", reason: "interval" };'),
 ('M15 modèle sans détection de dates dupliquées',D,'if (new Set(view.eligibleDates).size !== view.eligibleDates.length) {','if (false) {'),
 ('M16 modèle sans ambiguïté d\'offres',D,'function hasAmbiguousOffers(offers: CheckoutScheduleOffer[], slotMode: SlotMode): boolean {','function hasAmbiguousOffers(offers: CheckoutScheduleOffer[], slotMode: SlotMode): boolean {\n  if (true) return false;'),
 ('M17 modèle : dérivée avec créneau != none acceptée',D,'if (view.slotSelectionMode !== "none") {\n      return { kind: "unreadable", reason: "policy" };\n    }\n    // CSDJ2-R3-01','if (false) {\n      return { kind: "unreadable", reason: "policy" };\n    }\n    // CSDJ2-R3-01'),
 ('M18 dernier garde de la charge supprimé',O,'if (context.mode !== "table" && schedule && !isValidSchedulePayload(schedule)) {','if (false) {'),
 ('M19 garde d\'envoi du gestionnaire supprimé',V,'    if (!scheduleOk) return;\n','\n'),
 ('M20 sélection ambiguë : première offre retenue',D,'if (matches.length !== 1) return null;\n      const offer = matches[0];\n      return {\n        date,\n        slot_key: offer.slotKey,','if (matches.length < 1) return null;\n      const offer = matches[0];\n      return {\n        date,\n        slot_key: offer.slotKey,'),
 ('M21 isSelectionOffered accepte les doublons de clé',D,'offers.filter((o) => o.slotKey === slotKey).length === 1','offers.filter((o) => o.slotKey === slotKey).length >= 1'),
 ('M22 doublon accepté aux DEUX couches (M20+M21)',D,'MULTI','MULTI'),
]
only=sys.argv[1:] 
res=[]
for name,f,old,new in muts:
    if only and not any(name.startswith(o) for o in only): continue
    src=open(f).read()
    if old=='MULTI':
        src=open(f).read()
        a=src.replace('offers.filter((o) => o.slotKey === slotKey).length === 1','offers.filter((o) => o.slotKey === slotKey).length >= 1',1).replace('if (matches.length !== 1) return null;\n      const offer = matches[0];\n      return {\n        date,\n        slot_key: offer.slotKey,','if (matches.length < 1) return null;\n      const offer = matches[0];\n      return {\n        date,\n        slot_key: offer.slotKey,',1)
        open(f,'w').write(a)
        try:
            r=subprocess.run(['node','--experimental-strip-types','--import','./tests/register.mjs','--test','tests/csdj2-checkout-schedule-158-r4.test.ts'],capture_output=True,text=True,env=env,timeout=300)
            fails=re.findall(r'^not ok \d+ - (\[[^\]]+\])',r.stdout+r.stderr,re.M)
            res.append((name,'DÉTECTÉ par '+', '.join(fails) if fails else 'NON DÉTECTÉ'))
        finally: open(f,'w').write(src)
        continue
    if old not in src: res.append((name,'OLD-NOT-FOUND')); continue
    open(f,'w').write(src.replace(old,new,1))
    try:
        r=subprocess.run(['node','--experimental-strip-types','--import','./tests/register.mjs','--test','tests/csdj2-checkout-schedule-158-r4.test.ts','tests/csdj2-checkout-schedule-158-r3.test.ts','tests/csdj2-checkout-schedule-158-r2.test.ts','tests/csdj2-checkout-schedule-158.test.ts'],capture_output=True,text=True,env=env,timeout=300)
        out=r.stdout+r.stderr
        fails=re.findall(r'^not ok \d+ - (\[[^\]]+\])',out,re.M)
        m=re.search(r'# fail (\d+)',out)
        res.append((name,'DÉTECTÉ par '+', '.join(fails) if fails else 'NON DÉTECTÉ (fail=%s)'%(m.group(1) if m else '?')))
    finally:
        open(f,'w').write(src)
for n,r in res: print(f'{n} => {r}')
