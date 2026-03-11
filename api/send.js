// api/send.js
// POST /api/send
// Descarga el PDF del comprobante desde Odoo y lo envía
// a n8n para que dispare Evolution API → WhatsApp.
//
// FIX 1: Usa node-fetch explícito para compatibilidad con Node 16/18
// FIX 2: Prueba múltiples nombres de reporte POS (compatibilidad Odoo 14/15/16/17)
// FIX 3: Payload limpio y consistente con lo que n8n espera

const { execute, cors, readBody, makeClient, call } = require('./_odoo');

// Compatibilidad Node 16 (sin fetch global) y Node 18+
let fetchFn;
try {
  fetchFn = globalThis.fetch || require('node-fetch');
} catch {
  fetchFn = require('node-fetch');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      uid, password,
      order_id, order_number,
      client_name, client_phone,
      total, currency,
      vendor_name, company_id,
      message,
      invoice_id,
    } = await readBody(req);

    const url    = process.env.ODOO_URL;
    const db     = process.env.ODOO_DB;
    const n8nUrl = process.env.N8N_WEBHOOK_URL;

    if (!url || !db)   return res.status(500).json({ error: 'Odoo no configurado' });
    if (!n8nUrl)       return res.status(500).json({ error: 'N8N_WEBHOOK_URL no configurado' });
    if (!client_phone) return res.status(400).json({ error: 'Sin número de teléfono del cliente' });

    // ── 1. Intentar descargar PDF ────────────────────────────────────────
    let pdfBase64  = null;
    let pdfFilename = `${order_number || order_id}.pdf`;

    // FIX 2: Lista de nombres de reporte POS según versión de Odoo
    const posReportNames = [
      'point_of_sale.report_pos_order',   // Odoo 16/17
      'point_of_sale.pos_invoice_report',  // Odoo 15
      'point_of_sale.report_pos_receipt',  // algunos módulos custom
    ];

    // Intentar primero con la factura vinculada (account.move)
    if (invoice_id) {
      try {
        const models = makeClient(url, '/xmlrpc/2/object');
        const result = await call(models, 'execute_kw', [
          db, uid, password,
          'ir.actions.report', 'render_qweb_pdf',
          [['account.report_invoice', [invoice_id]]],
          {}
        ]);
        const bytes = result?.[0];
        if (bytes) {
          pdfBase64  = Buffer.isBuffer(bytes) ? bytes.toString('base64') : bytes;
          pdfFilename = `${String(order_number).replace(/\//g, '-')}.pdf`;
          console.log('[send] PDF de factura OK, invoice_id:', invoice_id);
        }
      } catch (e) {
        console.warn('[send] PDF factura falló:', e.message);
      }
    }

    // Si no hay PDF de factura, intentar con reportes POS
    if (!pdfBase64 && order_id) {
      const models = makeClient(url, '/xmlrpc/2/object');

      for (const reportName of posReportNames) {
        try {
          const result = await call(models, 'execute_kw', [
            db, uid, password,
            'ir.actions.report', 'render_qweb_pdf',
            [[reportName, [order_id]]],
            {}
          ]);
          const bytes = result?.[0];
          if (bytes) {
            pdfBase64   = Buffer.isBuffer(bytes) ? bytes.toString('base64') : bytes;
            pdfFilename  = `Recibo_${String(order_number || order_id).replace(/\//g, '-')}.pdf`;
            console.log('[send] PDF POS OK con reporte:', reportName);
            break; // Salir del loop al primer éxito
          }
        } catch (e) {
          console.warn(`[send] Reporte ${reportName} falló:`, e.message);
        }
      }
    }

    if (!pdfBase64) {
      console.warn('[send] No se pudo generar PDF — se enviará solo texto');
    }

    // ── 2. Construir mensaje ─────────────────────────────────────────────
    const finalMessage = message || buildDefaultMsg({
      order_number, client_name, total, currency
    });

    // ── 3. Payload para n8n ──────────────────────────────────────────────
    // Campos exactos que n8n espera en "Extraer datos del payload"
    const payload = {
      action:       'send_whatsapp',
      order_number: order_number || String(order_id),
      client_name:  client_name  || 'Cliente',
      client_phone: String(client_phone).replace(/\D/g, ''), // solo dígitos
      total:        String(Number(total).toFixed(2)),
      currency:     currency || 'PEN',
      vendor_name:  vendor_name || '',
      company_id:   company_id  || '',
      message:      finalMessage,
      // PDF: null explícito si no hay → n8n evalúa != "" como false y toma rama texto
      pdf_base64:   pdfBase64   || '',
      pdf_filename: pdfBase64   ? pdfFilename : '',
    };

    console.log('[send] Enviando a n8n:', {
      phone: payload.client_phone,
      order: payload.order_number,
      hasPdf: !!pdfBase64,
      n8nUrl,
    });

    // ── 4. POST al webhook de n8n ────────────────────────────────────────
    const n8nRes = await fetchFn(n8nUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    const responseText = await n8nRes.text();
    console.log('[send] n8n status:', n8nRes.status, 'body:', responseText.slice(0, 200));

    if (!n8nRes.ok) {
      throw new Error(`n8n respondió ${n8nRes.status}: ${responseText}`);
    }

    let n8nData;
    try { n8nData = JSON.parse(responseText); }
    catch { n8nData = { raw: responseText }; }

    return res.status(200).json({
      ok:       true,
      pdf_sent: !!pdfBase64,
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
