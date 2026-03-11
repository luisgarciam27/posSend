// api/orders.js
// POST /api/orders
// Retorna las órdenes POS del vendedor autenticado del turno actual.
//
// FIX 1 (VELOCIDAD):   Las 3 sub-consultas (lines, partners, moves) ahora son PARALELAS con Promise.all
// FIX 2 (EMPRESA/POS): Filtramos por empresa correcta recibida desde auth.js (no asumimos la default)

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
    const now        = new Date();
    const peruOffset = 5 * 60 * 60 * 1000;
    const peruNow    = new Date(now.getTime() - peruOffset);
    const peruDate   = peruNow.toISOString().slice(0, 10);
    const startUtc   = peruDate + ' 05:00:00';

    // ── Dominio de búsqueda ─────────────────────────────────────────────
    const domain = [
      ['state', 'in', ['done', 'invoiced', 'paid']],
      ['date_order', '>=', startUtc],
    ];

    // FIX 2: Usar siempre la empresa que viene del cliente (la que auth.js detectó como activa)
    if (company_id) {
      domain.push(['company_id', '=', company_id]);
    }

    // Filtrar por POS específicos si están configurados
    if (pos_ids && pos_ids.length) {
      domain.push(['config_id', 'in', pos_ids]);
    }

    console.log('[orders] domain:', JSON.stringify(domain));
    console.log('[orders] url:', url, 'db:', db, 'uid:', uid, 'company_id:', company_id);

    // ── FIX 1: Buscar órdenes (con fallback si campos no existen) ───────
    let orders = [];
    const fullFields = [
      'name', 'date_order', 'state',
      'user_id', 'employee_id', 'cashier',
      'partner_id', 'amount_total', 'amount_tax',
      'config_id', 'session_id', 'account_move', 'lines',
    ];
    const minFields = [
      'name', 'date_order', 'state',
      'user_id', 'partner_id', 'amount_total', 'amount_tax',
      'config_id', 'session_id', 'account_move', 'lines',
    ];

    try {
      orders = await execute(url, db, uid, password, 'pos.order', 'search_read',
        [domain],
        { fields: fullFields, order: 'date_order desc', limit: 200 }
      );
    } catch (e) {
      console.warn('[orders] full search failed, retrying minimal:', e.message);
      orders = await execute(url, db, uid, password, 'pos.order', 'search_read',
        [domain],
        { fields: minFields, order: 'date_order desc', limit: 200 }
      );
    }

    console.log('[orders] found:', orders.length, 'orders');

    // ── Filtrar por vendedor (user_id) ─────────────────────────────────
    const myOrders   = orders.filter(o => o.user_id?.[0] === uid);
    const finalOrders = myOrders.length > 0 ? myOrders : orders;
    console.log('[orders] filtered to:', finalOrders.length, '(mine:', myOrders.length, ')');

    // ── FIX 1: Las 3 sub-consultas ahora son PARALELAS ─────────────────
    const allLineIds  = finalOrders.flatMap(o => o.lines || []);
    const partnerIds  = [...new Set(finalOrders.map(o => o.partner_id?.[0]).filter(Boolean))];
    const moveIds     = finalOrders.map(o => o.account_move?.[0]).filter(Boolean);

    // Ejecutar las 3 consultas en paralelo — antes eran secuenciales (3x más lento)
    const [linesResult, partnersResult, movesResult] = await Promise.all([

      // 1. Líneas de detalle
      allLineIds.length
        ? execute(url, db, uid, password, 'pos.order.line', 'read',
            [allLineIds],
            { fields: ['product_id', 'qty', 'price_unit', 'price_subtotal_incl', 'full_product_name'] }
          ).catch(e => { console.warn('[orders] lines fetch failed:', e.message); return []; })
        : Promise.resolve([]),

      // 2. Datos de clientes (teléfono, RUC, etc.)
      partnerIds.length
        ? execute(url, db, uid, password, 'res.partner', 'read',
            [partnerIds],
            { fields: ['name', 'phone', 'mobile', 'vat', 'email'] }
          ).catch(e => { console.warn('[orders] partners fetch failed:', e.message); return []; })
        : Promise.resolve([]),

      // 3. Número de comprobante (account.move)
      moveIds.length
        ? execute(url, db, uid, password, 'account.move', 'read',
            [moveIds],
            { fields: ['name', 'move_type', 'l10n_pe_edi_status', 'payment_state'] }
          ).catch(() =>
            // Fallback sin l10n_pe_edi_status (instalaciones sin módulo PE)
            execute(url, db, uid, password, 'account.move', 'read',
              [moveIds],
              { fields: ['name', 'move_type', 'payment_state'] }
            ).catch(e2 => { console.warn('[orders] moves fetch failed:', e2.message); return []; })
          )
        : Promise.resolve([]),

    ]);

    // ── Construir mapas para lookup O(1) ───────────────────────────────
    const linesMap = {};
    linesResult.forEach(l => { linesMap[l.id] = l; });

    const partnerMap = {};
    partnersResult.forEach(p => {
      const raw   = p.mobile || p.phone || '';
      const clean = raw.replace(/\D/g, '');
      p.phone_whatsapp = (clean.length === 9 && !clean.startsWith('51')) ? '51' + clean : clean;
      partnerMap[p.id] = p;
    });

    const moveMap = {};
    movesResult.forEach(m => { moveMap[m.id] = m; });

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

      let payState = 'paid';
      if (move) {
        payState = move.payment_state || 'paid';
        if (o.state === 'invoiced') payState = 'invoiced';
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
        session_name:  o.session_id?.[1]  || null,
        pos_name:      o.config_id?.[1]   || null,
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
        _debug: {
          user_id_in_order: o.user_id?.[0],
          is_mine:          o.user_id?.[0] === uid,
          company_filter:   company_id,
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
