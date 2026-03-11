// api/send.js
// POST /api/send
// Descarga el PDF del comprobante desde Odoo y lo envía
// a n8n para que dispare Evolution API → WhatsApp.

const { execute, downloadInvoicePDF, cors, readBody } = require('./_odoo');

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
      // Si la orden tiene account_move (factura), se descarga esa
      invoice_id,
    } = await readBody(req);

    const url     = process.env.ODOO_URL;
    const db      = process.env.ODOO_DB;
    const n8nUrl  = process.env.N8N_WEBHOOK_URL;
    const n8nTok  = process.env.N8N_SECRET_TOKEN;

    if (!url || !db)  return res.status(500).json({ error: 'Odoo no configurado' });
    if (!n8nUrl)      return res.status(500).json({ error: 'N8N_WEBHOOK_URL no configurado' });
    if (!client_phone) return res.status(400).json({ error: 'Sin número de teléfono del cliente' });

    // 1. Descargar PDF del comprobante desde Odoo
    let pdfBase64 = null;
    let pdfFilename = `${order_number || order_id}.pdf`;

    if (invoice_id) {
      // Tiene factura electrónica vinculada → descargar esa
      try {
        const { buffer, filename } = await downloadInvoicePDF(url, db, uid, password, invoice_id, order_number);
        pdfBase64  = buffer.toString('base64');
        pdfFilename = filename;
      } catch (e) {
        console.warn('[send] No se pudo descargar PDF de factura, intentando reporte POS:', e.message);
      }
    }

    if (!pdfBase64) {
      // Fallback: reporte de recibo POS (pos.order)
      try {
        const models = require('xmlrpc').createSecureClient({
          host: new URL(url).hostname,
          port: 443,
          path: '/xmlrpc/2/object',
        });

        await new Promise((resolve, reject) => {
          models.methodCall('execute_kw', [
            db, uid, password,
            'ir.actions.report', 'render_qweb_pdf',
            [['point_of_sale.report_pos_order', [order_id]]],
            {}
          ], (err, result) => {
            if (err) return reject(err);
            const bytes = result?.[0];
            if (!bytes) return reject(new Error('PDF vacío'));
            pdfBase64   = Buffer.isBuffer(bytes) ? bytes.toString('base64') : bytes;
            pdfFilename  = `Recibo_${order_number || order_id}.pdf`;
            resolve();
          });
        });
      } catch (e) {
        console.warn('[send] No se pudo generar PDF POS:', e.message);
        // Continuar sin PDF — solo se enviará el mensaje de texto
      }
    }

    // 2. Enviar a n8n → n8n llama Evolution API
    const payload = {
      action:       'send_whatsapp',
      order_id,
      order_number,
      client_name,
      client_phone,   // formato: 51987654321
      total,
      currency:      currency || 'PEN',
      vendor_name,
      company_id,
      message:       message || buildDefaultMsg({ order_number, client_name, total, currency }),
      // PDF como base64 (n8n lo convierte a archivo y adjunta en Evolution)
      pdf_base64:   pdfBase64,
      pdf_filename: pdfFilename,
    };

    const n8nRes = await fetch(n8nUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(n8nTok ? { 'X-Token': n8nTok } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!n8nRes.ok) {
      const errText = await n8nRes.text().catch(() => '');
      throw new Error(`n8n respondió ${n8nRes.status}: ${errText}`);
    }

    const n8nData = await n8nRes.json().catch(() => ({ ok: true }));
    return res.status(200).json({ ok: true, n8n: n8nData });

  } catch (err) {
    console.error('[send]', err);
    return res.status(500).json({ error: err.message });
  }
};

function buildDefaultMsg({ order_number, client_name, total, currency }) {
  return `📄 *Comprobante de Pago*\n\nEstimado/a *${client_name || 'cliente'}*,\n\nAdjuntamos su comprobante *${order_number}* por un total de *${currency || 'PEN'} ${Number(total).toFixed(2)}*.\n\nGracias por su preferencia 🙏`;
}
