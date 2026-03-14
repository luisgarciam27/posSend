// api/debug-pdf.js  — SOLO PARA DIAGNÓSTICO, quitar en producción
// POST /api/debug-pdf  { uid, password, invoice_id, order_id }

const { execute, cors, readBody } = require('./_odoo');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { uid, password, invoice_id, order_id } = await readBody(req);
  const url = process.env.ODOO_URL;
  const db  = process.env.ODOO_DB;

  const result = {};

  // 1. ¿Qué invoice_id llegó?
  result.received = { uid, invoice_id, order_id };

  // 2. Si hay invoice_id, leer el account.move directamente
  if (invoice_id) {
    try {
      const move = await execute(url, db, uid, password,
        'account.move', 'read', [[invoice_id]],
        { fields: ['name', 'state', 'move_type', 'l10n_pe_edi_status'] }
      );
      result.account_move = move[0] || null;
    } catch(e) { result.account_move_error = e.message; }

    // 3. Buscar TODOS los ir.attachment para este move (sin filtro de mimetype)
    try {
      const atts = await execute(url, db, uid, password,
        'ir.attachment', 'search_read',
        [[['res_model','=','account.move'],['res_id','=',invoice_id]]],
        { fields: ['id','name','mimetype','file_size','store_fname'], order: 'id desc', limit: 10 }
      );
      result.attachments_all = atts;
    } catch(e) { result.attachments_error = e.message; }

    // 4. Intentar leer datas del primer adjunto PDF
    try {
      const pdfs = await execute(url, db, uid, password,
        'ir.attachment', 'search_read',
        [[['res_model','=','account.move'],['res_id','=',invoice_id],['mimetype','=','application/pdf']]],
        { fields: ['id','name','datas'], order: 'id desc', limit: 1 }
      );
      if (pdfs.length > 0) {
        result.pdf_datas_present = !!pdfs[0].datas;
        result.pdf_datas_length  = pdfs[0].datas?.length || 0;
        result.pdf_name          = pdfs[0].name;
      } else {
        result.pdf_datas_present = false;
        result.pdf_note = 'No attachment with mimetype application/pdf found';
      }
    } catch(e) { result.pdf_datas_error = e.message; }
  }

  // 5. Si hay order_id, ver el campo account_move del pos.order
  if (order_id) {
    try {
      const order = await execute(url, db, uid, password,
        'pos.order', 'read', [[order_id]],
        { fields: ['name', 'state', 'account_move', 'account_move_ids'] }
      );
      result.pos_order = order[0] || null;
    } catch(e) { result.pos_order_error = e.message; }
  }

  return res.status(200).json(result);
};
