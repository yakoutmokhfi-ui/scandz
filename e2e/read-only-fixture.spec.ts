// Local synthetic HTTP data boundary, NOT a test or a database emulator.
// Excluded by testMatch. Only allowlisted public reads exist; no upstream.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const id = '00000000-0000-4000-8000-000000000001';
const categories = ['Fromages', 'Desserts', 'Boissons', 'Pains', 'Epicerie'].map((name, i) => ({
  id: `category-${i}`, name, display_order: i, is_active: true, menu_subcategories: [],
  menu_items: [{ id: `item-${i}`, category_id: `category-${i}`, name: `Produit ${i + 1}`,
    price: i + 2, is_available: true, display_order: 0, image_url: null,
    description: null, short_description: null, menu_item_sale_modes: [] }],
}));
const restaurant = {
  id, name: 'Boutique E2E', slug: 'e2e-classic', is_active: true, status: 'active',
  created_at: '2026-01-01T00:00:00Z', menu_categories: categories,
  restaurant_active_languages: [],
  restaurant_configs: { restaurant_id: id, currency: 'EUR', max_tables: 10,
    whatsapp_number: '', whatsapp_enabled: false, source_language: 'fr',
    logo_url: null, cover_url: null, address: null, opening_hours: null },
};
const reads: Record<string, unknown> = {
  get_restaurant_collections: [{ id: 'collection-1', label: 'Selection E2E', display_order: 0, menu_item_ids: ['item-0', 'item-2'] }],
  get_restaurant_public_sale_modes: [{ mode_code: 'pickup', customer_text: null, pricing_mode: 'free' }],
  get_restaurant_public_field_requirements: [],
  get_restaurant_public_delivery_countries: [],
  get_restaurant_public_delivery_info: [],
  get_restaurant_public_delivery_fulfillments: [{ fulfillment_code: 'fixture', zone_prefixes: ['75'],
    is_fallback: false, min_items: 0, customer_text: 'Livraison de demonstration', display_order: 0,
    pricing_mode: 'fixed', fixed_fee: 3, free_threshold: null, discount_enabled: false }],
  get_restaurant_public_cgv: [{ restaurant_id: id, cgv_version_id: 'fixture-v1',
    rendered_content: '<h1>Conditions de vente E2E</h1><p>Document synthetique de test.</p>',
    content_hash: 'fixture', locale: 'fr', published_at: '2026-01-01T00:00:00Z', enforced: false }],
};
const fingerprint = () => createHash('sha256').update(JSON.stringify({ restaurant, reads })).digest('hex');
const audit: { method: string; path: string; allowed: boolean }[] = [];
createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:3100');
  res.setHeader('Access-Control-Allow-Headers', 'apikey,authorization,content-type,x-client-info');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url!, 'http://127.0.0.1:3101');
  const path = url.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (req.method === 'GET' && path === '/health') { res.end('{}'); return; }
  if (req.method === 'GET' && path === '/audit') { res.end(JSON.stringify({ fingerprint: fingerprint(), audit })); return; }
  let value: unknown;
  let allowed = false;
  if (req.method === 'GET' && path === '/rest/v1/restaurants') {
    const slug = url.searchParams.get('slug')?.replace(/^eq\./, '');
    allowed = ['e2e-classic', 'le-sirocco'].includes(slug ?? '');
    value = allowed ? { ...restaurant, slug } : null;
  } else if (req.method === 'GET' && path === '/rest/v1/sale_mode_catalog') {
    allowed = true;
    value = [{ code: 'pickup', label: 'A emporter', category: 'pickup' }];
  } else if (req.method === 'POST' && path.startsWith('/rest/v1/rpc/')) {
    const name = path.slice('/rest/v1/rpc/'.length);
    allowed = Object.hasOwn(reads, name);
    value = reads[name];
    // Consume the request without executing any operation.
    for await (const _chunk of req) { /* no writes */ }
  }
  audit.push({ method: req.method!, path, allowed });
  res.statusCode = allowed ? 200 : 403;
  res.end(JSON.stringify(allowed ? value : { message: 'Not an allowlisted public read' }));
}).listen(3101, '127.0.0.1');

