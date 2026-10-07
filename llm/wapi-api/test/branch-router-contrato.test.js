import test from 'node:test';
import assert from 'node:assert/strict';
import { validarContratoBranchRouter } from '../services/branch-router.service.js';

test('un JSON sin contrato se rechaza', () => {
  assert.equal(validarContratoBranchRouter({}).motivo, 'sin_texto_ni_accion');
  assert.equal(validarContratoBranchRouter({ algo: 'raro' }).ok, false);
  assert.equal(validarContratoBranchRouter(null).motivo, 'no_es_objeto');
  assert.equal(validarContratoBranchRouter([]).motivo, 'no_es_objeto');
  assert.equal(validarContratoBranchRouter('hola').ok, false);
});

test('los tipos de los campos de accion se revisan', () => {
  assert.equal(validarContratoBranchRouter({ reply_text: 'Hola' }).ok, true);
  assert.equal(validarContratoBranchRouter({ reply_text: 123 }).motivo, 'reply_text');
  assert.equal(validarContratoBranchRouter({ reply_text: 'Hola', needs_transfer: 'si' }).motivo, 'needs_transfer');
  assert.equal(validarContratoBranchRouter({ reply_text: 'Hola', mostrar_fotos: 1 }).motivo, 'mostrar_fotos');
  assert.equal(validarContratoBranchRouter({ reply_text: 'Hola', producto_seleccionado: 7 }).motivo, 'producto_seleccionado');
  assert.equal(validarContratoBranchRouter({ reply_text: 'Hola', producto_seleccionado: '2' }).ok, true);
  assert.equal(validarContratoBranchRouter({ reply_text: 'Hola', buscar_productos: '' }).motivo, 'buscar_productos');
  assert.equal(validarContratoBranchRouter({ reply_text: 'Hola', buscar_productos: ['tv', 'usb'] }).ok, true);
  assert.equal(validarContratoBranchRouter({ reply_text: 'Hola', collected_information: [{ label: 'x', value: 1 }] }).ok, true);
  assert.equal(validarContratoBranchRouter({ reply_text: 'Hola', collected_information: [{ value: 'x' }] }).motivo, 'collected_information');
});

test('decidir una busqueda o un traslado sin texto sigue siendo contrato valido', () => {
  assert.equal(validarContratoBranchRouter({ buscar_productos: 'fire tv', reply_text: '' }).ok, true);
  assert.equal(validarContratoBranchRouter({ reply_text: '', needs_transfer: true }).ok, true);
  assert.equal(validarContratoBranchRouter({ reply_text: '   ' }).ok, false);
});
