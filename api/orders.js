// api/orders.js
// POST /api/orders
// Retorna las órdenes POS del vendedor autenticado del turno actual.

const { authenticate, execute, cors, readBody } = require('./_odoo');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { uid, password, vendor_name, company_id, pos_ids } = await readBody(req);

    const url = process.env.ODOO_URL;
    const db  = process.env.ODOO_DB;

    if (!url || !db) return res.status(500).json({ error: 'Odoo no configurado' });
    if (!uid || !password) return res.status(401).json({ error: 'uid y password requeridos' });

    // Fecha de hoy (inicio del día en UTC-5 Perú)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Odoo guarda en UTC → ajustar +5h para cubrir todo el día peruano
    const todayUtc = new Date(today.getTime() - 5 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    // Dominio de búsqueda en pos.order
    const domain = [
      ['state', 'in', ['done', 'invoiced']],   // solo órdenes completadas
      ['date_order', '>=', todayUtc],           // del día de hoy
    ];

    // Si hay POS específicos configurados, filtrar por ellos
    if (pos_ids && pos_ids.length) {
      domain.push(['config_id', 'in', pos_ids]);
    }

    // Si hay empresa configurada
    if (company_id) {
      domain.push(['company_id', '=', company_id]);
    }

    // Buscar órdenes (el vendedor ve solo las suyas mediante employee_id o user_id)
    // En Odoo POS el campo es: employee_id o cashier_id según la versión
    domain.push(['employee_id.user_id', '=', uid]);
    // Fallback si no usa employee: también checar user_id directo
    // (en Odoo 17 es employee_id, en 14-16 puede ser cashier_id)

    let orders = [];
    try {
      orders = await execute(url, db, uid, password, 'pos.order', 'search_read',
        [domain],
        {
          fields: [
            'name', 'date_order', 'state',
            'employee_id',       // vendedor
            'partner_id',        // cliente
            'amount_total',      // total con IGV
            'amount_tax',        // IGV
            'config_id',         // POS config
            'session_id',        // sesión POS
            'account_move',      // factura vinculada (si está facturado)
            'lines',             // líneas de la orden
            'payment_ids',       // pagos
          ],
          order: 'date_order desc',
          limit: 100,
        }
      );
    } catch (e) {
      // Fallback: sin filtro por employee (Odoo con config diferente)
      const domainFallback = domain.filter(d => d[0] !== 'employee_id.user_id');
      domainFallback.push(['user_id', '=', uid]);
      orders = await execute(url, db, uid, password, 'pos.order', 'search_read',
        [domainFallback],
        { fields: ['name','date_order','state','partner_id','amount_total','amount_tax','config_id','session_id','account_move','lines'], order:'date_order desc', limit:100 }
      );
    }

    // Obtener líneas de detalle para cada orden
    const allLineIds = orders.flatMap(o => o.lines || []);
    let linesMap = {};
    if (allLineIds.length) {
      const lines = await execute(url, db, uid, password, 'pos.order.line', 'read',
        [allLineIds],
        { fields: ['product_id', 'qty', 'price_unit', 'price_subtotal_incl'] }
      );
      lines.forEach(l => { linesMap[l.id] = l; });
    }

    // Obtener teléfonos de los partners
    const partnerIds = [...new Set(orders.map(o => o.partner_id?.[0]).filter(Boolean))];
    let partnerMap = {};
    if (partnerIds.length) {
      const partners = await execute(url, db, uid, password, 'res.partner', 'read',
        [partnerIds],
        { fields: ['name', 'phone', 'mobile', 'vat', 'email'] }
      );
      partners.forEach(p => {
        const raw = p.mobile || p.phone || '';
        const clean = raw.replace(/\D/g, '');
        p.phone_whatsapp = (clean.length === 9 && !clean.startsWith('51')) ? '51' + clean : clean;
        partnerMap[p.id] = p;
      });
    }

    // Obtener número de comprobante (account.move) si está facturado
    const moveIds = orders.map(o => o.account_move?.[0]).filter(Boolean);
    let moveMap = {};
    if (moveIds.length) {
      const moves = await execute(url, db, uid, password, 'account.move', 'read',
        [moveIds],
        { fields: ['name', 'move_type', 'l10n_pe_edi_status'] }
      );
      moves.forEach(m => { moveMap[m.id] = m; });
    }

    // Construir respuesta normalizada
    const result = orders.map(o => {
      const partner  = partnerMap[o.partner_id?.[0]] || null;
      const move     = moveMap[o.account_move?.[0]]  || null;
      const orderLines = (o.lines || []).map(id => {
        const l = linesMap[id];
        if (!l) return null;
        return {
          name:  l.product_id?.[1] || 'Producto',
          qty:   l.qty,
          price: l.price_unit,
          total: l.price_subtotal_incl,
        };
      }).filter(Boolean);

      return {
        order_id:      o.id,
        name:          o.name,
        order_number:  move?.name || o.name,
        move_type:     move?.move_type || null,
        sunat_status:  move?.l10n_pe_edi_status || null,
        date_order:    o.date_order,
        state:         o.state,
        payment_state: move ? 'invoiced' : (o.state === 'done' ? 'paid' : 'not_paid'),
        session_name:  o.session_id?.[1] || null,
        pos_name:      o.config_id?.[1]  || null,
        total:         o.amount_total,
        tax:           o.amount_tax,
        lines:         orderLines,
        vendor: {
          name: vendor_name,
          uid:  uid,
        },
        client: partner ? {
          name:           partner.name,
          phone_whatsapp: partner.phone_whatsapp,
          ruc_dni:        partner.vat,
          email:          partner.email,
        } : {
          name:           'Cliente anónimo',
          phone_whatsapp: '',
          ruc_dni:        null,
          email:          null,
        },
      };
    });

    return res.status(200).json(result);

  } catch (err) {
    console.error('[orders]', err);
    return res.status(500).json({ error: err.message });
  }
};
