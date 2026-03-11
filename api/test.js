// api/test.js
// POST /api/test
// Prueba la conexión Odoo desde el panel de admin.
// Solo verifica las env vars del servidor — no expone credenciales.

const { version, authenticate, cors, readBody } = require('./_odoo');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const url = process.env.ODOO_URL;
  const db  = process.env.ODOO_DB;
  const n8n = process.env.N8N_WEBHOOK_URL;

  const result = {
    odoo_url:     url  ? '✓ configurado' : '✗ falta ODOO_URL',
    odoo_db:      db   ? '✓ configurado' : '✗ falta ODOO_DB',
    n8n_webhook:  n8n  ? '✓ configurado' : '✗ falta N8N_WEBHOOK_URL',
    odoo_version: null,
    odoo_ok:      false,
  };

  if (url && db) {
    try {
      const v = await version(url);
      result.odoo_version = v?.server_version || 'desconocida';
      result.odoo_ok = true;
    } catch (e) {
      result.odoo_version = '✗ ' + e.message;
    }
  }

  return res.status(200).json(result);
};
