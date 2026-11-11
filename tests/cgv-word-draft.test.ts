import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { renderCgvWordDraft } from "../lib/legal/cgv-word-draft.ts";
import { parseCgvDocumentModel, cgvChapterHeadingLine, toOoxmlBookmarkName } from "../lib/legal/cgv-document-model.ts";
import { buildCgvDocx } from "../lib/docx/docx-writer.ts";
import { readDocxDocument } from "../lib/docx/docx-reader.ts";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "synthetic";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "synthetic-test-key";
const { renderPublicationContext, publishMerchantCgvVersionServerAuthoritative } = await import("../lib/server/legal-cgv-publish-service.ts");
const { cgvWordDraft } = await import("../lib/server/legal-cgv-word-draft-service.ts");
const { asUserSupabaseClientFactory } = await import("../lib/server/supabase-as-user.ts");
const { getServiceRoleSupabaseClient } = await import("../lib/server/supabase-admin.ts");
const admin = getServiceRoleSupabaseClient();
const ctx: any = { restaurant_id: "r1", seller_name: "Boutique A", template_id: "t1", template_version: 7,
  controlled_sections: { header: "Conditions générales", identity_intro: "Conditions des ventes.", withdrawal_clauses: { EXEMPT_PERISHABLE: "Produits périssables.", STANDARD_14_DAYS: "Quatorze jours.", MIXED: "Produits éligibles uniquement." }, mediator_clause: "Médiateur", preparation_clause: "Délai indicatif", cancellation_clause_label: "Annulation", substitution_clause_label: "Substitution", jurisdiction_clause: "Droit français", legal_guarantee_encadre: { heading: "Garanties légales obligatoires", paragraphs: ["L. 217-1 à L. 217-32 : trente jours, vices cachés."] } },
  merchant_profile_version: 3, locale: "fr", presentation_variant: "FORMAL", legal_form: "SARL", address_line1: "1 rue Test", postal_code: "75001", city: "Paris", governing_country: "FR", mediator_name: "Médiateur", mediator_address: "2 rue Test", mediator_website: "https://mediation.test", withdrawal_regime: "EXEMPT_PERISHABLE", preparation_time_min: 1, preparation_time_max: 2, preparation_time_unit: "HOURS", context_fingerprint: "a".repeat(32), acting_user_id: "user-a" };
const baseline = renderPublicationContext(ctx);
const model = parseCgvDocumentModel(baseline);
const doc = () => ({ leadingContent: [...model.frontMatter], chapters: model.chapters.map(c => ({ bookmarkName: toOoxmlBookmarkName(c.bookmarkName), paragraphs: [cgvChapterHeadingLine(c), ...c.paragraphs.filter(p => p.trim())] })) });
const changed = () => { const d = doc(); d.chapters[0].paragraphs[1] = "NOUVELLES CGV & adresse <script>alert(1)</script>"; return d; };
const row = (document: unknown = changed(), overrides = {}) => ({ id: "draft-a", restaurant_id: "r1", base_fingerprint: ctx.context_fingerprint, document, ...overrides });
function mock(t: any, rpc: any) { t.mock.method(asUserSupabaseClientFactory, "create", () => ({ rpc })); }

test("Word changed text is rendered, escaped, and exported again without loss", () => {
  const d = changed(); d.leadingContent[0] = "$& Nouveau titre <img>";
  const html = renderCgvWordDraft(baseline, d);
  assert.ok(html.includes("NOUVELLES CGV &amp; adresse &lt;script&gt;")); assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("$&amp; Nouveau titre &lt;img&gt;"));
  const b = buildCgvDocx(parseCgvDocumentModel(html));
  assert.deepEqual(readDocxDocument(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer), d);
});
for (const [name, mutate] of [
  ["missing chapter", (d: any) => d.chapters.pop()],
  ["unknown chapter", (d: any) => d.chapters[0].bookmarkName = "cgv_other"],
  ["duplicate", (d: any) => d.chapters[1].bookmarkName = d.chapters[0].bookmarkName],
  ["reorder", (d: any) => d.chapters.reverse()],
  ["heading edit", (d: any) => d.chapters[0].paragraphs[0] = "Other"],
  ["empty body", (d: any) => d.chapters[0].paragraphs.splice(1)],
  ["non-string", (d: any) => d.chapters[0].paragraphs[1] = {}],
  ["oversize", (d: any) => d.chapters[0].paragraphs[1] = "x".repeat(40001)],
  ["control character", (d: any) => d.leadingContent[0] += "\x00"],
  ["protected guarantee", (d: any) => d.chapters.find((c: any) => c.bookmarkName === "cgv_legal_guarantee_encadre").paragraphs[1] = "Other warranty"],
] as const) test(`Refuses ${name}`, () => { const d = doc(); mutate(d); assert.throws(() => renderCgvWordDraft(baseline, d)); });

test("Save parses the actual DOCX and stores JSON only, never publishing", async t => {
  const d = changed(); const b = buildCgvDocx(parseCgvDocumentModel(renderCgvWordDraft(baseline,d)));
  const calls: string[] = [];
  mock(t, async (name: string, args: any) => { calls.push(name); if (name === "resolve_cgv_publication_context") return { data: ctx }; assert.equal(name, "save_merchant_cgv_word_draft"); assert.deepEqual(args.p_document, d); return { data: row() }; });
  const result = await cgvWordDraft("token", "r1", b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength) as ArrayBuffer, createHash("sha256").update(baseline).digest("hex"));
  assert.equal(result?.id, "draft-a"); assert.equal(result?.published, false); assert.deepEqual(calls, ["resolve_cgv_publication_context", "save_merchant_cgv_word_draft"]);
});
test("Reload displays saved text and establishes publication only by exact hash", async t => {
  const html = renderCgvWordDraft(baseline, changed());
  mock(t, async (name: string) => ({ data: name === "resolve_cgv_publication_context" ? ctx : row(changed(), { published_hash: createHash("md5").update(html).digest("hex") }) }));
  const result = await cgvWordDraft("token", "r1"); assert.equal(result?.html, html); assert.equal(result?.published, true);
});
test("Publishing selects the exact immutable saved draft, revalidates, and keeps server fingerprint", async t => {
  mock(t, async (name: string, args: any) => { if (name === "resolve_cgv_publication_context") return { data: ctx }; assert.equal(args.p_draft_id, "draft-a"); return { data: row() }; });
  t.mock.method(admin, "rpc", async (name: string, args: any) => { assert.equal(name, "persist_merchant_cgv_version"); assert.equal(args.p_rendered_content, renderCgvWordDraft(baseline, changed())); assert.equal(args.p_expected_context_fingerprint,ctx.context_fingerprint); assert.equal(args.p_acting_user_id, "user-a"); return { data: { id:"version-new" } }; });
  assert.equal((await publishMerchantCgvVersionServerAuthoritative("token","r1","draft-a")).id,"version-new");
});
for(const [label, bad] of [["wrong tenant",row(changed(),{restaurant_id:"r2"})],["stale settings",row(changed(),{base_fingerprint:"b".repeat(32)})],["wrong selected id",row(changed(),{id:"draft-other"})],["direct RPC poisoned JSON",row({ html:"<script>" })]] as const) {
 test(`Publication refuses ${label} before persistence`,async t=> { mock(t,async(name:string)=>({data:name==="resolve_cgv_publication_context"?ctx:bad}));let writes=0;t.mock.method(admin,"rpc",async()=>{writes++;return{data:{}};});await assert.rejects(()=>publishMerchantCgvVersionServerAuthoritative("token","r1","draft-a"));assert.equal(writes,0); });
}
test("Permission failure prevents all save and publish calls",async t=>{let count=0;mock(t,async()=>{count++;return{error:{code:"42501"}};});await assert.rejects(()=>cgvWordDraft("token","r1",new ArrayBuffer(0)));assert.equal(count,1);});
test("Stale draft is visible as stale without exposing outdated preview",async t=>{mock(t,async(name:string)=>({data:name==="resolve_cgv_publication_context"?ctx:row(changed(),{base_fingerprint:"b".repeat(32)})}));const r=await cgvWordDraft("token","r1");assert.equal(r?.stale,true);assert.equal(r?.html,null);});

const { NextRequest } = await import("next/server");
const { GET, POST } = await import("../app/api/dashboard/legal-cgv/word-draft/route.ts");
const url = "http://localhost/api/dashboard/legal-cgv/word-draft?restaurantId=11111111-1111-4111-8111-111111111111";
test("Word HTTP route refuses absent authentication and invalid tenant id",async()=>{
 assert.equal((await GET(new NextRequest(url))).status,401);
 assert.equal((await GET(new NextRequest("http://localhost/api/dashboard/legal-cgv/word-draft?restaurantId=bad",{headers:{authorization:"Bearer synthetic"}}))).status,400);
});
test("Word HTTP route bounds an upload even without Content-Length",async()=>{
 const response=await POST(new NextRequest(url,{method:"POST",headers:{authorization:"Bearer synthetic"},body:new Uint8Array(2*1024*1024+1)}));assert.equal(response.status,413);
});
test("Word HTTP route rejects corrupt DOCX without saving",async t=>{
 let calls=0;mock(t,async()=>{calls++;return{data:ctx};});const response=await POST(new NextRequest(url,{method:"POST",headers:{authorization:"Bearer synthetic","X-Cgv-Review-Hash":createHash("sha256").update(baseline).digest("hex")},body:"not a docx"}));assert.equal(response.status,422);assert.equal(calls,1);
});
test("Word HTTP route is private, uncached, and reports no draft without inventing one",async t=>{
 mock(t,async(name:string)=>({data:name==="resolve_cgv_publication_context"?ctx:null}));const response=await GET(new NextRequest(url,{headers:{authorization:"Bearer synthetic"}}));assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");assert.deepEqual(await response.json(),{outcome:"ok",draft:null});
});
test("Word HTTP permission errors are explicit and sanitized",async t=>{
 mock(t,async()=>({error:{code:"42501",message:"private table details"}}));const response=await GET(new NextRequest(url,{headers:{authorization:"Bearer synthetic"}}));assert.equal(response.status,403);assert.deepEqual(await response.json(),{outcome:"forbidden"});
});

test("Review-to-save settings drift rejects before draft insertion",async t=>{let calls=0;mock(t,async()=>{calls++;return{data:ctx};});await assert.rejects(()=>cgvWordDraft("token","r1",new ArrayBuffer(0),"wrong-review-hash"),/stale_context/);assert.equal(calls,1);});
