// api/auth.js
// POST /api/auth
// Autentica al vendedor usando sus credenciales de Odoo.
// Retorna: { uid, name, company_id, company_name }

const { authenticate, execute, version, cors, readBody } = require('./_odoo');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { username, password } = await readBody(req);

    // Las credenciales de conexión Odoo vienen de variables de entorno (configuradas en Vercel)
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

    // 2. Obtener datos del usuario (nombre, empresa)
    const [userInfo] = await execute(
      url, db, uid, password,   // ← usa la contraseña como "api_key" aquí
      'res.users', 'read',
      [[uid]],
      { fields: ['name', 'company_id', 'company_ids'] }
    );

    return res.status(200).json({
      uid,
      name:         userInfo.name,
      company_id:   userInfo.company_id?.[0] || null,
      company_name: userInfo.company_id?.[1] || null,
    });

  } catch (err) {
    const msg = err.message || 'Error de autenticación';
    const isAuth = msg.includes('incorrectas') || msg.includes('authenticate');
    return res.status(isAuth ? 401 : 500).json({ error: msg });
  }
};
