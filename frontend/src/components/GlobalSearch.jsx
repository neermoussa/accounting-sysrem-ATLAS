import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import '../styles/global-search.css';

// Loaded once, lazily, on first focus — cheap to filter client-side per
// keystroke even for a few hundred shops, and avoids a fetch on every page
// load for users who never touch the search box.
export default function GlobalSearch() {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const STATUS_LABEL = { red: t('globalSearch.statusRed'), yellow: t('globalSearch.statusYellow'), green: t('globalSearch.statusGreen') };
  const [query, setQuery] = useState('');
  const [allShops, setAllShops] = useState(null);
  const [allProducts, setAllProducts] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const boxRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) {
        setOpen(false);
        // Collapse back to just the icon once there's nothing left to show —
        // an active query stays visible even if focus moves elsewhere.
        if (!query.trim()) setExpanded(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [query]);

  function expand() {
    setExpanded(true);
    ensureLoaded();
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function ensureLoaded() {
    if ((allShops && allProducts) || loading) return;
    setLoading(true);
    Promise.all([api.getShops(), api.getProducts(true)])
      .then(([shops, products]) => {
        setAllShops(shops);
        setAllProducts(products);
      })
      .finally(() => setLoading(false));
  }

  const q = query.trim();
  const qDigits = q.replace(/\D/g, '');
  const shopResults =
    q.length >= 2 && allShops
      ? allShops
          .filter((s) => s.name.includes(q) || (qDigits.length >= 2 && s.phone.replace(/\D/g, '').includes(qDigits)))
          .slice(0, 6)
      : [];
  const productResults =
    q.length >= 2 && allProducts
      ? allProducts.filter((p) => p.name.includes(q)).slice(0, 6)
      : [];
  const results = [
    ...shopResults.map((s) => ({ kind: 'shop', item: s })),
    ...productResults.map((p) => ({ kind: 'product', item: p })),
  ];

  function goToShop(shop) {
    setOpen(false);
    setExpanded(false);
    setQuery('');
    navigate(`/?shop=${shop.id}`);
  }

  function goToProduct(product) {
    setOpen(false);
    setExpanded(false);
    setQuery('');
    navigate(`/products-master?material=${product.id}`);
  }

  return (
    <div className={'global-search' + (expanded ? ' expanded' : '')} ref={boxRef}>
      <button type="button" className="global-search-icon-btn" onClick={expand} aria-label="search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </button>
      {expanded && (
        <input
          ref={inputRef}
          type="text"
          className="global-search-input"
          placeholder={t('globalSearch.placeholder')}
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
        />
      )}
      {open && q.length >= 2 && (
        <div className="global-search-results">
          {loading && <div className="global-search-empty">{t('globalSearch.loading')}</div>}
          {!loading && results.length === 0 && <div className="global-search-empty">{t('globalSearch.noResults')}</div>}
          {results.map((r) =>
            r.kind === 'shop' ? (
              <button type="button" key={'shop-' + r.item.id} className="global-search-result" onClick={() => goToShop(r.item)}>
                <span className={'global-search-dot ' + r.item.status} />
                <span className="global-search-result-name">{r.item.name}</span>
                <span className="global-search-result-phone" dir="ltr">
                  {r.item.phone}
                </span>
                <span className={'global-search-result-status ' + r.item.status}>{STATUS_LABEL[r.item.status]}</span>
              </button>
            ) : (
              <button type="button" key={'product-' + r.item.id} className="global-search-result global-search-result-product" onClick={() => goToProduct(r.item)}>
                <span className="global-search-result-name">{r.item.name}</span>
                <span className="global-search-result-type">{t('globalSearch.materialTag')}</span>
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
