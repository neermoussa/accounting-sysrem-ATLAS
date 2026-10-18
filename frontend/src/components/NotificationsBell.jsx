import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useLanguage } from '../i18n/LanguageContext.jsx';

// Polls every 2 minutes — cheap (the endpoint just reads the persisted
// notifications table) and frequent enough that a new low-stock/debt/
// invoice/import event shows up without a manual refresh.
const POLL_MS = 2 * 60 * 1000;

function timeAgo(iso, lang) {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso.includes('Z') || iso.includes('+') ? iso : iso + 'Z').getTime();
  const mins = Math.max(0, Math.round(diffMs / 60000));
  if (mins < 1) return lang === 'ar' ? 'الآن' : 'now';
  if (mins < 60) return lang === 'ar' ? `قبل ${mins} د` : `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return lang === 'ar' ? `قبل ${hours} س` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return lang === 'ar' ? `قبل ${days} يوم` : `${days}d ago`;
}

export default function NotificationsBell() {
  const { t, lang } = useLanguage();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const boxRef = useRef(null);

  function load() {
    api
      .getNotifications()
      .then((res) => {
        setItems(res.items || []);
        setUnreadCount(res.unreadCount || 0);
      })
      .catch(() => {});
  }

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    function handleClickOutside(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function handleItemClick(n) {
    if (!n.read) {
      api.markNotificationRead(n.id).then(load);
      setItems((prev) => prev.map((it) => (it.id === n.id ? { ...it, read: true } : it)));
      setUnreadCount((c) => Math.max(0, c - 1));
    }
    setOpen(false);
    if (n.link_path) navigate(n.link_path);
  }

  function handleMarkAllRead() {
    api.markAllNotificationsRead().then(load);
    setItems((prev) => prev.map((it) => ({ ...it, read: true })));
    setUnreadCount(0);
  }

  return (
    <div className="notif-bell-wrap" ref={boxRef}>
      <button
        type="button"
        className="app-icon-btn"
        onClick={() => {
          setOpen((v) => {
            const next = !v;
            // The 2-minute poll alone would show stale state right after an
            // action that just created a notification (e.g. confirming an
            // invoice) — refetch on every open so what's shown is current.
            if (next) load();
            return next;
          });
        }}
        aria-label={t('notifications.title')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="notif-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>
        )}
      </button>

      {open && (
        <div className="notif-dropdown">
          <div className="notif-dropdown-header">
            <span className="notif-dropdown-title">{t('notifications.title')}</span>
            {unreadCount > 0 && (
              <button type="button" className="notif-mark-all-btn" onClick={handleMarkAllRead}>
                {t('notifications.markAllRead')}
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <div className="notif-empty">{t('notifications.empty')}</div>
          ) : (
            <div className="notif-list">
              {items.map((n) => (
                <button
                  type="button"
                  key={n.id}
                  className={'notif-item notif-' + n.type + (n.read ? ' read' : ' unread') + (n.link_path ? ' clickable' : '')}
                  onClick={() => handleItemClick(n)}
                >
                  {!n.read && <span className="notif-unread-dot" />}
                  <span className="notif-item-message">{lang === 'ar' ? n.message_ar : n.message_en}</span>
                  <span className="notif-item-time">{timeAgo(n.created_at, lang)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
