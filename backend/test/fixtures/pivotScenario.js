// backend/test/fixtures/pivotScenario.js
//
// The legacy (order-based) pivot and heatmap of /api/reports, before Prompt
// 12b extended them with a facts mode. Pure HTTP through the manager client,
// so the same file records the golden on the baseline commit (505b407) and
// replays it on the current code (test/pivotGolden.test.js).

async function runPivotScenario(manager) {
  const shop = async (name, lat, lng, region) => {
    const r = await manager.post('/api/shops', { name, lat, lng, region });
    if (r.status !== 201) throw new Error(`shop ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.id;
  };
  const a = await shop('محل المزة', 33.501, 36.251, 'دمشق - المزة');
  const b = await shop('محل الميدان', 33.502, 36.252, 'دمشق - الميدان');
  const c = await shop('محل حلب', 36.2, 37.15, 'حلب - العزيزية');
  const order = async (shopId, date, items, total) => {
    const r = await manager.post(`/api/shops/${shopId}/orders`, { order_date: date, items, total_value: total });
    if (r.status !== 201) throw new Error(`order ${r.status} ${JSON.stringify(r.body)}`);
  };
  await order(a, '2026-08-03', [{ product_name: 'لوز', qty: 4, price: 10 }, { product_name: 'كاجو', qty: 2, price: 15 }], 70);
  await order(b, '2026-08-17', [{ product_name: 'لوز', qty: 1, price: 10 }], 10);
  await order(c, '2026-09-02', [{ product_name: 'فستق', qty: 3, price: 20 }, { product_name: 'لوز', qty: 5, price: 9 }], 105);
  await order(a, '2026-09-20', [{ product_name: 'كاجو', qty: 6, price: 14 }], 84);
  const get = async (url) => {
    const r = await manager.get(url);
    return { status: r.status, body: r.body };
  };
  const q = 'from=2026-08-01&to=2026-09-30';
  return {
    pivot_region_month_value: await get(`/api/reports/pivot/table?rowDim=region&colDim=month&measure=totalValue&${q}`),
    pivot_product_city_qty: await get(`/api/reports/pivot/table?rowDim=productName&colDim=city&measure=qty&${q}`),
    pivot_month_branch_count: await get(`/api/reports/pivot/table?rowDim=month&colDim=branch&measure=orderCount&${q}`),
    pivot_bad_dim: await get('/api/reports/pivot/table?rowDim=nope&colDim=month'),
    heatmap_sales: await get(`/api/reports/heatmap/data?metric=sales&${q}`),
    heatmap_customers: await get(`/api/reports/heatmap/data?metric=customers&${q}`),
    heatmap_default: await get('/api/reports/heatmap/data'),
  };
}

module.exports = { runPivotScenario };
