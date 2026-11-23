/*
 * Remote BurgerFlow smoke test. This creates a small, tagged fixture set in
 * the linked project, exercises the Express API with normal Auth sessions,
 * then removes only rows/accounts carrying this run's unique tag.
 *
 * Run explicitly with: node scripts/supabase-remote-smoke.js --run
 * Requires no existing Auth users, profiles, or orders. Existing catalog and
 * inventory rows may remain; this run's product fixtures are uniquely tagged.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
delete process.env.SUPABASE_DB_PASSWORD;
process.env.NODE_ENV = 'test';

const PROJECT_REF = 'vwobduocgjcreulhebxb';
const RUN_TAG = crypto.randomBytes(5).toString('hex');
const PREFIX = `bf-${RUN_TAG}-`;
const PRODUCT_NAME = `BF Codex Test ${RUN_TAG} Burger`;
const PRODUCT_UPDATED_NAME = `BF Codex Test ${RUN_TAG} Burger Updated`;
const root = path.resolve(__dirname, '..');
const completed = [];
const profileIds = new Map();
const createdOrderIds = new Set();
const createdProductIds = new Set();
let adminClient;
let db;
let server;
let activeStage = 'preflight';
let failureStage = '';
let cleanupFailed = false;
let cleanupFailureStage = '';
let cleanupFile = '';
let fixturesStarted = false;
let safeServerErrorCode = '';
let safeServerErrorStatus;
let safeRemoteErrorCode = '';
let safeRemoteErrorStatus;

const originalConsoleError = console.error;
console.error = (...args) => {
  const error = args[0];
  if (typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(error.code)) {
    safeServerErrorCode = error.code;
  }
  if (Number.isInteger(error?.status)) safeServerErrorStatus = error.status;
};

function fail(stage) {
  activeStage = stage;
  throw new Error('remote-smoke-check-failed');
}

function check(condition, stage) {
  activeStage = stage;
  if (!condition) fail(stage);
  completed.push(`${stage}=ok`);
}

async function expectStatus(stage, action, expectedStatus) {
  activeStage = stage;
  const response = await action;
  if (response.status !== expectedStatus) fail(`${stage}-http-${response.status}-expected-${expectedStatus}`);
  completed.push(`${stage}=${expectedStatus}`);
  return response;
}

function safeEmail(role) {
  return `${PREFIX}${role}@example.com`;
}

function safePassword() {
  return crypto.randomBytes(24).toString('base64url');
}

function isNonPlaceholderKey(value, prefix) {
  return typeof value === 'string' && value.startsWith(prefix) &&
    value.length > prefix.length + 12 &&
    !/[<>]/.test(value) &&
    !/(?:replace_|your[-_]|example[-_]?key|clave|placeholder)/i.test(value);
}

function getRemoteAdminClient() {
  const url = process.env.SUPABASE_URL?.trim();
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    fail('supabase-url-invalid');
  }
  check(parsedUrl.protocol === 'https:' && parsedUrl.hostname === `${PROJECT_REF}.supabase.co`, 'project-url-matches');
  check(isNonPlaceholderKey(publishableKey, 'sb_publishable_'), 'publishable-key-nonplaceholder');
  check(isNonPlaceholderKey(secretKey, 'sb_secret_'), 'secret-key-nonplaceholder');
  check(!process.env.DATA_BACKEND || process.env.DATA_BACKEND === 'sqlite', 'sqlite-remains-default');

  const { createClient } = require('@supabase/supabase-js');
  adminClient = createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
  });
  return adminClient;
}

async function countRows(table) {
  activeStage = `baseline-${table}`;
  const { count, error } = await adminClient.from(table).select('id', { count: 'exact', head: true });
  if (error) {
    if (typeof error.code === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(error.code)) safeRemoteErrorCode = error.code;
    if (Number.isInteger(error.status)) safeRemoteErrorStatus = error.status;
    fail(`baseline-${table}-query-failed`);
  }
  return count || 0;
}

async function createTestUser(role, name, password, viaApi, adminAgent, accountKey = role) {
  const email = safeEmail(accountKey);
  if (viaApi) {
    const response = await expectStatus(`admin-create-${accountKey}`, adminAgent.post('/api/users').send({
      name,
      email,
      password,
      role
    }), 201);
    const id = Number(response.body?.user?.id);
    check(Number.isSafeInteger(id) && id > 0 && response.body?.user?.role === role, `profile-${accountKey}-created`);
    profileIds.set(accountKey, id);
    return { email, password, id };
  }

  activeStage = 'bootstrap-test-admin-auth';
  const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });
  if (authError || !authData?.user?.id) fail('bootstrap-test-admin-auth-failed');

  activeStage = 'bootstrap-test-admin-profile';
  const { data: profile, error: profileError } = await adminClient.from('users')
    .insert({ auth_user_id: authData.user.id, name, email, role_id: role })
    .select('id')
    .single();
  if (profileError || !profile?.id) {
    await adminClient.auth.admin.deleteUser(authData.user.id);
    fail('bootstrap-test-admin-profile-failed');
  }
  profileIds.set(role, Number(profile.id));
  completed.push('bootstrap-test-admin=provisioned');
  return { email, password, id: Number(profile.id) };
}

async function startServer() {
  const { createApp } = require('../backend/app');
  const app = createApp({
    db,
    supabaseMode: true,
    testMode: true,
    sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function stopServer() {
  if (!server) return;
  const current = server;
  server = null;
  await new Promise((resolve) => current.close(resolve));
}

async function login(baseUrl, role, credentials, accountKey = role) {
  const request = require('supertest');
  const agent = request.agent(baseUrl);
  const response = await expectStatus(`auth-login-${accountKey}`, agent.post('/api/auth/login').send({
    email: credentials.email,
    password: credentials.password
  }), 200);
  check(response.body?.user?.role === role, `auth-session-role-${accountKey}`);
  return agent;
}

async function findTestProfiles() {
  const { data, error } = await adminClient.from('users')
    .select('id, auth_user_id, email')
    .like('email', `${PREFIX}%@example.com`);
  if (error) throw new Error('cleanup-profile-discovery-failed');
  for (const row of data || []) profileIds.set(`cleanup-${row.id}`, Number(row.id));
  return (data || []).map((row) => ({ id: Number(row.id), authUserId: row.auth_user_id }));
}

async function discoverProducts() {
  const { data, error } = await adminClient.from('products').select('id').like('name', `BF Codex Test ${RUN_TAG}%`);
  if (error) throw new Error('cleanup-product-discovery-failed');
  for (const row of data || []) createdProductIds.add(Number(row.id));
}

async function discoverOrders(knownProfileIds) {
  for (const column of ['created_by', 'cliente_id', 'repartidor_id']) {
    if (!knownProfileIds.length) continue;
    const { data, error } = await adminClient.from('orders').select('id').in(column, knownProfileIds);
    if (error) throw new Error('cleanup-order-discovery-failed');
    for (const row of data || []) createdOrderIds.add(Number(row.id));
  }
}

function idList(values) {
  const safe = [...new Set(values)].filter((value) => Number.isSafeInteger(value) && value > 0);
  return safe.length ? safe.join(',') : 'null';
}

async function cleanup() {
  if (!adminClient || !fixturesStarted) return;
  try {
    const profiles = await findTestProfiles();
    const allProfileIds = [...new Set(profiles.map((row) => row.id))];
    await discoverProducts();
    await discoverOrders(allProfileIds);

    const usersToDelete = [...new Set(profiles.map((row) => row.authUserId).filter(Boolean))];
    activeStage = 'cleanup-auth-list';
    const { data: authPage, error: authError } = await adminClient.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (authError) throw new Error('cleanup-auth-discovery-failed');
    for (const user of authPage?.users || []) {
      if (typeof user.email === 'string' && user.email.startsWith(PREFIX)) usersToDelete.push(user.id);
    }

    const orderIds = idList(createdOrderIds);
    const productIds = idList(createdProductIds);
    const profileIdSql = idList(allProfileIds);
    const cleanupSql = [
      'begin;',
      `delete from public.personalizations where order_item_id in (select id from public.order_items where order_id in (${orderIds}));`,
      `delete from public.order_status_history where order_id in (${orderIds});`,
      `delete from public.delivery_info where order_id in (${orderIds});`,
      `delete from public.order_items where order_id in (${orderIds});`,
      `delete from public.order_financials where order_id in (${orderIds});`,
      `delete from public.order_payments where order_id in (${orderIds});`,
      `delete from public.orders where id in (${orderIds});`,
      `delete from public.inventory_movements where product_id in (${productIds});`,
      `delete from public.inventory where product_id in (${productIds});`,
      `delete from public.products where id in (${productIds});`,
      `delete from public.users where id in (${profileIdSql});`,
      'commit;'
    ].join('\n');
    cleanupFile = path.join(os.tmpdir(), `burgerflow-${RUN_TAG}-cleanup.sql`);
    fs.writeFileSync(cleanupFile, cleanupSql, { encoding: 'utf8', flag: 'wx' });
    activeStage = 'cleanup-test-rows';
    const cli = spawnSync(process.execPath, [
      path.join(root, 'scripts', 'supabase-cli.js'),
      'db', 'query', '--remote', '--file', cleanupFile, '--yes'
    ], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (cli.error || cli.status !== 0) throw new Error('cleanup-test-rows-failed');

    for (const authUserId of new Set(usersToDelete)) {
      activeStage = 'cleanup-test-auth-user';
      const { error } = await adminClient.auth.admin.deleteUser(authUserId);
      if (error) throw new Error('cleanup-test-auth-user-failed');
    }
    fs.rmSync(cleanupFile, { force: true });
    cleanupFile = '';
  } catch {
    cleanupFailed = true;
    cleanupFailureStage = activeStage;
  }
}

async function run() {
  if (!process.argv.includes('--run')) fail('explicit-run-flag-required');
  getRemoteAdminClient();

  const [profileCount, orderCount] = await Promise.all([
    countRows('users'), countRows('orders')
  ]);
  activeStage = 'auth-user-baseline';
  const { data: authPage, error: authError } = await adminClient.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (authError) fail('auth-user-baseline-query-failed');
  check(profileCount === 0 && orderCount === 0 && (authPage?.users?.length || 0) === 0,
    'remote-baseline-users-and-orders-empty');

  const { migrate } = require('../backend/db');
  const Database = require('better-sqlite3');
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const passwords = new Map();
  const roles = ['admin', 'cashier', 'kitchen', 'delivery-a', 'delivery-b', 'customer-a', 'customer-b'];
  const labels = {
    admin: 'BF Remote Test Admin',
    cashier: 'BF Remote Test Cashier',
    kitchen: 'BF Remote Test Kitchen',
    'delivery-a': 'BF Remote Test Driver A',
    'delivery-b': 'BF Remote Test Driver B',
    'customer-a': 'BF Remote Test Customer A',
    'customer-b': 'BF Remote Test Customer B'
  };
  const roleIds = {
    admin: 'admin', cashier: 'cashier', kitchen: 'kitchen',
    'delivery-a': 'delivery', 'delivery-b': 'delivery',
    'customer-a': 'customer', 'customer-b': 'customer'
  };

  const credentials = {};
  credentials.admin = { email: safeEmail('admin'), password: safePassword() };
  fixturesStarted = true;
  const adminUser = await createTestUser('admin', `${labels.admin} ${RUN_TAG}`, credentials.admin.password, false);
  credentials.admin.id = adminUser.id;

  let baseUrl = await startServer();
  const request = require('supertest');
  let adminAgent = await login(baseUrl, 'admin', credentials.admin);

  const usersList = await expectStatus('admin-list-users', adminAgent.get('/api/users'), 200);
  check(usersList.body?.users?.some((user) => user.role === 'admin'), 'admin-can-read-user-profiles');

  for (const role of roles.slice(1)) {
    const password = safePassword();
    passwords.set(role, password);
    credentials[role] = await createTestUser(roleIds[role], `${labels[role]} ${RUN_TAG}`, password, true, adminAgent, role);
  }

  const noSelfDeactivate = await expectStatus('admin-self-deactivation-invalid', adminAgent.patch(`/api/users/${credentials.admin.id}`).send({ active: 0 }), 400);
  check(Boolean(noSelfDeactivate.body?.error), 'admin-cannot-deactivate-own-session');

  const customerA = await login(baseUrl, 'customer', credentials['customer-a'], 'customer-a');
  const customerB = await login(baseUrl, 'customer', credentials['customer-b'], 'customer-b');
  let cashier = await login(baseUrl, 'cashier', credentials.cashier);
  const kitchen = await login(baseUrl, 'kitchen', credentials.kitchen);
  const driverA = await login(baseUrl, 'delivery', credentials['delivery-a'], 'delivery-a');
  const driverB = await login(baseUrl, 'delivery', credentials['delivery-b'], 'delivery-b');

  const deactivated = await expectStatus('admin-deactivate-cashier', adminAgent.patch(`/api/users/${credentials.cashier.id}`).send({ active: 0 }), 204);
  check(deactivated.status === 204, 'admin-can-deactivate-user');
  const inactiveSession = await expectStatus('inactive-profile-no-session', cashier.get('/api/auth/me'), 200);
  check(inactiveSession.body?.user === null, 'inactive-user-session-cleared');
  await expectStatus('admin-reactivate-cashier', adminAgent.patch(`/api/users/${credentials.cashier.id}`).send({ active: 1 }), 204);
  cashier = await login(baseUrl, 'cashier', credentials.cashier, 'cashier-reactivated');

  const forbiddenUserCreate = await expectStatus('cashier-cannot-create-user', cashier.post('/api/users').send({
    name: 'Forbidden Test', email: safeEmail('forbidden'), password: safePassword(), role: 'customer'
  }), 403);
  check(Boolean(forbiddenUserCreate.body?.error), 'user-write-denied-for-cashier');
  await expectStatus('cashier-cannot-list-users', cashier.get('/api/users'), 403);
  await expectStatus('anonymous-inventory-unauthorized', request(baseUrl).get('/api/inventory'), 401);
  await expectStatus('cashier-inventory-read-denied', cashier.get('/api/inventory'), 403);
  await expectStatus('customer-inventory-read-denied', customerA.get('/api/inventory'), 403);
  await expectStatus('cashier-kitchen-read-denied', cashier.get('/api/orders/kitchen'), 403);
  await expectStatus('delivery-general-orders-denied', driverA.get('/api/orders'), 403);

  const productResponse = await expectStatus('admin-create-product', adminAgent.post('/api/products').send({
    name: PRODUCT_NAME,
    category: 'Pruebas remotas',
    description: `Registro efímero ${RUN_TAG}`,
    priceCents: 1250,
    quantity: 10,
    unit: 'unidades'
  }), 201);
  const product = productResponse.body?.product;
  check(Number.isSafeInteger(Number(product?.id)) && product.quantity === 10, 'product-created-with-inventory');
  const productId = Number(product.id);
  createdProductIds.add(productId);

  const invalidProduct = await expectStatus('invalid-product-price', adminAgent.post('/api/products').send({
    name: `${PRODUCT_NAME} invalid`, category: 'Pruebas remotas', description: '', priceCents: -1, quantity: 2, unit: 'unidades'
  }), 400);
  check(Boolean(invalidProduct.body?.error), 'invalid-product-rejected');
  await expectStatus('cashier-product-write-denied', cashier.post('/api/products').send({
    name: `${PRODUCT_NAME} forbidden`, category: 'Pruebas remotas', priceCents: 100, quantity: 1, unit: 'unidades'
  }), 403);

  const publicProducts = await expectStatus('anonymous-active-products', request(baseUrl).get('/api/products'), 200);
  const publicProduct = publicProducts.body?.products?.find((item) => item.id === productId);
  check(Boolean(publicProduct) && !Object.hasOwn(publicProduct, 'quantity'), 'public-catalog-hides-inventory');

  const updatedProduct = await expectStatus('admin-update-product', adminAgent.patch(`/api/products/${productId}`).send({
    name: PRODUCT_UPDATED_NAME,
    description: `Actualizado ${RUN_TAG}`,
    priceCents: 1400
  }), 200);
  check(updatedProduct.body?.product?.name === PRODUCT_UPDATED_NAME && updatedProduct.body?.product?.priceCents === 1400,
    'product-update-persists');

  await expectStatus('invalid-inventory-negative', adminAgent.patch(`/api/inventory/${productId}`).send({ quantity: -1, reason: 'Prueba inválida' }), 400);
  const adjustedInventory = await expectStatus('admin-adjust-inventory', adminAgent.patch(`/api/inventory/${productId}`).send({
    quantity: 12,
    reason: `Ajuste de prueba ${RUN_TAG}`
  }), 200);
  check(adjustedInventory.body?.product?.quantity === 12, 'inventory-adjustment-persists');

  const invalidUser = await expectStatus('invalid-user-input', adminAgent.post('/api/users').send({
    name: 'Inválido', email: safeEmail('invalid'), password: 'corta', role: 'customer'
  }), 400);
  check(Boolean(invalidUser.body?.error), 'invalid-user-rejected');

  const invalidOrder = await expectStatus('invalid-order-quantity', customerA.post('/api/orders').send({
    orderType: 'pickup', paymentMethod: 'cash', items: [{ productId, quantity: 0 }]
  }), 400);
  check(Boolean(invalidOrder.body?.error), 'invalid-order-rejected');
  const invalidDelivery = await expectStatus('invalid-delivery-phone', customerA.post('/api/orders').send({
    orderType: 'delivery', paymentMethod: 'qr',
    delivery: { name: 'Prueba', phone: 'abc', address: 'Calle Prueba 1' },
    items: [{ productId, quantity: 1 }]
  }), 400);
  check(Boolean(invalidDelivery.body?.error), 'invalid-delivery-rejected');

  const deliveryOrder = await expectStatus('customer-create-delivery-order', customerA.post('/api/orders').send({
    orderType: 'delivery',
    paymentMethod: 'qr',
    delivery: { name: `Cliente de prueba ${RUN_TAG}`, phone: '+591 70000000', address: `Calle Prueba ${RUN_TAG}, Ciudad Demo` },
    items: [{ productId, quantity: 2, personalizations: [{ name: 'Tamaño', value: 'grande' }] }]
  }), 201);
  const order = deliveryOrder.body?.order;
  const orderId = Number(order?.id);
  check(Number.isSafeInteger(orderId) && order.items?.length === 1 && order.items[0].lineTotalCents === 3200,
    'order-lines-and-pricing-created');
  createdOrderIds.add(orderId);
  check(order.delivery?.address === `Calle Prueba ${RUN_TAG}, Ciudad Demo` && !Object.hasOwn(order, 'paymentMethod'),
    'customer-sees-own-delivery-but-not-payment');

  const customerOwnOrder = await expectStatus('customer-read-own-order', customerA.get(`/api/orders/${orderId}`), 200);
  check(customerOwnOrder.body?.order?.id === orderId, 'customer-can-read-own-order');
  const customerOtherOrder = await expectStatus('customer-cannot-read-other-order', customerB.get(`/api/orders/${orderId}`), 404);
  check(!JSON.stringify(customerOtherOrder.body).includes(`Calle Prueba ${RUN_TAG}`), 'other-customer-response-hides-private-data');
  const customerBOrders = await expectStatus('customer-list-isolated-by-owner', customerB.get('/api/orders'), 200);
  check(Array.isArray(customerBOrders.body?.orders) && !customerBOrders.body.orders.some((item) => item.id === orderId),
    'customer-rsl-isolates-own-orders');

  const editedDeliveryAddress = `Dirección de prueba ${RUN_TAG} revisada`;
  await expectStatus('customer-update-own-delivery', customerA.patch(`/api/orders/${orderId}/delivery`).send({
    name: `Cliente de prueba ${RUN_TAG}`,
    phone: '+591 70000001',
    address: editedDeliveryAddress
  }), 204);

  const assignedDriverA = await expectStatus('driver-a-read-initial-assignment', driverA.get(`/api/orders/${orderId}`), 200);
  check(assignedDriverA.body?.order?.delivery?.address === editedDeliveryAddress && !Object.hasOwn(assignedDriverA.body.order, 'totalCents'),
    'driver-a-gets-assigned-address-without-totals');
  const unassignedDriverB = await expectStatus('driver-b-denied-before-assignment', driverB.get(`/api/orders/${orderId}`), 404);
  check(!JSON.stringify(unassignedDriverB.body).includes(editedDeliveryAddress), 'unassigned-driver-response-hides-address');

  await expectStatus('reassignment-to-invalid-role-rejected', adminAgent.patch(`/api/orders/${orderId}/assign`).send({
    deliveryUserId: credentials.cashier.id
  }), 400);
  await expectStatus('admin-reassign-driver-a-to-b', adminAgent.patch(`/api/orders/${orderId}/assign`).send({
    deliveryUserId: credentials['delivery-b'].id
  }), 204);
  const formerDriverA = await expectStatus('former-driver-a-gets-404-after-reassignment', driverA.get(`/api/orders/${orderId}`), 404);
  check(!JSON.stringify(formerDriverA.body).includes(editedDeliveryAddress) && !JSON.stringify(formerDriverA.body).includes('+591 70000001'),
    'former-driver-response-has-no-personal-data');
  const newDriverB = await expectStatus('driver-b-reads-after-reassignment', driverB.get(`/api/orders/${orderId}`), 200);
  check(newDriverB.body?.order?.delivery?.address === editedDeliveryAddress && !Object.hasOwn(newDriverB.body.order, 'totalCents'),
    'new-driver-can-read-address-without-totals');

  const kitchenOrders = await expectStatus('kitchen-read-active-orders', kitchen.get('/api/orders/kitchen'), 200);
  const kitchenOrder = kitchenOrders.body?.orders?.find((item) => item.id === orderId);
  check(Boolean(kitchenOrder) && !Object.hasOwn(kitchenOrder, 'delivery') && !Object.hasOwn(kitchenOrder, 'totalCents'),
    'kitchen-response-omits-contact-and-amounts');
  await expectStatus('kitchen-start-order', kitchen.patch(`/api/orders/${orderId}/status`).send({ status: 'preparing' }), 200);
  await expectStatus('kitchen-cannot-cancel', kitchen.patch(`/api/orders/${orderId}/status`).send({ status: 'cancelled' }), 403);
  await expectStatus('kitchen-ready-order', kitchen.patch(`/api/orders/${orderId}/status`).send({ status: 'ready' }), 200);
  const deliveryQueue = await expectStatus('driver-b-delivery-queue', driverB.get('/api/orders/delivery'), 200);
  check(deliveryQueue.body?.orders?.some((item) => item.id === orderId && item.delivery?.address === editedDeliveryAddress),
    'delivery-queue-shows-assigned-address');
  const oldDriverQueue = await expectStatus('driver-a-delivery-queue-after-reassignment', driverA.get('/api/orders/delivery'), 200);
  check(!oldDriverQueue.body?.orders?.some((item) => item.id === orderId), 'former-driver-queue-excludes-order');
  await expectStatus('driver-b-start-delivery', driverB.patch(`/api/orders/${orderId}/status`).send({ status: 'out_for_delivery' }), 200);
  await expectStatus('driver-b-complete-delivery', driverB.patch(`/api/orders/${orderId}/status`).send({ status: 'delivered' }), 200);

  const cashierReauthenticated = await login(baseUrl, 'cashier', credentials.cashier);
  const cashierOrder = await expectStatus('cashier-read-order-payment', cashierReauthenticated.get(`/api/orders/${orderId}`), 200);
  check(cashierOrder.body?.order?.paymentMethod === 'qr', 'cashier-can-read-payment-method');
  const customerOrderNoPayment = await expectStatus('customer-payment-hidden', customerA.get(`/api/orders/${orderId}`), 200);
  check(!Object.hasOwn(customerOrderNoPayment.body?.order || {}, 'paymentMethod'), 'customer-cannot-read-payment-method');

  const pickupOrder = await expectStatus('cashier-create-pickup-order', cashierReauthenticated.post('/api/orders').send({
    orderType: 'pickup', paymentMethod: 'cash', customerId: credentials['customer-a'].id,
    items: [{ productId, quantity: 1 }]
  }), 201);
  const pickupOrderId = Number(pickupOrder.body?.order?.id);
  check(Number.isSafeInteger(pickupOrderId) && pickupOrder.body?.order?.paymentMethod === 'cash', 'cashier-order-includes-payment');
  createdOrderIds.add(pickupOrderId);

  const customerCannotCancel = await expectStatus('customer-cannot-cancel-order', customerA.patch(`/api/orders/${pickupOrderId}/status`).send({ status: 'cancelled' }), 403);
  check(Boolean(customerCannotCancel.body?.error), 'customer-status-transition-denied');
  await expectStatus('cashier-cancel-pickup-order', cashierReauthenticated.patch(`/api/orders/${pickupOrderId}/status`).send({ status: 'cancelled' }), 200);
  const inventoryAfterCancel = await expectStatus('inventory-restored-after-cancel', adminAgent.get('/api/inventory'), 200);
  check(inventoryAfterCancel.body?.inventory?.find((item) => item.id === productId)?.quantity === 10,
    'order-cancel-restores-inventory');

  await stopServer();
  baseUrl = await startServer();
  adminAgent = await login(baseUrl, 'admin', credentials.admin);
  const afterRestartProduct = await expectStatus('restarted-app-reads-product', adminAgent.get('/api/products'), 200);
  check(afterRestartProduct.body?.products?.some((item) => item.id === productId && item.name === PRODUCT_UPDATED_NAME),
    'product-persists-after-app-restart');
  const afterRestartOrder = await expectStatus('restarted-app-reads-order', adminAgent.get(`/api/orders/${orderId}`), 200);
  check(afterRestartOrder.body?.order?.status === 'delivered' && afterRestartOrder.body?.order?.delivery?.address === editedDeliveryAddress,
    'order-lines-status-and-delivery-persist-after-app-restart');
  const afterRestartInventory = await expectStatus('restarted-app-reads-inventory', adminAgent.get('/api/inventory'), 200);
  check(afterRestartInventory.body?.inventory?.find((item) => item.id === productId)?.quantity === 10,
    'inventory-persists-after-app-restart');

  await expectStatus('admin-soft-delete-test-product', adminAgent.delete(`/api/products/${productId}`), 204);
  const publicProductsAfterDelete = await expectStatus('anonymous-catalog-hides-deactivated-product', request(baseUrl).get('/api/products'), 200);
  check(!publicProductsAfterDelete.body?.products?.some((item) => item.id === productId), 'product-soft-delete-effective');
}

(async () => {
  try {
    await run();
  } catch {
    failureStage = activeStage;
  }
  await stopServer().catch(() => {});
  await cleanup();
  try {
    if (db) db.close();
  } catch {
    cleanupFailed = true;
  }
  console.error = originalConsoleError;
  const output = {
    success: !failureStage && !cleanupFailed,
    stage: failureStage || (cleanupFailed ? 'cleanup-failed' : 'complete'),
    cleanup: cleanupFailed ? 'incomplete' : (fixturesStarted ? 'test-records-and-auth-users-removed' : 'no-test-data-created'),
    cleanup_stage: cleanupFailureStage || undefined,
    server_error_code: safeServerErrorCode || undefined,
    server_error_status: safeServerErrorStatus,
    remote_error_code: safeRemoteErrorCode || undefined,
    remote_error_status: safeRemoteErrorStatus,
    checks: completed
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (!output.success) process.exitCode = 1;
})();
