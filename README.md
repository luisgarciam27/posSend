# POSSend 📲

**Envío de comprobantes Odoo por WhatsApp desde el punto de venta.**

Aplicación web que permite a los vendedores enviar comprobantes electrónicos (facturas/boletas) por WhatsApp al cliente con un solo clic, directamente desde su sesión de POS en Odoo.

---

## Arquitectura

```
Vendedor → POSSend (Vercel) → n8n webhook → Odoo XML-RPC + Evolution API → WhatsApp cliente
```

- **Frontend:** HTML estático en Vercel (este repo)
- **Backend:** n8n en tu VPS (webhook orquestador)
- **Odoo:** Conexión via XML-RPC con API key
- **WhatsApp:** Evolution API en tu VPS

---

## Deploy en Vercel (5 minutos)

### 1. Clona y sube a GitHub

```bash
git init
git add .
git commit -m "init: POSSend app"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/possend.git
git push -u origin main
```

### 2. Conecta con Vercel

1. Ve a [vercel.com](https://vercel.com) → **New Project**
2. Importa el repo `possend` desde GitHub
3. Framework preset: **Other** (es HTML estático)
4. Clic en **Deploy**

✅ En 30 segundos tendrás una URL tipo `possend.vercel.app`

---

## Configuración inicial (solo una vez)

1. Abre la URL de Vercel
2. Clic en **"Panel admin"** (debajo del login de vendedor)
3. Contraseña por defecto: `admin1234` *(cámbiala en Seguridad)*
4. Configura:
   - URL de Odoo + base de datos + API key
   - URL del webhook de n8n
   - Empresa y puntos de venta

---

## Configuración del webhook n8n

Tu n8n debe responder a estos `action` via POST:

| action | Descripción | Respuesta esperada |
|---|---|---|
| `authenticate` | Verifica usuario/pass Odoo | `{ uid, name }` |
| `get_my_orders` | Órdenes POS del vendedor hoy | `[ { order_id, order_number, client, total, lines, ... } ]` |
| `send_whatsapp` | Envía PDF + mensaje al cliente | `{ ok: true }` |
| `test_connection` | Prueba conexión Odoo | `{ ok: true, version: "17.0" }` |

### Payload de `get_my_orders`

```json
{
  "action": "get_my_orders",
  "vendor_uid": 5,
  "vendor_name": "Carlos Rojas",
  "company_id": 1,
  "pos_ids": [2, 3],
  "url": "https://miempresa.odoo.com",
  "db": "mi_bd",
  "api_key": "***"
}
```

### Payload de `send_whatsapp`

```json
{
  "action": "send_whatsapp",
  "order_id": 2001,
  "order_number": "F001-00023",
  "client_name": "Empresa SAC",
  "client_phone": "51987654321",
  "total": 590.00,
  "currency": "PEN",
  "vendor_name": "Carlos Rojas",
  "company_id": 1,
  "message": "📄 *Comprobante de Pago*..."
}
```

---

## Estructura del proyecto

```
possend/
├── index.html      ← App completa (login + dashboard + admin)
├── vercel.json     ← Config de Vercel
├── .gitignore
└── README.md
```

---

## Notas de seguridad

- Las credenciales de Odoo **no se almacenan en el servidor** — solo en `localStorage` del navegador del admin
- El vendedor solo ingresa con su usuario/contraseña de Odoo
- Se recomienda agregar un **secret token** en el webhook de n8n
- Usar siempre HTTPS (Vercel lo incluye gratis)

---

## Próximos pasos

- [ ] Configurar webhook en n8n con los 4 actions
- [ ] Configurar Evolution API para envío de PDF
- [ ] Probar con datos reales de Odoo
- [ ] Compartir la URL con los vendedores
