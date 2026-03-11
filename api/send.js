// api/send.js
// POST /api/send
// Para Odoo 14 + l10n_pe_edi: descarga el PDF via HTTP session (no XML-RPC)
// porque render_qweb_pdf está bloqueado por el proceso de firma SUNAT.

const { cors, readBody } = require('./_odoo');

let fetchFn;
try { fetchFn = globalThis.fetch ?? require('node-fetch'); }
catch { fetchFn = require('node-fetch'); }

// ── Descarga PDF de factura via HTTP (Odoo 14 + l10n_pe_edi) ───────────────
// Odoo expone /web/content/?model=account.move&id=X&field=invoice_pdf_report_file
// o /report/pdf/account.report_invoice_with_payments/X
// Ambos requieren autenticación via cookie de sesión.
async function downloadInvoicePDFviaHTTP(odooUrl, db, username, password, invoiceId) {
  const base = odooUrl.replace(/\/$/, '');

  // 1. Obtener sesión (cookie) autenticada
  const loginRes = await fetchFn(`${base}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: 1,
      params: { db, login: username, password },
    }),
  });

  const setCookie = loginRes.headers.get('set-cookie') || '';
  const sessionMatch = setCookie.match(/session_id=([^;]+)/);
  if (!sessionMatch) throw new Error('No se pudo obtener sesión Odoo');
  const sessionId = sessionMatch[1];
  const cookieHeader = `session_id=${sessionId}`;

  // 2. Intentar descargar PDF con diferentes endpoints de Odoo 14
  const endpoints = [
    `${base}/report/pdf/account.report_invoice_with_payments/${invoiceId}`,
    `${base}/report/pdf/account.report_invoice/${invoiceId}`,
    `${base}/web/content/?model=account.move&id=${invoiceId}&field=invoice_pdf_report_file&filename_field=invoice_pdf_report_filename&download=true`,
  ];

  for (const endpoint of endpoints) {
    try {
      console.log('[send] Intentando HTTP PDF:', endpoint);
      const pdfRes = await fetchFn(endpoint, {
        headers: { 'Cookie': cookieHeader },
        redirect: 'follow',
      });

      if (!pdfRes.ok) {
        console.warn(`[send] HTTP ${pdfRes.status} en: ${endpoint}`);
        continue;
      }

      const contentType = pdfRes.headers.get('content-type') || '';
      if (!contentType.includes('pdf')) {
        console.warn(`[send] Content-Type no es PDF: ${contentType} en: ${endpoint}`);
        continue;
      }

      const arrayBuffer = await pdfRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      console.log(`[send] ✅ PDF HTTP OK: ${buffer.length} bytes desde ${endpoint}`);
      return buffer;

    } catch (e) {
      console.warn(`[send] Error en endpoint ${endpoint}:`, e.message);
    }
  }

  throw new Error('No se pudo descargar PDF por HTTP de Odoo 14');
}

// ── Fallback: PDF recibo POS via HTTP ───────────────────────────────────────
async function downloadPOSReceiptViaHTTP(odooUrl, db, username, password, orderId) {
  const base = odooUrl.replace(/\/$/, '');

  const loginRes = await fetchFn(`${base}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: 1,
      params: { db, login: username, password },
    }),
  });

  const setCookie = loginRes.headers.get('set-cookie') || '';
  const sessionMatch = setCookie.match(/session_id=([^;]+)/);
  if (!sessionMatch) throw new Error('No se pudo obtener sesión Odoo');
  const cookieHeader = `session_id=${sessionMatch[1]}`;

  const endpoints = [
    `${odooUrl.replace(/\/$/, '')}/report/pdf/point_of_sale.report_pos_order/${orderId}`,
    `${odooUrl.replace(/\/$/, '')}/report/pdf/point_of_sale.receipt_report/${orderId}`,
  ];

  for (const endpoint of endpoints) {
    try {
      console.log('[send] Intentando POS PDF HTTP:', endpoint);
      const pdfRes = await fetchFn(endpoint, {
        headers: { 'Cookie': cookieHeader },
        redirect: 'follow',
      });
      if (!pdfRes.ok) continue;
      const contentType = pdfRes.headers.get('content-type') || '';
      if (!contentType.includes('pdf')) continue;
      const buffer = Buffer.from(await pdfRes.arrayBuffer());
      console.log(`[send] ✅ POS PDF OK: ${buffer.length} bytes`);
      return buffer;
    } catch (e) {
      console.warn(`[send] POS PDF error:`, e.message);
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
      username, // ← el frontend debe enviar también el username (email de login)
    } = await readBody(req);

    const url    = process.env.ODOO_URL;
    const db     = process.env.ODOO_DB;
    const n8nUrl = process.env.N8N_WEBHOOK_URL;
    const n8nTok = process.env.N8N_SECRET_TOKEN;

    if (!url || !db)       return res.status(500).json({ error: 'Odoo no configurado' });
    if (!n8nUrl)           return res.status(500).json({ error: 'N8N_WEBHOOK_URL no configurado' });
    if (!client_phone)     return res.status(400).json({ error: 'Sin número de teléfono del cliente' });
    if (!uid || !password) return res.status(401).json({ error: 'uid y password requeridos' });

    // El username puede venir del body o usamos un fallback con env var admin
    const odooUser = username || process.env.ODOO_ADMIN_USER;
    if (!odooUser) {
      console.warn('[send] No hay username para sesión HTTP — PDF puede fallar');
    }

    // ── 1. Descargar PDF via HTTP ────────────────────────────────────────
    let pdfBuffer   = null;
    let pdfFilename = `${String(order_number || order_id).replace(/\//g, '-')}.pdf`;

    if (invoice_id && odooUser) {
      try {
        pdfBuffer = await downloadInvoicePDFviaHTTP(url, db, odooUser, password, invoice_id);
      } catch (e) {
        console.warn('[send] PDF factura HTTP falló:', e.message);
      }
    }

    // Fallback: recibo POS
    if (!pdfBuffer && order_id && odooUser) {
      try {
        pdfBuffer = await downloadPOSReceiptViaHTTP(url, db, odooUser, password, order_id);
        if (pdfBuffer) pdfFilename = `Recibo_${String(order_number || order_id).replace(/\//g, '-')}.pdf`;
      } catch (e) {
        console.warn('[send] PDF POS HTTP falló:', e.message);
      }
    }

    const pdfBase64 = pdfBuffer ? pdfBuffer.toString('base64') : '';
    if (!pdfBase64) console.warn('[send] ⚠️ Sin PDF — se enviará solo texto');

    // ── 2. Payload para n8n ──────────────────────────────────────────────
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

    console.log('[send] → n8n:', {
      phone:  payload.client_phone,
      order:  payload.order_number,
      hasPdf: !!pdfBase64,
      bytes:  pdfBuffer?.length || 0,
    });

    // ── 3. POST a n8n ────────────────────────────────────────────────────
    const n8nRes = await fetchFn(n8nUrl, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(n8nTok ? { 'X-Token': n8nTok } : {}),
      },
      body: JSON.stringify(payload),
    });

    const responseText = await n8nRes.text();
    console.log('[send] n8n status:', n8nRes.status, '|', responseText.slice(0, 300));

    if (!n8nRes.ok) throw new Error(`n8n respondió ${n8nRes.status}: ${responseText}`);

    let n8nData;
    try { n8nData = JSON.parse(responseText); } catch { n8nData = { raw: responseText }; }

    return res.status(200).json({
      ok:       true,
      pdf_sent: !!pdfBase64,
      pdf_size: pdfBuffer?.length || 0,
      n8n:      n8nData,
    });

  } catch (err) {
    console.error('[send] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
};

function buildDefaultMsg({ order_number, client_name, total, currency }) {
  return `📄 *Comprobante de Pago*\n\nEstimado/a *${client_name || 'cliente'}*,\n\nAdjuntamos su comprobante *${order_number}* por un total de *${currency || 'PEN'} ${Number(total || 0).toFixed(2)}*.\n\nGracias por su preferencia 🙏`;
}
