import { useEffect, useState } from 'react';
import { api } from '../api.js';
import UnitQtyInput from './UnitQtyInput.jsx';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import { unitLabel } from '../lib/units.js';
import '../styles/order-form.css';
import '../styles/unit-input.css';
import '../styles/invoice.css';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function formatOrderItem(it) {
  const qty = it.enteredQty ?? it.qty;
  const unit = it.enteredUnit ? unitLabel(it.enteredUnit) : it.unit || '';
  return `${it.product_name} × ${qty}${unit ? ` ${unit}` : ''}`;
}

// Two modes driven by the `invoiceId` prop: without it, this starts a fresh
// upload (image + date, then the review/confirm step below); with it
// (notification deep-link into an existing invoice), it loads straight into
// review — read-only once already confirmed, showing the reconciliation
// outcome instead of editable fields.
export default function InvoiceUploadReview({ shopId, invoiceId, onCancel, onSaved }) {
  const { t } = useLanguage();
  const RECONCILIATION_LABEL = {
    pending: { text: t('invoiceReview.pending'), cls: 'pending' },
    matched: { text: t('invoiceReview.matched'), cls: 'matched' },
    mismatch: { text: t('invoiceReview.mismatch'), cls: 'mismatch' },
  };
  const [products, setProducts] = useState([]);
  const [invoice, setInvoice] = useState(null);
  const [loadingInvoice, setLoadingInvoice] = useState(!!invoiceId);
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [invoiceDate, setInvoiceDate] = useState(todayStr());
  const [qtyByProduct, setQtyByProduct] = useState({});
  const [enteredByProduct, setEnteredByProduct] = useState({});
  const [totalValue, setTotalValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getProducts().then(setProducts).catch(() => setProducts([]));
  }, []);

  useEffect(() => {
    if (!invoiceId) return;
    setLoadingInvoice(true);
    api
      .getInvoice(invoiceId)
      .then((inv) => {
        setInvoice(inv);
        setInvoiceDate(inv.invoice_date);
      })
      .finally(() => setLoadingInvoice(false));
  }, [invoiceId]);

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const inv = await api.uploadInvoice(shopId, file, invoiceDate);
      setInvoice(inv);
    } catch (err) {
      setError(t('invoiceReview.errorUploadFailed'));
    } finally {
      setUploading(false);
    }
  }

  const selectedIds = Object.keys(qtyByProduct).filter((id) => qtyByProduct[id] > 0);

  function toggleProduct(product) {
    setQtyByProduct((prev) => {
      const next = { ...prev };
      if (Object.prototype.hasOwnProperty.call(next, product.id)) delete next[product.id];
      else next[product.id] = 1;
      return next;
    });
    setEnteredByProduct((prev) => ({ ...prev, [product.id]: { qty: 1, unit: 'kg' } }));
  }

  async function handleConfirm() {
    setError(null);
    if (selectedIds.length === 0) {
      setError(t('invoiceReview.errorSelectProduct'));
      return;
    }
    if (totalValue === '' || Number.isNaN(Number(totalValue)) || Number(totalValue) <= 0) {
      setError(t('invoiceReview.errorPositiveTotal'));
      return;
    }
    setSaving(true);
    try {
      const items = selectedIds.map((id) => {
        const product = products.find((p) => String(p.id) === id);
        const entered = enteredByProduct[id] || { qty: qtyByProduct[id], unit: 'kg' };
        return {
          product_id: product.id,
          product_name: product.name,
          unit: product.unit,
          qty: qtyByProduct[id],
          enteredQty: entered.qty,
          enteredUnit: entered.unit,
        };
      });
      const updated = await api.confirmInvoice(invoice.id, {
        invoice_date: invoiceDate,
        items,
        total_value: Number(totalValue),
      });
      onSaved?.(updated);
    } catch (err) {
      if (err.detail?.error === 'total_value_must_be_positive') setError(t('invoiceReview.errorTotalMustBePositive'));
      else if (err.detail?.error === 'item_quantity_must_be_positive') setError(t('invoiceReview.errorItemQtyMustBePositive'));
      else if (err.detail?.error === 'invoice_already_confirmed') setError(t('invoiceReview.errorAlreadyConfirmed'));
      else setError(t('invoiceReview.errorSaveFailed'));
    } finally {
      setSaving(false);
    }
  }

  if (loadingInvoice) return <p className="shop-panel-loading">{t('invoiceReview.loading')}</p>;

  // Step 0: no invoice attached yet — pick an image + date
  if (!invoice) {
    return (
      <div className="invoice-review">
        <h2 className="shop-panel-name">{t('invoiceReview.uploadTitle')}</h2>
        <p className="settings-hint">{t('invoiceReview.uploadHint')}</p>
        <div className="qof-field">
          <label>{t('invoiceReview.invoiceDate')}</label>
          <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
        </div>
        <div className="qof-field">
          <label>{t('invoiceReview.invoiceImage')}</label>
          <input type="file" accept=".png,.jpg,.jpeg,.webp" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </div>
        {error && <p className="qof-error">{error}</p>}
        <div className="qof-actions">
          <button type="button" className="ghost-btn" onClick={onCancel} disabled={uploading}>
            {t('invoiceReview.cancel')}
          </button>
          <button type="button" className="gold-btn qof-save" onClick={handleUpload} disabled={uploading || !file}>
            {uploading ? t('invoiceReview.uploading') : t('invoiceReview.uploadAndContinue')}
          </button>
        </div>
      </div>
    );
  }

  const alreadyConfirmed = !!invoice.order_id;
  const reconciliation = RECONCILIATION_LABEL[invoice.reconciliation_status] || RECONCILIATION_LABEL.pending;

  return (
    <div className="invoice-review">
      <h2 className="shop-panel-name">{alreadyConfirmed ? t('invoiceReview.detailsTitle') : t('invoiceReview.reviewTitle')}</h2>

      <div className="invoice-review-layout">
        <div className="invoice-review-image">
          <img src={invoice.image_url} alt={t('invoiceReview.imageAlt')} />
        </div>

        <div className="invoice-review-fields">
          {alreadyConfirmed && (
            <div className={'invoice-reconciliation-badge ' + reconciliation.cls}>
              {reconciliation.text}
              {invoice.reconciliation_status === 'mismatch' && invoice.reconciliation_diff != null && (
                <span className="invoice-reconciliation-diff">
                  ({t('invoiceReview.diffPrefix')} {Number(invoice.reconciliation_diff).toLocaleString('ar')})
                </span>
              )}
            </div>
          )}

          <div className="qof-field">
            <label>{t('invoiceReview.invoiceDate')}</label>
            <input
              type="date"
              value={invoiceDate}
              disabled={alreadyConfirmed}
              onChange={(e) => setInvoiceDate(e.target.value)}
            />
          </div>

          {!alreadyConfirmed && (
            <div className="qof-products">
              {products.map((product) => {
                const selected = Object.prototype.hasOwnProperty.call(qtyByProduct, product.id);
                return (
                  <div key={product.id} className={'qof-product' + (selected ? ' selected' : '')}>
                    <button type="button" className="qof-product-btn" onClick={() => toggleProduct(product)}>
                      {product.name}
                      {product.unit ? <span className="qof-unit"> / {product.unit}</span> : null}
                    </button>
                    {selected && (
                      <UnitQtyInput
                        showStepper
                        valueKg={qtyByProduct[product.id]}
                        boxWeightGrams={product.box_weight_grams}
                        initialUnit={enteredByProduct[product.id]?.unit || 'kg'}
                        onChangeKg={(kg) => setQtyByProduct((prev) => ({ ...prev, [product.id]: kg }))}
                        onChangeEntered={(qty, unit) =>
                          setEnteredByProduct((prev) => ({ ...prev, [product.id]: { qty, unit } }))
                        }
                      />
                    )}
                  </div>
                );
              })}
              {products.length === 0 && <p className="qof-empty">{t('invoiceReview.noProducts')}</p>}
            </div>
          )}

          {alreadyConfirmed && invoice.order?.items?.length > 0 && (
            <div className="order-row-items">
              {invoice.order.items.map((it, i) => (
                <span key={i} className="order-item-chip">
                  {formatOrderItem(it)}
                </span>
              ))}
            </div>
          )}

          <div className="qof-field">
            <label>{t('invoiceReview.totalValue')}</label>
            <input
              type="number"
              inputMode="decimal"
              placeholder="0.00"
              value={alreadyConfirmed ? invoice.order?.total_value ?? '' : totalValue}
              disabled={alreadyConfirmed}
              onChange={(e) => setTotalValue(e.target.value)}
            />
          </div>

          {error && <p className="qof-error">{error}</p>}

          <div className="qof-actions">
            <button type="button" className="ghost-btn" onClick={onCancel}>
              {alreadyConfirmed ? t('invoiceReview.close') : t('invoiceReview.cancel')}
            </button>
            {!alreadyConfirmed && (
              <button type="button" className="gold-btn qof-save" onClick={handleConfirm} disabled={saving}>
                {saving ? t('invoiceReview.saving') : t('invoiceReview.confirmSave')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
