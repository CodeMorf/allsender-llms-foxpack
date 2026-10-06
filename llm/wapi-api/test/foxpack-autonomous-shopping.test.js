import test from 'node:test';
import assert from 'node:assert/strict';
import { FOXPACK_SHOPPING_WORKSPACE as fox, shoppingContext, runShoppingDecision as execute, PRICE_NOTICE } from '../services/foxpack-autonomous-shopping.service.js';
const runShoppingDecision = options => execute({ isEnabled: async () => true, ...options });

// Contract tests use an explicit fixture; live provider tests are a separate required gate.
const offer = { asin: 'B0ABCDEFGHI'.slice(0, 10), title: 'Contract test item', price: 20,
  price_normal: 30, url: 'https://www.amazon.com/dp/B0ABCDEFGH', image: 'https://m.media-amazon.com/images/I/fixture.jpg' };

test('only the exact FoxPack workspace can invoke shopping or receive the prompt', async () => {
  for (const workspaceId of [null, '6ab82a6847ab241dfafe4bc1', '6aa863ad921399335654423f']) {
    assert.equal(shoppingContext({ workspaceId }), '');
    let calls = 0;
    const result = await runShoppingDecision({ workspaceId, decision: { buscar_productos: 'ssd' }, search: async () => { calls++; } });
    assert.equal(calls, 0); assert.equal(result.searched, false);
  }
});

test('a model decision with no search does not consult Amazon', async () => {
  const result = await runShoppingDecision({ workspaceId: fox, decision: { buscar_productos: null, reply_text: 'Account support' }, search: () => { throw Error('Must not call'); } });
  assert.equal(result.decision.reply_text, 'Account support'); assert.equal(result.searches.length, 0);
});

test('live executor data overrides invented prices and links from the model', async () => {
  const result = await runShoppingDecision({ workspaceId: fox, decision: { buscar_productos: 'ssd portable' },
    search: async () => ({ ok: true, items: [offer] }),
    complete: async () => ({ reply_text: 'Only US$1 at https://fake.invalid', mostrar_fotos: true, producto_seleccionado: 1 }) });
  assert.match(result.decision.reply_text, /US\$20/); assert.ok(!result.decision.reply_text.includes('fake.invalid'));
  assert.ok(result.decision.reply_text.includes(PRICE_NOTICE)); assert.equal(result.photoOffers.length, 1);
});

test('a missing result can be reformulated once, never an unbounded loop', async () => {
  let calls = 0;
  const result = await runShoppingDecision({ workspaceId: fox, decision: { buscar_productos: 'first' },
    search: async () => { calls++; return { ok: false, items: [], reason: 'no_results' }; },
    complete: async () => ({ buscar_productos: 'second' + calls, reply_text: 'Invented price US$100' }) });
  assert.equal(calls, 2); assert.equal(result.decision.buscar_productos, null);
  assert.match(result.decision.reply_text, /No encontré ofertas verificadas/);
});

test('a repeated query is not executed twice', async () => {
  let calls = 0;
  await runShoppingDecision({ workspaceId: fox, decision: { buscar_productos: 'USB' },
    search: async () => { calls++; return { ok: false, items: [] }; }, complete: async () => ({ buscar_productos: 'usb' }) });
  assert.equal(calls, 1);
});

test('selected photos and links use the existing options without a new search', async () => {
  const result = await runShoppingDecision({ workspaceId: fox, offers: [offer],
    decision: { buscar_productos: null, producto_seleccionado: 1, mostrar_fotos: true, recommended_action: 'SEND_PRODUCT_LINK' },
    search: () => { throw Error('Must not search'); } });
  assert.equal(result.photoOffers[0].asin, offer.asin); assert.match(result.decision.reply_text, /amazon.com\/dp/);
});

test('a missing photo cannot produce a promise or an invented attachment', async () => {
  const result = await runShoppingDecision({ workspaceId: fox, offers: [],
    decision: { mostrar_fotos: true, producto_seleccionado: 9, reply_text: 'Sending photo' } });
  assert.equal(result.photoOffers.length, 0); assert.equal(result.decision.reply_text, '¿De qué producto quieres ver la foto?');
});

test('a purchase intention is not replaced by a product link and never buys anything', async () => {
  const result = await runShoppingDecision({ workspaceId: fox, offers: [offer],
    decision: { producto_seleccionado: 1, reply_text: 'Register and ask your advisor', needs_transfer: true } });
  assert.equal(result.decision.reply_text, 'Register and ask your advisor'); assert.equal(result.decision.needs_transfer, true);
});

test('a failed follow-up model call still returns verified products', async () => {
  const result = await runShoppingDecision({ workspaceId: fox, decision: { buscar_productos: 'usb' },
    search: async () => ({ ok: true, items: [offer] }), complete: async () => { throw Error('Provider unavailable'); } });
  assert.ok(result.decision.reply_text.includes(offer.url)); assert.equal(result.photoOffers.length, 0);
});

test('the customer budget is passed to the executor and cannot grow on reformulation', async () => {
  const limits = [];
  const result = await runShoppingDecision({ workspaceId: fox, decision: { buscar_productos: 'earbuds', precio_maximo_usd: 15 },
    search: async options => { limits.push(options.maxPriceUsd); return { ok: true, items: [offer] }; },
    complete: async () => ({ buscar_productos: 'bluetooth', precio_maximo_usd: 100 }) });
  assert.deepEqual(limits, [15.01, 15.01]); assert.equal(result.offers.length, 0);
});
