// api/send.js
// POST /api/send
// Estrategia para boletas/facturas electrónicas Perú (l10n_pe_edi):
//
// 1. ir.attachment via XML-RPC  ← PRIMARIO: Odoo guarda el PDF firmado como adjunto
// 2. HTTP session (report)       ← FALLBACK 1: render on-the-fly
// 3. POS receipt via HTTP        ← FALLBACK 2: si no hay factura vinculada

const { execute, cors, readBody } = require('./_odoo');

let fetchFn;
try { fetchFn = globalThis.fetch ?? require('node-fetch'); }
catch { fetchFn = require('node-fetch'); }

// ── 1. PDF via ir.attachment (XML-RPC) ─────────────────────────────────────
// Para documentos l10n_pe_edi, Odoo almacena el PDF firmado como attachment
// con mimetype application/pdf ligado al account.move.
// No requiere sesión HTTP — funciona con uid + password/api_key.
async function downloadPDFviaAttachment(url, db, uid, password, invoiceId) {
  console.log('[send] Buscando PDF en ir.attachment para invoice_id:', invoiceId);

  const attachments = await execute(
    url, db, uid, password,
    'ir.attachment', 'search_read',
    [[
      ['res_model', '=', 'account.move'],
      ['res_id',    '=', invoiceId],
      ['mimetype',  '=', 'application/pdf'],
    ]],
    { fields: ['id', 'name', 'datas', 'store_fname'], order: 'id desc', limit: 5 }
  );

  console.log('[send] Adjuntos PDF encontrados:', attachments.length, attachments.map(a => a.name));

  // Preferir el que tiene nombre de comprobante reconocible
  const best = attachments.find(a => /invoice|boleta|factura|BBB|FFF|B0|F0/i.test(a.name))
            || attachments[0];

  if (!best || !best.datas) {
    throw new Error(`No se encontró PDF adjunto para invoice_id=${invoiceId}`);
  }

  const buffer = Buffer.from(best.datas, 'base64');
  console.log(`[send] ✅ PDF adjunto OK: ${best.name} — ${buffer.length} bytes`);
  return { buffer, filename: best.name.endsWith('.pdf') ? best.name : best.name + '.pdf' };
}

// ── 2. PDF via sesión HTTP (report endpoint) ───────────────────────────────
async function downloadPDFviaHTTP(odooUrl, db, username, password, invoiceId) {
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
  if (!sessionMatch) throw new Error('No se pudo obtener sesión Odoo para HTTP');
  const cookieHeader = `session_id=${sessionMatch[1]}`;

  const endpoints = [
    `${base}/report/pdf/account.report_invoice_with_payments/${invoiceId}`,
    `${base}/report/pdf/account.report_invoice/${invoiceId}`,
    `${base}/web/content/?model=account.move&id=${invoiceId}&field=invoice_pdf_report_file&download=true`,
  ];

  for (const endpoint of endpoints) {
    try {
      console.log('[send] HTTP PDF:', endpoint);
      const pdfRes = await fetchFn(endpoint, {
        headers: { 'Cookie': cookieHeader },
        redirect: 'follow',
      });
      if (!pdfRes.ok) { console.warn(`[send] HTTP ${pdfRes.status}`); continue; }
      const ct = pdfRes.headers.get('content-type') || '';
      if (!ct.includes('pdf')) { console.warn(`[send] No es PDF: ${ct}`); continue; }
      const buffer = Buffer.from(await pdfRes.arrayBuffer());
      console.log(`[send] ✅ HTTP PDF OK: ${buffer.length} bytes`);
      return { buffer, filename: `Comprobante_${invoiceId}.pdf` };
    } catch (e) {
      console.warn(`[send] HTTP endpoint falló: ${e.message}`);
    }
  }
  throw new Error('Todos los endpoints HTTP fallaron');
}

// ── 3. Recibo POS via HTTP (fallback sin factura) ──────────────────────────
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
  if (!sessionMatch) return null;
  const cookieHeader = `session_id=${sessionMatch[1]}`;

  const endpoints = [
    `${base}/report/pdf/point_of_sale.report_pos_order/${orderId}`,
    `${base}/report/pdf/point_of_sale.receipt_report/${orderId}`,
  ];

  for (const endpoint of endpoints) {
    try {
      const pdfRes = await fetchFn(endpoint, {
        headers: { 'Cookie': cookieHeader },
        redirect: 'follow',
      });
      if (!pdfRes.ok) continue;
      const ct = pdfRes.headers.get('content-type') || '';
      if (!ct.includes('pdf')) continue;
      const buffer = Buffer.from(await pdfRes.arrayBuffer());
      console.log(`[send] ✅ POS receipt OK: ${buffer.length} bytes`);
      return { buffer, filename: `Recibo_${orderId}.pdf` };
    } catch (e) {
      console.warn(`[send] POS receipt error: ${e.message}`);
    }
  }
  return null;
}

// ── Handler principal ──────────────────────────────────────────────────────
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
    if (!client_phone)     return res.status(400).json({ error: 'Sin número de teléfono del cliente' });
    if (!uid || !password) return res.status(401).json({ error: 'uid y password requeridos' });

    const odooUser = username || process.env.ODOO_ADMIN_USER;

    console.log('[send] Iniciando:', {
      order_number, invoice_id, order_id,
      hasUsername: !!odooUser,
      phone: client_phone,
    });

    // ── Descargar PDF (3 estrategias en cascada) ──────────────────────────
    let pdfBuffer   = null;
    let pdfFilename = `${String(order_number || order_id).replace(/\//g, '-')}.pdf`;
    let strategy    = 'none';

    // Estrategia 1: ir.attachment XML-RPC (más confiable para l10n_pe_edi)
    if (invoice_id) {
      try {
        const result = await downloadPDFviaAttachment(url, db, uid, password, invoice_id);
        pdfBuffer   = result.buffer;
        pdfFilename = result.filename;
        strategy    = 'attachment_xmlrpc';
      } catch (e) {
        console.warn('[send] ir.attachment falló:', e.message);
      }
    }

    // Estrategia 2: HTTP report endpoint
    if (!pdfBuffer && invoice_id && odooUser) {
      try {
        const result = await downloadPDFviaHTTP(url, db, odooUser, password, invoice_id);
        pdfBuffer   = result.buffer;
        pdfFilename = result.filename;
        strategy    = 'http_report';
      } catch (e) {
        console.warn('[send] HTTP report falló:', e.message);
      }
    }

    // Estrategia 3: Recibo POS (sin factura vinculada)
    if (!pdfBuffer && order_id && odooUser) {
      try {
        const result = await downloadPOSReceiptViaHTTP(url, db, odooUser, password, order_id);
        if (result) {
          pdfBuffer   = result.buffer;
          pdfFilename = result.filename;
          strategy    = 'pos_receipt';
        }
      } catch (e) {
        console.warn('[send] POS receipt falló:', e.message);
      }
    }

    const pdfBase64 = pdfBuffer ? pdfBuffer.toString('base64') : '';

    if (!pdfBase64) {
      console.warn('[send] ⚠️ Sin PDF — se enviará solo texto. invoice_id:', invoice_id);
    } else {
      console.log(`[send] PDF listo [${strategy}]: ${pdfFilename} — ${pdfBuffer.length} bytes`);
    }

    // ── Payload n8n ────────────────────────────────────────────────────────
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

    // ── POST a n8n ─────────────────────────────────────────────────────────
    const n8nRes = await fetchFn(n8nUrl, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(n8nTok ? { 'X-Token': n8nTok } : {}),
      },
      body: JSON.stringify(payload),
    });

    const responseText = await n8nRes.text();
    console.log('[send] n8n status:', n8nRes.status, '|', responseText.slice(0, 200));

    if (!n8nRes.ok) throw new Error(`n8n respondió ${n8nRes.status}: ${responseText}`);

    let n8nData;
    try { n8nData = JSON.parse(responseText); } catch { n8nData = { raw: responseText }; }

    return res.status(200).json({
      ok:       true,
      pdf_sent: !!pdfBase64,
      pdf_size: pdfBuffer?.length || 0,
      strategy,
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
