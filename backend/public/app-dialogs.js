// app-dialogs.js — vlastní dialogová okna místo systémových alert/confirm/prompt
// (UX 5. 10. 2026: šedé okno prohlížeče „52.59.116.233 says“ nepatřilo do vzhledu aplikace
// a ukazovalo IP serveru). Vše přes tokeny --m-* → světlý i tmavý motiv.
//
//   await LexisUI.alert('Text')                → undefined
//   await LexisUI.confirm('Smazat?', {danger}) → true / false
//   await LexisUI.prompt('Název:', 'výchozí')  → text / null (zrušeno)
//
// window.alert se přesměruje sem (volající na výsledek nečekají, takže je to bezpečné).
// confirm/prompt jsou synchronní API — volající v aplikaci používají LexisUI.* s await.
(function () {
    'use strict';
    if (typeof window === 'undefined' || window.LexisUI) return;

    const CSS = `
.lx-dlg-overlay{position:fixed;inset:0;z-index:20000;background:rgba(20,18,17,.45);display:flex;align-items:center;justify-content:center;padding:16px;animation:lxDlgFade .12s ease-out}
.lx-dlg{background:var(--m-ground,#f3f2f2);color:var(--m-ink,#201e1d);border:2px solid var(--m-ink,#201e1d);box-shadow:6px 6px 0 var(--m-ink,#201e1d);width:min(480px,100%);max-height:calc(100vh - 32px);overflow:auto;font-family:'Archivo',system-ui,sans-serif}
.lx-dlg-head{display:flex;align-items:center;gap:10px;padding:14px 18px 0;font-weight:800;font-size:1rem;letter-spacing:-.01em}
.lx-dlg-head .lx-dlg-mark{width:10px;height:10px;background:var(--m-accent,#ec3013);flex-shrink:0}
.lx-dlg-body{padding:10px 18px 4px;font-size:.92rem;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.lx-dlg-input{display:block;width:100%;box-sizing:border-box;margin:10px 0 2px;padding:9px 11px;border:2px solid var(--m-ink,#201e1d);background:var(--m-surface,#fff);color:var(--m-ink,#201e1d);font:inherit;font-size:.92rem;border-radius:0}
.lx-dlg-input:focus{outline:3px solid var(--m-accent,#ec3013);outline-offset:1px}
.lx-dlg-foot{display:flex;justify-content:flex-end;gap:10px;padding:14px 18px 16px}
.lx-dlg-btn{font:inherit;font-weight:700;font-size:.85rem;padding:8px 16px;border:2px solid var(--m-ink,#201e1d);background:transparent;color:var(--m-ink,#201e1d);cursor:pointer;border-radius:0}
.lx-dlg-btn:focus-visible{outline:3px solid var(--m-accent,#ec3013);outline-offset:2px}
.lx-dlg-btn.lx-primary{background:var(--m-ink,#201e1d);color:var(--m-ground,#f3f2f2)}
.lx-dlg-btn.lx-danger{background:var(--m-accent,#ec3013);border-color:var(--m-accent,#ec3013);color:#fff}
.lx-dlg-btn:hover{filter:brightness(1.08)}
@keyframes lxDlgFade{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.lx-dlg-overlay{animation:none}}`;

    function ensureCss() {
        if (document.getElementById('lx-dlg-css')) return;
        const st = document.createElement('style');
        st.id = 'lx-dlg-css'; st.textContent = CSS;
        (document.head || document.documentElement).appendChild(st);
    }

    // Titulek podle obsahu: chyby/varování zvlášť, ať je hned vidět, o co jde.
    function titleFor(kind, text, opts) {
        if (opts && opts.title) return opts.title;
        const t = String(text || '');
        if (/^\s*(❌|⛔)/.test(t) || /chyba|selhal|nelze|nejde/i.test(t.slice(0, 80))) return 'Něco se nepovedlo';
        if (/^\s*(⚠️|⚠)/.test(t)) return 'Upozornění';
        if (/^\s*(✅|✓)/.test(t)) return 'Hotovo';
        if (kind === 'confirm') return 'Potvrzení';
        if (kind === 'prompt') return 'Zadejte údaj';
        return 'LexisLocal';
    }
    const clean = (t) => String(t == null ? '' : t).replace(/^\s*(❌|⛔|⚠️|⚠|✅|✓)\s*/, '');

    const queue = [];
    let busy = false;
    function run(kind, text, def, opts) {
        return new Promise(resolve => { queue.push({ kind, text, def, opts: opts || {}, resolve }); next(); });
    }
    function next() {
        if (busy || !queue.length) return;
        if (!document.body) { document.addEventListener('DOMContentLoaded', next, { once: true }); return; }
        busy = true;
        const job = queue.shift();
        ensureCss();
        const prevFocus = document.activeElement;
        const ov = document.createElement('div');
        ov.className = 'lx-dlg-overlay';
        const box = document.createElement('div');
        box.className = 'lx-dlg';
        box.setAttribute('role', job.kind === 'alert' ? 'alertdialog' : 'dialog');
        box.setAttribute('aria-modal', 'true');
        const head = document.createElement('div'); head.className = 'lx-dlg-head'; head.id = 'lx-dlg-t' + Date.now();
        const mark = document.createElement('span'); mark.className = 'lx-dlg-mark';
        head.append(mark, document.createTextNode(titleFor(job.kind, job.text, job.opts)));
        box.setAttribute('aria-labelledby', head.id);
        const body = document.createElement('div'); body.className = 'lx-dlg-body';
        body.textContent = clean(job.text); // vždy textContent — žádné HTML z hlášek
        box.append(head, body);
        let input = null;
        if (job.kind === 'prompt') {
            input = document.createElement('input');
            input.className = 'lx-dlg-input'; input.type = 'text';
            input.value = job.def == null ? '' : String(job.def);
            input.setAttribute('aria-label', clean(job.text).slice(0, 120));
            body.appendChild(input);
        }
        const foot = document.createElement('div'); foot.className = 'lx-dlg-foot';
        const ok = document.createElement('button'); ok.type = 'button';
        ok.className = 'lx-dlg-btn ' + (job.opts.danger ? 'lx-danger' : 'lx-primary');
        ok.textContent = job.opts.okText || (job.kind === 'confirm' ? (job.opts.danger ? 'Ano, provést' : 'Ano') : 'OK');
        let cancel = null;
        if (job.kind !== 'alert') {
            cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'lx-dlg-btn';
            cancel.textContent = job.opts.cancelText || 'Zrušit';
            foot.appendChild(cancel);
        }
        foot.appendChild(ok);
        box.appendChild(foot);
        ov.appendChild(box);
        document.body.appendChild(ov);

        const done = (val) => {
            document.removeEventListener('keydown', onKey, true);
            ov.remove();
            busy = false;
            try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) { /* ignore */ }
            job.resolve(val);
            setTimeout(next, 0);
        };
        const okVal = () => job.kind === 'prompt' ? input.value : (job.kind === 'confirm' ? true : undefined);
        const cancelVal = () => job.kind === 'prompt' ? null : (job.kind === 'confirm' ? false : undefined);
        ok.addEventListener('click', () => done(okVal()));
        if (cancel) cancel.addEventListener('click', () => done(cancelVal()));
        ov.addEventListener('mousedown', (e) => { if (e.target === ov && job.kind !== 'alert') done(cancelVal()); });
        function onKey(e) {
            if (e.key === 'Escape') { e.preventDefault(); done(cancelVal()); }
            else if (e.key === 'Enter' && (job.kind !== 'confirm' || document.activeElement === ok || document.activeElement === input)) { e.preventDefault(); done(okVal()); }
            else if (e.key === 'Tab') { // fokus zůstane v dialogu
                const f = [input, cancel, ok].filter(Boolean);
                const i = f.indexOf(document.activeElement);
                e.preventDefault();
                f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
            }
        }
        document.addEventListener('keydown', onKey, true);
        // U nebezpečných potvrzení je výchozí fokus na „Zrušit“ (Enter omylem nic nesmaže).
        setTimeout(() => { (input || (job.opts.danger && cancel) || ok).focus(); if (input) input.select(); }, 0);
    }

    const DANGER = /smaz|odstran|zru[šs]it|deaktiv|vymaz|zahodit|trvale/i;
    window.LexisUI = {
        alert: (text, opts) => run('alert', text, null, opts),
        confirm: (text, opts) => run('confirm', text, null, Object.assign({ danger: DANGER.test(String(text || '')) }, opts || {})),
        prompt: (text, def, opts) => run('prompt', text, def, opts)
    };
    window.alert = (text) => { window.LexisUI.alert(text); };
})();
