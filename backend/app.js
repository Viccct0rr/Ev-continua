const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const SQLiteSessionStore = require('./session-store');
const { createSupabaseAdminClient, createSupabaseClient } = require('./supabase-client');

const MOCKUP_DIR = path.resolve(__dirname, '..', 'mockup');
const MONEY_PATTERN = /^\d{1,7}(?:\.\d{1,2})?$/;
const VALID_ROLES = new Set(['admin', 'cashier', 'kitchen', 'delivery', 'customer']);
const STATUS_TRANSITIONS = {
  pending: new Set(['preparing', 'cancelled']),
  preparing: new Set(['ready', 'cancelled']),
  ready: new Set(['out_for_delivery']),
  out_for_delivery: new Set(['delivered']),
  delivered: new Set(),
  cancelled: new Set()
};

function createApp({
  db,
  sessionStore,
  supabaseMode = false,
  supabaseClientFactory = createSupabaseClient,
  testMode = false,
  sessionSecret = process.env.SESSION_SECRET
} = {}) {
  if (!db) throw new Error('createApp requiere una conexión SQLite.');
  if (!sessionSecret && process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET es obligatorio en producción.');
  }
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '32kb', strict: true }));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(session({
    name: 'burgerflow.sid',
    secret: sessionSecret || crypto.randomBytes(32).toString('hex'),
    store: sessionStore || new SQLiteSessionStore(db),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 8 * 60 * 60 * 1000
    }
  }));
  app.use('/api', rejectCrossOrigin);
  const supabaseFactory = supabaseMode ? supabaseClientFactory : null;
  if (supabaseFactory) {
    app.use('/api', async (req, res, next) => {
      try {
        req.supabase = supabaseFactory();
        const savedAuth = req.session.supabaseAuth;
        if (!savedAuth) return next();

        const { data, error } = await req.supabase.auth.setSession(savedAuth);
        if (error || !data.session) {
          if (error && ![400, 401, 403].includes(error.status)) return next(error);
          delete req.session.supabaseAuth;
          delete req.session.user;
          req.session.save((saveError) => {
            if (saveError) return next(saveError);
            next();
          });
          return;
        }
        const { data: userData, error: userError } = await req.supabase.auth.getUser(data.session.access_token);
        if (userError || !userData.user) {
          if (userError && ![400, 401, 403].includes(userError.status)) return next(userError);
          delete req.session.supabaseAuth;
          delete req.session.user;
          req.session.save((saveError) => {
            if (saveError) return next(saveError);
            next();
          });
          return;
        }
        req.session.supabaseAuth = {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token
        };
        req.supabaseAuthUser = userData.user;
        next();
      } catch (error) {
        next(error);
      }
    });
  }
  if (!testMode) {
    app.use('/api/auth/login', rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      standardHeaders: 'draft-8',
      legacyHeaders: false
    }));
  }

  function rejectCrossOrigin(req, res, next) {
    const origin = req.get('origin');
    if (!origin) return next();
    try {
      const requestOrigin = `${req.protocol}://${req.get('host')}`;
      if (new URL(origin).origin !== requestOrigin) {
        return res.status(403).json({ error: 'Origen no permitido.' });
      }
    } catch {
      return res.status(403).json({ error: 'Origen no permitido.' });
    }
    return next();
  }

  const userByEmail = db.prepare(`SELECT u.id, u.name, u.email, u.password_hash, u.active, r.id AS role_id
    FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = ? COLLATE NOCASE`);
  const activeUserById = db.prepare(`SELECT id, role_id FROM users WHERE id = ? AND active = 1`);
  const permissionCheck = db.prepare(`SELECT 1 FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
    WHERE rp.role_id = ? AND rp.permission_id = ?`);

  async function getAuthenticatedUser(req, res) {
    if (supabaseFactory) {
      if (!req.session.supabaseAuth || !req.supabaseAuthUser) {
        res.status(401).json({ error: 'Inicia sesión para continuar.' });
        return null;
      }
      const { data, error } = await req.supabase
        .from('users')
        .select('id, name, email, role_id, active, auth_user_id')
        .eq('auth_user_id', req.supabaseAuthUser.id)
        .maybeSingle();
      if (error) throw error;
      if (!data || !data.active) {
        req.session.destroy((destroyError) => {
          if (destroyError) console.error(destroyError);
        });
        res.status(401).json({ error: 'La cuenta está inactiva o no está provisionada.' });
        return null;
      }
      req.session.user = {
        id: Number(data.id),
        name: data.name,
        email: data.email,
        role: data.role_id,
        authUserId: data.auth_user_id
      };
      return req.session.user;
    }

    if (!req.session.user) {
      res.status(401).json({ error: 'Inicia sesión para continuar.' });
      return null;
    }
    const activeUser = activeUserById.get(req.session.user.id);
    if (!activeUser) {
      req.session.destroy(() => {});
      res.status(401).json({ error: 'La cuenta está inactiva. Inicia sesión con una cuenta autorizada.' });
      return null;
    }
    req.session.user.role = activeUser.role_id;
    return req.session.user;
  }

  function requireAuth(req, res, next) {
    getAuthenticatedUser(req, res).then((user) => {
      if (user) next();
    }).catch(next);
  }

  function requirePermission(permission) {
    return async (req, res, next) => {
      try {
        const user = await getAuthenticatedUser(req, res);
        if (!user) return;
        if (supabaseFactory) {
          const { data, error } = await req.supabase.rpc('has_app_permission', { permission_name: permission });
          if (error) throw error;
          if (!data) return res.status(403).json({ error: 'No tienes permiso para esta operación.' });
        } else if (!permissionCheck.get(user.role, permission)) {
          return res.status(403).json({ error: 'No tienes permiso para esta operación.' });
        }
        next();
      } catch (error) {
        next(error);
      }
    };
  }

  function publicUser(user) {
    return { id: user.id, name: user.name, email: user.email, role: user.role_id };
  }

  app.post('/api/auth/login', async (req, res, next) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().slice(0, 254) : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (supabaseFactory) {
      try {
        const { data, error } = await req.supabase.auth.signInWithPassword({ email, password });
        if (error && [400, 401, 403].includes(error.status)) {
          return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
        }
        if (error) throw error;
        if (!data.user || !data.session) throw new Error('Supabase Auth no devolvió una sesión válida.');
        const { data: profile, error: profileError } = await req.supabase
          .from('users')
          .select('id, name, email, role_id, active, auth_user_id')
          .eq('auth_user_id', data.user.id)
          .maybeSingle();
        if (profileError) throw profileError;
        if (!profile || !profile.active) {
          return res.status(401).json({ error: 'La cuenta está inactiva o no está provisionada.' });
        }
        req.session.regenerate((sessionError) => {
          if (sessionError) return next(sessionError);
          req.session.supabaseAuth = {
            access_token: data.session.access_token,
            refresh_token: data.session.refresh_token
          };
          req.session.user = {
            id: Number(profile.id),
            name: profile.name,
            email: profile.email,
            role: profile.role_id,
            authUserId: profile.auth_user_id
          };
          req.session.save((saveError) => {
            if (saveError) return next(saveError);
            res.json({ user: publicUser({ ...profile, role_id: profile.role_id }) });
          });
        });
      } catch (error) {
        next(error);
      }
      return;
    }
    const user = email && userByEmail.get(email);
    if (!user || !user.active || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
    }
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.user = { id: user.id, role: user.role_id };
      req.session.save((saveError) => {
        if (saveError) return next(saveError);
        res.json({ user: publicUser(user) });
      });
    });
  });

  app.get('/api/auth/me', async (req, res, next) => {
    if (!req.session.user) return res.json({ user: null });
    if (supabaseFactory) {
      try {
        const { data, error } = await req.supabase
          .from('users')
          .select('id, name, email, role_id, active')
          .eq('auth_user_id', req.supabaseAuthUser?.id || req.session.user.authUserId)
          .maybeSingle();
        if (error) throw error;
        if (!data || !data.active) {
          req.session.destroy(() => res.json({ user: null }));
          return;
        }
        req.session.user = {
          id: Number(data.id),
          name: data.name,
          email: data.email,
          role: data.role_id,
          authUserId: req.session.user.authUserId
        };
        return res.json({ user: publicUser({ ...data, role_id: data.role_id }) });
      } catch (error) {
        return next(error);
      }
    }
    const user = db.prepare(`SELECT u.id, u.name, u.email, u.active, r.id AS role_id
      FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`).get(req.session.user.id);
    if (!user || !user.active) {
      req.session.destroy(() => res.json({ user: null }));
      return;
    }
    res.json({ user: publicUser(user) });
  });

  app.post('/api/auth/logout', requireAuth, (req, res, next) => {
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie('burgerflow.sid', { httpOnly: true, sameSite: 'strict' });
      res.status(204).end();
    });
  });

  function productDto(row, includeInventory = false) {
    const product = {
      id: row.id,
      name: row.name,
      category: row.category,
      description: row.description,
      priceCents: row.price_cents,
      active: Boolean(row.active)
    };
    if (includeInventory) {
      product.quantity = row.quantity;
      product.unit = row.unit;
      product.lowStockThreshold = row.low_stock_threshold;
    }
    return product;
  }

  async function remoteProduct(req, id, includeInventory = false) {
    const { data: row, error } = await req.supabase
      .from('products')
      .select('id, name, category, description, price_cents, active')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!row) return null;
    if (!includeInventory) return productDto(row);
    const { data: inventory, error: inventoryError } = await req.supabase
      .from('inventory')
      .select('quantity, unit, low_stock_threshold')
      .eq('product_id', id)
      .maybeSingle();
    if (inventoryError) throw inventoryError;
    return productDto({ ...row, ...(inventory || {}) }, true);
  }

  const productQuery = `SELECT p.id, p.name, p.category, p.description, p.price_cents, p.active,
      i.quantity, i.unit, i.low_stock_threshold
    FROM products p LEFT JOIN inventory i ON i.product_id = p.id`;

  app.get('/api/products', async (req, res, next) => {
    if (supabaseFactory) {
      try {
        const { data, error } = await req.supabase
          .from('products')
          .select('id, name, category, description, price_cents, active')
          .eq('active', true)
          .order('category')
          .order('name');
        if (error) throw error;
        return res.json({ products: data.map((row) => productDto(row)) });
      } catch (error) {
        return next(error);
      }
    }
    const rows = db.prepare(`${productQuery} WHERE p.active = 1 ORDER BY p.category, p.name`).all();
    res.json({ products: rows.map((row) => productDto(row)) });
  });

  app.post('/api/products', requirePermission('products:write'), async (req, res, next) => {
    const input = validateProduct(req.body);
    if (input.error) return res.status(400).json({ error: input.error });
    if (supabaseFactory) {
      try {
        const { data: id, error } = await req.supabase.rpc('create_product', {
          product_name: input.name,
          product_category: input.category,
          product_description: input.description,
          product_price_cents: input.priceCents,
          initial_quantity: input.quantity,
          inventory_unit: input.unit
        });
        if (error) {
          if (respondSupabaseError(res, error)) return;
          throw error;
        }
        const product = await remoteProduct(req, id, true);
        if (!product) return res.status(500).json({ error: 'El producto se creó, pero no se pudo volver a consultar.' });
        return res.status(201).json({ product });
      } catch (error) {
        return next(error);
      }
    }
    try {
      const create = db.transaction(() => {
        const result = db.prepare(`INSERT INTO products (name, category, description, price_cents)
          VALUES (?, ?, ?, ?)`).run(input.name, input.category, input.description, input.priceCents);
        db.prepare('INSERT INTO inventory (product_id, quantity, unit) VALUES (?, ?, ?)')
          .run(result.lastInsertRowid, input.quantity, input.unit);
        return db.prepare(`${productQuery} WHERE p.id = ?`).get(result.lastInsertRowid);
      });
      res.status(201).json({ product: productDto(create(), true) });
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Ya existe un producto con ese nombre.' });
      throw error;
    }
  });

  app.patch('/api/products/:id', requirePermission('products:write'), async (req, res, next) => {
    const id = positiveId(req.params.id);
    if (supabaseFactory) {
      if (!id) return res.status(400).json({ error: 'Identificador inválido.' });
      try {
        const current = await remoteProduct(req, id);
        if (!current) return res.status(404).json({ error: 'Producto no encontrado.' });
        const merged = validateProduct({
          ...req.body,
          name: req.body?.name ?? current.name,
          category: req.body?.category ?? current.category,
          description: req.body?.description ?? current.description,
          priceCents: req.body?.priceCents ?? current.priceCents,
          quantity: 0,
          unit: 'unidades'
        }, { requireQuantity: false });
        if (merged.error) return res.status(400).json({ error: merged.error });
        const { error } = await req.supabase.rpc('update_product', {
          target_product_id: id,
          product_name: merged.name,
          product_category: merged.category,
          product_description: merged.description,
          product_price_cents: merged.priceCents
        });
        if (error) {
          if (respondSupabaseError(res, error)) return;
          throw error;
        }
        const product = await remoteProduct(req, id, true);
        if (!product) return res.status(500).json({ error: 'El producto se actualizó, pero no se pudo volver a consultar.' });
        return res.json({ product });
      } catch (error) {
        return next(error);
      }
    }
    const current = id && db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!current) return res.status(404).json({ error: 'Producto no encontrado.' });
    const merged = validateProduct({
      ...req.body,
      name: req.body?.name ?? current.name,
      category: req.body?.category ?? current.category,
      description: req.body?.description ?? current.description,
      priceCents: req.body?.priceCents ?? current.price_cents,
      quantity: db.prepare('SELECT quantity FROM inventory WHERE product_id = ?').get(id)?.quantity ?? 0,
      unit: db.prepare('SELECT unit FROM inventory WHERE product_id = ?').get(id)?.unit ?? 'unidades'
    }, { requireQuantity: false });
    if (merged.error) return res.status(400).json({ error: merged.error });
    db.prepare(`UPDATE products SET name = ?, category = ?, description = ?, price_cents = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(merged.name, merged.category, merged.description, merged.priceCents, id);
    const updated = db.prepare(`${productQuery} WHERE p.id = ?`).get(id);
    res.json({ product: productDto(updated, true) });
  });

  app.delete('/api/products/:id', requirePermission('products:write'), async (req, res, next) => {
    const id = positiveId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Identificador inválido.' });
    if (supabaseFactory) {
      try {
        const { error } = await req.supabase.rpc('deactivate_product', { target_product_id: id });
        if (error) {
          if (respondSupabaseError(res, error)) return;
          throw error;
        }
        return res.status(204).end();
      } catch (error) {
        return next(error);
      }
    }
    const result = db.prepare('UPDATE products SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND active = 1').run(id);
    if (!result.changes) return res.status(404).json({ error: 'Producto no encontrado o ya desactivado.' });
    res.status(204).end();
  });

  app.get('/api/inventory', requirePermission('inventory:read'), async (req, res, next) => {
    if (supabaseFactory) {
      try {
        const { data: products, error: productError } = await req.supabase
          .from('products')
          .select('id, name, category, description, price_cents, active')
          .eq('active', true)
          .order('name');
        if (productError) throw productError;
        const ids = products.map((product) => product.id);
        const inventoryByProduct = new Map();
        if (ids.length) {
          const { data: inventory, error: inventoryError } = await req.supabase
            .from('inventory')
            .select('product_id, quantity, unit, low_stock_threshold')
            .in('product_id', ids);
          if (inventoryError) throw inventoryError;
          for (const item of inventory) inventoryByProduct.set(item.product_id, item);
        }
        return res.json({
          inventory: products.map((product) => productDto({
            ...product,
            ...(inventoryByProduct.get(product.id) || {})
          }, true))
        });
      } catch (error) {
        return next(error);
      }
    }
    const rows = db.prepare(`${productQuery} WHERE p.active = 1 ORDER BY p.name`).all();
    res.json({ inventory: rows.map((row) => productDto(row, true)) });
  });

  app.patch('/api/inventory/:productId', requirePermission('inventory:write'), async (req, res, next) => {
    const productId = positiveId(req.params.productId);
    const quantity = req.body?.quantity;
    const reason = safeString(req.body?.reason, 120);
    if (!productId || !Number.isSafeInteger(quantity) || quantity < 0 || !reason) {
      return res.status(400).json({ error: 'Cantidad entera no negativa y motivo válido son obligatorios.' });
    }
    if (supabaseFactory) {
      try {
        const { error } = await req.supabase.rpc('adjust_inventory', {
          target_product_id: productId,
          new_quantity: quantity,
          change_reason: reason
        });
        if (error) {
          if (respondSupabaseError(res, error)) return;
          throw error;
        }
        const product = await remoteProduct(req, productId, true);
        if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
        return res.json({ product });
      } catch (error) {
        return next(error);
      }
    }
    const adjust = db.transaction(() => {
      const current = db.prepare('SELECT quantity FROM inventory WHERE product_id = ?').get(productId);
      if (!current) return null;
      const delta = quantity - current.quantity;
      db.prepare(`UPDATE inventory SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ?`)
        .run(quantity, productId);
      if (delta) db.prepare(`INSERT INTO inventory_movements (product_id, changed_by, delta, reason)
        VALUES (?, ?, ?, ?)`).run(productId, req.session.user.id, delta, reason);
      return db.prepare(`${productQuery} WHERE p.id = ?`).get(productId);
    });
    const row = adjust();
    if (!row) return res.status(404).json({ error: 'Producto no encontrado.' });
    res.json({ product: productDto(row, true) });
  });

  function itemDetails(orderId) {
    const items = db.prepare(`SELECT id, product_id, product_name, quantity, unit_price_cents, line_total_cents
      FROM order_items WHERE order_id = ? ORDER BY id`).all(orderId);
    return items.map((item) => ({
      id: item.id,
      productId: item.product_id,
      name: item.product_name,
      quantity: item.quantity,
      unitPriceCents: item.unit_price_cents,
      lineTotalCents: item.line_total_cents,
      personalizations: db.prepare(`SELECT name, value, price_delta_cents
        FROM personalizations WHERE order_item_id = ? ORDER BY id`)
        .all(item.id).map((option) => ({
          name: option.name,
          value: option.value,
          priceDeltaCents: option.price_delta_cents
        }))
    }));
  }

  function orderDto(row, { includeDelivery = false, includePayment = false, includeAmounts = true } = {}) {
    const order = {
      id: row.id,
      code: row.code,
      type: row.order_type,
      status: row.status,
      createdAt: row.created_at,
      items: itemDetails(row.id)
    };
    if (includeAmounts) {
      order.subtotalCents = row.subtotal_cents;
      order.taxCents = row.tax_cents;
      order.serviceCents = row.service_cents;
      order.totalCents = row.total_cents;
    }
    if (includePayment) order.paymentMethod = row.payment_method;
    if (includeDelivery) {
      order.delivery = db.prepare(`SELECT customer_name AS name, phone, address
        FROM delivery_info WHERE order_id = ?`).get(row.id) || null;
    }
    return order;
  }

  function remoteOrderColumns({ includeDelivery = false, includePayment = false, includeAmounts = true } = {}) {
    const columns = [
      'id',
      'code',
      'created_by',
      'cliente_id',
      'repartidor_id',
      'order_type',
      'status',
      'created_at',
      'order_items(id, product_id, product_name, quantity, unit_price_cents, line_total_cents, personalizations(name, value, price_delta_cents))'
    ];
    if (includeAmounts) columns.push('order_financials(subtotal_cents, tax_cents, service_cents, total_cents)');
    if (includePayment) columns.push('order_payments(payment_method)');
    if (includeDelivery) columns.push('delivery_info(customer_name, phone, address)');
    return columns.join(', ');
  }

  function relationOne(value) {
    return Array.isArray(value) ? (value[0] || null) : (value || null);
  }

  function remoteOrderDto(row, { includeDelivery = false, includePayment = false, includeAmounts = true } = {}) {
    const order = {
      id: row.id,
      code: row.code,
      type: row.order_type,
      status: row.status,
      createdAt: row.created_at,
      items: (row.order_items || [])
        .sort((left, right) => left.id - right.id)
        .map((item) => ({
          id: item.id,
          productId: item.product_id,
          name: item.product_name,
          quantity: item.quantity,
          unitPriceCents: item.unit_price_cents,
          lineTotalCents: item.line_total_cents,
          personalizations: (item.personalizations || [])
            .map((option) => ({
              name: option.name,
              value: option.value,
              priceDeltaCents: option.price_delta_cents
            }))
        }))
    };
    const financials = relationOne(row.order_financials);
    const payment = relationOne(row.order_payments);
    if (includeAmounts && financials) {
      order.subtotalCents = financials.subtotal_cents;
      order.taxCents = financials.tax_cents;
      order.serviceCents = financials.service_cents;
      order.totalCents = financials.total_cents;
    }
    if (includePayment && payment) order.paymentMethod = payment.payment_method;
    if (includeDelivery) {
      const delivery = relationOne(row.delivery_info);
      order.delivery = delivery ? {
        name: delivery.customer_name,
        phone: delivery.phone,
        address: delivery.address
      } : null;
    }
    return order;
  }

  async function loadRemoteOrders(req, options = {}, configureQuery = (query) => query) {
    const query = configureQuery(
      req.supabase.from('orders').select(remoteOrderColumns(options))
    );
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  const orderSelect = `SELECT id, code, created_by, cliente_id, repartidor_id, order_type, status, payment_method,
      subtotal_cents, tax_cents, service_cents, total_cents, created_at FROM orders`;

  app.get('/api/orders', requireAuth, async (req, res, next) => {
    const user = req.session.user;
    if (supabaseFactory) {
      if (!['admin', 'cashier', 'customer'].includes(user.role)) {
        return res.status(403).json({ error: 'No tienes permiso para consultar pedidos generales.' });
      }
      try {
        const flags = {
            includeDelivery: user.role === 'admin' || user.role === 'customer',
            includePayment: user.role === 'admin' || user.role === 'cashier',
            includeAmounts: true
          };
        const rows = await loadRemoteOrders(
          req,
          flags,
          (query) => query.order('created_at', { ascending: false }).limit(100)
        );
        return res.json({
          orders: rows.map((row) => remoteOrderDto(row, {
            includeDelivery: user.role === 'admin' || user.role === 'customer',
            includePayment: user.role === 'admin' || user.role === 'cashier'
          }))
        });
      } catch (error) {
        return next(error);
      }
    }
    let rows;
    if (user.role === 'admin' || user.role === 'cashier') {
      rows = db.prepare(`${orderSelect} ORDER BY created_at DESC LIMIT 100`).all();
    } else if (user.role === 'customer') {
      rows = db.prepare(`${orderSelect} WHERE cliente_id = ? ORDER BY created_at DESC LIMIT 100`).all(user.id);
    } else {
      return res.status(403).json({ error: 'No tienes permiso para consultar pedidos generales.' });
    }
    res.json({ orders: rows.map((row) => orderDto(row, {
      includeDelivery: user.role === 'admin' || user.role === 'customer',
      includePayment: user.role === 'admin' || user.role === 'cashier'
    })) });
  });

  app.get('/api/orders/kitchen', requirePermission('orders:kitchen'), async (req, res, next) => {
    if (supabaseFactory) {
      try {
        const rows = await loadRemoteOrders(req, { includeAmounts: false }, (query) => query
          .in('status', ['pending', 'preparing', 'ready'])
          .order('created_at'));
        return res.json({ orders: rows.map((row) => remoteOrderDto(row, { includeAmounts: false })) });
      } catch (error) {
        return next(error);
      }
    }
    const rows = db.prepare(`${orderSelect} WHERE status IN ('pending', 'preparing', 'ready')
      ORDER BY created_at`).all();
    res.json({ orders: rows.map((row) => orderDto(row, { includeAmounts: false })) });
  });

  app.get('/api/orders/delivery', requirePermission('orders:delivery'), async (req, res, next) => {
    if (supabaseFactory) {
      try {
        const rows = await loadRemoteOrders(req, { includeDelivery: true, includeAmounts: false }, (query) => query
          .eq('order_type', 'delivery')
          .in('status', ['ready', 'out_for_delivery'])
          .order('created_at'));
        return res.json({ orders: rows.map((row) => remoteOrderDto(row, {
          includeDelivery: true,
          includeAmounts: false
        })) });
      } catch (error) {
        return next(error);
      }
    }
    const rows = req.session.user.role === 'admin'
      ? db.prepare(`${orderSelect} WHERE order_type = 'delivery' AND status IN ('ready', 'out_for_delivery')
          ORDER BY created_at`).all()
      : db.prepare(`${orderSelect} WHERE repartidor_id = ?
          AND status IN ('ready', 'out_for_delivery') ORDER BY created_at`).all(req.session.user.id);
    res.json({ orders: rows.map((row) => orderDto(row, { includeDelivery: true, includeAmounts: false })) });
  });

  app.get('/api/orders/:id', requireAuth, async (req, res, next) => {
    const id = positiveId(req.params.id);
    const user = req.session.user;
    if (supabaseFactory) {
      if (!id) return res.status(404).json({ error: 'Pedido no encontrado.' });
      const options = {
        includeDelivery: user.role === 'admin' || user.role === 'customer' || user.role === 'delivery',
        includePayment: user.role === 'admin' || user.role === 'cashier',
        includeAmounts: user.role !== 'delivery' && user.role !== 'kitchen'
      };
      try {
        const rows = await loadRemoteOrders(req, options, (query) => query.eq('id', id));
        const order = rows[0];
        if (!order) return res.status(404).json({ error: 'Pedido no encontrado.' });
        if (user.role === 'delivery') {
          if (order.order_type !== 'delivery' || Number(order.repartidor_id) !== user.id) {
            return res.status(404).json({ error: 'Pedido no encontrado.' });
          }
          return res.json({ order: remoteOrderDto(order, { includeDelivery: true, includeAmounts: false }) });
        }
        if (user.role === 'admin') {
          return res.json({ order: remoteOrderDto(order, { includeDelivery: true, includePayment: true }) });
        }
        if (user.role === 'customer' && Number(order.cliente_id) === user.id) {
          return res.json({ order: remoteOrderDto(order, { includeDelivery: true }) });
        }
        if (user.role === 'cashier') {
          return res.json({ order: remoteOrderDto(order, { includePayment: true }) });
        }
        return res.status(404).json({ error: 'Pedido no encontrado.' });
      } catch (error) {
        return next(error);
      }
    }
    const order = id && db.prepare(`${orderSelect} WHERE id = ?`).get(id);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado.' });

    if (user.role === 'delivery') {
      if (order.order_type !== 'delivery' || order.repartidor_id !== user.id) {
        return res.status(404).json({ error: 'Pedido no encontrado.' });
      }
      return res.json({ order: orderDto(order, { includeDelivery: true, includeAmounts: false }) });
    }
    if (user.role === 'admin') {
      return res.json({ order: orderDto(order, { includeDelivery: true, includePayment: true }) });
    }
    if (user.role === 'customer' && order.cliente_id === user.id) {
      return res.json({ order: orderDto(order, { includeDelivery: true }) });
    }
    if (user.role === 'cashier') {
      return res.json({ order: orderDto(order, { includePayment: true }) });
    }
    return res.status(404).json({ error: 'Pedido no encontrado.' });
  });

  app.post('/api/orders', requirePermission('orders:create'), async (req, res, next) => {
    const { items, orderType, paymentMethod, delivery } = req.body || {};
    if (!Array.isArray(items) || items.length < 1 || items.length > 30) {
      return res.status(400).json({ error: 'El pedido debe contener entre 1 y 30 productos.' });
    }
    if (!['dine_in', 'pickup', 'delivery'].includes(orderType)) {
      return res.status(400).json({ error: 'Tipo de pedido inválido.' });
    }
    if (!['cash', 'card', 'qr'].includes(paymentMethod)) {
      return res.status(400).json({ error: 'Método de pago inválido.' });
    }
    if (orderType === 'delivery') {
      const invalidDelivery = validateDelivery(delivery);
      if (invalidDelivery) return res.status(400).json({ error: invalidDelivery });
    }
    let customerId;
    if (req.session.user.role === 'customer') {
      customerId = req.session.user.id;
    } else if (supabaseFactory) {
      customerId = req.body?.customerId === undefined ? null : positiveId(req.body.customerId);
      if (req.body?.customerId !== undefined && !customerId) {
        return res.status(400).json({ error: 'La cuenta de cliente indicada no es válida.' });
      }
    } else {
      const requestedCustomerId = req.body?.customerId === undefined
        ? null
        : positiveId(req.body.customerId);
      const customer = requestedCustomerId
        ? db.prepare(`SELECT id FROM users WHERE id = ? AND role_id = 'customer' AND active = 1`).get(requestedCustomerId)
        : db.prepare(`SELECT id FROM users WHERE email = 'cliente@burgerflow.local' COLLATE NOCASE
            AND role_id = 'customer' AND active = 1`).get();
      if (requestedCustomerId && !customer) {
        return res.status(400).json({ error: 'La cuenta de cliente indicada no es válida.' });
      }
      if (!customer) return res.status(400).json({ error: 'No hay una cuenta de cliente activa para asociar el pedido.' });
      customerId = customer.id;
    }
    const validatedItems = [];
    for (const item of items) {
      const personalizations = normalizePersonalizations(item?.personalizations);
      if (!item || !Number.isSafeInteger(item.productId) || item.productId < 1 ||
          !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 25 ||
          personalizations === null) {
        return res.status(400).json({ error: 'Producto, cantidad entera positiva o personalización inválida.' });
      }
      validatedItems.push({ ...item, personalizations });
    }

    if (supabaseFactory) {
      try {
        const { data: orderId, error } = await req.supabase.rpc('create_order', {
          requested_order_type: orderType,
          requested_payment_method: paymentMethod,
          requested_items: validatedItems.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            personalizations: item.personalizations.map(({ name, value }) => ({ name, value }))
          })),
          requested_delivery: orderType === 'delivery' ? delivery : null,
          requested_customer_id: customerId
        });
        if (error) {
          if (respondSupabaseError(res, error)) return;
          throw error;
        }
        const user = req.session.user;
        const flags = {
          includeDelivery: user.role === 'admin' || user.role === 'customer',
          includePayment: user.role === 'admin' || user.role === 'cashier',
          includeAmounts: true
        };
        const rows = await loadRemoteOrders(req, flags, (query) => query.eq('id', orderId));
        if (!rows[0]) {
          return res.status(500).json({ error: 'El pedido se creó, pero no se pudo volver a consultar.' });
        }
        return res.status(201).json({ order: remoteOrderDto(rows[0], flags) });
      } catch (error) {
        return next(error);
      }
    }

    try {
      const createOrder = db.transaction(() => {
        const requestedQuantities = new Map();
        for (const item of validatedItems) {
          requestedQuantities.set(item.productId, (requestedQuantities.get(item.productId) || 0) + item.quantity);
        }
        const products = validatedItems.map((item) => {
          const row = db.prepare(`SELECT p.id, p.name, p.price_cents, i.quantity
            FROM products p JOIN inventory i ON i.product_id = p.id
            WHERE p.id = ? AND p.active = 1`).get(item.productId);
          if (!row) throw new DomainError(400, 'Uno de los productos no está disponible.');
          const modifierCents = item.personalizations.reduce((sum, option) => sum + option.priceDeltaCents, 0);
          return {
            ...row,
            requestedQuantity: item.quantity,
            unitPriceCents: row.price_cents + modifierCents,
            personalizations: item.personalizations
          };
        });
        const productById = new Map(products.map((item) => [item.id, item]));
        for (const [productId, quantity] of requestedQuantities) {
          const item = productById.get(productId);
          if (item.quantity < quantity) throw new DomainError(409, `Inventario insuficiente para ${item.name}.`);
        }
        const subtotal = products.reduce((sum, item) => sum + item.unitPriceCents * item.requestedQuantity, 0);
        const tax = Math.round(subtotal * 0.08);
        const service = products.length ? 50 : 0;
        const total = subtotal + tax + service;
        const assignedDelivery = orderType === 'delivery'
          ? db.prepare(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
              WHERE r.id = 'delivery' AND u.active = 1 ORDER BY u.id LIMIT 1`).get()?.id || null
          : null;
        const code = `BF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        const result = db.prepare(`INSERT INTO orders
          (code, created_by, cliente_id, repartidor_id, order_type, status, payment_method,
           subtotal_cents, tax_cents, service_cents, total_cents)
          VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`)
          .run(code, req.session.user.id, customerId, assignedDelivery, orderType, paymentMethod, subtotal, tax, service, total);
        const orderId = result.lastInsertRowid;
        for (const item of products) {
          const lineTotal = item.unitPriceCents * item.requestedQuantity;
          const line = db.prepare(`INSERT INTO order_items
            (order_id, product_id, product_name, quantity, unit_price_cents, line_total_cents)
            VALUES (?, ?, ?, ?, ?, ?)`)
            .run(orderId, item.id, item.name, item.requestedQuantity, item.unitPriceCents, lineTotal);
          const insertPersonalization = db.prepare(`INSERT INTO personalizations
            (order_item_id, name, value, price_delta_cents) VALUES (?, ?, ?, ?)`);
          for (const option of item.personalizations) {
            insertPersonalization.run(line.lastInsertRowid, option.name, option.value, option.priceDeltaCents);
          }
          db.prepare(`UPDATE inventory SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP
            WHERE product_id = ?`).run(item.requestedQuantity, item.id);
          db.prepare(`INSERT INTO inventory_movements (product_id, changed_by, delta, reason)
            VALUES (?, ?, ?, 'Reserva por pedido')`).run(item.id, req.session.user.id, -item.requestedQuantity);
        }
        if (orderType === 'delivery') {
          db.prepare(`INSERT INTO delivery_info (order_id, customer_name, phone, address)
            VALUES (?, ?, ?, ?)`).run(orderId, delivery.name.trim(), delivery.phone.trim(), delivery.address.trim());
        }
        db.prepare(`INSERT INTO order_status_history (order_id, changed_by, old_status, new_status)
          VALUES (?, ?, NULL, 'pending')`).run(orderId, req.session.user.id);
        return db.prepare(`${orderSelect} WHERE id = ?`).get(orderId);
      });
      const order = createOrder();
      res.status(201).json({ order: orderDto(order, {
        includeDelivery: req.session.user.role === 'admin' || req.session.user.role === 'customer',
        includePayment: req.session.user.role === 'admin' || req.session.user.role === 'cashier'
      }) });
    } catch (error) {
      if (error instanceof DomainError) return res.status(error.status).json({ error: error.message });
      throw error;
    }
  });

  app.patch('/api/orders/:id/delivery', requireAuth, async (req, res, next) => {
    const id = positiveId(req.params.id);
    if (supabaseFactory) {
      if (!id) return res.status(404).json({ error: 'Pedido de delivery no encontrado.' });
      const invalidDelivery = validateDelivery(req.body);
      if (invalidDelivery) return res.status(400).json({ error: invalidDelivery });
      try {
        const { error } = await req.supabase.rpc('update_delivery_info', {
          target_order_id: id,
          delivery_name: req.body.name.trim(),
          delivery_phone: req.body.phone.trim(),
          delivery_address: req.body.address.trim()
        });
        if (error) {
          if (respondSupabaseError(res, error)) return;
          throw error;
        }
        return res.status(204).end();
      } catch (error) {
        return next(error);
      }
    }
    const user = req.session.user;
    const order = id && db.prepare(`${orderSelect} WHERE id = ?`).get(id);
    const ownsOrder = order &&
      ((user.role === 'customer' && order.cliente_id === user.id) ||
       (user.role === 'cashier' && order.created_by === user.id));
    if (!order || order.order_type !== 'delivery' || (user.role !== 'admin' && !ownsOrder)) {
      return res.status(404).json({ error: 'Pedido de delivery no encontrado.' });
    }
    if (order.status !== 'pending') {
      return res.status(409).json({ error: 'Los datos de entrega solo pueden cambiar antes de iniciar la preparación.' });
    }
    const invalidDelivery = validateDelivery(req.body);
    if (invalidDelivery) return res.status(400).json({ error: invalidDelivery });
    const result = db.prepare(`UPDATE delivery_info SET customer_name = ?, phone = ?, address = ?
      WHERE order_id = ?`).run(req.body.name.trim(), req.body.phone.trim(), req.body.address.trim(), id);
    if (!result.changes) return res.status(404).json({ error: 'Datos de entrega no encontrados.' });
    res.status(204).end();
  });

  app.patch('/api/orders/:id/status', requireAuth, async (req, res, next) => {
    const id = positiveId(req.params.id);
    const newStatus = req.body?.status;
    const user = req.session.user;
    if (supabaseFactory) {
      if (!id) return res.status(400).json({ error: 'Identificador inválido.' });
      try {
        const { error } = await req.supabase.rpc('update_order_status', {
          target_order_id: id,
          requested_status: newStatus
        });
        if (error) {
          if (respondSupabaseError(res, error)) return;
          throw error;
        }
        const flags = {
          includeDelivery: user.role === 'admin',
          includePayment: user.role === 'admin',
          includeAmounts: user.role !== 'delivery' && user.role !== 'kitchen'
        };
        const rows = await loadRemoteOrders(req, flags, (query) => query.eq('id', id));
        if (!rows[0]) return res.status(404).json({ error: 'Pedido no encontrado.' });
        return res.json({ order: remoteOrderDto(rows[0], flags) });
      } catch (error) {
        return next(error);
      }
    }
    const row = id && db.prepare(`${orderSelect} WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: 'Pedido no encontrado.' });
    if (user.role === 'delivery' && row.repartidor_id !== user.id) {
      return res.status(404).json({ error: 'Pedido no encontrado.' });
    }
    const canKitchen = permissionCheck.get(user.role, 'orders:status:kitchen');
    const canDelivery = permissionCheck.get(user.role, 'orders:status:delivery');
    const canCancel = permissionCheck.get(user.role, 'orders:cancel');
    const isAdmin = user.role === 'admin';
    const allowed = STATUS_TRANSITIONS[row.status]?.has(newStatus) &&
      ((newStatus === 'cancelled' && (canCancel || isAdmin) && ['pending', 'preparing'].includes(row.status)) ||
       (newStatus === 'preparing' || newStatus === 'ready') && (canKitchen || isAdmin) ||
       (newStatus === 'out_for_delivery' || newStatus === 'delivered') && (canDelivery || isAdmin));
    if (!allowed) return res.status(403).json({ error: 'Transición de estado no permitida.' });
    const changeStatus = db.transaction(() => {
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(newStatus, id);
      db.prepare(`INSERT INTO order_status_history (order_id, changed_by, old_status, new_status)
        VALUES (?, ?, ?, ?)`).run(id, user.id, row.status, newStatus);
      if (newStatus === 'cancelled') {
        const items = db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ?').all(id);
        for (const item of items) {
          db.prepare('UPDATE inventory SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ?')
            .run(item.quantity, item.product_id);
          db.prepare(`INSERT INTO inventory_movements (product_id, changed_by, delta, reason)
            VALUES (?, ?, ?, 'Reversión por cancelación')`).run(item.product_id, user.id, item.quantity);
        }
      }
      return db.prepare(`${orderSelect} WHERE id = ?`).get(id);
    });
    res.json({ order: orderDto(changeStatus(), { includeDelivery: isAdmin, includePayment: isAdmin }) });
  });

  app.patch('/api/orders/:id/assign', requirePermission('orders:assign'), async (req, res, next) => {
    const id = positiveId(req.params.id);
    const assigneeId = positiveId(req.body?.deliveryUserId);
    if (supabaseFactory) {
      if (!id) return res.status(404).json({ error: 'Pedido de delivery no encontrado.' });
      if (!assigneeId) return res.status(400).json({ error: 'Repartidor activo inválido.' });
      try {
        const { error } = await req.supabase.rpc('assign_delivery_driver', {
          target_order_id: id,
          target_driver_id: assigneeId
        });
        if (error) {
          if (respondSupabaseError(res, error)) return;
          throw error;
        }
        return res.status(204).end();
      } catch (error) {
        return next(error);
      }
    }
    const assignee = assigneeId && db.prepare(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.id = ? AND r.id = 'delivery' AND u.active = 1`).get(assigneeId);
    const order = id && db.prepare(`${orderSelect} WHERE id = ? AND order_type = 'delivery'`).get(id);
    if (!order) return res.status(404).json({ error: 'Pedido de delivery no encontrado.' });
    if (!['pending', 'preparing', 'ready'].includes(order.status)) {
      return res.status(409).json({ error: 'No se puede asignar o reasignar una entrega cerrada.' });
    }
    if (!assignee) return res.status(400).json({ error: 'Repartidor activo inválido.' });
    db.prepare('UPDATE orders SET repartidor_id = ? WHERE id = ?').run(assignee.id, id);
    res.status(204).end();
  });

  app.get('/api/dashboard', requirePermission('dashboard:read'), async (req, res, next) => {
    if (supabaseFactory) {
      try {
        const { data, error } = await req.supabase.rpc('dashboard_metrics');
        if (error) throw error;
        return res.json({ metrics: {
          orderCount: data.orderCount,
          todaySalesCents: data.todaySalesCents,
          inProgress: data.inProgress,
          lowStock: data.lowStock
        } });
      } catch (error) {
        return next(error);
      }
    }
    const totals = db.prepare(`SELECT COUNT(*) AS order_count,
      COALESCE(SUM(CASE WHEN date(created_at) = date('now','localtime') THEN total_cents ELSE 0 END), 0) AS today_sales,
      COALESCE(SUM(CASE WHEN status IN ('pending','preparing','ready','out_for_delivery') THEN 1 ELSE 0 END), 0) AS in_progress
      FROM orders`).get();
    const lowStock = db.prepare(`SELECT COUNT(*) AS count FROM inventory i
      JOIN products p ON p.id = i.product_id WHERE p.active = 1 AND i.quantity <= i.low_stock_threshold`).get();
    res.json({ metrics: { orderCount: totals.order_count, todaySalesCents: totals.today_sales, inProgress: totals.in_progress, lowStock: lowStock.count } });
  });

  app.get('/api/users', requirePermission('users:manage'), async (req, res, next) => {
    if (supabaseFactory) {
      try {
        const { data, error } = await req.supabase
          .from('users')
          .select('id, name, email, active, role_id')
          .order('id');
        if (error) throw error;
        return res.json({ users: data.map((user) => ({
          id: user.id,
          name: user.name,
          email: user.email,
          active: user.active,
          role: user.role_id
        })) });
      } catch (error) {
        return next(error);
      }
    }
    const users = db.prepare(`SELECT u.id, u.name, u.email, u.active, r.id AS role
      FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.id`).all()
      .map((user) => ({ ...user, active: Boolean(user.active) }));
    res.json({ users });
  });

  app.post('/api/users', requirePermission('users:manage'), async (req, res, next) => {
    const name = safeString(req.body?.name, 100);
    const email = safeEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const role = req.body?.role;
    if (!name || !email || password.length < 12 || !VALID_ROLES.has(role)) {
      return res.status(400).json({ error: 'Nombre, correo, rol válido y contraseña de al menos 12 caracteres son obligatorios.' });
    }
    if (supabaseFactory) {
      let authUserId;
      try {
        const admin = createSupabaseAdminClient();
        const { data, error } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true
        });
        if (error) {
          if (respondSupabaseError(res, error)) return;
          throw error;
        }
        if (!data.user) throw new Error('Supabase Auth no devolvió el usuario creado.');
        authUserId = data.user.id;
        const { data: profile, error: profileError } = await admin
          .from('users')
          .insert({ auth_user_id: authUserId, name, email, role_id: role })
          .select('id')
          .single();
        if (profileError) {
          const { error: cleanupError } = await admin.auth.admin.deleteUser(authUserId);
          if (cleanupError) {
            console.error('No se pudo revertir la creación de la cuenta Auth tras fallar el perfil:', cleanupError);
          }
          if (respondSupabaseError(res, profileError)) return;
          throw profileError;
        }
        return res.status(201).json({ user: { id: profile.id, name, email, role, active: true } });
      } catch (error) {
        return next(error);
      }
    }
    try {
      const result = db.prepare(`INSERT INTO users (name, email, password_hash, role_id) VALUES (?, ?, ?, ?)`)
        .run(name, email, bcrypt.hashSync(password, 12), role);
      res.status(201).json({ user: { id: result.lastInsertRowid, name, email, role, active: true } });
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Ese correo ya está registrado.' });
      throw error;
    }
  });

  app.patch('/api/users/:id', requirePermission('users:manage'), async (req, res, next) => {
    const id = positiveId(req.params.id);
    if (!id || (req.body?.active !== 0 && req.body?.active !== 1)) {
      return res.status(400).json({ error: 'Identificador o estado activo inválido.' });
    }
    if (id === req.session.user.id && req.body.active === 0) {
      return res.status(400).json({ error: 'No puedes desactivar tu propia sesión.' });
    }
    if (supabaseFactory) {
      try {
        const { data, error } = await req.supabase
          .from('users')
          .update({ active: req.body.active === 1 })
          .eq('id', id)
          .select('id')
          .maybeSingle();
        if (error) {
          if (respondSupabaseError(res, error)) return;
          throw error;
        }
        if (!data) return res.status(404).json({ error: 'Usuario no encontrado.' });
        return res.status(204).end();
      } catch (error) {
        return next(error);
      }
    }
    const result = db.prepare('UPDATE users SET active = ? WHERE id = ?').run(req.body.active, id);
    if (!result.changes) return res.status(404).json({ error: 'Usuario no encontrado.' });
    res.status(204).end();
  });

  app.use(express.static(MOCKUP_DIR, { extensions: ['html'], index: 'index.html' }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta de API no encontrada.' }));
  app.use((error, req, res, next) => {
    console.error(error);
    if (res.headersSent) return next(error);
    res.status(500).json({ error: 'Error interno del servidor.' });
  });
  return app;
}

class DomainError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function respondSupabaseError(res, error) {
  const knownErrors = {
    '42501': [403, 'No tienes permiso para esta operación.'],
    '22023': [400, 'Los datos enviados no son válidos.'],
    '22P02': [400, 'Los datos enviados no son válidos.'],
    '22003': [400, 'Los datos enviados exceden el rango permitido.'],
    '22001': [400, 'Los datos enviados exceden la longitud permitida.'],
    '23505': [409, 'El registro ya existe.'],
    '23514': [400, 'Los datos enviados no cumplen las reglas del sistema.'],
    'P0001': [409, 'La operación no está permitida en el estado actual.'],
    'P0002': [404, 'No se encontró el registro solicitado.'],
    'email_exists': [409, 'Ese correo ya está registrado.'],
    'user_already_exists': [409, 'Ese correo ya está registrado.'],
    'weak_password': [400, 'La contraseña no cumple los requisitos de Supabase Auth.'],
    'email_address_invalid': [400, 'El correo no cumple el formato aceptado por Supabase Auth.'],
    'validation_failed': [400, 'Los datos de la cuenta no cumplen los requisitos de Supabase Auth.']
  };
  const code = error?.code || error?.status;
  const mapped = knownErrors[code];
  if (!mapped) return false;
  res.status(mapped[0]).json({ error: mapped[1] });
  return true;
}

function safeString(value, maxLength) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text && text.length <= maxLength ? text : '';
}

function safeEmail(value) {
  const email = safeString(value, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function validateProduct(body, { requireQuantity = true } = {}) {
  const name = safeString(body?.name, 100);
  const category = safeString(body?.category, 60);
  const description = typeof body?.description === 'string' ? body.description.trim().slice(0, 500) : '';
  const priceCents = body?.priceCents;
  const quantity = body?.quantity;
  const unit = safeString(body?.unit, 24);
  if (!name || !category || !Number.isSafeInteger(priceCents) || priceCents < 0 ||
      (requireQuantity && (!Number.isSafeInteger(quantity) || quantity < 0 || !unit))) {
    return { error: 'Nombre, categoría, precio válido y cantidad entera no negativa son obligatorios.' };
  }
  return { name, category, description, priceCents, quantity, unit };
}

function validateDelivery(delivery) {
  const name = safeString(delivery?.name, 100);
  const phone = safeString(delivery?.phone, 24);
  const address = safeString(delivery?.address, 240);
  if (!name || !/^[+0-9 ()-]{7,24}$/.test(phone) || !address) {
    return 'Nombre, teléfono válido y dirección son obligatorios para delivery.';
  }
  return '';
}

function normalizePersonalizations(options) {
  if (options === undefined) return [];
  if (!Array.isArray(options) || options.length > 8) return null;

  const extraPrices = new Map([
    ['Queso extra', 100],
    ['Tocino extra', 150],
    ['Huevo frito', 100],
    ['Aros de cebolla', 120]
  ]);
  const uniqueOptions = new Set();
  let hasSize = false;
  const normalized = [];

  for (const option of options) {
    let name = safeString(option?.name, 50);
    let value = safeString(option?.value, 100);
    if (!name || !value) return null;

    if (name === 'Personalización') {
      const legacyExtra = value.match(/^(Queso extra|Tocino extra|Huevo frito|Aros de cebolla)(?:\s*\+\s*Bs\s*\d+(?:\.\d{1,2})?)?$/i);
      const legacyRemoval = value.match(/^Sin\s+(Cebolla|Pickles)$/i);
      if (legacyExtra) {
        name = 'Extra';
        value = [...extraPrices.keys()].find((item) => item.toLowerCase() === legacyExtra[1].toLowerCase());
      } else if (legacyRemoval) {
        name = 'Sin';
        value = legacyRemoval[1].toLowerCase() === 'cebolla' ? 'Cebolla' : 'Pickles';
      }
    }

    let priceDeltaCents = 0;
    if (name === 'Tamaño') {
      if (hasSize || !['regular', 'grande'].includes(value)) return null;
      hasSize = true;
      if (value === 'grande') priceDeltaCents = 200;
    } else if (name === 'Extra') {
      if (!extraPrices.has(value)) return null;
      priceDeltaCents = extraPrices.get(value);
    } else if (name === 'Sin' && !['Cebolla', 'Pickles'].includes(value)) {
      return null;
    } else if (!['Sin'].includes(name)) {
      return null;
    }

    const uniqueKey = `${name.toLowerCase()}:${value.toLowerCase()}`;
    if (uniqueOptions.has(uniqueKey)) return null;
    uniqueOptions.add(uniqueKey);
    normalized.push({ name, value, priceDeltaCents });
  }

  return normalized;
}

module.exports = { createApp };
