// api/_odoo.js
// Utilidad compartida para llamadas XML-RPC a Odoo
// No es una ruta pública — el prefijo _ lo evita en Vercel

const xmlrpc = require('xmlrpc');
const https  = require('https');
const http   = require('http');

/**
 * Crea un cliente XML-RPC para Odoo.
 * @param {string} url  - URL base de Odoo, ej: https://miempresa.odoo.com
 * @param {string} path - Ruta del endpoint, ej: /xmlrpc/2/common
 */
function makeClient(url, path) {
  const parsed   = new URL(url);
  const isHttps  = parsed.protocol === 'https:';
  const port     = parsed.port || (isHttps ? 443 : 80);
  const options  = {
    host: parsed.hostname,
    port: parseInt(port),
    path,
  };
  return isHttps
    ? xmlrpc.createSecureClient(options)
    : xmlrpc.createClient(options);
}

/**
 * Llama a un método XML-RPC y devuelve una Promise.
 */
function call(client, method, params) {
  return new Promise((resolve, reject) => {
    client.methodCall(method, params, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

/**
 * Autentica un usuario en Odoo.
 * Retorna el uid numérico o lanza error si falla.
 */
async function authenticate(url, db, username, password) {
  const common = makeClient(url, '/xmlrpc/2/common');
  const uid = await call(common, 'authenticate', [db, username, password, {}]);
  if (!uid) throw new Error('Credenciales incorrectas');
  return uid;
}

/**
 * Ejecuta un método de modelo Odoo (execute_kw).
 */
async function execute(url, db, uid, apiKey, model, method, args = [], kwargs = {}) {
  const models = makeClient(url, '/xmlrpc/2/object');
  return call(models, 'execute_kw', [db, uid, apiKey, model, method, args, kwargs]);
}

/**
 * Obtiene la versión del servidor Odoo.
 */
async function version(url) {
  const common = makeClient(url, '/xmlrpc/2/common');
  return call(common, 'version', []);
}

/**
 * Descarga el PDF de una factura/boleta como Buffer.
 * Retorna { buffer, filename }
 */
async function downloadInvoicePDF(url, db, uid, apiKey, invoiceId, invoiceName) {
  const models = makeClient(url, '/xmlrpc/2/object');
  const result = await call(models, 'execute_kw', [
    db, uid, apiKey,
    'ir.actions.report', 'render_qweb_pdf',
    [['account.report_invoice', [invoiceId]]],
    {}
  ]);

  const pdfBytes = result && result[0];
  if (!pdfBytes) throw new Error('No se pudo generar el PDF');

  const buffer = Buffer.isBuffer(pdfBytes)
    ? pdfBytes
    : Buffer.from(pdfBytes, 'base64');

  const safeName = String(invoiceName).replace(/\//g, '-').replace(/\s/g, '_');
  return { buffer, filename: `${safeName}.pdf` };
}

/**
 * Middleware CORS para todas las API routes.
 */
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Token');
}

/**
 * Lee el body JSON de una request de Vercel.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    // Vercel ya parsea el body si Content-Type es application/json
    if (req.body) return resolve(req.body);
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

module.exports = { authenticate, execute, version, downloadInvoicePDF, cors, readBody, makeClient, call };
