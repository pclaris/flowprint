const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'taller.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    nombre TEXT NOT NULL,
    icono TEXT DEFAULT 'cabeza-de-hombre.png',
    color TEXT DEFAULT '#602453'
  );

  CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre_empresa TEXT NOT NULL,
    nombre_contacto TEXT,
    email TEXT,
    telefono TEXT,
    rut TEXT,
    direccion TEXT
  );

  CREATE TABLE IF NOT EXISTS solicitudes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER,
    nombre_empresa TEXT,
    producto TEXT,
    descripcion TEXT,
    cantidad INTEGER DEFAULT 1,
    ancho REAL DEFAULT 0,
    alto REAL DEFAULT 0,
    unidad_medida TEXT DEFAULT 'cm',
    orientacion TEXT DEFAULT 'Vertical',
    material TEXT,
    gramaje TEXT,
    impresion_caras_tintas TEXT,
    sistema_impresion TEXT,
    terminaciones TEXT,
    especificaciones TEXT,
    fecha_requerida TEXT,
    archivo_url TEXT,
    estado TEXT DEFAULT 'Pendiente',
    FOREIGN KEY(cliente_id) REFERENCES clientes(id)
  );

  CREATE TABLE IF NOT EXISTS materiales_precios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT UNIQUE NOT NULL,
    precio_m2 REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS papeles_precios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    tamano_hoja TEXT NOT NULL DEFAULT 'A3',
    gramaje TEXT NOT NULL DEFAULT '250 g',
    precio_hoja REAL NOT NULL,
    ancho_hoja REAL DEFAULT 29.7,
    alto_hoja REAL DEFAULT 42.0
  );

  CREATE TABLE IF NOT EXISTS terminaciones_precios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT UNIQUE NOT NULL,
    precio REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cotizaciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    solicitud_id INTEGER,
    nombre_guardado TEXT,
    cliente_txt TEXT,
    precio_material REAL DEFAULT 0,
    precio_impresion REAL DEFAULT 0,
    precio_terminaciones REAL DEFAULT 0,
    precio_diseno REAL DEFAULT 0,
    precio_despacho REAL DEFAULT 0,
    descuento REAL DEFAULT 0,
    subtotal REAL DEFAULT 0,
    neto REAL DEFAULT 0,
    iva REAL DEFAULT 0,
    total REAL DEFAULT 0,
    fecha_creacion TEXT,
    FOREIGN KEY(solicitud_id) REFERENCES solicitudes(id)
  );

  CREATE TABLE IF NOT EXISTS ordenes_trabajo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero_ot INTEGER,
    codigo_ot TEXT,
    cliente TEXT,
    solicitud TEXT,
    estado_pedido TEXT DEFAULT 'Pendiente',
    prioridad TEXT DEFAULT 'Media',
    fecha_creacion TEXT,
    fecha_entrega TEXT,
    responsable TEXT,
    producto TEXT,
    descripcion TEXT,
    cantidad INTEGER DEFAULT 1,
    medidas TEXT,
    unidad_medida TEXT,
    orientacion TEXT,
    material TEXT,
    gramaje TEXT,
    impresion TEXT,
    sistema_impresion TEXT,
    terminaciones TEXT,
    especificaciones TEXT,
    fecha_requerida TEXT,
    archivo TEXT,
    maquina TEXT,
    operador TEXT,
    cantidad_producida INTEGER DEFAULT 0,
    resultado_calidad TEXT DEFAULT 'Pendiente',
    observaciones TEXT,
    metodo_entrega TEXT,
    fecha_entrega_real TEXT,
    cantidad_entregada INTEGER DEFAULT 0,
    subtotal REAL DEFAULT 0,
    iva REAL DEFAULT 0,
    total REAL DEFAULT 0,
    entrega_confirmada TEXT DEFAULT 'No'
  );

  CREATE TABLE IF NOT EXISTS productos_precios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT UNIQUE NOT NULL,
    precio_unitario REAL NOT NULL
  );
`);

function asegurarColumna(tabla, columna, tipoDef) {
  try {
    const columnas = db.prepare(`PRAGMA table_info(${tabla})`).all();
    if (!columnas.some(c => c.name.toLowerCase() === columna.toLowerCase())) {
      db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${tipoDef};`);
    }
  } catch (err) {}
}

asegurarColumna('clientes', 'rut', 'TEXT');
asegurarColumna('solicitudes', 'nombre_empresa', 'TEXT');
asegurarColumna('solicitudes', 'especificaciones', 'TEXT');
asegurarColumna('cotizaciones', 'nombre_guardado', 'TEXT');
asegurarColumna('cotizaciones', 'cliente_txt', 'TEXT');
asegurarColumna('cotizaciones', 'fecha_creacion', 'TEXT');
asegurarColumna('ordenes_trabajo', 'cliente', 'TEXT');
asegurarColumna('ordenes_trabajo', 'solicitud', 'TEXT');
asegurarColumna('ordenes_trabajo', 'subtotal', 'REAL DEFAULT 0');
asegurarColumna('ordenes_trabajo', 'iva', 'REAL DEFAULT 0');
asegurarColumna('ordenes_trabajo', 'total', 'REAL DEFAULT 0');
asegurarColumna('ordenes_trabajo', 'especificaciones', 'TEXT');
asegurarColumna('ordenes_trabajo', 'entrega_confirmada', "TEXT DEFAULT 'No'");
asegurarColumna('ordenes_trabajo', 'operador', 'TEXT');
asegurarColumna('ordenes_trabajo', 'repartidor', 'TEXT');

// ===== MULTI-EMPRESA: cada empresa ve solo sus datos =====
db.exec(`
  CREATE TABLE IF NOT EXISTS empresas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    config TEXT DEFAULT '{}',
    creado TEXT
  );
  CREATE TABLE IF NOT EXISTS sesiones_empresa (
    token TEXT PRIMARY KEY,
    empresa_id INTEGER NOT NULL,
    creado TEXT,
    FOREIGN KEY(empresa_id) REFERENCES empresas(id)
  );
`);

const TABLAS_EMPRESA = ['usuarios', 'clientes', 'solicitudes', 'materiales_precios', 'papeles_precios',
  'terminaciones_precios', 'cotizaciones', 'ordenes_trabajo', 'productos_precios'];
TABLAS_EMPRESA.forEach(t => asegurarColumna(t, 'empresa_id', 'INTEGER'));

// Los nombres únicos pasan a ser únicos por empresa (no globales)
function quitarUnicoGlobal(tabla, columna) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabla);
  const rx = new RegExp(`(\\b${columna}\\s+TEXT\\s+)UNIQUE\\s+`, 'i');
  if (!row || !rx.test(row.sql)) return;
  const nuevoSql = row.sql.replace(rx, '$1')
    .replace(new RegExp(`CREATE TABLE\\s+(IF NOT EXISTS\\s+)?"?${tabla}"?`, 'i'), `CREATE TABLE ${tabla}_mig`);
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(nuevoSql);
    db.exec(`INSERT INTO ${tabla}_mig SELECT * FROM ${tabla}; DROP TABLE ${tabla}; ALTER TABLE ${tabla}_mig RENAME TO ${tabla};`);
  })();
}
quitarUnicoGlobal('usuarios', 'usuario');
quitarUnicoGlobal('materiales_precios', 'nombre');
quitarUnicoGlobal('terminaciones_precios', 'nombre');
quitarUnicoGlobal('productos_precios', 'nombre');
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS ux_usuarios_empresa ON usuarios(empresa_id, usuario);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_materiales_empresa ON materiales_precios(empresa_id, nombre);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_terminaciones_empresa ON terminaciones_precios(empresa_id, nombre);
  CREATE UNIQUE INDEX IF NOT EXISTS ux_productos_empresa ON productos_precios(empresa_id, nombre);
`);
TABLAS_EMPRESA.forEach(t => db.exec(`CREATE INDEX IF NOT EXISTS ix_${t}_empresa ON ${t}(empresa_id)`));

// Catálogo inicial para cada empresa nueva
function sembrarCatalogoEmpresa(empresaId) {
  const vacio = t => db.prepare(`SELECT COUNT(*) AS cant FROM ${t} WHERE empresa_id = ?`).get(empresaId).cant === 0;
  if (vacio('papeles_precios')) {
    const ins = db.prepare('INSERT INTO papeles_precios (nombre, tamano_hoja, gramaje, precio_hoja, ancho_hoja, alto_hoja, empresa_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    [['Bond', 'A4', '75 g', 95, 21.0, 29.7], ['Bond', 'Carta', '75 g', 80, 21.6, 27.9], ['Bond', 'Oficio', '80 g', 98, 21.6, 33.0],
     ['Couché', 'A3', '200 g', 500, 29.7, 42.0], ['Couché', 'A3', '380 g', 650, 29.7, 42.0],
     ['Opalina', 'A4', '200 g', 490, 21.0, 29.7], ['Opalina', 'Oficio', '250 g', 550, 21.6, 33.0]]
      .forEach(p => ins.run(...p, empresaId));
  }
  if (vacio('materiales_precios')) {
    const ins = db.prepare('INSERT INTO materiales_precios (nombre, precio_m2, empresa_id) VALUES (?, ?, ?)');
    [['Acrílico', 28000], ['Alucomp', 32000], ['Tela PVC', 13000], ['Trovicel', 28000], ['Vinilo adhesivo', 25000], ['Vinilo one way', 15000]]
      .forEach(m => ins.run(...m, empresaId));
  }
  if (vacio('terminaciones_precios')) {
    const ins = db.prepare('INSERT INTO terminaciones_precios (nombre, precio, empresa_id) VALUES (?, ?, ?)');
    [['Barniz', 5000], ['Barniz UV', 7000], ['Corcheteado', 4000], ['Despuntado', 1000], ['Hendido', 2000], ['Laminado brillante', 3000],
     ['Laminado mate', 5000], ['Ojetillado', 5000], ['Perforado', 2000], ['Troquelado', 3000]]
      .forEach(t => ins.run(...t, empresaId));
  }
  if (vacio('productos_precios')) {
    const ins = db.prepare('INSERT INTO productos_precios (nombre, precio_unitario, empresa_id) VALUES (?, ?, ?)');
    [['Tarjeta de presentación', 48], ['Letrero', 40000], ['Pendón', 15000]].forEach(p => ins.run(...p, empresaId));
  }
}

const cantPapeles = db.prepare('SELECT COUNT(*) as cant FROM papeles_precios').get().cant;
if (cantPapeles === 0) {
  const insertPapel = db.prepare(`
    INSERT INTO papeles_precios (nombre, tamano_hoja, gramaje, precio_hoja, ancho_hoja, alto_hoja)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertPapel.run('Bond', 'A4', '75 g', 95, 21.0, 29.7);
  insertPapel.run('Bond', 'Carta', '75 g', 80, 21.6, 27.9);
  insertPapel.run('Bond', 'Oficio', '80 g', 98, 21.6, 33.0);
  insertPapel.run('Couché', 'A3', '200 g', 500, 29.7, 42.0);
  insertPapel.run('Couché', 'A3', '380 g', 650, 29.7, 42.0);
  insertPapel.run('Opalina', 'A4', '200 g', 490, 21.0, 29.7);
  insertPapel.run('Opalina', 'Oficio', '250 g', 550, 21.6, 33.0);
}

const cantMateriales = db.prepare('SELECT COUNT(*) as cant FROM materiales_precios').get().cant;
if (cantMateriales === 0) {
  const ins = db.prepare('INSERT INTO materiales_precios (nombre, precio_m2) VALUES (?, ?)');
  ins.run('Acrílico', 28000);
  ins.run('Alucomp', 32000);
  ins.run('Tela PVC', 13000);
  ins.run('Trovicel', 28000);
  ins.run('Vinilo adhesivo', 25000);
  ins.run('Vinilo one way', 15000);
}

const cantTerm = db.prepare('SELECT COUNT(*) as cant FROM terminaciones_precios').get().cant;
if (cantTerm === 0) {
  const ins = db.prepare('INSERT INTO terminaciones_precios (nombre, precio) VALUES (?, ?)');
  ins.run('Barniz', 5000);
  ins.run('Barniz UV', 7000);
  ins.run('Corcheteado', 4000);
  ins.run('Despuntado', 1000);
  ins.run('Hendido', 2000);
  ins.run('Laminado brillante', 3000);
  ins.run('Laminado mate', 5000);
  ins.run('Ojetillado', 5000);
  ins.run('Perforado', 2000);
  ins.run('Troquelado', 3000);
}
const cantProdPrecios = db.prepare('SELECT COUNT(*) as cant FROM productos_precios').get().cant;
if (cantProdPrecios === 0) {
  const ins = db.prepare('INSERT INTO productos_precios (nombre, precio_unitario) VALUES (?, ?)');
  ins.run('Tarjeta de presentación', 48);
  ins.run('Letrero', 40000);
  ins.run('Pendón', 15000);
}

function calcularTotales(precios, descuentoPorc = 0) {
  const mat = parseFloat(precios.material) || 0;
  const imp = parseFloat(precios.impresion) || 0;
  const term = parseFloat(precios.terminaciones) || 0;
  const dis = parseFloat(precios.diseno) || 0;
  const desp = parseFloat(precios.despacho) || 0;
  const desc = parseFloat(descuentoPorc) || 0;

  const subtotal = mat + imp + term + dis + desp;
  const montoDesc = Math.round(subtotal * (desc / 100));
  const neto = subtotal - montoDesc;
  const iva = Math.round(neto * 0.19);
  const total = Math.round(neto + iva);

  return { subtotal, descuento: desc, neto, iva, total };
}

function aprobarCotizacion(cotizacionId, empresaId) {
  const cot = db.prepare(`
    SELECT 
      c.id AS cotizacion_id, c.subtotal AS cot_subtotal, c.iva AS cot_iva, c.total AS cot_total, c.descuento AS cot_descuento,
      s.id AS sol_id, s.producto, s.descripcion, s.cantidad, s.ancho, s.alto, s.unidad_medida, s.orientacion,
      s.material, s.gramaje, s.impresion_caras_tintas, s.sistema_impresion, s.terminaciones, s.especificaciones,
      s.fecha_requerida, s.archivo_url,
      COALESCE(cl.nombre_empresa, s.nombre_empresa, c.cliente_txt, 'Cliente directo') AS nombre_empresa_final,
      COALESCE(cl.nombre_contacto, '') AS nombre_contacto_final
    FROM cotizaciones c
    LEFT JOIN solicitudes s ON c.solicitud_id = s.id
    LEFT JOIN clientes cl ON s.cliente_id = cl.id
    WHERE c.id = ? AND c.empresa_id = ?
  `).get(cotizacionId, empresaId);

  if (!cot) throw new Error(`La cotización #${cotizacionId} no existe.`);

  const totalOts = db.prepare('SELECT COUNT(*) as cant FROM ordenes_trabajo WHERE empresa_id = ?').get(empresaId).cant + 1;
  const numOt = totalOts;
  const codOt = `OT-${String(totalOts).padStart(4, '0')}`;
  const hoy = new Date().toISOString().split('T')[0];
  const medidasTxt = cot.ancho && cot.alto ? `${cot.ancho}x${cot.alto}` : '-';

  const infoOt = db.prepare(`
    INSERT INTO ordenes_trabajo (
      numero_ot, codigo_ot, cliente, solicitud, estado_pedido, prioridad,
      fecha_creacion, fecha_entrega, responsable, producto, descripcion,
      cantidad, medidas, unidad_medida, orientacion, material, gramaje,
      impresion, sistema_impresion, terminaciones, especificaciones,
      fecha_requerida, archivo, maquina, operador, cantidad_producida,
      resultado_calidad, observaciones, metodo_entrega, fecha_entrega_real,
      cantidad_entregada, subtotal, iva, total, entrega_confirmada, empresa_id
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?
    )
  `).run(
    numOt, codOt, cot.nombre_empresa_final, cot.sol_id ? `Solicitud #${cot.sol_id}` : 'Cotización directa',
    'Pendiente', 'Media', hoy, cot.fecha_requerida || hoy, cot.nombre_contacto_final,
    cot.producto || '', cot.descripcion || '', cot.cantidad || 1, medidasTxt, cot.unidad_medida || 'cm',
    cot.orientacion || 'Vertical', cot.material || '', cot.gramaje || '', cot.impresion_caras_tintas || '',
    cot.sistema_impresion || '', cot.terminaciones || '', cot.especificaciones || '', cot.fecha_requerida || '',
    cot.archivo_url || '', 'Máquina 1', '', cot.cantidad || 0, 'Pendiente',
    `Aprobada desde Cotización #${cot.cotizacion_id}. Descuento: ${cot.cot_descuento || 0}%`,
    'Despacho', '', 0, cot.cot_subtotal || 0, cot.cot_iva || 0, cot.cot_total || 0, 'No', empresaId
  );

  if (cot.sol_id) {
    db.prepare("UPDATE solicitudes SET estado = 'Aprobada' WHERE id = ?").run(cot.sol_id);
  }

  return { ok: true, ot_id: infoOt.lastInsertRowid, codigo_ot: codOt };
}

module.exports = {
  db,
  calcularTotales,
  aprobarCotizacion,
  sembrarCatalogoEmpresa,
  TABLAS_EMPRESA
};