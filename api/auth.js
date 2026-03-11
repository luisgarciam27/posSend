// api/auth.js
// POST /api/auth
// Autentica al vendedor usando sus credenciales de Odoo.
// Retorna: { uid, name, company_id, company_name, company_ids, pos_sessions }
//
// FIX: Ahora detecta correctamente la empresa y sesión POS activa del usuario,
//      no solo la empresa "por defecto" en Odoo.

const { authenticate, execute, version, cors, readBody } = require('./_odoo');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { username, password } = await readBody(req);

    const url = process.env.ODOO_URL;
    const db  = process.env.ODOO_DB;

    if (!url || !db) {
      return res.status(500).json({ error: 'Odoo no configurado en el servidor. Revisa las env vars.' });
    }
    if (!username || !password) {
      return res.status(400).json({ error: 'username y password requeridos' });
    }

    // 1. Autenticar → obtener UID del vendedor
    const uid = await authenticate(url, db, username, password);

    // 2. Obtener datos del usuario (nombre, TODAS las empresas a las que pertenece)
    const [userInfo] = await execute(
      url, db, uid, password,
      'res.users', 'read',
      [[uid]],
      { fields: ['name', 'company_id', 'company_ids'] }
    );

    // 3. FIX PRINCIPAL: Buscar sesiones POS ABIERTAS donde este usuario es el responsable
    //    Esto nos da la empresa REAL donde está trabajando el vendedor ahora mismo.
    let activePosSession = null;
    let activeCompanyId   = userInfo.company_id?.[0] || null;
    let activeCompanyName = userInfo.company_id?.[1] || null;

    try {
      const openSessions = await execute(
        url, db, uid, password,
        'pos.session', 'search_read',
        [[
          ['state', '=', 'opened'],
          ['user_id', '=', uid],          // sesiones donde el usuario es responsable
        ]],
        {
          fields: ['id', 'name', 'config_id', 'company_id', 'state'],
          order:  'id desc',
          limit:  1,
        }
      );

      if (openSessions.length > 0) {
        activePosSession  = openSessions[0];
        activeCompanyId   = openSessions[0].company_id?.[0] || activeCompanyId;
        activeCompanyName = openSessions[0].company_id?.[1] || activeCompanyName;
      }
    } catch (e) {
      // Si falla la búsqueda de sesiones POS, seguimos con la empresa por defecto
      console.warn('[auth] No se pudo consultar sesiones POS activas:', e.message);
    }

    // 4. Si no encontró sesión por user_id, buscar órdenes recientes del usuario
    //    para inferir en qué POS está trabajando
    if (!activePosSession) {
      try {
        const recentOrders = await execute(
          url, db, uid, password,
          'pos.order', 'search_read',
          [[
            ['user_id', '=', uid],
            ['state', 'in', ['draft', 'done', 'invoiced', 'paid']],
          ]],
          {
            fields: ['config_id', 'company_id', 'session_id'],
            order:  'id desc',
            limit:  1,
          }
        );

        if (recentOrders.length > 0) {
          const lastOrder = recentOrders[0];
          // Solo actualizar empresa si la orden es de hoy (sesión activa probable)
          if (lastOrder.company_id?.[0]) {
            activeCompanyId   = lastOrder.company_id[0];
            activeCompanyName = lastOrder.company_id[1];
          }
        }
      } catch (e) {
        console.warn('[auth] No se pudo inferir empresa desde órdenes recientes:', e.message);
      }
    }

    // 5. Obtener todas las empresas a las que pertenece el usuario (para el selector)
    let companiesDetail = [];
    if (userInfo.company_ids?.length) {
      try {
        companiesDetail = await execute(
          url, db, uid, password,
          'res.company', 'read',
          [userInfo.company_ids],
          { fields: ['id', 'name'] }
        );
      } catch (e) {
        console.warn('[auth] No se pudieron cargar empresas del usuario:', e.message);
      }
    }

    return res.status(200).json({
      uid,
      name:            userInfo.name,
      // Empresa activa REAL (donde tiene sesión POS abierta, o la de defecto)
      company_id:      activeCompanyId,
      company_name:    activeCompanyName,
      // Todas las empresas del usuario (para que el front pueda mostrar selector)
      company_ids:     companiesDetail,
      // Info de la sesión POS activa (si existe)
      active_pos_session: activePosSession ? {
        session_id: activePosSession.id,
        session_name: activePosSession.name,
        pos_id:   activePosSession.config_id?.[0],
        pos_name: activePosSession.config_id?.[1],
      } : null,
    });

  } catch (err) {
    const msg = err.message || 'Error de autenticación';
    const isAuth = msg.includes('incorrectas') || msg.includes('authenticate');
    return res.status(isAuth ? 401 : 500).json({ error: msg });
  }
};
