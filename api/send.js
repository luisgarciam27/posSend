// api/send.js
// Versión simplificada: Vercel solo reenvía metadatos a n8n.
// n8n es quien descarga el PDF directamente desde Odoo (sin timeout).

const { cors, readBody } = require('./_odoo');

let fetchFn;
try { fetchFn = globalThis.fetch ?? require('node-fetch'); }
catch { fetchFn = require('node-fetch'); }

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      uid, password, username,
      order_id, order_number, invoice_id,
      client_name, client_phone,
      total, currency, vendor_name, company_id, message,
    } = await readBody(req);

    const n8nUrl = process.env.N8N_WEBHOOK_URL;
    const n8nTok = process.env.N8N_SECRET_TOKEN;

    if (!n8nUrl)       return res.status(500).json({ error: 'N8N_WEBHOOK_URL no configurado' });
    if (!client_phone) return res.status(400).json({ error: 'Sin número de teléfono' });

    // Solo reenviar metadatos — n8n descarga el PDF directamente
    const payload = {
      action:       'send_whatsapp',
      order_id:     order_id     || null,
      order_number: order_number || String(order_id),
      invoice_id:   invoice_id   || null,
      client_name:  client_name  || 'Cliente',
      client_phone: String(client_phone).replace(/\D/g, ''),
      total:        String(Number(total || 0).toFixed(2)),
      currency:     currency    || 'PEN',
      vendor_name:  vendor_name || '',
      company_id:   company_id  || '',
      message:      message     || buildDefaultMsg({ order_number, client_name, total, currency }),
      // Credenciales Odoo para que n8n descargue el PDF
      odoo_url:     process.env.ODOO_URL,
      odoo_db:      process.env.ODOO_DB,
      odoo_uid:     uid,
      odoo_password: password,
      odoo_username: username || '',
    };

    console.log('[send] → n8n:', {
      order_number: payload.order_number,
      invoice_id:   payload.invoice_id,
      phone:        payload.client_phone,
    });

    const n8nRes = await fetchFn(n8nUrl, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(n8nTok ? { 'X-Token': n8nTok } : {}),
      },
      body: JSON.stringify(payload),
    });

    const responseText = await n8nRes.text();
    if (!n8nRes.ok) throw new Error(`n8n respondió ${n8nRes.status}: ${responseText}`);

    let n8nData;
    try { n8nData = JSON.parse(responseText); } catch { n8nData = { raw: responseText }; }

    return res.status(200).json({ ok: true, n8n: n8nData });

  } catch (err) {
    console.error('[send] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
};

function buildDefaultMsg({ order_number, client_name, total, currency }) {
  return `📄 *Comprobante de Pago*\n\nEstimado/a *${client_name || 'cliente'}*,\n\nAdjuntamos su comprobante *${order_number}* por un total de *${currency || 'PEN'} ${Number(total || 0).toFixed(2)}*.\n\nGracias por su preferencia 🙏`;
}
