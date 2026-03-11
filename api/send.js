// api/send.js
// POST /api/send
// Descarga el PDF del comprobante desde Odoo 14 y lo envía a n8n → Evolution API → WhatsApp.

const { cors, readBody } = require('./_odoo');

// Compatibilidad Node 16 (sin fetch global) y Node 18+
let fetchFn;
try { fetchFn = globalThis.fetch ?? require('node-fetch'); }
catch { fetchFn = require('node-fetch'); }

// Nombres de reporte por versión — Odoo 14 primero
const INVOICE_REPORTS = [
  'account.report_invoice_with_payments', // Odoo 14 ← correcto
  'account.report_invoice',               // Odoo 14 alternativo
  'account.account_invoices',             // Odoo 15+
];

const POS_REPORTS = [
  'point_of_sale.report_pos_order',         // Odoo 14 ← correcto
  'point_of_sale.receipt_report',           // Odoo 14 alternativo
  'point_of_sale.pos_invoice_report',       // Odoo 15
  'point_of_sale.report_pos_order_receipt', // Odoo 16/17
];

async function tryRenderPDF(url, db, uid, password, reportNames, recordId) {
  const parsed  = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const xmlrpc  = require('xmlrpc');
  const client  = isHttps
    ? xmlrpc.createSecureClient({ host: parsed.hostname, port: parseInt(parsed.port || 443), path: '/xmlrpc/2/object' })
    : xmlrpc.createClient({ host: parsed.hostname, port: parseInt(parsed.port || 80), path: '/xmlrpc/2/object' });

  for (const reportName of reportNames) {
    try {
      console.log(`[send] Intentando: ${reportName} id:${recordId}`);
      const result = await new Promise((resolve, reject) => {
        client.methodCall('execute_kw', [
          db, uid, password,
          'ir.actions.report', 'render_qweb_pdf',
          [[reportName, [recordId]]],
          {}
        ], (err, res) => err ? reject(err) : resolve(res));
      });
      const bytes = result?.[0];
      if (!bytes) throw new Error('PDF vacío');
      const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'base64');
      console.log(`[send] ✅ PDF OK: ${reportName} — ${buffer.length} bytes`);
      return buffer;
    } catch (e) {
      console.warn(`[send] ❌ ${reportName}:`, e.message);
    }
  }
  return null;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      uid, password,
      order_id, order_number, invoice_id,
      client_name, client_phone,
      total, currency, vendor_name, company_id, message,
    } = await readBody(req);

    const url    = process.env.ODOO_URL;
    const db     = process.env.ODOO_DB;
    const n8nUrl = process.env.N8N_WEBHOOK_URL;
    const n8nTok = process.env.N8N_SECRET_TOKEN;

    if (!url || !db)       return res.status(500).json({ error: 'Odoo no configurado' });
    if (!n8nUrl)           return res.status(500).json({ error: 'N8N_WEBHOOK_URL no configurado' });
    if (!client_phone)     return res.status(400).json({ error: 'Sin número de teléfono del cliente' });
    if (!uid || !password) return res.status(401).json({ error: 'uid y password requeridos' });

    // 1. PDF de factura (account.move) — Odoo 14
    let pdfBuffer   = null;
    let pdfFilename = `${String(order_number || order_id).replace(/\//g, '-')}.pdf`;

    if (invoice_id) {
      console.log('[send] PDF factura invoice_id:', invoice_id);
      pdfBuffer = await tryRenderPDF(url, db, uid, password, INVOICE_REPORTS, invoice_id);
    }

    // 2. Fallback: recibo POS
    if (!pdfBuffer && order_id) {
      console.log('[send] PDF recibo POS order_id:', order_id);
      pdfBuffer = await tryRenderPDF(url, db, uid, password, POS_REPORTS, order_id);
      if (pdfBuffer) pdfFilename = `Recibo_${String(order_number || order_id).replace(/\//g, '-')}.pdf`;
    }

    const pdfBase64 = pdfBuffer ? pdfBuffer.toString('base64') : '';
    if (!pdfBase64) console.warn('[send] ⚠️ Sin PDF — se enviará solo texto');

    // 3. Payload para n8n
    const payload = {
      action:       'send_whatsapp',
      order_number: order_number || String(order_id),
      client_name:  client_name  || 'Cliente',
      client_phone: String(client_phone).replace(/\D/g, ''),
      total:        String(Number(total || 0).toFixed(2)),
      currency:     currency || 'PEN',
      vendor_name:  vendor_name || '',
      company_id:   company_id  || '',
      message:      message || buildDefaultMsg({ order_number, client_name, total, currency }),
      pdf_base64:   pdfBase64,
      pdf_filename: pdfBase64 ? pdfFilename : '',
    };

    console.log('[send] → n8n:', { phone: payload.client_phone, order: payload.order_number, hasPdf: !!pdfBase64, bytes: pdfBuffer?.length || 0 });

    // 4. POST a n8n
    const n8nRes = await fetchFn(n8nUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...(n8nTok ? { 'X-Token': n8nTok } : {}) },
      body:    JSON.stringify(payload),
    });

    const responseText = await n8nRes.text();
    console.log('[send] n8n status:', n8nRes.status, '|', responseText.slice(0, 300));

    if (!n8nRes.ok) throw new Error(`n8n respondió ${n8nRes.status}: ${responseText}`);

    let n8nData;
    try { n8nData = JSON.parse(responseText); } catch { n8nData = { raw: responseText }; }

    return res.status(200).json({ ok: true, pdf_sent: !!pdfBase64, pdf_size: pdfBuffer?.length || 0, n8n: n8nData });

  } catch (err) {
    console.error('[send] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
};

function buildDefaultMsg({ order_number, client_name, total, currency }) {
  return `📄 *Comprobante de Pago*\n\nEstimado/a *${client_name || 'cliente'}*,\n\nAdjuntamos su comprobante *${order_number}* por un total de *${currency || 'PEN'} ${Number(total || 0).toFixed(2)}*.\n\nGracias por su preferencia 🙏`;
}
