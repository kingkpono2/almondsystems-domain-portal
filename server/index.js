import crypto from 'node:crypto';
import tls from 'node:tls';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { nanoid } from 'nanoid';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const publicDir = path.resolve(__dirname, '../frontend/dist');
const dataDir = process.env.ORDER_DATA_DIR || '/data';
const auditFile = path.join(dataDir, 'orders.jsonl');
const orderDir = path.join(dataDir, 'orders');
const usersFile = path.join(dataDir, 'users.json');
const sessionsFile = path.join(dataDir, 'sessions.json');
const passwordResetsFile = path.join(dataDir, 'password-resets.json');
const allowedTlds = new Set(['com', 'com.ng', 'ng', 'net', 'org', 'africa', 'co', 'io', 'biz', 'info']);
const defaultTlds = ['com', 'com.ng', 'ng', 'net', 'org'];
const baseUrl = (process.env.NAMECOM_BASE_URL || 'https://api.name.com').replace(/\/$/, '');
const username = process.env.NAMECOM_USERNAME || '';
const token = process.env.NAMECOM_TOKEN || '';
const enableLiveRegistration = process.env.ENABLE_LIVE_REGISTRATION === 'true';
const adminKey = process.env.ADMIN_ORDER_KEY || '';
const paystackSecret = process.env.PAYSTACK_SECRET_KEY || '';
const paystackCurrency = process.env.PAYSTACK_CURRENCY || 'NGN';
const fallbackUsdToNgn = Number(process.env.DOMAIN_USD_TO_NGN || 1700);
const exchangeRateTtlMs = Number(process.env.EXCHANGE_RATE_TTL_MINUTES || 120) * 60 * 1000;
let exchangeRateCache = { rate: fallbackUsdToNgn, fetchedAt: 0, source: "fallback" };
const serviceFeeNgn = Number(process.env.DOMAIN_SERVICE_FEE_NGN || 5000);
const siteBaseUrl = (process.env.SITE_BASE_URL || 'https://almondsystems.com.ng').replace(/\/$/, '');
const smtpHost = process.env.SMTP_HOST || 'smtp.zoho.com';
const smtpPort = Number(process.env.SMTP_PORT || 465);
const smtpUser = process.env.SMTP_USER || '';
const smtpPass = process.env.SMTP_PASS || '';
const mailFrom = process.env.MAIL_FROM || `Almond Systems <${smtpUser || 'admin@almondsystems.com.ng'}>`;
const adminEmail = process.env.ADMIN_EMAIL || smtpUser || 'admin@almondsystems.com.ng';
const reminderDelayMinutes = Number(process.env.CHECKOUT_REMINDER_DELAY_MINUTES || 60);
const reminderIntervalMinutes = Number(process.env.CHECKOUT_REMINDER_INTERVAL_MINUTES || 15);

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('combined'));

const apiLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
const orderLimiter = rateLimit({ windowMs: 60_000, limit: 8, standardHeaders: true, legacyHeaders: false });
const adminLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

function cleanDomain(value) {
  return String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[^a-z0-9.-]/g, '').replace(/\.+/g, '.').replace(/^\.|\.$/g, '');
}

function cleanKeyword(value) {
  return String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[^a-z0-9-]/g, '').slice(0, 63);
}

function safeTlds(values) {
  const list = Array.isArray(values) ? values : defaultTlds;
  const clean = list.map((tld) => String(tld).toLowerCase().replace(/^\./, '')).filter((tld) => allowedTlds.has(tld));
  return clean.length ? clean.slice(0, 10) : defaultTlds;
}

function safeReference(value) {
  return String(value || '').replace(/[^A-Za-z0-9=._-]/g, '').slice(0, 80);
}

function statusLabel(status) {
  return String(status || '').replace(/-/g, ' ');
}

function parseCookies(req) {
  return String(req.headers.cookie || '').split(';').reduce((cookies, part) => {
    const index = part.indexOf('=');
    if (index < 0) return cookies;
    const key = part.slice(0, index).trim();
    if (!key) return cookies;
    cookies[key] = decodeURIComponent(part.slice(index + 1).trim());
    return cookies;
  }, {});
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function publicUser(user) {
  if (!user) return null;
  return { userId: user.userId, name: user.name, email: user.email, createdAt: user.createdAt };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 210000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  if (!user?.salt || !user?.passwordHash) return false;
  const computed = hashPassword(password, user.salt).hash;
  return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(user.passwordHash, 'hex'));
}


function smtpRead(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (/^\d{3} /.test(last)) {
        socket.off('data', onData);
        socket.off('error', onError);
        resolve(buffer);
      }
    };
    const onError = (error) => {
      socket.off('data', onData);
      reject(error);
    };
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

async function smtpCommand(socket, command, expected = /^[23]/) {
  if (command) socket.write(`${command}\r\n`);
  const response = await smtpRead(socket);
  if (!expected.test(response)) throw new Error(`SMTP command failed: ${response.trim()}`);
  return response;
}

function parseEmailAddress(value) {
  const match = String(value || '').match(/<([^>]+)>/);
  return (match ? match[1] : value).trim();
}

function encodeHeader(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function dotStuff(value) {
  return String(value || '').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

async function sendMail({ to, subject, text, html }) {
  if (!smtpUser || !smtpPass || !to) return false;
  const recipients = Array.isArray(to) ? to : [to];
  const fromAddress = parseEmailAddress(mailFrom);
  const boundary = `almond-${crypto.randomBytes(12).toString('hex')}`;
  const message = [
    `From: ${encodeHeader(mailFrom)}`,
    `To: ${recipients.map(encodeHeader).join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text || '',
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    html || `<pre>${String(text || '').replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]))}</pre>`,
    '',
    `--${boundary}--`,
    ''
  ].join('\r\n');

  const socket = tls.connect({ host: smtpHost, port: smtpPort, servername: smtpHost });
  try {
    await smtpCommand(socket, null);
    await smtpCommand(socket, `EHLO ${new URL(siteBaseUrl).hostname || 'almondsystems.com.ng'}`);
    await smtpCommand(socket, 'AUTH LOGIN', /^334/);
    await smtpCommand(socket, Buffer.from(smtpUser).toString('base64'), /^334/);
    await smtpCommand(socket, Buffer.from(smtpPass).toString('base64'));
    await smtpCommand(socket, `MAIL FROM:<${fromAddress}>`);
    for (const recipient of recipients) await smtpCommand(socket, `RCPT TO:<${parseEmailAddress(recipient)}>`);
    await smtpCommand(socket, 'DATA', /^354/);
    await smtpCommand(socket, `${dotStuff(message)}\r\n.`, /^250/);
    await smtpCommand(socket, 'QUIT', /^[23]/).catch(() => {});
    return true;
  } finally {
    socket.end();
  }
}

function orderItemsText(order) {
  const items = Array.isArray(order.items) && order.items.length ? order.items : [{ domainName: order.domainName, purchaseType: order.purchaseType, years: order.years }];
  return items.map((item) => `- ${item.domainName} (${item.purchaseType === 'transfer' ? 'transfer' : 'registration'}, ${item.years || order.years || 1} year${Number(item.years || order.years || 1) === 1 ? '' : 's'})`).join('\n');
}

async function notifySignup(user) {
  const text = `Welcome to Almond Systems, ${user.name}.\n\nYour domain account has been created with ${user.email}. You can now search, add domains to cart, and checkout securely.\n\n${siteBaseUrl}/domains/`;
  const html = `<p>Welcome to Almond Systems, <strong>${user.name}</strong>.</p><p>Your domain account has been created with ${user.email}. You can now search, add domains to cart, and checkout securely.</p><p><a href="${siteBaseUrl}/domains/">Open domain portal</a></p>`;
  await sendMail({ to: user.email, subject: 'Welcome to Almond Systems Domains', text, html });
  await sendMail({ to: adminEmail, subject: `New Almond Systems signup: ${user.email}`, text: `New signup\n\nName: ${user.name}\nEmail: ${user.email}\nUser ID: ${user.userId}`, html: `<p>New signup</p><p><strong>${user.name}</strong><br>${user.email}<br>${user.userId}</p>` });
}


function orderInvoiceText(order, intro = 'Your Almond Systems domain invoice is ready.') {
  const items = orderItemsText(order);
  const amount = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(order.payment.totalNgn || 0);
  return `${intro}\n\nInvoice: ${order.orderId}\nCustomer: ${order.customer.name}\nAmount: ${amount}\nStatus: ${statusLabel(order.status)}\n\nItems:\n${items}\n\nComplete payment: ${order.payment.authorizationUrl || `${siteBaseUrl}/domains/`}\n\nIf you have questions, reply to this email or contact Almond Systems support.`;
}

function orderInvoiceHtml(order, intro = 'Your Almond Systems domain invoice is ready.') {
  const items = orderItemsText(order);
  const amount = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(order.payment.totalNgn || 0);
  const payUrl = order.payment.authorizationUrl || `${siteBaseUrl}/domains/`;
  return `<div style="font-family:Inter,Arial,sans-serif;color:#172033;line-height:1.55"><h2 style="margin:0 0 12px">${intro}</h2><p><strong>Invoice:</strong> ${order.orderId}<br><strong>Customer:</strong> ${order.customer.name}<br><strong>Amount:</strong> ${amount}<br><strong>Status:</strong> ${statusLabel(order.status)}</p><pre style="background:#f5f7fb;border:1px solid #e2e8f0;border-radius:10px;padding:12px;white-space:pre-wrap">${items}</pre><p><a href="${payUrl}" style="display:inline-block;background:#1d315d;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px">Complete secure payment</a></p><p style="color:#5e6878">If you have questions, reply to this email or contact Almond Systems support.</p></div>`;
}

async function notifyInvoiceCreated(order) {
  if (!order.customer?.email || !order.payment?.authorizationUrl) return false;
  await sendMail({
    to: order.customer.email,
    subject: `Invoice ${order.orderId} - Almond Systems Domains`,
    text: orderInvoiceText(order),
    html: orderInvoiceHtml(order)
  });
  await sendMail({
    to: adminEmail,
    subject: `Domain invoice created: ${order.orderId}`,
    text: orderInvoiceText(order, 'A domain invoice was created.'),
    html: orderInvoiceHtml(order, 'A domain invoice was created.')
  });
  return true;
}

async function notifyPaymentReminder(order) {
  if (!order.customer?.email || !order.payment?.authorizationUrl) return false;
  await sendMail({
    to: order.customer.email,
    subject: `Reminder: complete invoice ${order.orderId}`,
    text: orderInvoiceText(order, 'Your Almond Systems domain order is still waiting for payment.'),
    html: orderInvoiceHtml(order, 'Your Almond Systems domain order is still waiting for payment.')
  });
  return true;
}

async function notifyPasswordReset(user, token) {
  const url = `${siteBaseUrl}/domains/?resetToken=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email)}`;
  const text = `Password reset requested for Almond Systems Domains.\n\nUse this secure link within 30 minutes:\n${url}\n\nIf you did not request this, ignore this email.`;
  const html = `<p>Password reset requested for Almond Systems Domains.</p><p><a href="${url}">Reset your password</a></p><p>This link expires in 30 minutes. If you did not request this, ignore this email.</p>`;
  await sendMail({ to: user.email, subject: 'Reset your Almond Systems password', text, html });
}

async function sendDueReminders() {
  const orders = await listOrders();
  const now = Date.now();
  for (const order of orders) {
    if (order.status !== 'payment-pending' || !order.payment?.authorizationUrl) continue;
    if (order.emailSent?.paymentReminderAt) continue;
    const base = Date.parse(order.payment.invoiceSentAt || order.updatedAt || order.createdAt || '');
    if (!base || now - base < reminderDelayMinutes * 60 * 1000) continue;
    try {
      await notifyPaymentReminder(order);
      order.emailSent = { ...(order.emailSent || {}), paymentReminderAt: new Date().toISOString() };
      order.updatedAt = new Date().toISOString();
      await saveOrder(order, 'payment_reminder_sent');
    } catch (error) {
      console.error('Payment reminder email failed', error);
    }
  }
}

async function notifyOrderConfirmed(order) {
  const items = orderItemsText(order);
  const amount = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(order.payment.totalNgn || 0);
  const text = `Payment received for your Almond Systems domain order.\n\nOrder: ${order.orderId}\nCustomer: ${order.customer.name}\nAmount: ${amount}\n\nItems:\n${items}\n\nStatus: Awaiting Almond Systems approval before live registration or transfer.\n\n${siteBaseUrl}/domains/`;
  const html = `<p>Payment received for your Almond Systems domain order.</p><p><strong>Order:</strong> ${order.orderId}<br><strong>Amount:</strong> ${amount}</p><pre>${items}</pre><p>Status: Awaiting Almond Systems approval before live registration or transfer.</p><p><a href="${siteBaseUrl}/domains/">Open domain portal</a></p>`;
  await sendMail({ to: order.customer.email, subject: `Payment received: ${order.orderId}`, text, html });
  await sendMail({ to: adminEmail, subject: `Paid domain order awaiting approval: ${order.orderId}`, text, html: `<p>Paid order awaiting approval.</p><p><strong>${order.orderId}</strong><br>${order.customer.name}<br>${order.customer.email}<br>${order.customer.phone}<br>${amount}</p><pre>${items}</pre>` });
}

async function createSession(res, userId) {
  const sessions = await readJsonFile(sessionsFile, {});
  const sessionId = crypto.randomBytes(32).toString('base64url');
  sessions[sessionId] = { userId, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString() };
  await writeJsonFile(sessionsFile, sessions);
  res.setHeader('Set-Cookie', `almond_session=${encodeURIComponent(sessionId)}; Path=/domains; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
  return sessionId;
}

async function currentUser(req) {
  const sessionId = parseCookies(req).almond_session;
  if (!sessionId) return null;
  const sessions = await readJsonFile(sessionsFile, {});
  const session = sessions[sessionId];
  if (!session || Date.parse(session.expiresAt) < Date.now()) return null;
  const users = await readJsonFile(usersFile, {});
  return users[session.userId] || null;
}

async function clearSession(req, res) {
  const sessionId = parseCookies(req).almond_session;
  if (sessionId) {
    const sessions = await readJsonFile(sessionsFile, {});
    delete sessions[sessionId];
    await writeJsonFile(sessionsFile, sessions);
  }
  res.setHeader('Set-Cookie', 'almond_session=; Path=/domains; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
}

function normalizeCartItems(body) {
  const rawItems = Array.isArray(body.items) && body.items.length ? body.items : [{ domainName: body.domainName, purchaseType: body.purchaseType, years: body.years, authCode: body.authCode }];
  return rawItems.slice(0, 10).map((item) => ({
    domainName: cleanDomain(item.domainName),
    purchaseType: item.purchaseType === 'transfer' ? 'transfer' : 'registration',
    years: Math.max(1, Math.min(5, Number(item.years || body.years || 1))),
    authCode: String(item.authCode || '').trim().slice(0, 160)
  })).filter((item) => item.domainName);
}

async function getUsdToNgnRate() {
  const now = Date.now();
  if (exchangeRateCache.rate && now - exchangeRateCache.fetchedAt < exchangeRateTtlMs) return exchangeRateCache;
  try {
    const response = await fetch("https://open.er-api.com/v6/latest/USD", { headers: { Accept: "application/json" } });
    const data = await response.json().catch(() => ({}));
    const rate = Number(data?.rates?.NGN);
    if (response.ok && Number.isFinite(rate) && rate > 100) {
      exchangeRateCache = { rate, fetchedAt: now, source: "open.er-api.com" };
      return exchangeRateCache;
    }
    throw new Error(data?.error_type || "Exchange rate response missing NGN.");
  } catch (error) {
    console.error("Exchange rate lookup failed; using fallback rate", error.message);
    exchangeRateCache = { rate: exchangeRateCache.rate || fallbackUsdToNgn, fetchedAt: now, source: "fallback" };
    return exchangeRateCache;
  }
}

function toNairaFromUsd(value, rate) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.ceil(amount * rate);
}

async function estimateCart(items) {
  const registrarEstimateUsd = Number(items.reduce((sum, item) => {
    const firstYearUsd = Number(item.availability.purchasePrice || 0);
    const renewalUsd = Number(item.availability.renewalPrice || item.availability.purchasePrice || 0);
    return sum + Math.max(firstYearUsd + Math.max(0, item.years - 1) * renewalUsd, firstYearUsd);
  }, 0).toFixed(2));
  const rateInfo = await getUsdToNgnRate();
  const registrarEstimateNgn = Math.ceil(registrarEstimateUsd * rateInfo.rate);
  const totalServiceFeeNgn = serviceFeeNgn * Math.max(1, items.length);
  const totalNgn = Math.max(1, registrarEstimateNgn + totalServiceFeeNgn);
  return {
    registrarEstimateUsd,
    registrarEstimateNgn,
    serviceFeeNgn: totalServiceFeeNgn,
    totalNgn,
    amountKobo: totalNgn * 100,
    currency: paystackCurrency,
    usdToNgn: rateInfo.rate,
    exchangeRateSource: rateInfo.source
  };
}

function orderPath(reference) {
  const clean = safeReference(reference);
  if (!clean) throw new Error('Invalid order reference.');
  return path.join(orderDir, `${clean}.json`);
}

function publicResult(item, rate = exchangeRateCache.rate || fallbackUsdToNgn) {
  return {
    domainName: item.domainName,
    purchasable: Boolean(item.purchasable),
    premium: Boolean(item.premium),
    purchasePrice: item.purchasePrice,
    renewalPrice: item.renewalPrice,
    purchasePriceNgn: toNairaFromUsd(item.purchasePrice, rate),
    renewalPriceNgn: toNairaFromUsd(item.renewalPrice || item.purchasePrice, rate),
    exchangeRate: rate,
    purchaseType: item.purchaseType || 'registration',
    reason: item.reason || ''
  };
}

function estimatePrice(availability, years) {
  const firstYearUsd = Number(availability.purchasePrice || 0);
  const renewalUsd = Number(availability.renewalPrice || availability.purchasePrice || 0);
  const registrarEstimateUsd = Math.max(firstYearUsd + Math.max(0, years - 1) * renewalUsd, firstYearUsd);
  const registrarEstimateNgn = Math.ceil(registrarEstimateUsd * (exchangeRateCache.rate || fallbackUsdToNgn));
  const totalNgn = Math.max(1, registrarEstimateNgn + serviceFeeNgn);
  return {
    registrarEstimateUsd: Number(registrarEstimateUsd.toFixed(2)),
    registrarEstimateNgn,
    serviceFeeNgn,
    totalNgn,
    amountKobo: totalNgn * 100,
    currency: paystackCurrency,
    usdToNgn: exchangeRateCache.rate || fallbackUsdToNgn
  };
}

function isAdmin(req) {
  const supplied = String(req.get('x-admin-key') || '');
  if (!adminKey || !supplied) return false;
  const expected = Buffer.from(adminKey);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ ok: false, message: 'Unauthorized.' });
  next();
}

async function registrarRequest(method, endpoint, body, headers = {}) {
  if (!username || !token) {
    const error = new Error('Domain service is not configured yet.');
    error.status = 503;
    throw error;
  }

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(payload.message || payload.details || 'Domain service request failed.');
    error.status = response.status >= 500 ? 502 : response.status;
    error.details = payload.details;
    throw error;
  }
  return payload;
}

async function paystackRequest(method, endpoint, body) {
  if (!paystackSecret) {
    const error = new Error('Paystack live secret key is not configured yet.');
    error.status = 503;
    throw error;
  }

  const response = await fetch(`https://api.paystack.co${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${paystackSecret}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status === false) {
    const error = new Error(payload.message || 'Payment service request failed.');
    error.status = response.status >= 500 ? 502 : response.status;
    throw error;
  }
  return payload;
}

async function checkAvailability(domainName, purchaseType = 'registration') {
  const safePurchaseType = purchaseType === 'transfer' ? 'transfer' : 'registration';
  const data = await registrarRequest('POST', '/core/v1/domains:checkAvailability', {
    domainNames: [domainName],
    purchaseType: safePurchaseType
  });
  const rateInfo = await getUsdToNgnRate();
  return (data.results || []).map((item) => publicResult(item, rateInfo.rate))[0];
}

async function appendAudit(event) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.appendFile(auditFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}

async function saveOrder(order, auditType = 'order_saved') {
  await fs.mkdir(orderDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(orderPath(order.orderId), JSON.stringify(order, null, 2), { mode: 0o600 });
  await appendAudit({ type: auditType, orderId: order.orderId, status: order.status });
}

async function loadOrder(reference) {
  const text = await fs.readFile(orderPath(reference), 'utf8');
  return JSON.parse(text);
}

async function listOrders() {
  await fs.mkdir(orderDir, { recursive: true, mode: 0o700 });
  const files = await fs.readdir(orderDir);
  const orders = await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => {
    try {
      return JSON.parse(await fs.readFile(path.join(orderDir, file), 'utf8'));
    } catch {
      return null;
    }
  }));
  return orders.filter(Boolean).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function publicOrder(order) {
  return {
    orderId: order.orderId,
    domainName: order.domainName,
    purchaseType: order.purchaseType || order.items?.[0]?.purchaseType || 'registration',
    items: order.items || null,
    years: order.years,
    status: order.status,
    payment: order.payment ? {
      amountNgn: order.payment.totalNgn,
      currency: order.payment.currency,
      reference: order.payment.reference,
      confirmedAt: order.payment.confirmedAt || null
    } : null,
    registration: order.registration ? {
      domainName: order.registration.domain?.domainName,
      expireDate: order.registration.domain?.expireDate,
      order: order.registration.order,
      totalPaid: order.registration.totalPaid
    } : null,
    message: order.message || ''
  };
}

function adminOrder(order) {
  return {
    ...publicOrder(order),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt || null,
    availability: order.availability,
    customer: order.customer,
    registrationError: order.registrationError || null,
    paymentVerification: order.payment?.verification || null
  };
}

async function initializePayment(order) {
  const payload = await paystackRequest('POST', '/transaction/initialize', {
    email: order.customer.email,
    amount: String(order.payment.amountKobo),
    currency: order.payment.currency,
    reference: order.payment.reference,
    callback_url: `${siteBaseUrl}/domains/payment/callback`,
    metadata: {
      orderId: order.orderId,
      domainName: order.domainName,
      itemCount: order.items?.length || 1,
      years: order.years,
      customerName: order.customer.name,
      custom_fields: [
        { display_name: 'Domain', variable_name: 'domain_name', value: order.domainName },
        { display_name: 'Order ID', variable_name: 'order_id', value: order.orderId }
      ]
    }
  });
  return payload.data;
}

async function verifyPaidOrder(reference) {
  const order = await loadOrder(reference);
  if (['registered', 'transfer-started', 'completed'].includes(order.status) && order.registration) return order;

  const verification = await paystackRequest('GET', `/transaction/verify/${encodeURIComponent(order.payment.reference)}`);
  const data = verification.data || {};
  const paid = data.status === 'success';
  const amountMatches = Number(data.amount) === Number(order.payment.amountKobo);
  const currencyMatches = String(data.currency || '').toUpperCase() === String(order.payment.currency || '').toUpperCase();

  order.payment.verification = {
    status: data.status,
    amount: data.amount,
    currency: data.currency,
    paidAt: data.paid_at || data.paidAt || null,
    gatewayResponse: data.gateway_response || ''
  };
  order.updatedAt = new Date().toISOString();

  if (!paid || !amountMatches || !currencyMatches) {
    order.status = 'payment-verification-failed';
    order.message = 'Payment could not be verified for this order amount.';
    await saveOrder(order, 'payment_verification_failed');
    return order;
  }

  order.status = 'payment-confirmed-awaiting-approval';
  order.message = `Payment confirmed. Awaiting Almond Systems approval for live ${order.purchaseType === 'transfer' ? 'transfer' : 'registration'}.`;
  order.payment.confirmedAt = order.payment.confirmedAt || new Date().toISOString();
  if (!order.emailSent?.paymentConfirmedAt) {
    try {
      await notifyOrderConfirmed(order);
      order.emailSent = { ...(order.emailSent || {}), paymentConfirmedAt: new Date().toISOString() };
    } catch (emailError) {
      console.error('Order confirmation email failed', emailError);
    }
  }
  await saveOrder(order, 'payment_confirmed');
  return order;
}

async function registerApprovedOrder(order, approver = 'admin') {
  if (!enableLiveRegistration) {
    const error = new Error('Live registration is disabled.');
    error.status = 403;
    throw error;
  }

  if (['registered', 'transfer-started', 'completed'].includes(order.status) && order.registration) return order;
  if (!['payment-confirmed-awaiting-approval', 'registration-failed'].includes(order.status)) {
    const error = new Error('Order must have a verified payment before approval.');
    error.status = 409;
    throw error;
  }

  const sourceItems = Array.isArray(order.items) && order.items.length ? order.items : [{
    domainName: order.domainName,
    purchaseType: order.purchaseType === 'transfer' ? 'transfer' : 'registration',
    years: order.years || 1,
    authCode: order.transfer?.authCode || '',
    availability: order.availability || null
  }];
  const registrations = [];

  for (const [index, item] of sourceItems.entries()) {
    const purchaseType = item.purchaseType === 'transfer' ? 'transfer' : 'registration';
    const availability = await checkAvailability(item.domainName, purchaseType);
    if (!availability?.purchasable || availability.purchaseType !== purchaseType) {
      order.status = 'registration-failed';
      order.message = purchaseType === 'transfer'
        ? `Payment confirmed, but ${item.domainName} is not currently eligible for transfer.`
        : `Payment confirmed, but ${item.domainName} is no longer available for standard registration.`;
      order.registrationError = { domainName: item.domainName, availability };
      order.updatedAt = new Date().toISOString();
      await saveOrder(order, 'registration_failed');
      return order;
    }

    const domain = {
      domainName: item.domainName,
      purchaseType: availability.purchaseType,
      years: item.years || order.years || 1,
      ...(purchaseType === 'transfer' ? { authCode: item.authCode || order.transfer?.authCode || '' } : {}),
      autorenewEnabled: true,
      locked: true,
      privacyEnabled: true
    };
    if (availability.premium && availability.purchasePrice) domain.purchasePrice = availability.purchasePrice;

    const idempotencyKey = crypto.createHash('sha256').update(`${order.idempotencyKey}-${index}-${item.domainName}`).digest('hex');
    const data = await registrarRequest('POST', '/core/v1/domains', { domain }, { 'X-Idempotency-Key': idempotencyKey });
    registrations.push({ domainName: item.domainName, purchaseType, data });
  }

  const hasTransfer = sourceItems.some((item) => item.purchaseType === 'transfer');
  const hasRegistration = sourceItems.some((item) => item.purchaseType !== 'transfer');
  order.status = hasTransfer && hasRegistration ? 'completed' : hasTransfer ? 'transfer-started' : 'registered';
  order.message = hasTransfer && hasRegistration
    ? 'Payment confirmed and domain registration/transfer actions have been submitted.'
    : hasTransfer ? 'Payment confirmed and domain transfer started.' : 'Payment confirmed and domain registered.';
  order.registration = registrations.length === 1 ? registrations[0].data : { items: registrations };
  order.approvedBy = approver;
  order.registeredAt = new Date().toISOString();
  order.updatedAt = new Date().toISOString();
  await saveOrder(order, 'domain_registered');
  return order;
}

app.post('/domains/api/paystack/webhook', express.raw({ type: 'application/json', limit: '120kb' }), async (req, res) => {
  try {
    if (!paystackSecret) return res.sendStatus(503);
    const signature = req.get('x-paystack-signature') || '';
    const expected = crypto.createHmac('sha512', paystackSecret).update(req.body).digest('hex');
    if (signature !== expected) return res.sendStatus(401);
    const event = JSON.parse(req.body.toString('utf8'));
    if (event.event === 'charge.success' && event.data?.reference) {
      verifyPaidOrder(event.data.reference).catch((error) => console.error('Paystack webhook verification failed', error));
    }
    res.sendStatus(200);
  } catch (error) {
    console.error(error);
    res.sendStatus(500);
  }
});

app.use(express.json({ limit: '80kb' }));
app.use('/domains/assets', express.static(path.join(publicDir, 'assets'), { maxAge: '1y', immutable: true }));
app.use('/domains', express.static(publicDir, { index: false }));

app.get('/domains/health', (req, res) => {
  res.json({ ok: true, portal: 'almondsystems-domains', liveRegistration: enableLiveRegistration, paystack: Boolean(paystackSecret), approvalRequired: true });
});

app.get('/domains/api/auth/me', apiLimiter, async (req, res, next) => {
  try {
    res.json({ ok: true, user: publicUser(await currentUser(req)) });
  } catch (error) {
    next(error);
  }
});

app.post('/domains/api/auth/signup', apiLimiter, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 120);
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
    const password = String(req.body.password || '');
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) {
      return res.status(422).json({ ok: false, message: 'Enter a name, valid email, and password of at least 8 characters.' });
    }
    const users = await readJsonFile(usersFile, {});
    if (Object.values(users).some((user) => user.email === email)) {
      return res.status(409).json({ ok: false, message: 'An account with that email already exists.' });
    }
    const userId = `ASU-${nanoid(10).toUpperCase()}`;
    const passwordData = hashPassword(password);
    const user = { userId, name, email, salt: passwordData.salt, passwordHash: passwordData.hash, createdAt: new Date().toISOString() };
    users[userId] = user;
    await writeJsonFile(usersFile, users);
    await createSession(res, userId);
    notifySignup(user).catch((error) => console.error('Signup email failed', error));
    res.status(201).json({ ok: true, user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post('/domains/api/auth/login', apiLimiter, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const users = await readJsonFile(usersFile, {});
    const user = Object.values(users).find((item) => item.email === email);
    if (!user || !verifyPassword(password, user)) return res.status(401).json({ ok: false, message: 'Invalid email or password.' });
    await createSession(res, user.userId);
    res.json({ ok: true, user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});


app.post('/domains/api/auth/forgot-password', apiLimiter, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const users = await readJsonFile(usersFile, {});
    const user = Object.values(users).find((item) => item.email === email);
    if (user) {
      const tokens = await readJsonFile(passwordResetsFile, {});
      const token = crypto.randomBytes(32).toString('base64url');
      tokens[token] = { userId: user.userId, email: user.email, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), usedAt: null };
      await writeJsonFile(passwordResetsFile, tokens);
      notifyPasswordReset(user, token).catch((error) => console.error('Password reset email failed', error));
    }
    res.json({ ok: true, message: 'If an account exists for that email, a reset link has been sent.' });
  } catch (error) {
    next(error);
  }
});

app.post('/domains/api/auth/reset-password', apiLimiter, async (req, res, next) => {
  try {
    const token = String(req.body.token || '').trim();
    const password = String(req.body.password || '');
    if (!token || password.length < 8) return res.status(422).json({ ok: false, message: 'A valid token and password of at least 8 characters are required.' });
    const tokens = await readJsonFile(passwordResetsFile, {});
    const reset = tokens[token];
    if (!reset || reset.usedAt || Date.parse(reset.expiresAt) < Date.now()) return res.status(400).json({ ok: false, message: 'Password reset link is invalid or expired.' });
    const users = await readJsonFile(usersFile, {});
    const user = users[reset.userId];
    if (!user) return res.status(400).json({ ok: false, message: 'Password reset link is invalid or expired.' });
    const passwordData = hashPassword(password);
    user.salt = passwordData.salt;
    user.passwordHash = passwordData.hash;
    user.updatedAt = new Date().toISOString();
    reset.usedAt = new Date().toISOString();
    users[user.userId] = user;
    tokens[token] = reset;
    await writeJsonFile(usersFile, users);
    await writeJsonFile(passwordResetsFile, tokens);
    await createSession(res, user.userId);
    res.json({ ok: true, user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post('/domains/api/auth/logout', apiLimiter, async (req, res, next) => {
  try {
    await clearSession(req, res);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/domains/api/search', apiLimiter, async (req, res, next) => {
  try {
    const input = cleanDomain(req.body.query);
    const purchaseType = req.body.purchaseType === 'transfer' ? 'transfer' : 'registration';
    if (!input) return res.status(422).json({ ok: false, message: 'Enter a valid domain search.' });

    if (purchaseType === 'transfer') {
      if (!input.includes('.')) return res.status(422).json({ ok: false, message: 'Enter the full domain you want to transfer.' });
      const result = await checkAvailability(input, 'transfer');
      return res.json({ ok: true, results: result ? [result] : [] });
    }

    if (input.includes('.')) {
      const result = await checkAvailability(input, 'registration');
      return res.json({ ok: true, results: result ? [result] : [] });
    }

    const keyword = cleanKeyword(input);
    if (!keyword) return res.status(422).json({ ok: false, message: 'Enter a valid name idea.' });
    const data = await registrarRequest('POST', '/core/v1/domains:search', {
      keyword,
      timeout: 2500,
      tldFilter: safeTlds(req.body.tlds),
      purchaseType: 'registration'
    });
    const rateInfo = await getUsdToNgnRate();
    res.json({ ok: true, exchangeRate: rateInfo.rate, exchangeRateSource: rateInfo.source, results: (data.results || []).map((item) => publicResult(item, rateInfo.rate)) });
  } catch (error) {
    next(error);
  }
});

app.post('/domains/api/orders', orderLimiter, async (req, res, next) => {
  try {
    const cartItems = normalizeCartItems(req.body);
    const domainName = cartItems.length === 1 ? cartItems[0].domainName : `${cartItems[0]?.domainName} + ${cartItems.length - 1} more`;
    const purchaseType = cartItems.length === 1 ? cartItems[0].purchaseType : 'cart';
    const name = String(req.body.name || '').trim().slice(0, 120);
    const email = String(req.body.email || '').trim().slice(0, 160);
    const phone = String(req.body.phone || '').trim().slice(0, 80);
    const years = Math.max(1, Math.min(5, Number(req.body.years || 1)));
    const authCode = String(req.body.authCode || '').trim().slice(0, 160);
    if (!cartItems.length || !name || !email || !phone) return res.status(422).json({ ok: false, message: 'Domain, name, email, and phone are required.' });

    const checkedItems = [];
    for (const item of cartItems) {
      if (item.purchaseType === 'transfer' && !item.authCode) {
        return res.status(422).json({ ok: false, message: `Transfer authorization code is required for ${item.domainName}.` });
      }
      const availability = await checkAvailability(item.domainName, item.purchaseType);
      if (!availability?.purchasable || availability.purchaseType !== item.purchaseType) {
        return res.status(409).json({ ok: false, message: item.purchaseType === 'transfer' ? `${item.domainName} is not currently eligible for transfer.` : `${item.domainName} is no longer available for standard registration.` });
      }
      checkedItems.push({ ...item, availability });
    }

    const orderId = `ASD-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${nanoid(8).toUpperCase()}`;
    const payment = await estimateCart(checkedItems);
    payment.reference = orderId;

    const order = {
      orderId,
      createdAt: new Date().toISOString(),
      domainName,
      purchaseType,
      years,
      idempotencyKey: nanoid(32),
      customer: {
        name,
        email,
        phone,
        business: String(req.body.business || '').trim().slice(0, 140),
        notes: String(req.body.notes || '').trim().slice(0, 600)
      },
      availability: checkedItems[0]?.availability || null,
      items: checkedItems,
      ...(purchaseType === 'transfer' ? { transfer: { authCode: checkedItems[0]?.authCode || authCode } } : {}),
      payment,
      status: 'payment-initializing',
      message: 'Preparing secure payment.'
    };
    await saveOrder(order, 'order_created');

    try {
      const paystack = await initializePayment(order);
      order.status = 'payment-pending';
      order.message = 'Payment link created. Awaiting customer payment.';
      order.payment.accessCode = paystack.access_code;
      order.payment.authorizationUrl = paystack.authorization_url;
      order.updatedAt = new Date().toISOString();
      if (!order.emailSent?.invoiceSentAt) {
        try {
          await notifyInvoiceCreated(order);
          order.emailSent = { ...(order.emailSent || {}), invoiceSentAt: new Date().toISOString() };
          order.payment.invoiceSentAt = order.emailSent.invoiceSentAt;
        } catch (emailError) {
          console.error('Invoice email failed', emailError);
        }
      }
      await saveOrder(order, 'payment_initialized');
      return res.status(201).json({ ok: true, order: publicOrder(order), payment: { authorizationUrl: paystack.authorization_url, accessCode: paystack.access_code, reference: paystack.reference } });
    } catch (error) {
      order.status = 'payment-initialization-failed';
      order.message = error.message || 'Could not initialize payment.';
      order.updatedAt = new Date().toISOString();
      await saveOrder(order, 'payment_initialization_failed');
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

app.get('/domains/api/orders/:reference', apiLimiter, async (req, res, next) => {
  try {
    const order = await loadOrder(req.params.reference);
    res.json({ ok: true, order: publicOrder(order) });
  } catch (error) {
    error.status = 404;
    next(error);
  }
});

app.get('/domains/payment/callback', async (req, res) => {
  const reference = safeReference(req.query.reference);
  if (!reference) return res.redirect('/domains/?payment=missing-reference');
  try {
    const order = await verifyPaidOrder(reference);
    res.redirect(`/domains/?payment=${encodeURIComponent(order.status)}&reference=${encodeURIComponent(reference)}`);
  } catch (error) {
    console.error(error);
    res.redirect(`/domains/?payment=verification-error&reference=${encodeURIComponent(reference)}`);
  }
});

app.get('/domains/api/admin/orders', adminLimiter, requireAdmin, async (req, res, next) => {
  try {
    const status = String(req.query.status || 'all');
    const orders = await listOrders();
    const filtered = status === 'all' ? orders : orders.filter((order) => order.status === status);
    res.json({ ok: true, orders: filtered.map(adminOrder) });
  } catch (error) {
    next(error);
  }
});

app.post('/domains/api/admin/orders/:reference/verify-payment', adminLimiter, requireAdmin, async (req, res, next) => {
  try {
    const order = await verifyPaidOrder(req.params.reference);
    res.json({ ok: true, order: adminOrder(order) });
  } catch (error) {
    next(error);
  }
});

app.post('/domains/api/admin/orders/:reference/approve', adminLimiter, requireAdmin, async (req, res, next) => {
  try {
    let order = await loadOrder(req.params.reference);
    if (order.status === 'payment-pending') order = await verifyPaidOrder(order.orderId);
    const registered = await registerApprovedOrder(order, 'admin');
    res.json({ ok: ['registered', 'transfer-started', 'completed'].includes(registered.status), order: adminOrder(registered) });
  } catch (error) {
    next(error);
  }
});

app.post('/domains/api/admin/orders/:reference/hold', adminLimiter, requireAdmin, async (req, res, next) => {
  try {
    const order = await loadOrder(req.params.reference);
    if (!['payment-confirmed-awaiting-approval', 'registration-failed', 'payment-pending'].includes(order.status)) {
      return res.status(409).json({ ok: false, message: 'Only pending or paid orders can be placed on hold.' });
    }
    order.status = 'admin-hold';
    order.message = String(req.body.message || 'Order placed on admin hold.').slice(0, 240);
    order.updatedAt = new Date().toISOString();
    await saveOrder(order, 'admin_hold');
    res.json({ ok: true, order: adminOrder(order) });
  } catch (error) {
    next(error);
  }
});

app.get(['/domains', '/domains/', '/domains/admin'], (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/domains/*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.use((error, req, res, _next) => {
  const status = Number(error.status || 500);
  console.error(error);
  res.status(status).json({ ok: false, message: status >= 500 ? 'Domain service is temporarily unavailable.' : error.message });
});

setInterval(() => sendDueReminders().catch((error) => console.error('Reminder scan failed', error)), Math.max(1, reminderIntervalMinutes) * 60 * 1000);
sendDueReminders().catch((error) => console.error('Initial reminder scan failed', error));

app.listen(port, '0.0.0.0', () => {
  console.log(`Almond Systems domain portal listening on ${port}`);
});
