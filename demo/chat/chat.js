// Fake team chat for the Séance opener. Presenter-driven, offline, no network calls.
// Space / → / PageDown / Enter / N: next beat (press again mid-animation to finish it)
// ← / PageUp / P: previous beat     R: reset     F: fullscreen
// Routes: #sarah   #session?address=<addr>&ended=Oct%2018   (add &beat=N to start at a beat)
(() => {
  'use strict';

  const DEFAULT_ADDRESS = 's-055fcb2d@safe-maple.primitive.email';
  const QUESTION = 'hey Sarah, quick q: why is RETRY_BASE_DELAY 0.37 in retry.ts? can I bump it down to 0.25?';
  const SESSION_QUESTION = 'hey, quick q: why is RETRY_BASE_DELAY 0.37 in retry.ts? can I bump it down to 0.25?';
  const SARAH_REPLY = "don't touch it 😅 0.25 caused double charges when the provider hadn't settled yet. 0.37 gives it margin.";

  // ---------- params ----------
  function readRoute() {
    const raw = decodeURIComponent((location.hash || '').replace(/^#/, ''));
    const [name, query = ''] = raw.split('?');
    const params = new URLSearchParams(query || location.search.replace(/^\?/, ''));
    return { name: name === 'session' ? 'session' : 'sarah', params };
  }

  // ---------- time ----------
  const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function todayShort() { return new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }

  // ---------- people ----------
  const ME = { id: 'me', name: 'Atin Kumar Singh', initials: 'AS', color: '#2563eb', presence: 'active' };
  const PEOPLE = {
    me: ME,
    sarah: { id: 'sarah', name: 'Sarah Chen', initials: 'SC', color: '#d24d7a', presence: 'active', role: 'Staff Engineer, Payments' },
    marcus: { id: 'marcus', name: 'Marcus Lee', initials: 'ML', color: '#0e8aa8', presence: 'away' },
    priya: { id: 'priya', name: 'Priya Raman', initials: 'PR', color: '#7c4ddb', presence: 'active' },
    dana: { id: 'dana', name: 'Dana Okafor', initials: 'DO', color: '#c27a12', presence: 'away' },
  };
  function sessionPerson(address) {
    const local = address.split('@')[0];
    const short = local.replace(/^s-/, '');
    return { id: 'session:' + short, name: 'Claude session ' + short, glyph: '>_', color: '#3b4252', presence: 'ended', bot: true, address };
  }

  // ---------- routes ----------
  function buildRoute(name, params) {
    const t0 = new Date();
    const later = new Date(t0.getTime() + 60 * 1000);
    if (name === 'session') {
      const address = (params.get('address') || DEFAULT_ADDRESS).trim();
      const ended = (params.get('ended') || 'Oct 18').trim();
      const s = sessionPerson(address);
      PEOPLE[s.id] = s;
      const other = sessionPerson('s-3b7d91e2@x');
      PEOPLE[other.id] = other;
      const endedLabel = ended === todayShort() ? 'Today' : ended;
      return {
        dm: s,
        subtitle: 'Claude Code session · payments-repo · ended ' + ended,
        channels: [['general'], ['payments', 'unread'], ['incidents', 'unread', 2], ['deploys'], ['random']],
        dms: [s.id, 'priya', other.id, 'marcus', 'me'],
        endedText: 'This session ended ' + ended + ". There's no one to ask.",
        lockedText: s.name + ' has ended. Messages to this conversation can’t be delivered.',
        history: [
          { kind: 'intro', who: s.id, role: 'Claude Code session in payments-repo. Ended ' + ended + '.',
            text: 'This is the very beginning of your direct message history with <span class="mention">@' + esc(s.name) + '</span>.' },
          { kind: 'divider', label: endedLabel },
          { kind: 'msg', from: s.id, time: '1:37 AM', text: 'Finished src/retry.ts. Tests pass. Committed “add retry backoff”.' },
          { kind: 'msg', from: s.id, time: '1:37 AM', text: 'Session complete.' },
        ],
        todayLabel: 'Today',
        beats: [
          { kind: 'send', text: SESSION_QUESTION, time: fmtTime(t0), ended: true },
          { kind: 'reveal', address },
        ],
      };
    }
    return {
      dm: PEOPLE.sarah,
      subtitle: '',
      channels: [['general'], ['payments', 'unread'], ['incidents'], ['deploys'], ['random']],
      dms: ['sarah', 'marcus', 'priya', 'dana', 'me'],
      history: [
        { kind: 'intro', who: 'sarah', role: 'Staff Engineer, Payments',
          text: 'This conversation is just between <span class="mention">@Sarah Chen</span> and you. Check out their profile to learn more about them.' },
        { kind: 'divider', label: 'Yesterday' },
        { kind: 'msg', from: 'sarah', time: '4:12 PM', text: 'can you look at #412 when you get a sec? idempotency keys on refunds' },
        { kind: 'msg', from: 'me', time: '4:31 PM', text: 'on it' },
        { kind: 'msg', from: 'me', time: '4:33 PM', text: 'left two nits, otherwise lgtm' },
        { kind: 'msg', from: 'sarah', time: '5:02 PM', text: 'ty! 🙏', reactions: [] },
      ],
      todayLabel: 'Today',
      beats: [
        { kind: 'send', text: QUESTION, time: fmtTime(t0) },
        { kind: 'reply', from: 'sarah', text: SARAH_REPLY, time: fmtTime(later), typingMs: 2300, react: '👍' },
      ],
    };
  }

  // ---------- state ----------
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function initialState(route) {
    return { items: clone(route.history), composer: '', focus: false, typing: null, locked: false, reveal: false };
  }
  function ensureToday(st, route, anim) {
    const last = st.items.filter((i) => i.kind === 'divider').pop();
    if (!last || last.label !== route.todayLabel) st.items.push({ kind: 'divider', label: route.todayLabel, _anim: anim });
  }
  // Each beat's end state. The animations below arrive at exactly this state.
  function applyBeat(st, route, beat) {
    if (beat.kind === 'send') {
      ensureToday(st, route);
      st.items.push({ kind: 'msg', from: 'me', time: beat.time, text: beat.text, undelivered: !!beat.ended });
      if (beat.ended) { st.items.push({ kind: 'system', text: route.endedText }); st.locked = true; }
    } else if (beat.kind === 'reply') {
      st.items.push({ kind: 'msg', from: beat.from, time: beat.time, text: beat.text,
        reactions: beat.react ? [{ emoji: beat.react, count: 1, mine: true }] : [] });
    } else if (beat.kind === 'reveal') {
      st.reveal = true;
    }
  }
  function stateAt(route, n) {
    const st = initialState(route);
    for (let i = 0; i < n; i++) applyBeat(st, route, route.beats[i]);
    return st;
  }

  // ---------- rendering ----------
  const $ = (id) => document.getElementById(id);
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function avatar(p, size, withPresence) {
    const cls = ['avatar', size || '', p.glyph ? 'glyph' : '', p.presence === 'ended' ? 'ended' : ''].join(' ');
    const label = p.glyph || p.initials;
    const pres = withPresence ? `<i class="presence ${p.presence}"></i>` : '';
    return `<div class="${cls}" style="--av:${p.color}">${esc(label)}${pres}</div>`;
  }

  function renderChrome(route) {
    $('channels').innerHTML = route.channels.map(([name, state, badge]) =>
      `<li class="sb-item ${state || ''}"><span class="sb-icon">#</span><span class="name">${name}</span>${badge ? `<span class="badge">${badge}</span>` : ''}</li>`).join('');
    $('dms').innerHTML = route.dms.map((id) => {
      const p = PEOPLE[id];
      const active = p === route.dm ? 'active' : '';
      const dim = p.presence === 'ended' && !active ? 'dim' : '';
      const you = id === 'me' ? ' <span class="you">you</span>' : '';
      return `<li class="sb-item ${active} ${dim}">${avatar(p, 'xs', true)}<span class="name">${esc(p.name)}${you}</span></li>`;
    }).join('');
    const p = route.dm;
    const tag = p.bot ? '<span class="tag">Agent</span>' : '';
    const sub = route.subtitle ? `<span class="title-sub">${esc(route.subtitle)}</span>` : '';
    $('convTitle').innerHTML = `${avatar(p, 'sm', true)}<div class="title-text"><span class="title-name">${esc(p.name)} ${tag}</span>${sub}</div>`;
    $('facepile').innerHTML = `${avatar(p, 'xs')}${avatar(ME, 'xs')}<span>2</span>`;
    document.title = p.name + ' (DM) - acme-payments';
  }

  const HOVER_ACTIONS = '<div class="hover-actions">' +
    '<span>✅</span><span>👀</span><span>🙌</span>' +
    '<span><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6.5" /><path d="M7.4 11.8a3.2 3.2 0 0 0 5.2 0" /><circle cx="7.8" cy="8.4" r=".6" /><circle cx="12.2" cy="8.4" r=".6" /></svg></span>' +
    '<span><svg viewBox="0 0 20 20"><path d="M4 5h12v8H9l-3.5 3v-3H4z" /></svg></span>' +
    '<span><svg viewBox="0 0 20 20"><circle cx="5" cy="10" r=".9" /><circle cx="10" cy="10" r=".9" /><circle cx="15" cy="10" r=".9" /></svg></span></div>';

  function renderItems(st) {
    let prev = null;
    const html = st.items.map((it) => {
      const enter = it._anim ? ' enter' : '';
      let out = '';
      if (it.kind === 'intro') {
        const p = PEOPLE[it.who];
        out = `<div class="intro${enter}">${avatar(p, 'lg')}<h2>${esc(p.name)}${p.bot ? ' <span class="tag">Agent</span>' : ''}</h2>` +
          `<div class="role">${esc(it.role)}</div><p>${it.text}</p>` +
          `<div class="intro-actions"><span class="pill-btn">View profile</span></div></div>`;
      } else if (it.kind === 'divider') {
        out = `<div class="divider${enter}"><span>${esc(it.label)}</span></div>`;
      } else if (it.kind === 'system') {
        out = `<div class="system${enter}"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" /><path d="M10 9v4.5" /><circle cx="10" cy="6.6" r=".5" /></svg><span>${esc(it.text)}</span></div>`;
      } else if (it.kind === 'msg') {
        const p = PEOPLE[it.from];
        const cont = prev && prev.kind === 'msg' && prev.from === it.from;
        const reactions = (it.reactions || []).map((r) =>
          `<span class="reaction${r.mine ? ' mine' : ''}${r._anim ? ' enter' : ''}"><span class="emoji">${r.emoji}</span>${r.count}</span>`).join('');
        const meta = it.undelivered && !it._hideMeta
          ? `<div class="msg-meta${it._animMeta ? ' enter' : ''}"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" /><path d="M10 6.5v4.2" /><circle cx="10" cy="13.4" r=".5" /></svg>Not delivered</div>` : '';
        out = `<div class="msg${cont ? ' cont' : ''}${enter}">` +
          `<div class="gutter">${cont ? `<span class="hover-time">${esc(it.time.replace(/\s?[AP]M$/, ''))}</span>` : avatar(p)}</div>` +
          `<div>${cont ? '' : `<div class="msg-head"><span class="msg-name">${esc(p.name)}</span><span class="msg-time">${esc(it.time)}</span></div>`}` +
          `<div class="msg-body">${esc(it.text)}</div>${meta}${reactions ? `<div class="reactions">${reactions}</div>` : ''}</div>` +
          HOVER_ACTIONS + '</div>';
      }
      prev = it;
      return out;
    }).join('');
    $('messagesInner').innerHTML = html;
    // Animation flags are one-shot.
    for (const it of st.items) {
      delete it._anim; delete it._animMeta;
      for (const r of it.reactions || []) delete r._anim;
    }
    const box = $('messages');
    box.scrollTop = box.scrollHeight;
  }

  function renderComposer(st, route) {
    const input = $('composerInput');
    const caret = st.focus ? '<span class="caret"></span>' : '';
    input.innerHTML = st.composer
      ? esc(st.composer) + caret
      : caret + `<span class="placeholder">Message ${esc(route.dm.name)}</span>`;
    $('composer').classList.toggle('focus', st.focus);
    $('sendBtn').classList.toggle('ready', !!st.composer);
    const wrap = document.querySelector('.composer-wrap');
    wrap.classList.toggle('locked', st.locked);
    if (st._animLock) { wrap.classList.add('enter'); delete st._animLock; } else if (!st.locked) wrap.classList.remove('enter');
    $('composerLocked').innerHTML = `<svg viewBox="0 0 20 20"><rect x="5" y="9" width="10" height="7.5" rx="1.5" /><path d="M7.2 9V7a2.8 2.8 0 0 1 5.6 0v2" /></svg>${esc(route.lockedText || '')}`;
    $('typingLine').innerHTML = st.typing ? `<span class="dots"><i></i><i></i><i></i></span><b>${esc(st.typing)}</b> is typing…` : '';
  }

  function renderReveal(st, route, animate) {
    const el = $('reveal');
    const beat = route.beats.find((b) => b.kind === 'reveal');
    if (beat) {
      // Break after the @ (never mid-word) if the screen is too narrow for one line.
      const [local, domain] = beat.address.split('@');
      $('revealAddressText').innerHTML = domain ? `${esc(local)}<wbr>@${esc(domain)}` : esc(beat.address);
    }
    el.classList.toggle('instant', !animate);
    el.classList.toggle('show', !!st.reveal);
    el.setAttribute('aria-hidden', st.reveal ? 'false' : 'true');
    if (!animate) void el.offsetWidth; // flush so 'instant' applies before it's removed next time
  }

  function render(st, route, animateReveal) {
    renderItems(st);
    renderComposer(st, route);
    renderReveal(st, route, !!animateReveal);
  }

  // ---------- animation ----------
  const CANCEL = Symbol('cancel');
  function makeToken() {
    const t = { dead: false, timers: new Set(), rejects: new Set() };
    t.wait = (ms) => new Promise((res, rej) => {
      if (t.dead) return rej(CANCEL);
      const id = setTimeout(() => { t.timers.delete(id); t.rejects.delete(rej); res(); }, ms);
      t.timers.add(id); t.rejects.add(rej);
    });
    t.cancel = () => { t.dead = true; t.timers.forEach(clearTimeout); t.rejects.forEach((r) => r(CANCEL)); };
    return t;
  }

  function charDelay(ch, next) {
    let d = 26 + Math.random() * 38;
    if (ch === ' ') d += 18;
    if (/[,.:?!]/.test(ch)) d += 150;
    if (ch === '_' || /[0-9]/.test(ch)) d += 22;
    if (next === ' ' && Math.random() < 0.08) d += 140; // occasional thinking pause
    return d;
  }

  async function animateBeat(st, route, beat, tk) {
    if (beat.kind === 'send') {
      st.focus = true; renderComposer(st, route);
      await tk.wait(450);
      $('composer').classList.add('typing');
      for (let i = 0; i < beat.text.length; i++) {
        st.composer = beat.text.slice(0, i + 1);
        renderComposer(st, route);
        await tk.wait(charDelay(beat.text[i], beat.text[i + 1]));
      }
      $('composer').classList.remove('typing');
      await tk.wait(420);
      const send = $('sendBtn');
      send.classList.add('press');
      await tk.wait(110);
      send.classList.remove('press');
      st.composer = '';
      ensureToday(st, route, true);
      const msg = { kind: 'msg', from: 'me', time: beat.time, text: beat.text, undelivered: !!beat.ended, _anim: true, _hideMeta: !!beat.ended };
      st.items.push(msg);
      render(st, route);
      if (beat.ended) {
        await tk.wait(1300);
        delete msg._hideMeta; msg._animMeta = true;
        st.focus = false;
        st.items.push({ kind: 'system', text: route.endedText, _anim: true });
        st.locked = true; st._animLock = true;
        render(st, route);
      }
    } else if (beat.kind === 'reply') {
      const p = PEOPLE[beat.from];
      st.focus = false; renderComposer(st, route);
      await tk.wait(500);
      st.typing = p.name; renderComposer(st, route);
      await tk.wait(beat.typingMs || 2000);
      st.typing = null;
      const msg = { kind: 'msg', from: beat.from, time: beat.time, text: beat.text, reactions: [], _anim: true };
      st.items.push(msg);
      render(st, route);
      if (beat.react) {
        await tk.wait(1200);
        msg.reactions.push({ emoji: beat.react, count: 1, mine: true, _anim: true });
        render(st, route);
      }
    } else if (beat.kind === 'reveal') {
      await tk.wait(150);
      st.reveal = true;
      renderReveal(st, route, true);
    }
  }

  // ---------- controller ----------
  let route = null, beat = 0, token = null;

  function showStatic(n) {
    beat = Math.max(0, Math.min(n, route.beats.length));
    $('composer').classList.remove('typing');
    render(stateAt(route, beat), route, false);
    updateHud();
  }

  function next() {
    if (token) { // mid-animation: jump to the end of this beat
      token.cancel(); token = null;
      showStatic(beat);
      return;
    }
    if (beat >= route.beats.length) return;
    const st = stateAt(route, beat);
    render(st, route, false);
    beat += 1;
    updateHud();
    const tk = token = makeToken();
    animateBeat(st, route, route.beats[beat - 1], tk)
      .then(() => { if (token === tk) token = null; })
      .catch((e) => { if (e !== CANCEL) console.error(e); });
  }
  function prev() { if (token) { token.cancel(); token = null; } showStatic(beat - 1); }
  function reset() { if (token) { token.cancel(); token = null; } showStatic(0); }

  function updateHud() { $('hudCount').textContent = `${beat} / ${route.beats.length}`; }

  function load() {
    if (token) { token.cancel(); token = null; }
    const r = readRoute();
    route = buildRoute(r.name, r.params);
    renderChrome(route);
    // ?beat=N (in the hash query) jumps straight to a beat, e.g. #session?beat=2 for the reveal.
    showStatic(parseInt(r.params.get('beat') || '0', 10) || 0);
  }

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === ' ' || k === 'ArrowRight' || k === 'PageDown' || k === 'Enter' || k === 'n' || k === 'ArrowDown') { e.preventDefault(); next(); }
    else if (k === 'ArrowLeft' || k === 'PageUp' || k === 'p' || k === 'ArrowUp' || k === 'Backspace') { e.preventDefault(); prev(); }
    else if (k === 'r' || k === 'R') { e.preventDefault(); reset(); }
    else if (k === 'f' || k === 'F') {
      e.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.();
    }
  });
  $('hudNext').addEventListener('click', (e) => { e.currentTarget.blur(); next(); });
  $('hudPrev').addEventListener('click', (e) => { e.currentTarget.blur(); prev(); });
  $('hudReset').addEventListener('click', (e) => { e.currentTarget.blur(); reset(); });

  // Copy the address. Clipboard API may be blocked on file://, so fall back to execCommand.
  $('revealAddress').addEventListener('click', async (e) => {
    e.currentTarget.blur();
    const text = $('revealAddressText').textContent;
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      ta.remove();
    }
    const chip = $('copyChip');
    chip.textContent = ok ? 'Copied' : 'Select';
    chip.classList.toggle('done', ok);
    if (!ok) { const r = document.createRange(); r.selectNodeContents($('revealAddressText')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    setTimeout(() => { chip.textContent = 'Copy'; chip.classList.remove('done'); }, 1600);
  });

  // Keep the newest message in view when the window (or projector resolution) changes.
  const stickToBottom = () => { const box = $('messages'); box.scrollTop = box.scrollHeight; };
  if (window.ResizeObserver) new ResizeObserver(stickToBottom).observe($('messages'));
  window.addEventListener('resize', stickToBottom);

  window.addEventListener('hashchange', load);
  load();
})();
