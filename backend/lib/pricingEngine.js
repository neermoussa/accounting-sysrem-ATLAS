const db = require('../db/init');
const { getStoredRate } = require('./exchangeRate');
const { toBaseQty, convert: convertUnit } = require('./productUnits');

// Best-effort conversion for this app's single currency pair (see
// lib/exchangeRate.js — one stored USD→SYP rate per company). Any other
// pair is returned unconverted rather than guessed at.
function convertCurrency(companyId, amount, fromCurrency, toCurrency) {
  if (!fromCurrency || !toCurrency || fromCurrency === toCurrency) return amount;
  const { rate } = getStoredRate(companyId);
  const rateNum = Number(rate);
  if (!(rateNum > 0)) return amount;
  if (fromCurrency === 'USD' && toCurrency === 'SYP') return amount * rateNum;
  if (fromCurrency === 'SYP' && toCurrency === 'USD') return amount / rateNum;
  return amount;
}

// Specificity order: a list scoped to this exact customer always wins over
// one scoped to their region, which wins over one scoped to the sales
// channel, which wins over the company's general list — matching the
// "قوائم أسعار متعددة حسب العميل/المنطقة/القناة" requirement's own
// precedence. Within equal specificity, higher `priority` (then newer)
// wins.
function candidatePriceLists(companyId, { shopId, region, channel }) {
  const lists = db
    .prepare('SELECT * FROM price_lists WHERE company_id = ? AND active = 1 ORDER BY priority DESC, id DESC')
    .all(companyId);
  const rank = (list) => {
    if (list.scope_type === 'customer' && shopId && list.scope_value === String(shopId)) return 0;
    if (list.scope_type === 'region' && region && list.scope_value === region) return 1;
    if (list.scope_type === 'channel' && channel && list.scope_value === channel) return 2;
    if (list.scope_type === 'general') return 3;
    return null;
  };
  return lists
    .map((l) => ({ list: l, rank: rank(l) }))
    .filter((r) => r.rank !== null)
    .sort((a, b) => a.rank - b.rank)
    .map((r) => r.list);
}

// Picks the price-list price for the given product/unit/quantity, trying
// lists from most to least specific and, within a list, the highest
// quantity-break tier the order actually qualifies for. Falls back to the
// product's own base_price (converted to the requested unit) when no list
// has anything for this product at all.
function resolveUnitPrice(companyId, { productId, unitKey, qtyBase, shopId, region, channel, currency }) {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(productId, companyId);
  if (!product) return null;

  for (const list of candidatePriceLists(companyId, { shopId, region, channel })) {
    const tiers = db
      .prepare(
        `SELECT * FROM price_list_items WHERE price_list_id = ? AND product_id = ? AND unit_key = ? AND min_quantity <= ?
         ORDER BY min_quantity DESC LIMIT 1`
      )
      .get(list.id, productId, unitKey, qtyBase);
    if (tiers) {
      return { price: convertCurrency(companyId, tiers.price, list.currency, currency || list.currency), currency: currency || list.currency, source: 'price_list', priceListId: list.id };
    }
  }

  if (product.base_price != null) {
    const baseUnit = db.prepare('SELECT * FROM product_units WHERE product_id = ? AND is_base = 1').get(productId);
    const factor = baseUnit
      ? (db.prepare('SELECT factor FROM product_units WHERE product_id = ? AND unit_key = ?').get(productId, unitKey)?.factor || 1) / baseUnit.factor
      : 1;
    return { price: product.base_price * factor, currency: currency || 'USD', source: 'base_price', priceListId: null };
  }

  return null;
}

function isPromotionActive(promo, now) {
  if (!promo.active) return false;
  if (promo.starts_at && now < promo.starts_at) return false;
  if (promo.ends_at && now > promo.ends_at) return false;
  return true;
}

function promotionMatchesScope(promo, { shopId, region, channel }) {
  if (promo.scope_type === 'general') return true;
  if (promo.scope_type === 'customer') return shopId && promo.scope_value === String(shopId);
  if (promo.scope_type === 'region') return region && promo.scope_value === region;
  if (promo.scope_type === 'channel') return channel && promo.scope_value === channel;
  return false;
}

// Every active, in-window, scope-matching promotion for this product (by
// id, or by category when the promotion targets a category instead of one
// specific product).
function findApplicablePromotions(companyId, { productId, category, shopId, region, channel }) {
  const now = new Date().toISOString();
  const rows = db.prepare('SELECT * FROM promotions WHERE company_id = ? AND active = 1').all(companyId);
  return rows.filter((p) => {
    if (!isPromotionActive(p, now)) return false;
    if (p.product_id && p.product_id !== productId) return false;
    if (!p.product_id && p.category && p.category !== category) return false;
    if (!p.product_id && !p.category) return false; // a promo must target something
    return promotionMatchesScope(p, { shopId, region, channel });
  });
}

// Applies percent/fixed_amount discounts (capped at max_discount_amount)
// and returns free units separately (buy_x_get_y / free_item / the
// buy_x_get_y half of 'mixed') rather than folding them into the paid
// line — a free unit has its own zero-value line and its own
// free_goods_log entry, per the "goods given free are a separate
// zero-value stock-out, reported separately" requirement.
function applyPromotions(promotions, { unitPrice, qty }) {
  let discountedUnitPrice = unitPrice;
  let discountAmount = 0;
  const freeUnits = []; // { promotion, qty }
  let appliedPromotionId = null;

  for (const promo of promotions) {
    if (promo.type === 'percent') {
      let amt = unitPrice * qty * (promo.value / 100);
      if (promo.max_discount_amount != null) amt = Math.min(amt, promo.max_discount_amount);
      discountAmount += amt;
      appliedPromotionId = promo.id;
    } else if (promo.type === 'fixed_amount') {
      let amt = Math.min(promo.value, promo.max_discount_amount ?? promo.value);
      discountAmount += amt;
      appliedPromotionId = promo.id;
    } else if (promo.type === 'free_item') {
      freeUnits.push({ promotion: promo, qty: promo.get_qty || 1 });
      appliedPromotionId = promo.id;
    } else if (promo.type === 'buy_x_get_y') {
      if (promo.buy_qty > 0 && qty >= promo.buy_qty) {
        const freeQty = Math.floor(qty / promo.buy_qty) * (promo.get_qty || 0);
        if (freeQty > 0) freeUnits.push({ promotion: promo, qty: freeQty });
        appliedPromotionId = promo.id;
      }
    } else if (promo.type === 'mixed') {
      const cfg = promo.mixed_config_json ? JSON.parse(promo.mixed_config_json) : {};
      if (cfg.percent) discountAmount += unitPrice * qty * (cfg.percent / 100);
      if (cfg.fixed_amount) discountAmount += cfg.fixed_amount;
      if (cfg.buy_qty > 0 && qty >= cfg.buy_qty) {
        const freeQty = Math.floor(qty / cfg.buy_qty) * (cfg.get_qty || 0);
        if (freeQty > 0) freeUnits.push({ promotion: promo, qty: freeQty });
      }
      if (promo.max_discount_amount != null) discountAmount = Math.min(discountAmount, promo.max_discount_amount);
      appliedPromotionId = promo.id;
    }
  }

  const lineTotal = Math.max(0, unitPrice * qty - discountAmount);
  discountedUnitPrice = qty > 0 ? lineTotal / qty : unitPrice;
  return { lineTotal, discountedUnitPrice, discountAmount, freeUnits, appliedPromotionId };
}

// The actual floor check: refuses to price a paid line below the
// promotion's own margin floor (or the company default, from settings key
// 'default_min_profit_margin_pct') unless an approved, matching
// price_approval_requests row already covers this exact shop+product+price.
function checkMinProfit(companyId, { shopId, productId, effectiveUnitPrice, costPrice, promotions }) {
  if (costPrice == null) return { ok: true };
  const promoFloor = promotions.map((p) => p.min_profit_margin_pct).filter((v) => v != null);
  const companyDefault = db
    .prepare("SELECT value FROM settings WHERE company_id = ? AND key = 'default_min_profit_margin_pct'")
    .get(companyId)?.value;
  const floorPct = promoFloor.length ? Math.min(...promoFloor) : companyDefault != null ? Number(companyDefault) : null;
  if (floorPct == null || costPrice <= 0) return { ok: true };

  const marginPct = ((effectiveUnitPrice - costPrice) / costPrice) * 100;
  if (marginPct >= floorPct) return { ok: true };

  const minAllowedPrice = costPrice * (1 + floorPct / 100);
  const approved = db
    .prepare(
      `SELECT * FROM price_approval_requests
       WHERE company_id = ? AND shop_id = ? AND product_id = ? AND status = 'approved' AND requested_price <= ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(companyId, shopId, productId, effectiveUnitPrice + 0.0001);
  if (approved) return { ok: true, approvedRequestId: approved.id };

  return { ok: false, reason: 'below_min_profit', minAllowedPrice, marginPct, floorPct };
}

// Full pricing for one order line: resolves the list price, applies
// promotions, then enforces the profit floor. Returns either a priced line
// (paid + any free units) or { blocked: true, ... } for the route to turn
// into a 403.
function priceLine(companyId, { productId, unitKey, qty, shopId, region, channel, currency }) {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(productId, companyId);
  if (!product) return { blocked: true, reason: 'product_not_found' };

  const qtyBase = toBaseQty(productId, qty, unitKey);
  const resolved = resolveUnitPrice(companyId, { productId, unitKey, qtyBase, shopId, region, channel, currency });
  if (!resolved) return { blocked: true, reason: 'no_price_available' };

  const promotions = findApplicablePromotions(companyId, { productId, category: product.category, shopId, region, channel });
  const { lineTotal, discountedUnitPrice, discountAmount, freeUnits, appliedPromotionId } = applyPromotions(promotions, {
    unitPrice: resolved.price,
    qty,
  });

  // Compare against cost_price in the SAME unit as the sale price.
  let costInUnit = product.cost_price;
  if (costInUnit != null) {
    const baseUnit = db.prepare('SELECT * FROM product_units WHERE product_id = ? AND is_base = 1').get(productId);
    if (baseUnit) {
      const f = db.prepare('SELECT factor FROM product_units WHERE product_id = ? AND unit_key = ?').get(productId, unitKey)?.factor;
      if (f) costInUnit = product.cost_price * (f / baseUnit.factor);
    }
  }

  const profitCheck = checkMinProfit(companyId, {
    shopId,
    productId,
    effectiveUnitPrice: discountedUnitPrice,
    costPrice: costInUnit,
    promotions,
  });
  if (!profitCheck.ok) {
    return { blocked: true, reason: profitCheck.reason, minAllowedPrice: profitCheck.minAllowedPrice, marginPct: profitCheck.marginPct, floorPct: profitCheck.floorPct, unitPrice: resolved.price };
  }

  const freeLines = freeUnits.map((f) => ({
    productId: f.promotion.free_product_id || productId,
    qty: f.qty,
    unitKey,
    is_free: true,
    free_reason: 'promo',
    promotionId: f.promotion.id,
  }));

  return {
    blocked: false,
    productId,
    unitKey,
    qty,
    unitPrice: resolved.price,
    discountedUnitPrice,
    discountAmount,
    lineTotal,
    currency: resolved.currency,
    priceSource: resolved.source,
    appliedPromotionId,
    approvedRequestId: profitCheck.approvedRequestId || null,
    freeLines,
  };
}

module.exports = { resolveUnitPrice, findApplicablePromotions, applyPromotions, checkMinProfit, priceLine, convertCurrency };
