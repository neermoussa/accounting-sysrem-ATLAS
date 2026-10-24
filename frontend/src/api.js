import { setOffline } from './lib/connectivity.js';

async function fetchOrMarkOffline(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
    // fetch() itself throwing (not an HTTP error status) means the request
    // never reached any server at all — DNS failure, connection refused, no
    // network.
    setOffline(true);
    throw err;
  }
  // Our Express backend always answers in JSON, even for its own 4xx/5xx
  // errors (see server.js's catch-all). A non-JSON 5xx here instead means
  // the reverse proxy in front of it (Vite's dev proxy locally, Nginx in
  // production) couldn't reach the backend process at all and generated the
  // error page itself — the real "server unreachable" case, just one that
  // arrives as an HTTP response instead of a thrown fetch error.
  const contentType = res.headers.get('content-type') || '';
  const isGatewayFailure = res.status >= 500 && !contentType.includes('application/json');
  if (isGatewayFailure) {
    setOffline(true);
    const err = new Error('server_unreachable');
    throw err;
  }
  setOffline(false);
  return res;
}

async function request(path, options = {}) {
  const res = await fetchOrMarkOffline(`/api${path}`, {
    credentials: 'same-origin',
    headers: options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let detail;
    try {
      detail = await res.json();
    } catch {
      detail = { error: res.statusText };
    }
    const err = new Error(detail.error || 'request_failed');
    err.detail = detail;
    throw err;
  }
  // 202/204 are sent with no body (e.g. POST /ai/stock-forecast/run
  // acknowledges and computes in the background) — res.json() on an
  // empty body throws "Unexpected end of JSON input", which surfaced
  // raw and untranslated in the UI.
  if (res.status === 204 || res.status === 202) return null;
  return res.json();
}

async function downloadFile(path, options = {}) {
  const res = await fetchOrMarkOffline(`/api${path}`, { credentials: 'same-origin', ...options });
  if (!res.ok) {
    let detail;
    try {
      detail = await res.json();
    } catch {
      detail = { error: res.statusText };
    }
    const err = new Error(detail.error || 'request_failed');
    err.detail = detail;
    throw err;
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = /filename\*=UTF-8''([^;]+)/.exec(disposition);
  const filename = match ? decodeURIComponent(match[1]) : 'export.xlsx';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const api = {
  register: (name, contact, password) =>
    request('/auth/register', { method: 'POST', body: JSON.stringify({ name, contact, password }) }),
  login: (contact, password) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ contact, password }) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  getMe: () => request('/auth/me'),
  updateLanguage: (language) =>
    request('/auth/language', { method: 'PUT', body: JSON.stringify({ language }) }),
  changePassword: (currentPassword, newPassword) =>
    request('/auth/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) }),

  getNotifications: () => request('/notifications'),
  markNotificationRead: (id) => request(`/notifications/${id}/read`, { method: 'POST' }),
  markAllNotificationsRead: () => request('/notifications/mark-all-read', { method: 'POST' }),

  uploadInvoice: (shopId, file, invoiceDate) => {
    const form = new FormData();
    form.append('file', file);
    form.append('shop_id', shopId);
    if (invoiceDate) form.append('invoice_date', invoiceDate);
    return request('/invoices', { method: 'POST', body: form });
  },
  getInvoice: (id) => request(`/invoices/${id}`),
  getShopInvoices: (shopId) => request(`/invoices?shopId=${shopId}`),
  confirmInvoice: (id, data) => request(`/invoices/${id}/confirm`, { method: 'POST', body: JSON.stringify(data) }),

  adminListUsers: () => request('/admin/users'),
  createStaffUser: (data) => request('/admin/users', { method: 'POST', body: JSON.stringify(data) }),
  adminApproveUser: (id) => request(`/admin/users/${id}/approve`, { method: 'POST' }),
  adminRejectUser: (id) => request(`/admin/users/${id}/reject`, { method: 'POST' }),

  getPermissionsCatalog: () => request('/permissions/catalog'),
  getPermissionsUsers: () => request('/permissions/users'),
  getPermissionTemplates: () => request('/permissions/templates'),
  createPermissionTemplate: (data) =>
    request('/permissions/templates', { method: 'POST', body: JSON.stringify(data) }),
  updatePermissionTemplate: (id, data) =>
    request(`/permissions/templates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePermissionTemplate: (id) => request(`/permissions/templates/${id}`, { method: 'DELETE' }),
  setUserPermissions: (id, permissions) =>
    request(`/permissions/users/${id}/permissions`, { method: 'PUT', body: JSON.stringify({ permissions }) }),
  applyPermissionTemplate: (userId, templateId) =>
    request(`/permissions/users/${userId}/apply-template/${templateId}`, { method: 'POST' }),
  setManagePermissions: (id, grant) =>
    request(`/permissions/users/${id}/manage-permissions`, { method: 'PUT', body: JSON.stringify({ grant }) }),

  getAuditLog: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/audit-log${qs ? `?${qs}` : ''}`);
  },

  getShops: (classification) =>
    request(`/shops${classification ? `?classification=${classification}` : ''}`),
  getInactiveShops: () => request('/shops?status=inactive'),
  getShop: (id) => request(`/shops/${id}`),
  createShop: (data) => request('/shops', { method: 'POST', body: JSON.stringify(data) }),
  updateShop: (id, data) => request(`/shops/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteShop: (id) => request(`/shops/${id}`, { method: 'DELETE' }),
  deactivateShop: (id) => request(`/shops/${id}/deactivate`, { method: 'POST' }),
  reactivateShop: (id) => request(`/shops/${id}/reactivate`, { method: 'POST' }),
  bulkReassignShopRep: (shopIds, repId) => request('/shops/bulk-reassign-rep', { method: 'POST', body: JSON.stringify({ shopIds, repId }) }),
  bulkSetShopsActive: (shopIds, active) => request('/shops/bulk-set-active', { method: 'POST', body: JSON.stringify({ shopIds, active }) }),
  recomputeClassifications: () => request('/shops/recompute-classifications', { method: 'POST' }),
  addOrder: (shopId, data) => request(`/shops/${shopId}/orders`, { method: 'POST', body: JSON.stringify(data) }),
  updateOrder: (shopId, orderId, data) =>
    request(`/shops/${shopId}/orders/${orderId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteOrder: (shopId, orderId) => request(`/shops/${shopId}/orders/${orderId}`, { method: 'DELETE' }),
  getShopNotes: (shopId, type) => request(`/shops/${shopId}/notes?type=${type}`),
  addShopNote: (shopId, type, body) =>
    request(`/shops/${shopId}/notes`, { method: 'POST', body: JSON.stringify({ type, body }) }),
  resolveShopNote: (shopId, noteId) => request(`/shops/${shopId}/notes/${noteId}/resolve`, { method: 'POST' }),
  getShopStats: (shopId) => request(`/shops/${shopId}/stats`),
  getDiscontinuedItems: (shopId) => request(`/shops/${shopId}/discontinued-items`),
  exportShopStatement: (shopId) => downloadFile(`/shops/${shopId}/statement`),

  // Multi-phone / OTP
  getShopPhones: (shopId) => request(`/shops/${shopId}/phones`),
  addShopPhone: (shopId, data) => request(`/shops/${shopId}/phones`, { method: 'POST', body: JSON.stringify(data) }),
  updateShopPhone: (shopId, phoneId, data) => request(`/shops/${shopId}/phones/${phoneId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteShopPhone: (shopId, phoneId) => request(`/shops/${shopId}/phones/${phoneId}`, { method: 'DELETE' }),
  requestShopPhoneOtp: (shopId, phoneId) => request(`/shops/${shopId}/phones/${phoneId}/request-otp`, { method: 'POST' }),
  verifyShopPhoneOtp: (shopId, phoneId, code) =>
    request(`/shops/${shopId}/phones/${phoneId}/verify-otp`, { method: 'POST', body: JSON.stringify({ code }) }),
  manualConfirmShopPhone: (shopId, phoneId) => request(`/shops/${shopId}/phones/${phoneId}/manual-confirm`, { method: 'POST' }),

  // Media (images/documents)
  uploadShopMedia: (shopId, file, kind, label) => {
    const form = new FormData();
    form.append('file', file);
    form.append('kind', kind);
    if (label) form.append('label', label);
    return request(`/shops/${shopId}/media`, { method: 'POST', body: form });
  },
  deleteShopMedia: (shopId, mediaId) => request(`/shops/${shopId}/media/${mediaId}`, { method: 'DELETE' }),

  // Duplicate detection / merge
  getShopDuplicates: () => request('/shops/duplicates'),
  mergeShops: (keepId, mergeId) => request('/shops/merge', { method: 'POST', body: JSON.stringify({ keepId, mergeId }) }),

  // Rep assignment / transfer
  getAssignmentSuggestion: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/shops/assignment-suggestion${qs ? `?${qs}` : ''}`);
  },
  assignShopRep: (shopId, repId, reason) =>
    request(`/shops/${shopId}/assign`, { method: 'PUT', body: JSON.stringify({ repId, reason }) }),
  getShopTransfers: (shopId) => request(`/shops/${shopId}/transfers`),

  // QR / public link
  getShopQrCode: (shopId) => request(`/shops/${shopId}/qrcode`),

  // Activity log
  getShopActivity: (shopId, params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/shops/${shopId}/activity${qs ? `?${qs}` : ''}`);
  },

  // Import/export
  importShops: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('/shops/import', { method: 'POST', body: form });
  },
  // Leads
  getLeads: (status) => request(`/leads${status ? `?status=${status}` : ''}`),
  createLead: (data) => request('/leads', { method: 'POST', body: JSON.stringify(data) }),
  updateLead: (id, data) => request(`/leads/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteLead: (id) => request(`/leads/${id}`, { method: 'DELETE' }),
  convertLead: (id) => request(`/leads/${id}/convert`, { method: 'POST' }),

  // Company custom fields
  getCustomFields: () => request('/companies/custom-fields'),
  addCustomField: (data) => request('/companies/custom-fields', { method: 'POST', body: JSON.stringify(data) }),
  deleteCustomField: (id) => request(`/companies/custom-fields/${id}`, { method: 'DELETE' }),

  // Product units / barcode / QR / scan
  getProductUnits: (productId) => request(`/products/${productId}/units`),
  addProductUnit: (productId, data) => request(`/products/${productId}/units`, { method: 'POST', body: JSON.stringify(data) }),
  deleteProductUnit: (productId, unitId) => request(`/products/${productId}/units/${unitId}`, { method: 'DELETE' }),
  convertProductUnit: (productId, qty, from, to) =>
    request(`/products/${productId}/convert?${new URLSearchParams({ qty, from, to }).toString()}`),
  getProductBarcode: (productId) => request(`/products/${productId}/barcode`),
  getProductQrCode: (productId) => request(`/products/${productId}/qrcode`),
  scanProduct: (code) => request(`/products/scan/${encodeURIComponent(code)}`),
  uploadProductImage: (productId, file) => {
    const form = new FormData();
    form.append('file', file);
    return request(`/products/${productId}/image`, { method: 'POST', body: form });
  },

  // Pricing: price lists, promotions, quote, approvals, free-goods report
  getPriceLists: () => request('/pricing/price-lists'),
  createPriceList: (data) => request('/pricing/price-lists', { method: 'POST', body: JSON.stringify(data) }),
  updatePriceList: (id, data) => request(`/pricing/price-lists/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePriceList: (id) => request(`/pricing/price-lists/${id}`, { method: 'DELETE' }),
  getPriceListItems: (id) => request(`/pricing/price-lists/${id}/items`),
  addPriceListItem: (id, data) => request(`/pricing/price-lists/${id}/items`, { method: 'POST', body: JSON.stringify(data) }),
  deletePriceListItem: (id, itemId) => request(`/pricing/price-lists/${id}/items/${itemId}`, { method: 'DELETE' }),

  getPromotions: () => request('/pricing/promotions'),
  createPromotion: (data) => request('/pricing/promotions', { method: 'POST', body: JSON.stringify(data) }),
  updatePromotion: (id, data) => request(`/pricing/promotions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePromotion: (id) => request(`/pricing/promotions/${id}`, { method: 'DELETE' }),

  quotePricing: (data) => request('/pricing/quote', { method: 'POST', body: JSON.stringify(data) }),

  getPriceApprovalRequests: (status) => request(`/pricing/price-approval-requests${status ? `?status=${status}` : ''}`),
  requestPriceApproval: (data) => request('/pricing/price-approval-requests', { method: 'POST', body: JSON.stringify(data) }),
  approvePriceRequest: (id) => request(`/pricing/price-approval-requests/${id}/approve`, { method: 'POST' }),
  rejectPriceRequest: (id) => request(`/pricing/price-approval-requests/${id}/reject`, { method: 'POST' }),

  getFreeGoodsReport: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/pricing/free-goods-report${qs ? `?${qs}` : ''}`);
  },

  // Rep management: profile, targets, attendance, route, commissions,
  // scorecard, announcements, ratings, leaderboard
  getRepProfile: (repId) => request(`/reps/${repId}/profile`),
  updateRepProfile: (repId, data) => request(`/reps/${repId}/profile`, { method: 'PUT', body: JSON.stringify(data) }),
  getRepTargets: (repId) => request(`/reps/${repId}/targets`),
  setRepTarget: (repId, data) => request(`/reps/${repId}/targets`, { method: 'PUT', body: JSON.stringify(data) }),

  getAttendanceSettings: () => request('/reps/attendance/settings'),
  updateAttendanceSettings: (locationRequired) =>
    request('/reps/attendance/settings', { method: 'PUT', body: JSON.stringify({ locationRequired }) }),
  recordAttendance: (data) => request('/reps/attendance', { method: 'POST', body: JSON.stringify(data) }),
  getRepAttendance: (repId, params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/reps/${repId}/attendance${qs ? `?${qs}` : ''}`);
  },

  recordRoutePoint: (data) => request('/reps/route-points', { method: 'POST', body: JSON.stringify(data) }),
  getRepRoute: (repId, params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/reps/${repId}/route${qs ? `?${qs}` : ''}`);
  },

  getCommissionSettings: () => request('/reps/commission-settings'),
  updateCommissionSettings: (data) => request('/reps/commission-settings', { method: 'PUT', body: JSON.stringify(data) }),
  getCommissionStatement: (repId, period, anchor) =>
    request(`/reps/${repId}/commission-statement?${new URLSearchParams({ period, ...(anchor ? { anchor } : {}) }).toString()}`),

  getRepScorecard: (period) => request(`/reps/scorecard?period=${period}`),
  getRepLeaderboard: (period) => request(`/reps/leaderboard?period=${period}`),

  getAnnouncements: () => request('/reps/announcements'),
  createAnnouncement: (data) => request('/reps/announcements', { method: 'POST', body: JSON.stringify(data) }),
  markAnnouncementRead: (id) => request(`/reps/announcements/${id}/read`, { method: 'POST' }),

  getVisitRatings: (repId) => request(`/reps/${repId}/visit-ratings`),
  addVisitRating: (repId, data) => request(`/reps/${repId}/visit-ratings`, { method: 'POST', body: JSON.stringify(data) }),

  awardRepPoints: (repId, data) => request(`/reps/${repId}/points`, { method: 'POST', body: JSON.stringify(data) }),

  // Waves: weekly templates, daily report, point management, visit records
  getWaveTemplates: (repId) => request(`/waves/reps/${repId}/templates`),
  createWaveTemplate: (repId, data) => request(`/waves/reps/${repId}/templates`, { method: 'POST', body: JSON.stringify(data) }),
  updateWaveTemplate: (id, data) => request(`/waves/templates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteWaveTemplate: (id) => request(`/waves/templates/${id}`, { method: 'DELETE' }),
  addWaveTemplatePoint: (templateId, shopId) => request(`/waves/templates/${templateId}/points`, { method: 'POST', body: JSON.stringify({ shopId }) }),
  deleteWaveTemplatePoint: (templateId, pointId) => request(`/waves/templates/${templateId}/points/${pointId}`, { method: 'DELETE' }),

  getWaveDay: (repId, date) => request(`/waves/day?${new URLSearchParams({ repId, date }).toString()}`),
  addWaveInstancePoint: (instanceId, shopId) => request(`/waves/instances/${instanceId}/points`, { method: 'POST', body: JSON.stringify({ shopId }) }),
  cancelWavePoint: (pointId, data) => request(`/waves/points/${pointId}`, { method: 'DELETE', body: JSON.stringify(data || {}) }),
  reassignWavePoint: (pointId, waveInstanceId) => request(`/waves/points/${pointId}/reassign`, { method: 'PUT', body: JSON.stringify({ waveInstanceId }) }),
  reorderWavePoints: (instanceId, orderedPointIds) => request(`/waves/instances/${instanceId}/reorder`, { method: 'PUT', body: JSON.stringify({ orderedPointIds }) }),
  setWavePointStatus: (pointId, status) => request(`/waves/points/${pointId}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
  setWavePointNotVisited: (pointId, reason) => request(`/waves/points/${pointId}/not-visited`, { method: 'PUT', body: JSON.stringify({ reason }) }),
  getWavePointChanges: (pointId) => request(`/waves/points/${pointId}/changes`),
  startWaveInstance: (id) => request(`/waves/instances/${id}/start`, { method: 'POST' }),
  endWaveInstance: (id) => request(`/waves/instances/${id}/end`, { method: 'POST' }),

  getVisitFormTemplates: () => request('/waves/visit-form-templates'),
  createVisitFormTemplate: (data) => request('/waves/visit-form-templates', { method: 'POST', body: JSON.stringify(data) }),
  updateVisitFormTemplate: (id, data) => request(`/waves/visit-form-templates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  submitVisit: (pointId, formData) => request(`/waves/points/${pointId}/visit`, { method: 'POST', body: formData }),
  getPointVisits: (pointId) => request(`/waves/points/${pointId}/visits`),

  logCall: (data) => request('/waves/calls', { method: 'POST', body: JSON.stringify(data) }),
  getCalls: (params = {}) => request(`/waves/calls?${new URLSearchParams(params).toString()}`),
  getDueReminders: () => request('/waves/calls/due-reminders'),
  markReminderSent: (id) => request(`/waves/calls/${id}/remind`, { method: 'POST' }),

  // Order lifecycle: listing, approval, amend, fulfillment, WhatsApp inbox
  getOrders: (params = {}) => request(`/orders?${new URLSearchParams(params).toString()}`),
  getOrder: (id) => request(`/orders/${id}`),
  getOrderHistory: (id) => request(`/orders/${id}/history`),
  approveOrderLifecycle: (id) => request(`/orders/${id}/approve`, { method: 'POST' }),
  rejectOrderLifecycle: (id, reason) => request(`/orders/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
  amendOrder: (id, data) => request(`/orders/${id}/amend`, { method: 'PUT', body: JSON.stringify(data) }),
  setOrderStatus: (id, status) => request(`/orders/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
  deliverOrder: (id, data) => request(`/orders/${id}/deliver`, { method: 'POST', body: JSON.stringify(data) }),
  markOrderPaid: (id) => request(`/orders/${id}/mark-paid`, { method: 'POST' }),
  returnOrder: (id, reason) => request(`/orders/${id}/return`, { method: 'POST', body: JSON.stringify({ reason }) }),
  cancelOrderLifecycle: (id, reason) => request(`/orders/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),

  getWhatsappOrderInbox: (status) => request(`/orders/whatsapp/inbox?status=${status || 'pending_review'}`),
  submitWhatsappOrder: (data) => request('/orders/whatsapp/inbox', { method: 'POST', body: JSON.stringify(data) }),
  approveWhatsappOrder: (id, data) => request(`/orders/whatsapp/inbox/${id}/approve`, { method: 'POST', body: JSON.stringify(data) }),
  rejectWhatsappOrder: (id) => request(`/orders/whatsapp/inbox/${id}/reject`, { method: 'POST' }),

  getOrderLifecycleSettings: () => request('/orders/settings/lifecycle'),
  updateOrderLifecycleSettings: (data) => request('/orders/settings/lifecycle', { method: 'PUT', body: JSON.stringify(data) }),

  // Automatic stock check: production + warehouse-replenish requests
  getProductionRequests: (status) => request(`/production/requests${status ? `?status=${status}` : ''}`),
  getProductionRequest: (id) => request(`/production/requests/${id}`),
  setProductionRequestStatus: (id, status) => request(`/production/requests/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
  getReplenishRequests: (status) => request(`/production/replenish-requests${status ? `?status=${status}` : ''}`),
  setReplenishRequestStatus: (id, status) => request(`/production/replenish-requests/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
  getPrepPolicies: () => request('/production/prep-policies'),
  createPrepPolicy: (data) => request('/production/prep-policies', { method: 'POST', body: JSON.stringify(data) }),
  updatePrepPolicy: (id, data) => request(`/production/prep-policies/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePrepPolicy: (id) => request(`/production/prep-policies/${id}`, { method: 'DELETE' }),
  setDefaultPrepLeadTime: (leadTimeDays) => request('/production/prep-policies/default', { method: 'PUT', body: JSON.stringify({ lead_time_days: leadTimeDays }) }),

  // Returns / damaged goods
  getReturnRequests: (params = {}) => request(`/returns?${new URLSearchParams(params).toString()}`),
  getReturnRequest: (id) => request(`/returns/${id}`),
  getReturnChanges: (id) => request(`/returns/${id}/changes`),
  fileReturnRequest: (data) => request('/returns', { method: 'POST', body: JSON.stringify(data) }),
  uploadReturnMedia: (id, file, itemId) => {
    const form = new FormData();
    form.append('file', file);
    if (itemId) form.append('itemId', itemId);
    return request(`/returns/${id}/media`, { method: 'POST', body: form });
  },
  inspectReturnItem: (returnId, itemId, data) => request(`/returns/${returnId}/items/${itemId}/inspect`, { method: 'PUT', body: JSON.stringify(data) }),
  approveReturnRequest: (id, notes) => request(`/returns/${id}/approve`, { method: 'POST', body: JSON.stringify({ notes }) }),
  rejectReturnRequest: (id, notes) => request(`/returns/${id}/reject`, { method: 'POST', body: JSON.stringify({ notes }) }),
  applyReturnFinancialAdjustment: (id) => request(`/returns/${id}/apply-financial-adjustment`, { method: 'POST' }),
  getReturnFinancialSettings: () => request('/returns/settings/financial'),
  updateReturnFinancialSettings: (autoFinancialAdjustment) =>
    request('/returns/settings/financial', { method: 'PUT', body: JSON.stringify({ autoFinancialAdjustment }) }),

  // Collections: cash/transfer, confirmation, statements, reports, reminders
  recordCollection: (data) => request('/collections', { method: 'POST', body: JSON.stringify(data) }),
  getCollections: (params = {}) => request(`/collections?${new URLSearchParams(params).toString()}`),
  getCollection: (id) => request(`/collections/${id}`),
  getCollectionChanges: (id) => request(`/collections/${id}/changes`),
  confirmCollection: (id) => request(`/collections/${id}/confirm`, { method: 'POST' }),
  rejectCollection: (id, reason) => request(`/collections/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
  reverseCollection: (id, reason) => request(`/collections/${id}/reverse`, { method: 'POST', body: JSON.stringify({ reason }) }),
  reverseOpeningBalances: (entryId, reason) => request(`/ledger/opening-balances/${entryId}/reverse`, { method: 'POST', body: JSON.stringify({ reason }) }),
  getShopStatement: (shopId) => request(`/collections/statement/${shopId}`),
  getCollectionsReport: (params = {}) => request(`/collections/report/summary?${new URLSearchParams(params).toString()}`),

  // Sales documents + customer sub-ledger
  getSalesMeta: () => request('/sales/meta'),
  getSalesInvoices: (params = {}) => request(`/sales/invoices?${new URLSearchParams(params).toString()}`),
  getSalesInvoice: (id) => request(`/sales/invoices/${id}`),
  createSalesInvoice: (data) => request('/sales/invoices', { method: 'POST', body: JSON.stringify(data) }),
  updateSalesInvoice: (id, data) => request(`/sales/invoices/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteSalesInvoice: (id) => request(`/sales/invoices/${id}`, { method: 'DELETE' }),
  postSalesInvoice: (id) => request(`/sales/invoices/${id}/post`, { method: 'POST' }),
  cancelSalesInvoice: (id, data) => request(`/sales/invoices/${id}/cancel`, { method: 'POST', body: JSON.stringify(data) }),
  getCreditNotes: (params = {}) => request(`/sales/credit-notes?${new URLSearchParams(params).toString()}`),
  getCreditNote: (id) => request(`/sales/credit-notes/${id}`),
  createCreditNote: (data) => request('/sales/credit-notes', { method: 'POST', body: JSON.stringify(data) }),
  getCustomerLedger: (shopId) => request(`/sales/customers/${shopId}/ledger`),
  getSalesReconciliation: () => request('/sales/reconciliation'),
  getGoLiveRuns: () => request('/sales/go-live/runs'),
  goLiveDryRun: (date) => request('/sales/go-live/dry-run', { method: 'POST', body: JSON.stringify({ date }) }),
  executeGoLive: (dryRunId, confirmText) => request('/sales/go-live', { method: 'POST', body: JSON.stringify({ dryRunId, confirmText }) }),

  // Receivables (Prompt 3)
  getInvoiceableOrders: () => request('/sales/invoiceable-orders'),
  createInvoiceFromOrder: (orderId) => request(`/sales/invoices/from-order/${orderId}`, { method: 'POST' }),
  postSalesInvoiceWithOverride: (id, creditOverrideReason) => request(`/sales/invoices/${id}/post`, { method: 'POST', body: JSON.stringify({ creditOverrideReason }) }),
  getReceipts: (params = {}) => request(`/receivables/receipts?${new URLSearchParams(params).toString()}`),
  getReceipt: (id) => request(`/receivables/receipts/${id}`),
  createReceipt: (data) => request('/receivables/receipts', { method: 'POST', body: JSON.stringify(data) }),
  autoAllocateReceipt: (id) => request(`/receivables/receipts/${id}/auto-allocate`, { method: 'POST' }),
  setReceiptAllocations: (id, allocations) => request(`/receivables/receipts/${id}/allocations`, { method: 'PUT', body: JSON.stringify({ allocations }) }),
  reverseReceipt: (id, reason) => request(`/receivables/receipts/${id}/reverse`, { method: 'POST', body: JSON.stringify({ reason }) }),
  getOpenInvoices: (shopId) => request(`/receivables/customers/${shopId}/open-invoices`),
  getCheques: (params = {}) => request(`/receivables/cheques?${new URLSearchParams(params).toString()}`),
  receiveCheque: (data) => request('/receivables/cheques', { method: 'POST', body: JSON.stringify(data) }),
  chequeAction: (id, action, data = {}) => request(`/receivables/cheques/${id}/${action}`, { method: 'POST', body: JSON.stringify(data) }),
  // Prompt 6: purchasing (one helper per verb over /api/purchasing)
  purGet: (path, params = {}) => request(`/purchasing${path}${Object.keys(params).length ? `?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined)).toString()}` : ''}`),
  purPost: (path, body = {}) => request(`/purchasing${path}`, { method: 'POST', body: JSON.stringify(body) }),
  purPut: (path, body = {}) => request(`/purchasing${path}`, { method: 'PUT', body: JSON.stringify(body) }),
  purDel: (path) => request(`/purchasing${path}`, { method: 'DELETE' }),
  purDownload: (path, params = {}) => downloadFile(`/purchasing${path}?${new URLSearchParams(params).toString()}`),
  // Prompt 8: stock ledger (/api/stock)
  stGet: (path, params = {}) => request(`/stock${path}${Object.keys(params).length ? `?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined)).toString()}` : ''}`),
  stPost: (path, body = {}) => request(`/stock${path}`, { method: 'POST', body: JSON.stringify(body) }),
  stPut: (path, body = {}) => request(`/stock${path}`, { method: 'PUT', body: JSON.stringify(body) }),
  // Year rollover banner and the failed-posting queue
  getYearStatus: () => request('/ledger/year-status'),
  getPostingFailures: (status = 'open') => request(`/ledger/posting-failures?status=${encodeURIComponent(status)}`),
  retryPostingFailure: (id) => request(`/ledger/posting-failures/${id}/retry`, { method: 'POST', body: '{}' }),
  getAnalyticsCatalog: () => request('/analytics/catalog'),
  runAnalyticsReport: (key, params = {}) => request(`/analytics/run/${encodeURIComponent(key)}?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v !== undefined && v !== null)).toString()}`),
  analyticsDrill: (fact, filters = {}) => request(`/analytics/drill?fact=${encodeURIComponent(fact)}&filters=${encodeURIComponent(JSON.stringify(filters))}`),
  refreshAnalytics: () => request('/analytics/refresh', { method: 'POST', body: '{}' }),
  // Prompt 12b: Report Builder (/api/report-builder)
  rbGet: (path) => request(`/report-builder${path}`),
  rbPost: (path, body = {}) => request(`/report-builder${path}`, { method: 'POST', body: JSON.stringify(body) }),
  rbPut: (path, body = {}) => request(`/report-builder${path}`, { method: 'PUT', body: JSON.stringify(body) }),
  rbDelete: (path) => request(`/report-builder${path}`, { method: 'DELETE' }),
  rbDownload: (path) => downloadFile(`/report-builder${path}`),
  rbExport: (body) => downloadFile('/report-builder/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  // Prompt 11-lite: payroll accounting (/api/payroll)
  prGet: (path) => request(`/payroll${path}`),
  prPost: (path, body = {}) => request(`/payroll${path}`, { method: 'POST', body: JSON.stringify(body) }),
  prPut: (path, body = {}) => request(`/payroll${path}`, { method: 'PUT', body: JSON.stringify(body) }),
  // Prompt 10: fixed assets, tax codes, recurring entries (/api/accounting)
  acGet: (path) => request(`/accounting${path}`),
  acPost: (path, body = {}) => request(`/accounting${path}`, { method: 'POST', body: JSON.stringify(body) }),
  acPut: (path, body = {}) => request(`/accounting${path}`, { method: 'PUT', body: JSON.stringify(body) }),
  // Prompt 9: manufacturing (/api/manufacturing)
  mfGet: (path, params = {}) => request(`/manufacturing${path}${Object.keys(params).length ? `?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined)).toString()}` : ''}`),
  mfPost: (path, body = {}) => request(`/manufacturing${path}`, { method: 'POST', body: JSON.stringify(body) }),
  mfPut: (path, body = {}) => request(`/manufacturing${path}`, { method: 'PUT', body: JSON.stringify(body) }),
  mfDel: (path) => request(`/manufacturing${path}`, { method: 'DELETE' }),
  // Prompt 7: treasury (one helper per verb over /api/treasury)
  trGet: (path, params = {}) => request(`/treasury${path}${Object.keys(params).length ? `?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined)).toString()}` : ''}`),
  trPost: (path, body = {}) => request(`/treasury${path}`, { method: 'POST', body: JSON.stringify(body) }),
  trPut: (path, body = {}) => request(`/treasury${path}`, { method: 'PUT', body: JSON.stringify(body) }),
  trDel: (path) => request(`/treasury${path}`, { method: 'DELETE' }),
  trDownload: (path, params = {}) => downloadFile(`/treasury${path}?${new URLSearchParams(params).toString()}`),
  trUploadStatement: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('/treasury/bank/preview', { method: 'POST', body: form });
  },
  getCurrentRate: (currencyCode, date) => request(`/currency/rates/current?${new URLSearchParams({ currencyCode, date }).toString()}`),
  getExchangeRates: (params = {}) => request(`/currency/rates?${new URLSearchParams(params).toString()}`),
  addExchangeRate: (data) => request('/currency/rates', { method: 'POST', body: JSON.stringify(data) }),
  getCurrencyBalances: (params = {}) => request(`/currency/balances?${new URLSearchParams(params).toString()}`),
  downloadCurrencyBalances: (params = {}) => downloadFile(`/currency/balances?${new URLSearchParams(params).toString()}`),
  getFxReport: (params = {}) => request(`/currency/fx-report?${new URLSearchParams(params).toString()}`),
  downloadFxReport: (params = {}) => downloadFile(`/currency/fx-report?${new URLSearchParams(params).toString()}`),
  getRevaluations: () => request('/currency/revaluations'),
  previewRevaluation: (asOf) => request('/currency/revaluations/preview', { method: 'POST', body: JSON.stringify({ asOf }) }),
  postRevaluation: (asOf) => request('/currency/revaluations', { method: 'POST', body: JSON.stringify({ asOf }) }),
  getFinancialReport: (key, params = {}) => request(`/financial-reports/${key}?${new URLSearchParams(params).toString()}`),
  downloadFinancialReport: (key, params = {}) => downloadFile(`/financial-reports/${key}?${new URLSearchParams(params).toString()}`),
  getBudgets: () => request('/financial-reports/budgets'),
  getBudget: (id) => request(`/financial-reports/budgets/${id}`),
  createBudget: (data) => request('/financial-reports/budgets', { method: 'POST', body: JSON.stringify(data) }),
  setBudgetLines: (id, lines) => request(`/financial-reports/budgets/${id}/lines`, { method: 'PUT', body: JSON.stringify({ lines }) }),
  setBudgetStatus: (id, status) => request(`/financial-reports/budgets/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
  getYearEnd: () => request('/financial-reports/year-end'),
  closeYear: (id) => request(`/financial-reports/year-end/${id}/close`, { method: 'POST', body: '{}' }),
  reopenYear: (id, reason) => request(`/financial-reports/year-end/${id}/reopen`, { method: 'POST', body: JSON.stringify({ reason }) }),
  getMonthEnd: (periodId) => request(`/financial-reports/month-end/${periodId}`),
  getAging: (params = {}) => request(`/receivables/aging?${new URLSearchParams(params).toString()}`),
  downloadAging: (params = {}) => downloadFile(`/receivables/aging?${new URLSearchParams(params).toString()}`),
  getOpenItemsImport: () => request('/sales/go-live/open-items'),
  uploadOpenItems: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('/sales/go-live/open-items', { method: 'POST', body: form });
  },
  discardOpenItems: () => request('/sales/go-live/open-items', { method: 'DELETE' }),
  getCustomerAging: (shopId, asOf) => request(`/receivables/aging/customer/${shopId}${asOf ? `?asOf=${asOf}` : ''}`),
  getCollectionForecast: (weeks) => request(`/receivables/forecast?weeks=${weeks || 12}`),
  getArReconciliation: () => request('/receivables/reconciliation'),
  runArReconciliation: () => request('/receivables/reconciliation/run', { method: 'POST' }),
  getCustomerStatement: (shopId, params = {}) => request(`/receivables/customers/${shopId}/statement?${new URLSearchParams(params).toString()}`),
  downloadCustomerStatement: (shopId, params = {}) => downloadFile(`/receivables/customers/${shopId}/statement?${new URLSearchParams(params).toString()}`),
  sendCustomerStatement: (shopId, data = {}) => request(`/receivables/customers/${shopId}/statement/send`, { method: 'POST', body: JSON.stringify(data) }),
  getReceivablesSettings: () => request('/receivables/settings'),
  saveReceivablesSettings: (data) => request('/receivables/settings', { method: 'PUT', body: JSON.stringify(data) }),

  // Ledger (double-entry core)
  getLedgerMeta: () => request('/ledger/meta'),
  getLedgerAccounts: () => request('/ledger/accounts'),
  createLedgerAccount: (data) => request('/ledger/accounts', { method: 'POST', body: JSON.stringify(data) }),
  updateLedgerAccount: (id, data) => request(`/ledger/accounts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  applyCoaTemplate: (key) => request(`/ledger/coa-templates/${key}/apply`, { method: 'POST' }),
  saveLedgerDimension: (kind, id, data) =>
    request(`/ledger/${kind}${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(data) }),
  getFiscalYears: () => request('/ledger/fiscal-years'),
  createFiscalYear: (data) => request('/ledger/fiscal-years', { method: 'POST', body: JSON.stringify(data) }),
  getFiscalPeriods: (fiscalYearId) => request(`/ledger/periods${fiscalYearId ? `?fiscalYearId=${fiscalYearId}` : ''}`),
  setFiscalPeriodStatus: (id, action) => request(`/ledger/periods/${id}/${action}`, { method: 'POST' }),
  getJournalEntries: (params = {}) => request(`/ledger/entries?${new URLSearchParams(params).toString()}`),
  getJournalEntry: (id) => request(`/ledger/entries/${id}`),
  createJournalEntry: (data) => request('/ledger/entries', { method: 'POST', body: JSON.stringify(data) }),
  updateJournalEntry: (id, data) => request(`/ledger/entries/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteJournalEntry: (id) => request(`/ledger/entries/${id}`, { method: 'DELETE' }),
  postJournalEntry: (id) => request(`/ledger/entries/${id}/post`, { method: 'POST' }),
  reverseJournalEntry: (id, data) => request(`/ledger/entries/${id}/reverse`, { method: 'POST', body: JSON.stringify(data) }),
  uploadJournalAttachment: (id, file) => {
    const form = new FormData();
    form.append('file', file);
    return request(`/ledger/entries/${id}/attachments`, { method: 'POST', body: form });
  },
  downloadJournalAttachment: (id) => downloadFile(`/ledger/attachments/${id}`),
  getLedgerIntegrity: () => request('/ledger/integrity-check'),
  getOpeningBalanceEntries: () => request('/ledger/opening-balances'),
  previewOpeningBalances: (rows) => request('/ledger/opening-balances/preview', { method: 'POST', body: JSON.stringify({ rows }) }),
  postOpeningBalances: (data) => request('/ledger/opening-balances', { method: 'POST', body: JSON.stringify(data) }),
  uploadOpeningBalances: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('/ledger/opening-balances/upload', { method: 'POST', body: form });
  },

  getPaymentReminders: (status) => request(`/collections/reminders?status=${status || 'pending_review'}`),
  sendPaymentReminder: (id, message) => request(`/collections/reminders/${id}/send`, { method: 'POST', body: JSON.stringify({ message }) }),
  dismissPaymentReminder: (id) => request(`/collections/reminders/${id}/dismiss`, { method: 'POST' }),

  getCollectionsSettings: () => request('/collections/settings/collections'),
  updateCollectionsSettings: (data) => request('/collections/settings/collections', { method: 'PUT', body: JSON.stringify(data) }),

  // WhatsApp bot: conversation log, alerts, tickets, statements, settings
  getWhatsappMessages: (shopId) => request(`/whatsapp-bot/messages${shopId ? `?shopId=${shopId}` : ''}`),
  getWhatsappShopThread: (shopId) => request(`/whatsapp-bot/messages/shop/${shopId}`),
  simulateWhatsappIncoming: (fromPhone, body) =>
    request('/whatsapp-bot/simulate-incoming', { method: 'POST', body: JSON.stringify({ fromPhone, body }) }),
  replyWhatsappShopThread: (shopId, message) =>
    request(`/whatsapp-bot/messages/shop/${shopId}/reply`, { method: 'POST', body: JSON.stringify({ message }) }),
  getWhatsappAlerts: () => request('/whatsapp-bot/alerts'),
  dismissWhatsappAlert: (id) => request(`/whatsapp-bot/alerts/${id}/dismiss`, { method: 'POST' }),
  getWhatsappTickets: (status) => request(`/whatsapp-bot/tickets${status ? `?status=${status}` : ''}`),
  updateWhatsappTicket: (id, data) => request(`/whatsapp-bot/tickets/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  sendWhatsappStatement: (shopId) => request(`/whatsapp-bot/messages/shop/${shopId}/send-statement`, { method: 'POST' }),
  getWhatsappBotSettings: () => request('/whatsapp-bot/settings'),
  updateWhatsappBotSettings: (data) => request('/whatsapp-bot/settings', { method: 'PUT', body: JSON.stringify(data) }),

  // WhatsApp bot knowledge base: company-side read-only view + suggestions
  getKnowledgeBase: () => request('/whatsapp-bot/knowledge-base'),
  getKnowledgeBaseSubmissions: (status) => request(`/whatsapp-bot/knowledge-base/submissions${status ? `?status=${status}` : ''}`),
  answerNewWhatsappQuestion: (shopId, data) =>
    request(`/whatsapp-bot/messages/shop/${shopId}/answer-new-question`, { method: 'POST', body: JSON.stringify(data) }),

  // Advisory AI layer: product suggestions, anomaly detection, stock
  // forecast, wave summaries — every result is a proposal, never an
  // automatic action.
  getAiProductSuggestions: (shopId) => request(`/ai/shops/${shopId}/product-suggestions`),
  getAiRecommendations: (params = {}) => request(`/ai/recommendations?${new URLSearchParams(params).toString()}`),
  getAiRecommendation: (id) => request(`/ai/recommendations/${id}`),
  decideAiRecommendation: (id, status, reason) =>
    request(`/ai/recommendations/${id}/decide`, { method: 'POST', body: JSON.stringify({ status, reason }) }),
  getAiStockForecast: () => request('/ai/stock-forecast'),
  runAiStockForecast: () => request('/ai/stock-forecast/run', { method: 'POST' }),
  getAiSettings: () => request('/ai/settings'),
  updateAiSettings: (data) => request('/ai/settings', { method: 'PUT', body: JSON.stringify(data) }),

  // Legal: privacy policy shown (and required to be accepted, via
  // createCompany's acceptedPrivacyPolicy flag) at signup.
  getPrivacyPolicy: () => request('/legal/privacy-policy'),

  // Anonymized, aggregated cross-company market intelligence — never
  // company- or customer-specific, see backend/lib/marketIntelligence.js.
  getMarketIntelligenceStats: (params = {}) => request(`/market-intelligence/stats?${new URLSearchParams(params).toString()}`),

  // Role-based dashboards
  getManagerDashboard: () => request('/dashboards/manager'),
  // Department dashboards (warehouse / accounting / vendors)
  getDepartments: () => request('/departments'),
  getDepartmentDashboard: (dept) => request(`/departments/${dept}`),
  getSupervisorDashboard: () => request('/dashboards/supervisor'),
  getRepDashboard: () => request('/dashboards/rep'),
  getDashboardHiddenSections: (dashboard) => request(`/dashboards/${dashboard}/sections`),
  setDashboardHiddenSections: (dashboard, hidden) => request(`/dashboards/${dashboard}/sections`, { method: 'PUT', body: JSON.stringify({ hidden }) }),

  // Filterable reports (period/city/region/rep/customer/product/warehouse/
  // vehicle/branch — see backend/lib/reportFilters.js), heatmap, pivot,
  // AI summaries, and saved filter presets.
  getReport: (reportKey, params = {}) => request(`/reports/${reportKey}?${new URLSearchParams(params).toString()}`),
  getReportHeatmap: (params = {}) => request(`/reports/heatmap/data?${new URLSearchParams(params).toString()}`),
  getReportPivot: (params = {}) => request(`/reports/pivot/table?${new URLSearchParams(params).toString()}`),
  requestReportAiSummary: (reportKey, params = {}) =>
    request(`/reports/${reportKey}/ai-summary?${new URLSearchParams(params).toString()}`, { method: 'POST' }),
  decideReportAiSummary: (id, status, reason) =>
    request(`/reports/ai-summary/${id}/decide`, { method: 'POST', body: JSON.stringify({ status, reason }) }),
  getSavedReportFilters: (reportKey) => request(`/reports/saved-filters/${reportKey}`),
  saveReportFilter: (reportKey, name, filters) =>
    request(`/reports/saved-filters/${reportKey}`, { method: 'POST', body: JSON.stringify({ name, filters }) }),
  deleteSavedReportFilter: (id) => request(`/reports/saved-filters/${id}`, { method: 'DELETE' }),

  // Document templates: platform catalog, per-company selection, custom
  // upload-for-review, and rendering (invoice/statement/delivery-note/
  // receipt/report/whatsapp-message).
  getDocumentTemplateCatalog: () => request('/document-templates/catalog'),
  getDocumentTemplateSelections: () => request('/document-templates/selections'),
  setDocumentTemplateSelection: (documentType, data) =>
    request(`/document-templates/selections/${documentType}`, { method: 'PUT', body: JSON.stringify(data) }),
  getCustomDocumentTemplates: () => request('/document-templates/custom'),
  submitCustomDocumentTemplate: (data) => request('/companies/document-templates', { method: 'POST', body: JSON.stringify(data) }),
  renderInvoiceUrl: (orderId, format = 'pdf') => `/api/document-templates/render/invoice/${orderId}?format=${format}`,
  renderDeliveryNoteUrl: (orderId, format = 'pdf') => `/api/document-templates/render/delivery-note/${orderId}?format=${format}`,
  renderReceiptUrl: (collectionId, format = 'pdf') => `/api/document-templates/render/receipt/${collectionId}?format=${format}`,
  renderStatementUrl: (shopId, format = 'pdf') => `/api/document-templates/render/statement/${shopId}?format=${format}`,
  renderReportDocument: (title, columns, rows) =>
    request('/document-templates/render/report', { method: 'POST', body: JSON.stringify({ title, columns, rows }) }),
  renderWhatsappMessageDocument: (message) =>
    request('/document-templates/render/whatsapp-message', { method: 'POST', body: JSON.stringify({ message }) }),

  // Offline sync: local-cache pull, batch queue submission (idempotent),
  // this user's own queue history, sensitive-op approval, and manual
  // conflict resolution — never an automatic pick between client/server.
  getSyncPullData: () => request('/sync/pull-data'),
  submitSyncBatch: (operations) => request('/sync/batch', { method: 'POST', body: JSON.stringify({ operations }) }),
  getSyncQueue: () => request('/sync/queue'),
  getSyncSettings: () => request('/sync/settings'),
  updateSyncSettings: (sensitiveOpsMode) => request('/sync/settings', { method: 'PUT', body: JSON.stringify({ sensitiveOpsMode }) }),
  getSyncPendingApproval: () => request('/sync/pending-approval'),
  decideSyncPendingOperation: (id, decision) => request(`/sync/pending-approval/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision }) }),
  getSyncConflicts: (status = 'pending') => request(`/sync/conflicts?status=${status}`),
  resolveSyncConflict: (id, resolution, mergedPayload, notes) =>
    request(`/sync/conflicts/${id}/resolve`, { method: 'POST', body: JSON.stringify({ resolution, mergedPayload, notes }) }),

  // Trusted devices: app-lock/biometric itself is device-native; this is
  // the server side — registration, listing, revoke + remote wipe.
  registerDevice: (data) => request('/devices/register', { method: 'POST', body: JSON.stringify(data) }),
  acknowledgeDeviceWipe: (deviceId) => request('/devices/acknowledge-wipe', { method: 'POST', body: JSON.stringify({ deviceId }) }),
  getMyDevices: () => request('/devices'),
  getUserDevices: (userId) => request(`/devices/users/${userId}`),
  revokeDevice: (id) => request(`/devices/${id}/revoke`, { method: 'POST' }),

  // Universal search across shops/products/orders in one call
  search: (q) => request(`/search?q=${encodeURIComponent(q)}`),

  // Support tickets (company side) + help center content
  createSupportTicket: (data) => request('/support-tickets', { method: 'POST', body: JSON.stringify(data) }),
  getSupportTickets: (status) => request(`/support-tickets${status ? `?status=${status}` : ''}`),
  getSupportTicket: (id) => request(`/support-tickets/${id}`),
  replySupportTicket: (id, body) => request(`/support-tickets/${id}/reply`, { method: 'POST', body: JSON.stringify({ body }) }),
  getTrainingVideos: () => request('/help-center/training-videos'),
  getChangelog: () => request('/help-center/changelog'),

  // Document numbering config per company/document type
  getDocumentNumbering: (documentType) => request(`/document-templates/numbering/${documentType}`),
  setDocumentNumbering: (documentType, data) =>
    request(`/document-templates/numbering/${documentType}`, { method: 'PUT', body: JSON.stringify(data) }),

  // ---- Platform Admin: technical dashboard + support tickets + help-center management ----
  platformGetFailedLogins: (hours) => request(`/platform-admin/technical/failed-logins${hours ? `?hours=${hours}` : ''}`),
  platformGetActiveSessions: () => request('/platform-admin/technical/sessions'),
  platformGetErrorLog: () => request('/platform-admin/technical/errors'),
  platformGetIntegrationHealth: () => request('/platform-admin/technical/integration-health'),
  platformListSupportTickets: (status) => request(`/platform-admin/support-tickets${status ? `?status=${status}` : ''}`),
  platformGetSupportTicket: (id) => request(`/platform-admin/support-tickets/${id}`),
  platformReplySupportTicket: (id, body, status) =>
    request(`/platform-admin/support-tickets/${id}/reply`, { method: 'POST', body: JSON.stringify({ body, status }) }),
  platformAddTrainingVideo: (data) => request('/platform-admin/training-videos', { method: 'POST', body: JSON.stringify(data) }),
  platformAddChangelogEntry: (data) => request('/platform-admin/changelog', { method: 'POST', body: JSON.stringify(data) }),

  getSettings: () => request('/settings'),
  updateSettings: (data) => request('/settings', { method: 'PUT', body: JSON.stringify(data) }),
  getPublicDefaults: () => request('/settings/public-defaults'),
  uploadLogo: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('/settings/logo', { method: 'POST', body: form });
  },

  getProducts: (all = false) => request(`/products${all ? '?all=1' : ''}`),
  createProduct: (data) => request('/products', { method: 'POST', body: JSON.stringify(data) }),
  updateProduct: (id, data) => request(`/products/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteProduct: (id) => request(`/products/${id}`, { method: 'DELETE' }),
  getMaterialStats: (period) => request(`/products/material-stats?period=${period}`),
  previewProductImport: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('/products/import/preview', { method: 'POST', body: form });
  },
  commitProductImport: (rows) =>
    request('/products/import/commit', { method: 'POST', body: JSON.stringify({ rows }) }),

  getDayPlan: (classification, date, repId) => {
    const params = new URLSearchParams();
    if (classification) params.set('classification', classification);
    if (date) params.set('date', date);
    if (repId) params.set('repId', repId);
    const qs = params.toString();
    return request(`/day-plan${qs ? `?${qs}` : ''}`);
  },
  getDayPlanReps: () => request('/day-plan/reps'),
  addToDayPlan: (shopId, date, repId) =>
    request(`/day-plan/manual${repId ? `?repId=${repId}` : ''}`, { method: 'POST', body: JSON.stringify({ shopId, date }) }),
  removeFromDayPlan: (shopId, date, repId) => {
    const params = new URLSearchParams();
    if (date) params.set('date', date);
    if (repId) params.set('repId', repId);
    const qs = params.toString();
    return request(`/day-plan/manual/${shopId}${qs ? `?${qs}` : ''}`, { method: 'DELETE' });
  },

  uploadImport: (file, reportDate) => {
    const form = new FormData();
    form.append('file', file);
    if (reportDate) form.append('report_date', reportDate);
    return request('/import/upload', { method: 'POST', body: form });
  },
  getImportMapping: () => request('/import/mapping'),
  listImportBatches: () => request('/import/batches'),
  stageImportBatch: (batchId, data) =>
    request(`/import/batches/${batchId}/stage`, { method: 'POST', body: JSON.stringify(data) }),
  getImportBatch: (batchId) => request(`/import/batches/${batchId}`),
  linkImportRow: (batchId, rowId, data) =>
    request(`/import/batches/${batchId}/rows/${rowId}/link`, { method: 'POST', body: JSON.stringify(data) }),
  ignoreImportRow: (batchId, rowId) =>
    request(`/import/batches/${batchId}/rows/${rowId}/ignore`, { method: 'POST' }),
  commitImportBatch: (batchId) => request(`/import/batches/${batchId}/commit`, { method: 'POST' }),

  getInventory: () => request('/inventory'),
  getInventoryAlerts: () => request('/inventory/alerts'),
  createInventoryItem: (data) => request('/inventory', { method: 'POST', body: JSON.stringify(data) }),
  updateInventoryItem: (id, data) => request(`/inventory/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteInventoryItem: (id) => request(`/inventory/${id}`, { method: 'DELETE' }),
  exportInventory: (lang) => downloadFile(`/inventory/export${lang ? `?lang=${lang}` : ''}`),

  getFactoryInventory: () => request('/factory-inventory'),
  getFactoryInventoryAlerts: () => request('/factory-inventory/alerts'),
  createFactoryInventoryItem: (data) =>
    request('/factory-inventory', { method: 'POST', body: JSON.stringify(data) }),
  updateFactoryInventoryItem: (id, data) =>
    request(`/factory-inventory/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteFactoryInventoryItem: (id) => request(`/factory-inventory/${id}`, { method: 'DELETE' }),
  exportFactoryInventory: (lang) => downloadFile(`/factory-inventory/export${lang ? `?lang=${lang}` : ''}`),

  // Shared by both warehouses — prefix is 'inventory' or 'factory-inventory'.
  previewItemImport: (prefix, file) => {
    const form = new FormData();
    form.append('file', file);
    return request(`/${prefix}/import/preview`, { method: 'POST', body: form });
  },
  commitItemImport: (prefix, rows) =>
    request(`/${prefix}/import/commit`, { method: 'POST', body: JSON.stringify({ rows }) }),

  // Physical stock count (جرد المستودع) — same prefix pattern as the
  // threshold import above, but comparing an uploaded count against the
  // system's current quantity instead of editing minimums.
  previewInventoryCount: (prefix, file) => {
    const form = new FormData();
    form.append('file', file);
    return request(`/${prefix}/count/preview`, { method: 'POST', body: form });
  },
  confirmInventoryCount: (prefix, rows, filename) =>
    request(`/${prefix}/count/confirm`, { method: 'POST', body: JSON.stringify({ rows, filename }) }),
  getInventoryCountHistory: (prefix) => request(`/${prefix}/count/history`),

  exportShops: (options = {}) => {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(options).filter(([, v]) => v))).toString();
    return downloadFile(`/shops/export${qs ? `?${qs}` : ''}`);
  },

  getOverviewStats: () => request('/stats/overview'),
  getMonthlyTarget: () => request('/stats/monthly-target'),
  getMonthlySales: () => request('/stats/monthly-sales'),
  getMonthDetail: (month) => request(`/stats/monthly-sales/${month}`),
  getSalesReport: (filters = {}) => {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, v]) => v))).toString();
    return request(`/stats/sales-report${qs ? `?${qs}` : ''}`);
  },
  getBalancesReport: () => request('/stats/balances-report'),
  getInventoryReport: () => request('/stats/inventory-report'),
  exportStatsReport: (report, format, filters = {}) => {
    const entries = Object.entries({ report, format, ...filters }).filter(([, v]) => v !== undefined && v !== null && v !== '');
    const qs = new URLSearchParams(Object.fromEntries(entries)).toString();
    return downloadFile(`/stats/export?${qs}`);
  },
  getMaterialDetail: (productId) => request(`/products/${productId}/detail-stats`),

  getInvoicesByDay: (date) => request(`/invoices/by-day?date=${date}`),
  exportInvoicesByDay: (date, format, lang) =>
    downloadFile(`/invoices/by-day/export?date=${date}&format=${format}${lang ? `&lang=${lang}` : ''}`),

  getReps: () => request('/targets/reps'),
  getTargets: (userId) => request(`/targets?userId=${userId}`),
  getTargetProgress: (userId) => request(`/targets/progress${userId ? `?userId=${userId}` : ''}`),
  setTarget: (userId, period, value) =>
    request('/targets', { method: 'PUT', body: JSON.stringify({ userId, period, value }) }),

  getWhatsAppStatus: () => request('/whatsapp/status'),
  connectWhatsApp: () => request('/whatsapp/connect', { method: 'POST' }),
  disconnectWhatsApp: () => request('/whatsapp/disconnect', { method: 'POST' }),
  requestWhatsAppLink: (requestedNumber) =>
    request('/whatsapp/request', { method: 'POST', body: JSON.stringify({ requested_number: requestedNumber }) }),

  // ---- Companies / Startup Setup ----
  createCompany: (data) => request('/companies', { method: 'POST', body: JSON.stringify(data) }),
  getCompanyMe: () => request('/companies/me'),
  updateCompanyMe: (data) => request('/companies/me', { method: 'PUT', body: JSON.stringify(data) }),
  getSetup: () => request('/companies/setup'),
  saveSetup: (data) => request('/companies/setup', { method: 'PUT', body: JSON.stringify(data) }),
  completeSetup: () => request('/companies/setup/complete', { method: 'POST' }),
  updateModules: (modules) => request('/companies/modules', { method: 'PUT', body: JSON.stringify({ modules }) }),
  getWarehouses: () => request('/companies/warehouses'),
  addWarehouse: (data) => request('/companies/warehouses', { method: 'POST', body: JSON.stringify(data) }),
  // ---- Custody transfers (warehouse -> vehicle/rep custody) ----
  getCustodyTransfers: (params = {}) => {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v))).toString();
    return request(`/custody-transfers${qs ? `?${qs}` : ''}`);
  },
  getCustodyTransfer: (id) => request(`/custody-transfers/${id}`),
  getCustodyTransferChanges: (id) => request(`/custody-transfers/${id}/changes`),
  createCustodyTransfer: (data) => request('/custody-transfers', { method: 'POST', body: JSON.stringify(data) }),
  createCustodyTransferFromReplenishRequest: (requestId) =>
    request(`/custody-transfers/from-replenish-request/${requestId}`, { method: 'POST' }),
  addCustodyTransferItem: (id, data) => request(`/custody-transfers/${id}/items`, { method: 'POST', body: JSON.stringify(data) }),
  updateCustodyTransferItem: (id, itemId, data) =>
    request(`/custody-transfers/${id}/items/${itemId}`, { method: 'PUT', body: JSON.stringify(data) }),
  removeCustodyTransferItem: (id, itemId) => request(`/custody-transfers/${id}/items/${itemId}`, { method: 'DELETE' }),
  readyCustodyTransfer: (id) => request(`/custody-transfers/${id}/ready`, { method: 'POST' }),
  confirmCustodyTransferReceipt: (id, items) =>
    request(`/custody-transfers/${id}/confirm-receipt`, { method: 'POST', body: JSON.stringify({ items }) }),
  resolveCustodyTransferDiscrepancy: (id, itemId, data) =>
    request(`/custody-transfers/${id}/items/${itemId}/resolve-discrepancy`, { method: 'PUT', body: JSON.stringify(data) }),
  cancelCustodyTransfer: (id) => request(`/custody-transfers/${id}/cancel`, { method: 'POST' }),
  deleteWarehouse: (id) => request(`/companies/warehouses/${id}`, { method: 'DELETE' }),
  getVehicles: () => request('/companies/vehicles'),
  addVehicle: (data) => request('/companies/vehicles', { method: 'POST', body: JSON.stringify(data) }),
  deleteVehicle: (id) => request(`/companies/vehicles/${id}`, { method: 'DELETE' }),
  setVehicleReps: (id, repIds) => request(`/companies/vehicles/${id}/reps`, { method: 'PUT', body: JSON.stringify({ repIds }) }),
  getDataRestoreRequests: () => request('/companies/data-restore-requests'),
  requestDataRestore: (description) =>
    request('/companies/data-restore-requests', { method: 'POST', body: JSON.stringify({ description }) }),
  getDocumentTemplates: () => request('/companies/document-templates'),
  submitDocumentTemplate: (data) => request('/companies/document-templates', { method: 'POST', body: JSON.stringify(data) }),

  // ---- Platform Admin ----
  platformRecomputeMarketIntelligence: (period) =>
    request('/platform-admin/market-intelligence/recompute', { method: 'POST', body: JSON.stringify({ period }) }),
  platformGetMarketIntelligenceStats: (params = {}) =>
    request(`/platform-admin/market-intelligence/stats?${new URLSearchParams(params).toString()}`),
  platformListCompanies: () => request('/platform-admin/companies'),
  platformGetCompany: (id) => request(`/platform-admin/companies/${id}`),
  platformSetSubscription: (id, status) =>
    request(`/platform-admin/companies/${id}/subscription`, { method: 'PUT', body: JSON.stringify({ status }) }),
  platformListWhatsappRequests: (status) => request(`/platform-admin/whatsapp_link_requests${status ? `?status=${status}` : ''}`),
  platformApproveWhatsapp: (id, note) => request(`/platform-admin/whatsapp_link_requests/${id}/approve`, { method: 'POST', body: JSON.stringify({ note }) }),
  platformRejectWhatsapp: (id, note) => request(`/platform-admin/whatsapp_link_requests/${id}/reject`, { method: 'POST', body: JSON.stringify({ note }) }),
  platformListDataRestore: (status) => request(`/platform-admin/data_restore_requests${status ? `?status=${status}` : ''}`),
  platformApproveDataRestore: (id, note) => request(`/platform-admin/data_restore_requests/${id}/approve`, { method: 'POST', body: JSON.stringify({ note }) }),
  platformRejectDataRestore: (id, note) => request(`/platform-admin/data_restore_requests/${id}/reject`, { method: 'POST', body: JSON.stringify({ note }) }),
  platformListDocumentTemplates: (status) => request(`/platform-admin/document_templates${status ? `?status=${status}` : ''}`),
  platformApproveDocumentTemplate: (id, note) => request(`/platform-admin/document_templates/${id}/approve`, { method: 'POST', body: JSON.stringify({ note }) }),
  platformRejectDocumentTemplate: (id, note) => request(`/platform-admin/document_templates/${id}/reject`, { method: 'POST', body: JSON.stringify({ note }) }),
  platformListKbSubmissions: (status) => request(`/platform-admin/kb-submissions${status ? `?status=${status}` : ''}`),
  // data may include edited { question, answer, keywords, note } before publishing
  platformApproveKbSubmission: (id, data = {}) => request(`/platform-admin/kb-submissions/${id}/approve`, { method: 'POST', body: JSON.stringify(data) }),
  platformRejectKbSubmission: (id, note) => request(`/platform-admin/kb-submissions/${id}/reject`, { method: 'POST', body: JSON.stringify({ note }) }),

  previewShopImport: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('/shop-import/preview', { method: 'POST', body: form });
  },
  commitShopImport: (rows, batchId) =>
    request('/shop-import/commit', { method: 'POST', body: JSON.stringify({ rows, batch_id: batchId }) }),
  listShopImportBatches: () => request('/shop-import/batches'),
};
