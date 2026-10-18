import '../styles/celebration.css';

// Everything here is deliberately self-contained and imperative (no React
// state, no props threading) so a call site is a single one-line call, and
// the whole effect can be tweaked or disabled later by editing only this
// file — never by touching the order form or import review components.

const MUTE_KEY = 'nuts_sound_muted';
const VOLUME_KEY = 'nuts_sound_volume';
const CHIME_KEY = 'nuts_chime_preset';

export function isSoundMuted() {
  return localStorage.getItem(MUTE_KEY) === '1';
}

export function setSoundMuted(muted) {
  localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
}

export function getSoundVolume() {
  const raw = localStorage.getItem(VOLUME_KEY);
  const n = raw === null ? 1 : Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

export function setSoundVolume(v) {
  localStorage.setItem(VOLUME_KEY, String(Math.min(1, Math.max(0, Number(v) || 0))));
}

// Three inharmonic-partial bell/coin timbres — same synthesis technique,
// different strike/partial profiles — so "اختيار نغمة" has real distinct
// options instead of a single hardcoded tone.
const CHIME_PRESETS = {
  classic: {
    labelKey: 'settings.chimeClassic',
    strikes: [
      { freq: 900, start: 0, decay: 0.22, gain: 0.62 },
      { freq: 1250, start: 0.1, decay: 0.5, gain: 0.55 },
    ],
    partials: [
      { ratio: 1, amp: 1 },
      { ratio: 2.4, amp: 0.5 },
      { ratio: 3.8, amp: 0.28 },
      { ratio: 5.4, amp: 0.14 },
    ],
  },
  coin: {
    labelKey: 'settings.chimeCoin',
    strikes: [{ freq: 1900, start: 0, decay: 0.16, gain: 0.7 }],
    partials: [
      { ratio: 1, amp: 1 },
      { ratio: 1.5, amp: 0.45 },
      { ratio: 2.2, amp: 0.22 },
    ],
  },
  soft: {
    labelKey: 'settings.chimeSoft',
    strikes: [
      { freq: 660, start: 0, decay: 0.35, gain: 0.5 },
      { freq: 880, start: 0.16, decay: 0.45, gain: 0.42 },
    ],
    partials: [
      { ratio: 1, amp: 1 },
      { ratio: 2, amp: 0.3 },
    ],
  },
};

export const CHIME_PRESET_OPTIONS = Object.entries(CHIME_PRESETS).map(([value, p]) => ({ value, labelKey: p.labelKey }));

export function getChimePreset() {
  const raw = localStorage.getItem(CHIME_KEY);
  return raw && CHIME_PRESETS[raw] ? raw : 'classic';
}

export function setChimePreset(preset) {
  if (CHIME_PRESETS[preset]) localStorage.setItem(CHIME_KEY, preset);
}

// Seeds this device's local sound prefs from the server-side defaults —
// only for whichever of mute/volume/chime hasn't already been explicitly
// set locally (an explicit local choice always wins), same pattern
// LanguageContext uses for adopting the user's saved language once.
export function seedSoundDefaultsFromServer(defaults) {
  if (!defaults) return;
  if (localStorage.getItem(MUTE_KEY) === null && defaults.sound_default_muted !== undefined) {
    setSoundMuted(defaults.sound_default_muted === '1');
  }
  if (localStorage.getItem(VOLUME_KEY) === null && defaults.sound_volume) {
    setSoundVolume(Number(defaults.sound_volume));
  }
  if (localStorage.getItem(CHIME_KEY) === null && defaults.sound_chime_preset) {
    setChimePreset(defaults.sound_chime_preset);
  }
}

// Struck-bell/coin synthesis from a few inharmonic sine partials with
// independent decay envelopes per strike — the classic way to fake a
// metallic timbre without a sampled sound file.
function synthesizeChime(preset, volume) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    let maxEnd = 0;
    preset.strikes.forEach(({ freq, start: startOffset, decay, gain: strikeGain }) => {
      const start = ctx.currentTime + startOffset;
      preset.partials.forEach(({ ratio, amp }) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq * ratio, start);
        const peak = strikeGain * amp * volume;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(peak, start + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.001, start + decay);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + decay + 0.02);
      });
      maxEnd = Math.max(maxEnd, startOffset + decay);
    });
    setTimeout(() => ctx.close(), (maxEnd + 0.2) * 1000);
  } catch {
    // Web Audio unsupported/blocked in this browser — never let a sound
    // failure interrupt the save flow that triggered it.
  }
}

function playRisingChime() {
  if (isSoundMuted()) return;
  synthesizeChime(CHIME_PRESETS[getChimePreset()], getSoundVolume());
}

// Bypasses the mute check on purpose — used by the settings screen's
// "play preview" button, where clicking it is itself the request to hear it.
export function previewChime(presetKey) {
  synthesizeChime(CHIME_PRESETS[presetKey] || CHIME_PRESETS.classic, getSoundVolume());
}

function burstConfetti() {
  import('canvas-confetti')
    .then(({ default: confetti }) => {
      confetti({
        particleCount: 60,
        spread: 65,
        startVelocity: 32,
        origin: { y: 0.7 },
        colors: ['#ffffff', '#cfd6e0', '#0b0f14', '#8b95a1'],
        scalar: 0.9,
        ticks: 120,
      });
    })
    .catch(() => {});
}

function showBadge(text, calm) {
  const el = document.createElement('div');
  el.className = 'celebration-badge' + (calm ? ' calm' : '');
  el.textContent = text;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const holdMs = calm ? 1000 : 1400;
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, holdMs);
}

// Order saved successfully: sound + confetti + a brief gold checkmark.
export function celebrateOrderSaved() {
  playRisingChime();
  burstConfetti();
  showBadge('✓', false);
}

// Amin import committed successfully: calmer — no sound, no confetti, just
// a small "updated" badge.
export function celebrateImportUpdated() {
  showBadge('✓ تم التحديث', true);
}

// Same chime as an order save, reused as-is (no confetti/badge) for the
// map's demo-mode car arriving at an endpoint.
export function playSuccessChime() {
  playRisingChime();
}

function showInvoiceToast(shopName, amount) {
  const el = document.createElement('div');
  el.className = 'demo-invoice-toast';
  el.innerHTML = `
    <div class="demo-invoice-toast-title">🧾 عملية بيع تجريبية</div>
    <div class="demo-invoice-toast-shop">${shopName}</div>
    <div class="demo-invoice-toast-amount">${amount.toLocaleString('ar-SY')} ل.س</div>
  `;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 2600);
}

// Demo-mode car arrives at a point: create a local preview invoice event,
// play the cashier chime, and show the in-app notification toast. Nothing is
// sent to the backend, WhatsApp, email, or any external service.
export function celebrateDemoSale(shopName, amount) {
  const invoice = {
    id: `preview-${Date.now()}`,
    shopName,
    amount,
    createdAt: new Date().toISOString(),
  };
  try {
    const previous = JSON.parse(localStorage.getItem('atlas_preview_invoices') || '[]');
    localStorage.setItem('atlas_preview_invoices', JSON.stringify([invoice, ...previous].slice(0, 50)));
    window.dispatchEvent(new CustomEvent('atlas:preview-sale', { detail: invoice }));
  } catch {
    // Local preview persistence is best effort and must never interrupt the map.
  }
  playRisingChime();
  showInvoiceToast(shopName, amount);
}
