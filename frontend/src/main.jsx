import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowLeft, Check, CheckCircle2, CreditCard, Globe2, Headphones, KeyRound, Lock, LogOut, RefreshCw, Search, ShieldCheck, ShoppingCart, Sparkles, Trash2, User, X } from 'lucide-react';
import './styles.css';

const defaultTlds = ['com', 'com.ng', 'ng', 'net', 'org', 'africa', 'co', 'io'];
const orderStatuses = ['all', 'payment-pending', 'payment-confirmed-awaiting-approval', 'registered', 'transfer-started', 'registration-failed', 'payment-verification-failed', 'admin-hold'];
const serviceSteps = [
  { icon: Search, title: 'Search live inventory', text: 'Check available domains and transfers with live registrar data.' },
  { icon: CreditCard, title: 'Secure Paystack checkout', text: 'Pay with supported cards, bank transfer, and local payment channels.' },
  { icon: ShieldCheck, title: 'Admin-reviewed orders', text: 'Every paid order is reviewed before billable registration or transfer.' },
  { icon: Headphones, title: 'Launch support', text: 'Get help with DNS, hosting, email, SSL, and launch handoff.' }
];
const cartStorageKey = 'almond-domain-cart-v3';

function naira(value) {
  const amount = Number(value || 0);
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(amount);
}

function cleanInput(value) {
  return value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[^a-z0-9.-]/g, '');
}

function statusLabel(status) {
  return String(status || '').replace(/-/g, ' ');
}

function itemKey(item) {
  return `${item.domainName}-${item.purchaseType || 'registration'}`;
}

function itemEstimate(item) {
  const firstYear = Number(item.purchasePriceNgn || 0);
  const renewal = Number(item.renewalPriceNgn || item.purchasePriceNgn || 0);
  const years = Number(item.years || 1);
  return Math.max(firstYear + Math.max(0, years - 1) * renewal, firstYear);
}

function PaymentMarks() {
  return (
    <div className="payment-marks" aria-label="Cards and payment methods supported by Paystack">
      <span className="paystack-mark">paystack</span>
      <span className="card-mark visa">VISA</span>
      <span className="card-mark mastercard"><i /><i /><b>mastercard</b></span>
      <span className="card-mark verve">Verve</span>
      <span className="card-mark amex">AMEX</span>
      <span className="card-mark transfer">Bank transfer</span>
    </div>
  );
}

function CustomerPortal() {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('registration');
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState({ type: 'idle', message: '' });
  const [orderStatus, setOrderStatus] = useState('');
  const [callbackNotice, setCallbackNotice] = useState(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState('login');
  const [authMessage, setAuthMessage] = useState('');
  const [resetToken, setResetToken] = useState(() => new URLSearchParams(window.location.search).get('resetToken') || '');
  const [user, setUser] = useState(null);
  const [cartItems, setCartItems] = useState(() => {
    try { return JSON.parse(localStorage.getItem(cartStorageKey) || '[]'); } catch { return []; }
  });
  const [form, setForm] = useState({ name: '', email: '', phone: '', business: '', notes: '' });
  const [authForm, setAuthForm] = useState(() => ({ name: '', email: new URLSearchParams(window.location.search).get('email') || '', password: '' }));

  const availableResults = useMemo(() => results.filter((item) => item.purchasable), [results]);
  const unavailableResults = useMemo(() => results.filter((item) => !item.purchasable), [results]);
  const cartTotalNgn = useMemo(() => cartItems.reduce((sum, item) => sum + itemEstimate(item), 0), [cartItems]);

  useEffect(() => {
    localStorage.setItem(cartStorageKey, JSON.stringify(cartItems));
  }, [cartItems]);

  useEffect(() => {
    if (resetToken) { setAuthMode('reset'); setAuthOpen(true); }
  }, [resetToken]);

  useEffect(() => {
    fetch('/domains/api/auth/me')
      .then((response) => response.json())
      .then((payload) => {
        if (payload.user) {
          setUser(payload.user);
          setForm((current) => ({ ...current, name: current.name || payload.user.name || '', email: current.email || payload.user.email || '' }));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const payment = params.get('payment');
    const reference = params.get('reference');
    if (!payment && !reference) return;
    if (!reference) {
      setCallbackNotice({ type: 'error', title: 'Payment update', message: statusLabel(payment) });
      return;
    }
    fetch(`/domains/api/orders/${encodeURIComponent(reference)}`)
      .then((response) => response.json())
      .then((payload) => {
        if (!payload.ok) throw new Error(payload.message || 'Could not load order status.');
        const order = payload.order;
        const isGood = ['registered', 'transfer-started', 'payment-confirmed-awaiting-approval'].includes(order.status);
        setCallbackNotice({
          type: isGood ? 'success' : 'error',
          title: order.status === 'registered' ? 'Domain registered' : 'Payment received',
          message: order.message || `${order.domainName} is ${statusLabel(order.status)}.`,
          reference: order.orderId
        });
      })
      .catch((error) => setCallbackNotice({ type: 'error', title: 'Payment update', message: error.message || 'Could not load payment status.', reference }));
  }, []);

  async function searchDomains(event, directQuery = query) {
    event?.preventDefault();
    const keyword = cleanInput(directQuery);
    if (!keyword) {
      setStatus({ type: 'error', message: mode === 'transfer' ? 'Enter the full domain you want to transfer.' : 'Enter a business name, idea, or domain.' });
      return;
    }
    if (mode === 'transfer' && !keyword.includes('.')) {
      setStatus({ type: 'error', message: 'Transfer needs a full domain, for example mybrand.com.' });
      return;
    }
    setQuery(directQuery);
    setOrderStatus('');
    setStatus({ type: 'loading', message: 'Checking live availability...' });
    setResults([]);
    try {
      const response = await fetch('/domains/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: keyword, tlds: defaultTlds, purchaseType: mode })
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.message || 'Could not complete search.');
      setResults(payload.results || []);
      setStatus({ type: 'success', message: payload.results?.length ? 'Live results ready.' : 'No matching options returned. Try another name.' });
    } catch (error) {
      setStatus({ type: 'error', message: error.message || 'Search failed. Please try again.' });
    }
  }

  function switchMode(nextMode) {
    setMode(nextMode);
    setResults([]);
    setStatus({ type: 'idle', message: '' });
  }

  function addToCart(domain) {
    if (!domain.purchasable) return;
    const nextItem = { ...domain, years: 1, authCode: '' };
    setCartItems((current) => {
      if (current.some((item) => itemKey(item) === itemKey(nextItem))) return current;
      return [...current, nextItem];
    });
    setCartOpen(true);
    setOrderStatus('');
  }

  function updateCartItem(key, patch) {
    setCartItems((current) => current.map((item) => itemKey(item) === key ? { ...item, ...patch } : item));
  }

  function removeCartItem(key) {
    setCartItems((current) => current.filter((item) => itemKey(item) !== key));
  }

  async function submitAuth(event) {
    event.preventDefault();
    const endpoint = authMode === 'forgot' ? 'forgot-password' : authMode === 'reset' ? 'reset-password' : authMode;
    setAuthMessage(authMode === 'forgot' ? 'Sending reset link...' : authMode === 'reset' ? 'Updating password...' : authMode === 'login' ? 'Signing you in...' : 'Creating your account...');
    try {
      const response = await fetch(`/domains/api/auth/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authMode === 'reset' ? { token: resetToken, password: authForm.password } : authForm)
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.message || 'Authentication failed.');
      if (authMode === 'forgot') {
        setAuthMessage(payload.message || 'If an account exists, a reset link has been sent.');
        return;
      }
      setUser(payload.user);
      setForm((current) => ({ ...current, name: current.name || payload.user.name || '', email: current.email || payload.user.email || '' }));
      setAuthMessage(authMode === 'reset' ? 'Password updated.' : 'Signed in.');
      setResetToken('');
      setAuthOpen(false);
    } catch (error) {
      setAuthMessage(error.message || 'Could not continue.');
    }
  }

  async function logout() {
    await fetch('/domains/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
  }

  async function placeOrder(event) {
    event.preventDefault();
    if (!cartItems.length) {
      setOrderStatus('Add at least one domain to your cart.');
      return;
    }
    const missingTransfer = cartItems.find((item) => item.purchaseType === 'transfer' && !item.authCode);
    if (missingTransfer) {
      setOrderStatus(`Enter the transfer auth code for ${missingTransfer.domainName}.`);
      setCartOpen(true);
      return;
    }
    setOrderStatus('Confirming availability and preparing secure payment...');
    try {
      const response = await fetch('/domains/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cartItems.map((item) => ({ domainName: item.domainName, purchaseType: item.purchaseType || 'registration', years: item.years || 1, authCode: item.authCode || '' })),
          ...form
        })
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.message || 'Could not create order.');
      if (!payload.payment?.authorizationUrl) throw new Error('Payment link was not returned. Please contact support.');
      localStorage.removeItem(cartStorageKey);
      setCartItems([]);
      setOrderStatus(`Redirecting to secure payment for ${naira(payload.order.payment.amountNgn)}...`);
      window.location.href = payload.payment.authorizationUrl;
    } catch (error) {
      setOrderStatus(error.message || 'Order failed. Please try again.');
    }
  }

  return (
    <main className="portal-shell">
      <div className="announcement-strip"><span>Domain offers, hosting updates, and service notices</span><a href="/downloads/">View downloads <span aria-hidden="true">-&gt;</span></a></div>
      <header className="topbar">
        <a className="brand-link" href="/" aria-label="Almond Systems">
          <img className="brand-logo" src="/assets/logo/almond-logo-live.png?v=20260717b" onError={(event) => { event.currentTarget.src = '/assets/logo/almond-systems-logo.svg'; }} alt="Almond Systems" />
        </a>
        <nav className="top-actions" aria-label="Domain portal navigation">
          <a href="#domains">Domains</a>
          <a href="#how-it-works">Hosting</a>
          <a href="/downloads/">Downloads</a>
          <button className="icon-action" type="button" onClick={() => setCartOpen(true)} aria-label="Open cart">
            <ShoppingCart size={19} />
            <span>{cartItems.length}</span>
          </button>
          <button className="account-button" type="button" onClick={() => setAuthOpen(true)}>
            <User size={18} /> {user ? user.name.split(' ')[0] : 'Login / Sign up'}
          </button>
        </nav>
      </header>

      {callbackNotice && (
        <section className={`callback-notice ${callbackNotice.type}`}>
          <strong>{callbackNotice.title}</strong>
          <span>{callbackNotice.message}</span>
          {callbackNotice.reference && <small>Reference: {callbackNotice.reference}</small>}
        </section>
      )}

      <section id="domains" className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow"><Sparkles size={15} /> Domain registration, handled properly</p>
          <h1>Seek the name your business can own.</h1>
          <p>Search, register, transfer, and manage domain orders with secure payment and guided Almond Systems support.</p>
        </div>

        <form className="search-card" onSubmit={searchDomains}>
          <div className="mode-switch" aria-label="Domain action">
            <button type="button" className={mode === 'registration' ? 'active' : ''} onClick={() => switchMode('registration')}>Register</button>
            <button type="button" className={mode === 'transfer' ? 'active' : ''} onClick={() => switchMode('transfer')}>Transfer</button>
          </div>

          <div className="search-line">
            <Search className="search-prefix" size={28} aria-hidden="true" />
            <input id="domain-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={mode === 'transfer' ? 'Enter domain to transfer...' : 'Search for a domain name...'} />
            <span className="smart-mode"><Sparkles size={16} /> Guided search</span>
            <button type="submit">Search</button>
          </div>

          {status.message && <p className={`status ${status.type}`}>{status.message}</p>}
          {results.length > 0 && (
            <div className="search-results" aria-live="polite">
              <div className="search-results-head">
                <strong>{availableResults.length} available</strong>
                <small>{unavailableResults.length} unavailable</small>
              </div>
              <div className="search-result-list">
                {results.map((domain) => {
                  const inCart = cartItems.some((item) => itemKey(item) === itemKey(domain));
                  return (
                    <button key={itemKey(domain)} type="button" className={domain.purchasable ? 'search-result available' : 'search-result'} disabled={!domain.purchasable} onClick={() => addToCart(domain)}>
                      <span>
                        <strong title={domain.domainName}>{domain.domainName}</strong>
                        <small>{domain.purchasable ? (inCart ? 'Already in cart' : domain.purchaseType === 'transfer' ? 'Eligible for transfer' : 'Available to order') : (domain.reason || 'Unavailable')}</small>
                      </span>
                      <em>{domain.purchasable ? naira(domain.purchasePriceNgn) : 'Taken'}</em>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="hero-promo-row" aria-label="Payment and support highlights">
            <span><CheckCircle2 size={16} /> Secure Paystack checkout</span>
            <span><Globe2 size={16} /> Register or transfer domains</span>
          </div>
        </form>
      </section>

      <section id="checkout" className={cartItems.length ? 'checkout-panel active' : 'checkout-panel'}>
        <div className="checkout-copy">
          <p className="eyebrow"><Lock size={15} /> Secure checkout</p>
          <h2>{cartItems.length ? 'Complete your domain order' : 'Add domains to checkout'}</h2>
          <p>{cartItems.length ? 'Review your cart, add customer details, then continue to Paystack. Paid orders remain subject to Almond Systems approval before live registration or transfer.' : 'Search results can be added to cart. Your checkout details will stay ready here.'}</p>
          <div className="checkout-summary">
            <span>{cartItems.length} item{cartItems.length === 1 ? '' : 's'} in cart</span>
            <strong>{naira(cartTotalNgn)}</strong>
            <small>Converted with the current exchange rate, plus service fees before Paystack payment.</small>
          </div>
        </div>

        {cartItems.length ? (
          <form onSubmit={placeOrder} className="order-form">
            <label>Full name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" /></label>
            <label>Email<input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" /></label>
            <label>Phone / WhatsApp<input required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} autoComplete="tel" /></label>
            <label>Business name<input value={form.business} onChange={(e) => setForm({ ...form, business: e.target.value })} autoComplete="organization" /></label>
            <label className="wide">Launch notes<textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="DNS, hosting, email, SSL, or launch notes" /></label>
            <div className="form-actions">
              <button className="submit-order" type="submit"><CreditCard size={18} /> Pay with Paystack</button>
              <button className="ghost-button" type="button" onClick={() => setCartOpen(true)}>Review cart</button>
            </div>
            {orderStatus && <p className="order-status">{orderStatus}</p>}
          </form>
        ) : (
          <div className="checkout-placeholder"><Globe2 size={34} /><span>Select an available result and add it to your cart.</span></div>
        )}
      </section>

      <section id="how-it-works" className="service-grid">
        {serviceSteps.map(({ icon: Icon, title, text }) => <article key={title}><Icon size={21} /><h3>{title}</h3><p>{text}</p></article>)}
      </section>

      <section className="faq-panel">
        <div>
          <p className="eyebrow"><Check size={15} /> Clear next steps</p>
          <h2>Built for serious business names.</h2>
        </div>
        <div className="faq-list">
          <article><h3>Will my domain register instantly?</h3><p>Payment is verified first, then Almond Systems approves the order before live registration.</p></article>
          <article><h3>Can I transfer a domain?</h3><p>Yes. Use the transfer tab, add the domain to cart, and provide the EPP/auth code before payment.</p></article>
          <article><h3>Can you help with hosting?</h3><p>Yes. Add DNS, email, SSL, or hosting notes in checkout and our team will assist.</p></article>
        </div>
      </section>

      <footer className="portal-footer">
        <div className="footer-grid">
          <section>
            <img className="footer-logo" src="/assets/logo/almond-logo-live.png?v=20260717b" onError={(event) => { event.currentTarget.src = '/assets/logo/almond-systems-logo.svg'; }} alt="Almond Systems" />
            <h2>Payment options</h2>
            <PaymentMarks />
            <p>Checkout is processed by Paystack. Supported card options include Visa, Mastercard, Verve, and eligible Amex cards, alongside bank transfer and other enabled local channels.</p>
          </section>
          <section>
            <h2>Protected checkout</h2>
            <div className="security-card"><ShieldCheck size={30} /><div><strong>Secured by Paystack</strong><span>Card details are handled by Paystack, a PCI DSS Level 1 certified payment processor.</span></div></div>
          </section>
          <section>
            <h2>Support</h2>
            <p>Need DNS, email, or hosting help after payment? Almond Systems reviews every order before completing registration or transfer.</p>
            <a className="footer-cta" href="https://wa.me/2349168775034?text=Hi%20Almond%20Systems%2C%20I%20need%20help%20with%20domain%20registration" target="_blank" rel="noreferrer">Talk to sales</a>
          </section>
        </div>
        <div className="footer-bottom"><span>© 2026 Almond Systems</span><span>Domains, hosting, web applications, and managed launch support.</span></div>
      </footer>

      <aside className={cartOpen ? 'drawer cart-drawer open' : 'drawer cart-drawer'} aria-label="Domain cart">
        <div className="drawer-head"><div><small>Domain cart</small><strong>{cartItems.length} item{cartItems.length === 1 ? '' : 's'}</strong></div><button type="button" onClick={() => setCartOpen(false)} aria-label="Close cart"><X size={20} /></button></div>
        <div className="cart-list">
          {cartItems.length ? cartItems.map((item) => (
            <article className="cart-item" key={itemKey(item)}>
              <button className="remove-item" type="button" onClick={() => removeCartItem(itemKey(item))} aria-label={`Remove ${item.domainName}`}><Trash2 size={16} /></button>
              <strong title={item.domainName}>{item.domainName}</strong>
              <small>{item.purchaseType === 'transfer' ? 'Transfer' : 'Registration'} / {naira(item.purchasePriceNgn)}</small>
              <label>Years<select value={item.years || 1} onChange={(e) => updateCartItem(itemKey(item), { years: Number(e.target.value) })}>{[1,2,3,4,5].map((year) => <option key={year} value={year}>{year}</option>)}</select></label>
              {item.purchaseType === 'transfer' && <label>Auth code<input value={item.authCode || ''} onChange={(e) => updateCartItem(itemKey(item), { authCode: e.target.value })} placeholder="EPP / transfer code" /></label>}
            </article>
          )) : <div className="empty-cart"><ShoppingCart size={32} /><strong>Your cart is empty</strong><span>Add a domain result to continue.</span></div>}
        </div>
        <div className="drawer-foot"><span>Estimated naira total</span><strong>{naira(cartTotalNgn)}</strong><button type="button" onClick={() => { setCartOpen(false); document.getElementById('checkout')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>Continue checkout</button></div>
      </aside>

      <aside className={authOpen ? 'drawer auth-drawer open' : 'drawer auth-drawer'} aria-label="Account access">
        <div className="drawer-head"><div><small>Almond account</small><strong>{user ? 'Signed in' : 'Login / Sign up'}</strong></div><button type="button" onClick={() => setAuthOpen(false)} aria-label="Close account"><X size={20} /></button></div>
        {user ? (
          <div className="account-panel"><User size={34} /><h3>{user.name}</h3><p>{user.email}</p><button type="button" onClick={logout}><LogOut size={17} /> Sign out</button></div>
        ) : (
          <form className="auth-form" onSubmit={submitAuth}>
            <div className="auth-tabs"><button type="button" className={authMode === 'login' ? 'active' : ''} onClick={() => setAuthMode('login')}>Login</button><button type="button" className={authMode === 'signup' ? 'active' : ''} onClick={() => setAuthMode('signup')}>Sign up</button></div>
            {authMode === 'signup' && <label>Full name<input required value={authForm.name} onChange={(e) => setAuthForm({ ...authForm, name: e.target.value })} /></label>}
            {authMode !== 'reset' && <label>Email<input required type="email" value={authForm.email} onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })} /></label>}
            {authMode !== 'forgot' && <label>{authMode === 'reset' ? 'New password' : 'Password'}<input required type="password" minLength={8} value={authForm.password} onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })} /></label>}
            <button type="submit">{authMode === 'forgot' ? 'Send reset link' : authMode === 'reset' ? 'Update password' : authMode === 'login' ? 'Log in' : 'Create account'}</button>
            {authMode === 'login' && <button className="link-button" type="button" onClick={() => setAuthMode('forgot')}>Forgot password?</button>}
            {authMode === 'forgot' && <button className="link-button" type="button" onClick={() => setAuthMode('login')}>Back to login</button>}
            {authMessage && <p className="auth-message">{authMessage}</p>}
          </form>
        )}
      </aside>
      {(cartOpen || authOpen) && <button className="drawer-backdrop" type="button" aria-label="Close panel" onClick={() => { setCartOpen(false); setAuthOpen(false); }} />}
    </main>
  );
}

function AdminPortal() {
  const [adminKey, setAdminKey] = useState(() => localStorage.getItem('almond-domain-admin-key') || '');
  const [status, setStatus] = useState('all');
  const [orders, setOrders] = useState([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');

  async function adminFetch(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey, ...(options.headers || {}) } });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.message || 'Admin request failed.');
    return payload;
  }

  async function loadOrders(nextStatus = status) {
    if (!adminKey) { setMessage('Enter your admin key.'); return; }
    localStorage.setItem('almond-domain-admin-key', adminKey);
    setMessage('Loading orders...');
    try {
      const payload = await adminFetch(`/domains/api/admin/orders?status=${encodeURIComponent(nextStatus)}`);
      setOrders(payload.orders || []);
      setMessage(`${payload.orders?.length || 0} order${payload.orders?.length === 1 ? '' : 's'} loaded.`);
    } catch (error) { setMessage(error.message || 'Could not load orders.'); }
  }

  useEffect(() => { if (adminKey) loadOrders('all'); }, []);

  async function orderAction(order, action) {
    setBusy(`${action}-${order.orderId}`);
    setMessage(`${action === 'approve' ? 'Approving' : 'Updating'} ${order.domainName}...`);
    try {
      const payload = await adminFetch(`/domains/api/admin/orders/${encodeURIComponent(order.orderId)}/${action}`, { method: 'POST', body: JSON.stringify({}) });
      setOrders((current) => current.map((item) => item.orderId === order.orderId ? payload.order : item));
      setMessage(payload.order.message || 'Order updated.');
    } catch (error) { setMessage(error.message || 'Order update failed.'); }
    finally { setBusy(''); }
  }

  return (
    <main className="portal-shell admin-shell">
      <header className="topbar static"><a className="back-link" href="/domains/"><ArrowLeft size={18} /> Customer portal</a><button className="support-link" type="button" onClick={() => loadOrders(status)}><RefreshCw size={17} /> Refresh</button></header>
      <section className="admin-hero"><div><p className="eyebrow"><KeyRound size={15} /> Admin approval</p><h1>Domain orders</h1><p>Review paid orders, confirm payment state, and approve registration or transfer only when everything is correct.</p></div><form className="admin-login" onSubmit={(event) => { event.preventDefault(); loadOrders(status); }}><label>Admin key<input type="password" value={adminKey} onChange={(event) => setAdminKey(event.target.value)} placeholder="Enter admin key" /></label><button type="submit">Load orders</button></form></section>
      <div className="admin-toolbar"><select value={status} onChange={(event) => { setStatus(event.target.value); loadOrders(event.target.value); }}>{orderStatuses.map((item) => <option value={item} key={item}>{statusLabel(item)}</option>)}</select>{message && <p className="status success">{message}</p>}</div>
      <section className="admin-orders">{orders.map((order) => <article className="admin-order" key={order.orderId}><div className="admin-order-head"><div><span className={`admin-status ${order.status}`}>{statusLabel(order.status)}</span><h2>{order.domainName}</h2><p>{order.orderId} / {order.createdAt ? new Date(order.createdAt).toLocaleString() : 'No date'}</p></div><strong>{naira(order.payment?.amountNgn)}</strong></div>{order.items?.length ? <div className="admin-items">{order.items.map((item) => <span key={`${order.orderId}-${item.domainName}`}>{item.domainName} · {item.purchaseType}</span>)}</div> : null}<dl><div><dt>Customer</dt><dd>{order.customer?.name}<br />{order.customer?.email}<br />{order.customer?.phone}</dd></div><div><dt>Years</dt><dd>{order.years}</dd></div><div><dt>Payment</dt><dd>{order.payment?.confirmedAt ? `Confirmed ${new Date(order.payment.confirmedAt).toLocaleString()}` : statusLabel(order.status)}</dd></div><div><dt>Message</dt><dd>{order.message || 'No message'}</dd></div></dl>{order.customer?.notes && <p className="admin-note">{order.customer.notes}</p>}<div className="admin-actions"><button type="button" disabled={busy || order.status === 'registered'} onClick={() => orderAction(order, 'verify-payment')}>Verify payment</button><button type="button" disabled={busy || !['payment-confirmed-awaiting-approval', 'registration-failed', 'payment-pending'].includes(order.status)} onClick={() => orderAction(order, 'approve')}>Approve order</button><button type="button" disabled={busy || order.status === 'registered'} onClick={() => orderAction(order, 'hold')}>Hold</button></div></article>)}</section>
    </main>
  );
}

function App() {
  return window.location.pathname.startsWith('/domains/admin') ? <AdminPortal /> : <CustomerPortal />;
}

createRoot(document.getElementById('root')).render(<App />);
