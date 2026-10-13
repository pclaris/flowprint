const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const { db, calcularTotales, aprobarCotizacion, sembrarCatalogoEmpresa, TABLAS_EMPRESA } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;


// Middlewares base (arriba de las rutas)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
// Solo se publican index.html y la carpeta assets (nunca la base de datos ni el código del servidor)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Crear carpeta uploads si no existe
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configurar almacenamiento de archivos
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const safeName = Date.now() + '-' + Math.round(Math.random() * 1E9) + ext;
    cb(null, safeName);
  }
});
const upload = multer({ storage });

// Servir archivos subidos
app.use('/uploads', express.static(uploadDir));

// Servir la página del formulario público
app.get('/form', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'form.html'));
});

// ===== CUENTAS DE EMPRESA =====
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
}
function verificarPassword(password, guardado) {
  if (!guardado) return false;
  if (!String(guardado).startsWith('scrypt$')) return String(password) === String(guardado);
  const [, salt, hash] = String(guardado).split('$');
  const calc = crypto.scryptSync(String(password), salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return ref.length === calc.length && crypto.timingSafeEqual(ref, calc);
}
function slugify(texto) {
  return String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'empresa';
}
function datosEmpresa(e) { return { id: e.id, nombre: e.nombre, email: e.email, slug: e.slug }; }
function crearSesionEmpresa(empresaId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sesiones_empresa (token, empresa_id, creado) VALUES (?, ?, ?)').run(token, empresaId, new Date().toISOString());
  return token;
}
function leerConfig(empresa) {
  try { return JSON.parse((empresa && empresa.config) || '{}'); } catch (e) { return {}; }
}
function empresaPublica(req) {
  const slug = String(req.query.e || (req.body && req.body.empresa) || '').trim().toLowerCase();
  if (slug) return db.prepare('SELECT * FROM empresas WHERE slug = ?').get(slug);
  const todas = db.prepare('SELECT * FROM empresas LIMIT 2').all();
  return todas.length === 1 ? todas[0] : null;
}

app.post('/api/empresas/registro', (req, res) => {
  try {
    const nombre = String(req.body.nombre || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!nombre || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Ingresa el nombre de la empresa y un correo válido.' });
    if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
    if (db.prepare('SELECT id FROM empresas WHERE email = ?').get(email)) return res.status(400).json({ error: 'Ya existe una empresa registrada con ese correo.' });

    let slug = slugify(nombre), n = 2;
    while (db.prepare('SELECT id FROM empresas WHERE slug = ?').get(slug)) slug = `${slugify(nombre)}-${n++}`;

    const empresa = db.transaction(() => {
      const esPrimera = db.prepare('SELECT COUNT(*) AS cant FROM empresas').get().cant === 0;
      let config = {};
      if (esPrimera) {
        try { config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config-empresa.json'), 'utf8')); } catch (e) {}
      }
      const id = db.prepare('INSERT INTO empresas (nombre, email, password, slug, config, creado) VALUES (?, ?, ?, ?, ?, ?)')
        .run(nombre, email, hashPassword(password), slug, JSON.stringify(config), new Date().toISOString()).lastInsertRowid;
      // La primera empresa se queda con los datos que ya existían antes del modo multi-empresa
      if (esPrimera) TABLAS_EMPRESA.forEach(t => db.prepare(`UPDATE ${t} SET empresa_id = ? WHERE empresa_id IS NULL`).run(id));
      sembrarCatalogoEmpresa(id);
      return db.prepare('SELECT * FROM empresas WHERE id = ?').get(id);
    })();

    res.json({ ok: true, token: crearSesionEmpresa(empresa.id), empresa: datosEmpresa(empresa) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/empresas/login', (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const empresa = db.prepare('SELECT * FROM empresas WHERE email = ?').get(email);
    if (!empresa || !verificarPassword(req.body.password, empresa.password)) {
      return res.status(401).json({ error: 'Correo o contraseña de empresa incorrectos.' });
    }
    res.json({ ok: true, token: crearSesionEmpresa(empresa.id), empresa: datosEmpresa(empresa) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Todas las demás rutas /api (menos las públicas) requieren la sesión de empresa
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/public/') || req.path === '/empresas/registro' || req.path === '/empresas/login') return next();
  const token = req.get('X-Empresa-Token');
  const empresa = token && db.prepare('SELECT e.* FROM sesiones_empresa s JOIN empresas e ON e.id = s.empresa_id WHERE s.token = ?').get(token);
  if (!empresa) return res.status(401).json({ error: 'Debes iniciar sesión con la cuenta de la empresa.', codigo: 'EMPRESA_NO_AUTENTICADA' });
  req.empresa = empresa;
  req.empresaId = empresa.id;
  next();
});

app.get('/api/empresas/sesion', (req, res) => res.json({ ok: true, empresa: datosEmpresa(req.empresa) }));

app.post('/api/empresas/logout', (req, res) => {
  db.prepare('DELETE FROM sesiones_empresa WHERE token = ?').run(req.get('X-Empresa-Token'));
  res.json({ ok: true });
});

// Configuración de empresa (logo, firma, datos PDF y tema de colores)
app.get('/api/config-empresa', (req, res) => {
  res.json(leerConfig(req.empresa));
});

app.put('/api/config-empresa', (req, res) => {
  try {
    const cfg = Object.assign(leerConfig(req.empresa), req.body || {});
    db.prepare('UPDATE empresas SET config = ? WHERE id = ?').run(JSON.stringify(cfg), req.empresaId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Catálogo público para el formulario (solo nombres, sin precios)
app.get('/api/public/catalogo', (req, res) => {
  try {
    const empresa = empresaPublica(req);
    if (!empresa) return res.status(404).json({ error: 'Empresa no encontrada' });
    const empresaId = empresa.id;
    const nombres = rows => Array.from(new Set(rows.map(r => String(r.nombre || '').trim()).filter(Boolean)));
    const productos = nombres(db.prepare('SELECT nombre FROM productos_precios WHERE empresa_id = ? ORDER BY nombre ASC').all(empresaId));
    const materialesM2 = nombres(db.prepare('SELECT nombre FROM materiales_precios WHERE empresa_id = ? ORDER BY nombre ASC').all(empresaId));
    const papeles = db.prepare('SELECT nombre, tamano_hoja, gramaje FROM papeles_precios WHERE empresa_id = ? ORDER BY nombre ASC, tamano_hoja ASC').all(empresaId)
      .map(p => `${String(p.nombre || '').trim()} (${p.tamano_hoja} - ${p.gramaje})`);
    const terminaciones = nombres(db.prepare('SELECT nombre FROM terminaciones_precios WHERE empresa_id = ? ORDER BY nombre ASC').all(empresaId));
    const cfg = leerConfig(empresa);
    res.json({ empresa: empresa.nombre, productos, materiales: Array.from(new Set([...materialesM2, ...papeles])), terminaciones, tema: cfg.tema || null, logoUrl: cfg.logoUrl || '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/public/solicitudes-form', upload.array('archivos', 5), (req, res) => {
  try {
    const d = req.body;
    const empresa = empresaPublica(req);
    if (!empresa) return res.status(404).json({ error: 'Empresa no encontrada. Revisa el link del formulario.' });
    const empresaId = empresa.id;
    const files = req.files || [];
    const rutasArchivos = files.map(f => `/uploads/${f.filename}`).join(', ');

    let clienteId = null;
    if (d.rut || d.nombre_empresa) {
      let clienteExistente = null;
      if (d.rut) {
        clienteExistente = db.prepare('SELECT id FROM clientes WHERE LOWER(rut) = LOWER(?) AND empresa_id = ?').get(d.rut.trim(), empresaId);
      }
      if (!clienteExistente && d.nombre_empresa) {
        clienteExistente = db.prepare('SELECT id FROM clientes WHERE LOWER(nombre_empresa) = LOWER(?) AND empresa_id = ?').get(d.nombre_empresa.trim(), empresaId);
      }

      if (clienteExistente) {
        clienteId = clienteExistente.id;
      } else {
        const insCli = db.prepare(`
          INSERT INTO clientes (nombre_empresa, nombre_contacto, email, telefono, direccion, rut, empresa_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          d.nombre_empresa || 'Cliente Web',
          d.nombre_contacto || '',
          d.email || '',
          d.telefono || '',
          d.direccion || '',
          d.rut || '',
          empresaId
        );
        clienteId = insCli.lastInsertRowid;
      }
    }

    let productos = [];
    try {
      productos = JSON.parse(d.especificaciones || '[]');
    } catch(e) {
      productos = [];
    }

    const nombresProductos = productos.map(p => p.producto).filter(Boolean).join(', ') || 'Varios';
    const totalCantidad = productos.reduce((acc, p) => acc + (parseInt(p.cantidad) || 0), 0) || 1;
    
    // Tratamiento seguro de cadenas sin fragmentar letras con comas
    const materialesStr = productos.map(p => {
      if (Array.isArray(p.materiales)) return p.materiales.join(' + ');
      return String(p.materiales || '');
    }).filter(Boolean).join(' | ');

    const terminacionesStr = productos.map(p => {
      if (Array.isArray(p.terminaciones)) return p.terminaciones.join(' + ');
      return String(p.terminaciones || '');
    }).filter(Boolean).join(' | ');

    const carasStr = productos.map(p => p.impresion || p.caras || '').filter(Boolean).join(' | ');

    let descripcionCompleta = d.descripcion_proyecto 
      ? `[PROYECTO]: ${d.descripcion_proyecto} | [INSP/IDEA]: ${d.idea_diseno || 'N/A'}` 
      : (d.idea_diseno ? `[INSP/IDEA]: ${d.idea_diseno}` : '[WEB FORM]');
    if (d.metodo_entrega) descripcionCompleta += ` | [ENTREGA]: ${d.metodo_entrega}`;

    const insSol = db.prepare(`
      INSERT INTO solicitudes (
        cliente_id, nombre_empresa, producto, cantidad, ancho, alto,
        unidad_medida, orientacion, material, terminaciones,
        impresion_caras_tintas, especificaciones, descripcion,
        archivo_url, fecha_requerida, empresa_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      clienteId,
      d.nombre_empresa || 'Cliente Web',
      nombresProductos,
      totalCantidad,
      parseFloat(productos[0]?.ancho) || 0,
      parseFloat(productos[0]?.alto) || 0,
      productos[0]?.unidad_medida || 'cm',
      productos[0]?.orientacion || 'Vertical',
      materialesStr,
      terminacionesStr,
      carasStr,
      d.especificaciones || '[]',
      descripcionCompleta,
      rutasArchivos || d.archivo_url || '',
      d.fecha_requerida || new Date().toISOString().split('T')[0],
      empresaId
    );

    res.json({ ok: true, id: insSol.lastInsertRowid });
  } catch (err) {
    console.error('Error procesando formulario público:', err);
    res.status(500).json({ error: err.message });
  }
});

// 1. USUARIOS
app.get('/api/usuarios', (req, res) => {
  try {
    res.json(db.prepare('SELECT id, usuario, nombre, icono, color FROM usuarios WHERE empresa_id = ? ORDER BY id ASC').all(req.empresaId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/usuarios/registro', (req, res) => {
  const { usuario, password, nombre, icono, color } = req.body;
  if (!usuario || !password) return res.status(400).json({ error: 'Faltan campos obligatorios' });
  try {
    const info = db.prepare('INSERT INTO usuarios (usuario, password, nombre, icono, color, empresa_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(usuario.trim().toLowerCase(), hashPassword(password), nombre || usuario, icono || 'cabeza-de-hombre.png', color || '#602453', req.empresaId);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) { res.status(400).json({ error: 'El usuario ya existe' }); }
});

app.post('/api/usuarios/login', (req, res) => {
  try {
    const fila = db.prepare('SELECT id, usuario, nombre, icono, color, password FROM usuarios WHERE usuario = ? AND empresa_id = ?')
      .get((req.body.usuario || '').trim().toLowerCase(), req.empresaId);
    if (!fila || !verificarPassword(req.body.password, fila.password)) return res.status(401).json({ error: 'Credenciales incorrectas' });
    if (!String(fila.password).startsWith('scrypt$')) {
      db.prepare('UPDATE usuarios SET password = ? WHERE id = ?').run(hashPassword(req.body.password), fila.id);
    }
    const { password, ...user } = fila;
    res.json({ ok: true, usuario: { ...user, empresa_id: req.empresaId } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/usuarios/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM usuarios WHERE id = ? AND empresa_id = ?').run(req.params.id, req.empresaId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. CLIENTES
app.get('/api/clientes', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM clientes WHERE empresa_id = ? ORDER BY id DESC').all(req.empresaId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clientes', (req, res) => {
  const d = req.body;
  if (!d.nombre_empresa) return res.status(400).json({ error: 'Empresa requerida' });
  try {
    const info = db.prepare('INSERT INTO clientes (nombre_empresa, nombre_contacto, email, telefono, rut, direccion, empresa_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(d.nombre_empresa.trim(), d.nombre_contacto || '', d.email || '', d.telefono || '', d.rut || '', d.direccion || '', req.empresaId);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/clientes', (req, res) => {
  try {
    const ids = req.body.ids || [];
    if (!ids.length) return res.json({ ok: true });
    const placeholders = ids.map(() => '?').join(',');
    
    const trans = db.transaction(() => {
      db.prepare(`UPDATE solicitudes SET cliente_id = NULL WHERE empresa_id = ? AND cliente_id IN (${placeholders})`).run(req.empresaId, ...ids);
      db.prepare(`DELETE FROM clientes WHERE empresa_id = ? AND id IN (${placeholders})`).run(req.empresaId, ...ids);
    });
    trans();
    res.json({ ok: true });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// 3. SOLICITUDES
app.get('/api/solicitudes', (req, res) => {
  try {
    const sols = db.prepare(`
      SELECT s.*, COALESCE(c.nombre_empresa, s.nombre_empresa, 'Cliente') as nombre_empresa, c.nombre_contacto, c.email, c.telefono, c.rut
      FROM solicitudes s 
      LEFT JOIN clientes c ON s.cliente_id = c.id
      WHERE s.empresa_id = ?
      ORDER BY s.id DESC
    `).all(req.empresaId);
    res.json(sols);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/solicitudes', (req, res) => {
  try {
    const d = req.body;
    let clienteId = d.cliente_id ? parseInt(d.cliente_id) : null;
    if (!clienteId && d.nombre_empresa) {
      let cl = db.prepare('SELECT id FROM clientes WHERE nombre_empresa = ? AND empresa_id = ?').get(d.nombre_empresa, req.empresaId);
      if (cl) clienteId = cl.id;
      else clienteId = db.prepare('INSERT INTO clientes (nombre_empresa, empresa_id) VALUES (?, ?)').run(d.nombre_empresa, req.empresaId).lastInsertRowid;
    }

    const info = db.prepare(`
      INSERT INTO solicitudes (
        cliente_id, nombre_empresa, producto, descripcion, cantidad, ancho, alto, unidad_medida,
        orientacion, material, gramaje, impresion_caras_tintas, sistema_impresion,
        terminaciones, especificaciones, fecha_requerida, archivo_url, empresa_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      clienteId, d.nombre_empresa || '', d.producto || 'Producto', d.descripcion || '', parseInt(d.cantidad) || 1,
      parseFloat(d.ancho) || 0, parseFloat(d.alto) || 0, d.unidad_medida || 'cm', d.orientacion || 'Vertical',
      d.material || '', d.gramaje || '', d.impresion || '', d.sistema_impresion || '',
      d.terminaciones || '', d.especificaciones || '', d.fecha_requerida || new Date().toISOString().split('T')[0],
      d.archivo_url || '', req.empresaId
    );
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/solicitudes/:id', (req, res) => {
  try {
    const d = req.body;
    const solId = parseInt(req.params.id);
    let clienteId = d.cliente_id ? parseInt(d.cliente_id) : null;
    if (!clienteId && d.nombre_empresa) {
      let cl = db.prepare('SELECT id FROM clientes WHERE nombre_empresa = ? AND empresa_id = ?').get(d.nombre_empresa, req.empresaId);
      if (cl) clienteId = cl.id;
      else clienteId = db.prepare('INSERT INTO clientes (nombre_empresa, empresa_id) VALUES (?, ?)').run(d.nombre_empresa, req.empresaId).lastInsertRowid;
    }

    db.prepare(`
      UPDATE solicitudes SET
        cliente_id = ?, nombre_empresa = ?, producto = ?, cantidad = ?, ancho = ?, alto = ?,
        unidad_medida = ?, orientacion = ?, material = ?, impresion_caras_tintas = ?,
        terminaciones = ?, especificaciones = ?, fecha_requerida = ?
      WHERE id = ? AND empresa_id = ?
    `).run(
      clienteId, d.nombre_empresa || '', d.producto || 'Producto', parseInt(d.cantidad) || 1, parseFloat(d.ancho) || 0,
      parseFloat(d.alto) || 0, d.unidad_medida || 'cm', d.orientacion || 'Vertical', d.material || '',
      d.impresion || '', d.terminaciones || '', d.especificaciones || '',
      d.fecha_requerida || new Date().toISOString().split('T')[0], solId, req.empresaId
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/solicitudes', (req, res) => {
  try {
    const ids = req.body.ids || [];
    if (!ids.length) return res.json({ ok: true });
    const placeholders = ids.map(() => '?').join(',');

    const trans = db.transaction(() => {
      db.prepare(`UPDATE cotizaciones SET solicitud_id = NULL WHERE empresa_id = ? AND solicitud_id IN (${placeholders})`).run(req.empresaId, ...ids);
      db.prepare(`DELETE FROM solicitudes WHERE empresa_id = ? AND id IN (${placeholders})`).run(req.empresaId, ...ids);
    });
    trans();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. PRECIOS
app.get('/api/materiales', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM materiales_precios WHERE empresa_id = ? ORDER BY nombre ASC').all(req.empresaId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/materiales', (req, res) => {
  try {
    const nombre = req.body.nombre.trim();
    const precio = parseFloat(req.body.precio_m2) || 0;
    const existente = db.prepare('SELECT id FROM materiales_precios WHERE LOWER(nombre) = LOWER(?) AND empresa_id = ?').get(nombre, req.empresaId);
    
    if (existente) {
      db.prepare('UPDATE materiales_precios SET precio_m2 = ? WHERE id = ? AND empresa_id = ?').run(precio, existente.id, req.empresaId);
    } else {
      db.prepare('INSERT INTO materiales_precios (nombre, precio_m2, empresa_id) VALUES (?, ?, ?)').run(nombre, precio, req.empresaId);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/materiales/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM materiales_precios WHERE id = ? AND empresa_id = ?').run(req.params.id, req.empresaId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/papeles', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM papeles_precios WHERE empresa_id = ? ORDER BY nombre ASC, tamano_hoja ASC').all(req.empresaId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/papeles', (req, res) => {
  const { nombre, tamano_hoja, gramaje, precio_hoja, ancho_hoja, alto_hoja } = req.body;
  try {
    const nom = nombre.trim();
    const tam = tamano_hoja || 'A3';
    const gra = gramaje || '250 g';
    const precio = parseFloat(precio_hoja) || 0;
    
    const existente = db.prepare(`
      SELECT id FROM papeles_precios 
      WHERE LOWER(nombre) = LOWER(?) AND LOWER(tamano_hoja) = LOWER(?) AND LOWER(gramaje) = LOWER(?) AND empresa_id = ?
    `).get(nom, tam, gra, req.empresaId);

    if (existente) {
      db.prepare('UPDATE papeles_precios SET precio_hoja = ?, ancho_hoja = ?, alto_hoja = ? WHERE id = ? AND empresa_id = ?')
        .run(precio, parseFloat(ancho_hoja) || 29.7, parseFloat(alto_hoja) || 42.0, existente.id, req.empresaId);
    } else {
      db.prepare(`
        INSERT INTO papeles_precios (nombre, tamano_hoja, gramaje, precio_hoja, ancho_hoja, alto_hoja, empresa_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(nom, tam, gra, precio, parseFloat(ancho_hoja) || 29.7, parseFloat(alto_hoja) || 42.0, req.empresaId);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/papeles/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM papeles_precios WHERE id = ? AND empresa_id = ?').run(req.params.id, req.empresaId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/terminaciones', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM terminaciones_precios WHERE empresa_id = ? ORDER BY nombre ASC').all(req.empresaId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/terminaciones', (req, res) => {
  try {
    const nombre = req.body.nombre.trim();
    const precio = parseFloat(req.body.precio) || 0;
    const existente = db.prepare('SELECT id FROM terminaciones_precios WHERE LOWER(nombre) = LOWER(?) AND empresa_id = ?').get(nombre, req.empresaId);
    
    if (existente) {
      db.prepare('UPDATE terminaciones_precios SET precio = ? WHERE id = ? AND empresa_id = ?').run(precio, existente.id, req.empresaId);
    } else {
      db.prepare('INSERT INTO terminaciones_precios (nombre, precio, empresa_id) VALUES (?, ?, ?)').run(nombre, precio, req.empresaId);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/terminaciones/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM terminaciones_precios WHERE id = ? AND empresa_id = ?').run(req.params.id, req.empresaId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4.1 PRODUCTOS PRECIOS UNITARIOS
app.get('/api/productos-precios', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM productos_precios WHERE empresa_id = ? ORDER BY nombre ASC').all(req.empresaId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/productos-precios', (req, res) => {
  try {
    const nombre = req.body.nombre.trim();
    const precio = parseFloat(req.body.precio_unitario) || 0;
    const existente = db.prepare('SELECT id FROM productos_precios WHERE LOWER(nombre) = LOWER(?) AND empresa_id = ?').get(nombre, req.empresaId);
    
    if (existente) {
      db.prepare('UPDATE productos_precios SET precio_unitario = ? WHERE id = ? AND empresa_id = ?').run(precio, existente.id, req.empresaId);
    } else {
      db.prepare('INSERT INTO productos_precios (nombre, precio_unitario, empresa_id) VALUES (?, ?, ?)').run(nombre, precio, req.empresaId);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/productos-precios/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM productos_precios WHERE id = ? AND empresa_id = ?').run(req.params.id, req.empresaId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. COTIZACIONES
app.get('/api/cotizaciones', (req, res) => {
  try {
    const list = db.prepare(`
      SELECT 
        c.*,
        c.precio_material,
        c.precio_impresion,
        c.precio_terminaciones,
        c.precio_diseno,
        c.precio_despacho,
        s.producto, s.descripcion, s.especificaciones, s.cantidad
      FROM cotizaciones c
      LEFT JOIN solicitudes s ON c.solicitud_id = s.id
      WHERE c.empresa_id = ?
      ORDER BY c.id DESC
    `).all(req.empresaId);
    res.json(list);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cotizaciones', (req, res) => {
  try {
    const d = req.body;
    const pMat = parseFloat(d.precio_material ?? d.precios?.material ?? 0) || 0;
    const pImp = parseFloat(d.precio_impresion ?? d.precios?.impresion ?? 0) || 0;
    const pTerm = parseFloat(d.precio_terminaciones ?? d.precios?.terminaciones ?? 0) || 0;
    const pDis = parseFloat(d.precio_diseno ?? d.precios?.diseno ?? 0) || 0;
    const pDesp = parseFloat(d.precio_despacho ?? d.precios?.despacho ?? 0) || 0;

    const preciosLimpios = { material: pMat, impresion: pImp, terminaciones: pTerm, diseno: pDis, despacho: pDesp };
    const t = calcularTotales(preciosLimpios, d.descuento || 0);
    const hoy = d.fecha_creacion || new Date().toISOString().split('T')[0];

    const info = db.prepare(`
      INSERT INTO cotizaciones (
        solicitud_id, nombre_guardado, cliente_txt, precio_material, precio_impresion,
        precio_terminaciones, precio_diseno, precio_despacho, descuento, subtotal,
        neto, iva, total, fecha_creacion, empresa_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      (d.solicitud_id && db.prepare('SELECT id FROM solicitudes WHERE id = ? AND empresa_id = ?').get(d.solicitud_id, req.empresaId)) ? d.solicitud_id : null, d.nombre_guardado || 'Cotización', d.cliente_txt || 'Cliente',
      pMat, pImp, pTerm, pDis, pDesp, t.descuento, t.subtotal, t.neto,
      t.iva, t.total, hoy, req.empresaId
    );

    res.json({ 
      id: info.lastInsertRowid, 
      ...t, 
      precio_material: pMat,
      precio_impresion: pImp,
      precio_terminaciones: pTerm,
      precio_diseno: pDis,
      precio_despacho: pDesp,
      precios: preciosLimpios,
      fecha_creacion: hoy 
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/cotizaciones/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM cotizaciones WHERE id = ? AND empresa_id = ?').run(req.params.id, req.empresaId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/cotizaciones/:id/aprobar', (req, res) => {
  try { res.json(aprobarCotizacion(parseInt(req.params.id), req.empresaId)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// 6. ÓRDENES DE TRABAJO
app.get('/api/ots', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM ordenes_trabajo WHERE empresa_id = ? ORDER BY id DESC').all(req.empresaId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/ots/:id', (req, res) => {
  try {
    const campo = String(req.body.campo || '');
    const columnas = db.prepare('PRAGMA table_info(ordenes_trabajo)').all().map(c => c.name).filter(c => c !== 'id' && c !== 'empresa_id');
    if (!columnas.includes(campo)) return res.status(400).json({ error: 'Campo inválido' });
    db.prepare(`UPDATE ordenes_trabajo SET ${campo} = ? WHERE id = ? AND empresa_id = ?`).run(req.body.valor, req.params.id, req.empresaId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/ots', (req, res) => {
  try {
    const ids = req.body.ids || [];
    if (!ids.length) return res.json({ ok: true });
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM ordenes_trabajo WHERE empresa_id = ? AND id IN (${placeholders})`).run(req.empresaId, ...ids);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Inicio del servidor
app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});