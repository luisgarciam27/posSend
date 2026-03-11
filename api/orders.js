// api/orders.js
// POST /api/orders
// Retorna las órdenes POS del vendedor autenticado del turno actual.
// Versión corregida: filtros más permisivos, timezone Peru, mejor manejo de errores.

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

    // ── Fecha de hoy en hora Perú (UTC-5) ──────────────────────────────
    // Odoo guarda en UTC → el inicio del día en Lima es las 05:00 UTC
    const now      = new Date();
    const peruOffset = 5 * 60 * 60 * 1000;          // UTC-5 en ms
    const peruNow  = new Date(now.getTime() - peruOffset);
    const peruDate = peruNow.toISOString().slice(0, 10); // YYYY-MM-DD en hora Peru
    const startUtc = peruDate + ' 05:00:00';             // medianoche Lima en UTC

    // ── Dominio base ────────────────────────────────────────────────────
    // No filtramos por vendedor aquí — lo filtramos en JS después
    // para evitar incompatibilidades entre versiones de Odoo
    const domain = [
      ['state', 'in', ['done', 'invoiced', 'paid']],
      ['date_order', '>=', startUtc],
    ];

    // Filtrar por POS específicos si están configurados
    if (pos_ids && pos_ids.length) {
      domain.push(['config_id', 'in', pos_ids]);
    }

    // Filtrar por empresa
    if (company_id) {
      domain.push(['company_id', '=', company_id]);
    }

    console.log('[orders] domain:', JSON.stringify(domain));
    console.log('[orders] url:', url, 'db:', db, 'uid:', uid);

    // ── Buscar órdenes ──────────────────────────────────────────────────
    let orders = [];
    try {
      orders = await execute(url, db, uid, password, 'pos.order', 'search_read',
        [domain],
        {
          fields: [
            'name', 'date_order', 'state',
            'user_id',           // usuario que procesó la orden (Odoo 14+)
            'employee_id',       // empleado en sesión (Odoo 15+)
            'cashier',           // nombre cashier (algunos módulos)
            'partner_id',
            'amount_total',
            'amount_tax',
            'config_id',
            'session_id',
            'account_move',
            'lines',
          ],
          order: 'date_order desc',
          limit: 200,
        }
      );
    } catch (e) {
      // Si falla con employee_id u otros campos, reintentar con campos mínimos
      console.warn('[orders] full search failed, retrying minimal:', e.message);
      orders = await execute(url, db, uid, password, 'pos.order', 'search_read',
        [domain],
        {
          fields: ['name', 'date_order', 'state', 'user_id', 'partner_id',
                   'amount_total', 'amount_tax', 'config_id', 'session_id',
                   'account_move', 'lines'],
          order: 'date_order desc',
          limit: 200,
        }
      );
    }

    console.log('[orders] found:', orders.length, 'orders');

    // ── Filtrar por vendedor en JS ──────────────────────────────────────
    // user_id[0] debe coincidir con el uid del vendedor logueado
    // Si no hay ninguno con su uid → devolver todas (admin ve todo)
    const myOrders = orders.filter(o => {
      const orderUserId = o.user_id?.[0];
      return orderUserId === uid;
    });

    // Si no encontramos órdenes del usuario específico, devolver todas del POS
    // (puede pasar cuando el usuario es admin o la config de POS no asocia user)
    const finalOrders = myOrders.length > 0 ? myOrders : orders;
    console.log('[orders] filtered to:', finalOrders.length, '(mine:', myOrders.length, ')');

    // ── Líneas de detalle ───────────────────────────────────────────────
    const allLineIds = finalOrders.flatMap(o => o.lines || []);
    let linesMap = {};
    if (allLineIds.length) {
      try {
        const lines = await execute(url, db, uid, password, 'pos.order.line', 'read',
          [allLineIds],
          { fields: ['product_id', 'qty', 'price_unit', 'price_subtotal_incl', 'full_product_name'] }
        );
        lines.forEach(l => { linesMap[l.id] = l; });
      } catch (e) {
        console.warn('[orders] lines fetch failed:', e.message);
      }
    }

    // ── Teléfonos de clientes ───────────────────────────────────────────
    const partnerIds = [...new Set(finalOrders.map(o => o.partner_id?.[0]).filter(Boolean))];
    let partnerMap = {};
    if (partnerIds.length) {
      try {
        const partners = await execute(url, db, uid, password, 'res.partner', 'read',
          [partnerIds],
          { fields: ['name', 'phone', 'mobile', 'vat', 'email'] }
        );
        partners.forEach(p => {
          const raw   = p.mobile || p.phone || '';
          const clean = raw.replace(/\D/g, '');
          p.phone_whatsapp = (clean.length === 9 && !clean.startsWith('51')) ? '51' + clean : clean;
          partnerMap[p.id] = p;
        });
      } catch (e) {
        console.warn('[orders] partners fetch failed:', e.message);
      }
    }

    // ── Número de comprobante desde account.move ────────────────────────
    const moveIds = finalOrders.map(o => o.account_move?.[0]).filter(Boolean);
    let moveMap = {};
    if (moveIds.length) {
      try {
        const moves = await execute(url, db, uid, password, 'account.move', 'read',
          [moveIds],
          { fields: ['name', 'move_type', 'l10n_pe_edi_status', 'payment_state'] }
        );
        moves.forEach(m => { moveMap[m.id] = m; });
      } catch (e) {
        // l10n_pe_edi_status puede no existir en instalaciones sin módulo PE
        try {
          const moves = await execute(url, db, uid, password, 'account.move', 'read',
            [moveIds],
            { fields: ['name', 'move_type', 'payment_state'] }
          );
          moves.forEach(m => { moveMap[m.id] = m; });
        } catch (e2) {
          console.warn('[orders] moves fetch failed:', e2.message);
        }
      }
    }

    // ── Construir respuesta normalizada ─────────────────────────────────
    const result = finalOrders.map(o => {
      const partner = partnerMap[o.partner_id?.[0]] || null;
      const move    = moveMap[o.account_move?.[0]]  || null;

      const orderLines = (o.lines || []).map(id => {
        const l = linesMap[id];
        if (!l) return null;
        return {
          name:  l.full_product_name || l.product_id?.[1] || 'Producto',
          qty:   l.qty,
          price: l.price_unit,
          total: l.price_subtotal_incl,
        };
      }).filter(Boolean);

      // Estado de pago
      let payState = 'paid';
      if (move) {
        payState = move.payment_state || 'paid';
        // Renombrar para compatibilidad con el frontend
        if (payState === 'not_paid') payState = 'not_paid';
        if (o.state === 'invoiced')  payState = 'invoiced';
      }

      return {
        order_id:      o.id,
        name:          o.name,
        order_number:  move?.name || o.name,
        move_type:     move?.move_type || null,
        sunat_status:  move?.l10n_pe_edi_status || null,
        invoice_id:    o.account_move?.[0] || null,
        date_order:    o.date_order,
        state:         o.state,
        payment_state: payState,
        session_name:  o.session_id?.[1] || null,
        pos_name:      o.config_id?.[1]  || null,
        total:         o.amount_total,
        tax:           o.amount_tax,
        lines:         orderLines,
        vendor: {
          name: vendor_name || o.user_id?.[1] || 'Vendedor',
          uid:  uid,
        },
        client: partner ? {
          name:           partner.name,
          phone_whatsapp: partner.phone_whatsapp,
          ruc_dni:        partner.vat,
          email:          partner.email,
        } : {
          name:           o.partner_id?.[1] || 'Cliente anónimo',
          phone_whatsapp: '',
          ruc_dni:        null,
          email:          null,
        },
        // Debug info (útil para diagnóstico)
        _debug: {
          user_id_in_order: o.user_id?.[0],
          is_mine: o.user_id?.[0] === uid,
        }
      };
    });

    return res.status(200).json(result);

  } catch (err) {
    console.error('[orders] fatal:', err);
    return res.status(500).json({
      error: err.message,
      hint: 'Verifica que el usuario tenga acceso al módulo POS en Odoo'
    });
  }
};
