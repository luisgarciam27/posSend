// api/config.js
// POST /api/config
// Trae las empresas y puntos de venta disponibles en Odoo.
// Usado por el panel admin para seleccionar empresa y POS sin saber los IDs.

const { authenticate, execute, cors, readBody } = require('./_odoo');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const url = process.env.ODOO_URL;
    const db  = process.env.ODOO_DB;

    if (!url || !db) return res.status(500).json({ error: 'ODOO_URL y ODOO_DB no configurados en Vercel' });

    // Leer credenciales admin del body (las ingresó en el panel)
    const { username, api_key } = await readBody(req);
    if (!username || !api_key) return res.status(400).json({ error: 'username y api_key requeridos' });

    // Autenticar con API key (no contraseña)
    const uid = await authenticate(url, db, username, api_key);

    // 1. Traer empresas a las que tiene acceso el admin
    const companies = await execute(url, db, uid, api_key,
      'res.company', 'search_read',
      [[]],
      { fields: ['id', 'name', 'vat', 'currency_id'], order: 'id asc' }
    );

    // 2. Traer configuraciones de POS (pos.config)
    const posConfigs = await execute(url, db, uid, api_key,
      'pos.config', 'search_read',
      [[['active', '=', true]]],
      {
        fields: ['id', 'name', 'company_id', 'current_session_id', 'current_session_state'],
        order: 'company_id asc, id asc'
      }
    );

    // Estructurar: agrupar POS por empresa
    const companiesMap = {};
    companies.forEach(c => {
      companiesMap[c.id] = {
        id:       c.id,
        name:     c.name,
        vat:      c.vat || '',
        currency: c.currency_id?.[1] || 'PEN',
        pos_list: []
      };
    });

    posConfigs.forEach(p => {
      const cid = p.company_id?.[0];
      if (companiesMap[cid]) {
        companiesMap[cid].pos_list.push({
          id:            p.id,
          name:          p.name,
          session_state: p.current_session_state || 'closed',
          session_open:  p.current_session_state === 'opened'
        });
      }
    });

    return res.status(200).json({
      companies: Object.values(companiesMap),
      total_pos: posConfigs.length
    });

  } catch (err) {
    console.error('[config]', err);
    const isAuth = err.message?.includes('incorrectas') || err.message?.includes('authenticate');
    return res.status(isAuth ? 401 : 500).json({ error: err.message });
  }
};
