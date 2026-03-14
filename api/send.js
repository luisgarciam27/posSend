// api/send.js
// Estrategia híbrida para l10n_pe_edi (Odoo Perú):
//   1. XML-RPC → busca el ID del adjunto PDF (solo metadatos, sin datas)
//   2. HTTP    → descarga /web/content/?model=ir.attachment&id=X  (el binario real)
//   3. Fallback HTTP → /web/content en account.move directamente
//   4. Fallback texto → avisa en logs

const { execute, cors, readBody } = require('./_odoo');

let fetchFn;
try { fetchFn = globalThis.fetch ?? require('node-fetch'); }
catch { fetchFn = require('node-fetch'); }

// ── Obtener cookie de sesión Odoo ──────────────────────────────────────────
async function getSessionCookie(base, db, username, password) {
  const loginRes = await fetchFn(`${base}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: 1,
      params: { db, login: username, password },
    }),
  });
  const setCookie = loginRes.headers.get('set-cookie') || '';
  const match = setCookie.match(/session_id=([^;]+)/);
  if (!match) throw new Error('No se pudo obtener sesión HTTP de Odoo');
  return `session_id=${match[1]}`;
}

// ── Descargar buffer desde una URL con cookie ──────────────────────────────
async function downloadWithCookie(url, cookie) {
  const res = await fetchFn(url, {
    headers: { 'Cookie': cookie },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('pdf')) throw new Error(`Respuesta no es PDF (${ct})`);
  return Buffer.from(await res.arrayBuffer());
}

// ── Estrategia principal ───────────────────────────────────────────────────
async function downloadPDF(url, db, uid, password, username, invoiceId, orderId) {
  const base = url.replace(/\/$/, '');
  let cookie = null;

  // Helper: obtener cookie sólo cuando se necesita (lazy)
  async function getCookie() {
    if (!cookie && username) cookie = await getSessionCookie(base, db, username, password);
    if (!cookie) throw new Error('No hay username para obtener sesión HTTP');
    return cookie;
  }

  // ── Paso 1: buscar adjunto PDF por XML-RPC (solo ID y nombre, SIN datas) ──
  if (invoiceId) {
    let attachmentId = null;
    let attachmentName = null;

    try {
      const atts = await execute(url, db, uid, password,
        'ir.attachment', 'search_read',
        [[
          ['res_model', '=', 'account.move'],
          ['res_id',    '=', invoiceId],
          ['mimetype',  '=', 'application/pdf'],
        ]],
        { fields: ['id', 'name'], order: 'id desc', limit: 5 }
      );
      console.log('[send] Adjuntos encontrados:', atts.map(a => `${a.id}:${a.name}`));

      const best = atts.find(a => /invoice|boleta|factura|BBB|FFF|B0|F0/i.test(a.name)) || atts[0];
      if (best) {
        attachmentId   = best.id;
        attachmentName = best.name.endsWith('.pdf') ? best.name : best.name + '.pdf';
      }
    } catch (e) {
      console.warn('[send] Búsqueda ir.attachment falló:', e.message);
    }

    // ── Paso 2: descargar el adjunto por HTTP /web/content ─────────────────
    if (attachmentId) {
      try {
        const ck  = await getCookie();
        const dlUrl = `${base}/web/content/?model=ir.attachment&id=${attachmentId}&field=datas&download=true`;
        console.log('[send] Descargando adjunto:', dlUrl);
        const buffer = await downloadWithCookie(dlUrl, ck);
        console.log(`[send] ✅ PDF adjunto OK: ${attachmentName} — ${buffer.length} bytes`);
        return { buffer, filename: attachmentName, strategy: 'attachment' };
      } catch (e) {
        console.warn('[send] Descarga adjunto HTTP falló:', e.message);
      }
    }

    // ── Paso 3: /web/content directamente en account.move ─────────────────
    try {
      const ck = await getCookie();
      const dlUrl = `${base}/web/content/?model=account.move&id=${invoiceId}&field=invoice_pdf_report_file&download=true`;
      console.log('[send] Intentando account.move field:', dlUrl);
      const buffer = await downloadWithCookie(dlUrl, ck);
      console.log(`[send] ✅ account.move field OK: ${buffer.length} bytes`);
      return { buffer, filename: `Comprobante_${invoiceId}.pdf`, strategy: 'move_field' };
    } catch (e) {
      console.warn('[send] account.move field falló:', e.message);
    }
  }

  // ── Paso 4: recibo POS ─────────────────────────────────────────────────
  if (orderId) {
    const endpoints = [
      `${base}/report/pdf/point_of_sale.report_pos_order/${orderId}`,
      `${base}/report/pdf/point_of_sale.receipt_report/${orderId}`,
    ];
    for (const ep of endpoints) {
      try {
        const ck = await getCookie();
        const buffer = await downloadWithCookie(ep, ck);
        console.log(`[send] ✅ POS receipt OK: ${buffer.length} bytes`);
        return { buffer, filename: `Recibo_${orderId}.pdf`, strategy: 'pos_receipt' };
      } catch (e) {
        console.warn(`[send] POS receipt falló: ${e.message}`);
      }
    }
  }

  return null;
}

// ── Handler ────────────────────────────────────────────────────────────────
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

    const url    = process.env.ODOO_URL;
    const db     = process.env.ODOO_DB;
    const n8nUrl = process.env.N8N_WEBHOOK_URL;
    const n8nTok = process.env.N8N_SECRET_TOKEN;

    if (!url || !db)       return res.status(500).json({ error: 'Odoo no configurado' });
    if (!n8nUrl)           return res.status(500).json({ error: 'N8N_WEBHOOK_URL no configurado' });
    if (!client_phone)     return res.status(400).json({ error: 'Sin número de teléfono' });
    if (!uid || !password) return res.status(401).json({ error: 'uid y password requeridos' });

    const odooUser = username || process.env.ODOO_ADMIN_USER;

    console.log('[send] Iniciando:', { order_number, invoice_id, order_id, hasUsername: !!odooUser, phone: client_phone });

    const safeFilename = String(order_number || order_id).replace(/\//g, '-');
    let pdfBuffer   = null;
    let pdfFilename = `${safeFilename}.pdf`;
    let strategy    = 'none';

    const result = await downloadPDF(url, db, uid, password, odooUser, invoice_id, order_id);
    if (result) {
      pdfBuffer   = result.buffer;
      pdfFilename = result.filename;
      strategy    = result.strategy;
    }

    const pdfBase64 = pdfBuffer ? pdfBuffer.toString('base64') : '';

    if (!pdfBase64) {
      console.warn('[send] ⚠️ Sin PDF — enviando solo texto');
    } else {
      console.log(`[send] PDF listo [${strategy}]: ${pdfFilename} — ${pdfBuffer.length} bytes`);
    }

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

    return res.status(200).json({
      ok: true,
      pdf_sent: !!pdfBase64,
      pdf_size: pdfBuffer?.length || 0,
      strategy,
      n8n: n8nData,
    });

  } catch (err) {
    console.error('[send] fatal:', err);
    return res.status(500).json({ error: err.message });
  }
};

function buildDefaultMsg({ order_number, client_name, total, currency }) {
  return `📄 *Comprobante de Pago*\n\nEstimado/a *${client_name || 'cliente'}*,\n\nAdjuntamos su comprobante *${order_number}* por un total de *${currency || 'PEN'} ${Number(total || 0).toFixed(2)}*.\n\nGracias por su preferencia 🙏`;
}
