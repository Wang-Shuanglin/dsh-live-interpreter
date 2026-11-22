// Client half of dsh-live-interpreter.
//
// Registers three seats and owns the whole meeting UI:
//   • sidebar.panellist  — the entry icon
//   • main (key)         — the split-pane interpreter panel
//   • settings.section    — model download + reading voice
//
// Audio path: getUserMedia -> AudioWorklet (resample + 240 ms Int16 frames) ->
// POST as raw octet-stream. Nothing is buffered in the browser beyond a few
// frames, so stopping the page stops the recording immediately.

window.__ModuleLoader__.load({
  id: 'dsh-live-interpreter',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useCallback = React.useCallback
    var useMemo = React.useMemo

    var PANEL_ID = 'live-interpreter'
    var API = '/dsh-live-interpreter/api'
    var NS = 'dsh-live-interpreter'

    /* --------------------------------------------------------------- styles */

    var FONT = 'inherit'

    /* ------------------------------------------------------- design tokens */

    // Only tokens the host actually defines may be referenced. A var() with a
    // misspelled name resolves to nothing and falls back silently: an earlier
    // build asked for `--dsw-alias-text-primary` / `-bg-elevated`, which do not
    // exist, so near-white dark-theme fallbacks were painted onto the light
    // base background and the transcript became invisible. The full legal set
    // is bg-base / bg-layer-1 / bg-layer-2 / bg-overlay / border-l1 / border-l2
    // / brand-primary / label-primary / label-secondary / state-{error,idle,
    // success,warn}-primary / specific-sidebar-fill.
    //
    // Certainty tiers are expressed as OPACITY over label-primary rather than
    // as three separate greys: opacity blends toward whatever the surface is,
    // so the dimmest tier stays readable in the light theme as well as in the
    // dark one instead of being tuned for just one of them.
    var T = {
      bg: 'var(--dsw-alias-bg-base, #ffffff)',
      surface: 'var(--dsw-alias-bg-layer-1, #f6f7f9)',
      surface2: 'var(--dsw-alias-bg-layer-2, #eceff4)',
      overlay: 'var(--dsw-alias-bg-overlay, #ffffff)',
      border: 'var(--dsw-alias-border-l1, rgba(15,18,23,0.10))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(15,18,23,0.20))',
      // --dsw-alias-brand-primary is an INK token in this design system: it
      // resolves to neutral-bluish-1000 (#0f1115) in light and to
      // neutral-bluish-50 (#f9fafb) in dark, not to a hue. Painting a button
      // with it produced the black blocks users reported, so the accent comes
      // from the static violet ramp instead and is defined once as --dli-accent.
      brand: 'var(--dli-accent, #7c3aed)',
      accentWeak: 'var(--dli-accent-weak, rgba(124,58,237,0.08))',
      accentSoft: 'var(--dli-accent-soft, rgba(124,58,237,0.10))',
      accentLine: 'var(--dli-accent-line, rgba(124,58,237,0.34))',
      text: 'var(--dsw-alias-label-primary, #16181d)',
      dim: 'var(--dsw-alias-label-secondary, #5b6270)',
      error: 'var(--dsw-alias-state-error-primary, #d92d20)',
      warn: 'var(--dsw-alias-state-warn-primary, #b54708)',
      success: 'var(--dsw-alias-state-success-primary, #067647)',
      idle: 'var(--dsw-alias-state-idle-primary, #98a2b3)',
      mono: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
      radius: 'var(--dsw-radius-lg, 12px)',
      radiusSm: 'var(--dsw-radius-md, 8px)',
      shadow: 'var(--dsw-shadow-lv2, 0 6px 24px rgba(16,24,40,0.10))',
      shadowBig: 'var(--dsw-shadow-lv3, 0 18px 48px rgba(16,24,40,0.18))',
    }

    // Inline styles cannot express hover, focus-visible, scrollbars or
    // transitions, and a live transcript is read for tens of minutes, so the
    // interaction layer lives in one small stylesheet instead. It is scoped
    // under [data-dsh-live-interpreter] so it cannot leak into the host UI.
    var CSS = [
      '[data-dsh-live-interpreter]{',
      // One accent pair drives every highlighted surface. Violet rather than
      // blue: a saturated blue fill on the primary buttons read as a foreign
      // element against the host's near-monochrome shell. The accent is used as
      // a SOFT fill (tinted background + accent text + accent border) instead of
      // a solid block — brand-primary is an ink token (#0f1115), so a solid
      // primary button was literally painting a black rectangle.
      '--dli-accent:var(--dsw-static-violet-600,#7c3aed);',
      '--dli-accent-soft:color-mix(in srgb,var(--dsw-static-violet-600,#7c3aed) 10%,transparent);',
      '--dli-accent-line:color-mix(in srgb,var(--dsw-static-violet-600,#7c3aed) 34%,transparent);',
      '--dli-accent-weak:color-mix(in srgb,var(--dsw-static-violet-600,#7c3aed) 8%,transparent);',
      '--dli-accent-ink:#ffffff;',
      'font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);',
      'color:var(--dsw-alias-label-primary,#16181d);',
      'background:var(--dsw-alias-bg-base,#fff);}',
      '@media (prefers-color-scheme:dark){',
      '[data-dsh-live-interpreter]{',
      '--dli-accent:var(--dsw-static-violet-400,#a78bfa);',
      '--dli-accent-soft:color-mix(in srgb,var(--dsw-static-violet-400,#a78bfa) 18%,transparent);',
      '--dli-accent-line:color-mix(in srgb,var(--dsw-static-violet-400,#a78bfa) 40%,transparent);',
      '--dli-accent-weak:color-mix(in srgb,var(--dsw-static-violet-400,#a78bfa) 14%,transparent);',
      '--dli-accent-ink:#0f1115;}}',
      '.dli-root{display:flex;height:100%;min-height:0}',
      // The project list sits on the sidebar surface, a step away from the page
      // so the two read as one window instead of a slab bolted on the left.
      '.dli-rail{background:var(--dsw-specific-sidebar-fill,#f9fafb);',
      'border-right:1px solid var(--dsw-alias-border-l1,rgba(15,18,23,0.10))}',
      // While a session records, the transcript area lifts onto a tinted surface.
      // It is the only large colour change in the UI, so "the machine is
      // listening" is legible from across a table without reading any label.
      '.dli-main{transition:background .5s ease}',
      // Tinted against the theme's own base rather than white, so the recording
      // state reads the same in the light and dark themes without a media query.
      '[data-dsh-live-interpreter][data-live="1"] .dli-main{',
      'background:color-mix(in srgb,var(--dli-accent,#7c3aed) 5%,var(--dsw-alias-bg-base,#fff))}',
      '[data-dsh-live-interpreter][data-live="1"] .dli-rail{',
      'background:color-mix(in srgb,var(--dli-accent,#7c3aed) 8%,var(--dsw-specific-sidebar-fill,#f9fafb))}',
      '[data-dsh-live-interpreter][data-live="1"] .dli-colhead{',
      'color:var(--dli-accent,#7c3aed)}',
      '[data-dsh-live-interpreter] button{font-family:inherit;color:inherit}',
      '[data-dsh-live-interpreter] button:focus-visible,',
      '[data-dsh-live-interpreter] select:focus-visible,',
      '[data-dsh-live-interpreter] textarea:focus-visible{',
      'outline:none;box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) var(--dsw-focus-ring-color,#4d6bfe);}',
      '.dli-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;',
      'padding:7px 13px;border-radius:var(--dsw-radius-md,8px);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(15,18,23,0.18));',
      'background:var(--dsw-alias-bg-layer-1,#f6f7f9);color:var(--dsw-alias-label-primary,#16181d);',
      'font-size:13px;line-height:1.2;cursor:pointer;white-space:nowrap;',
      'transition:background .14s ease,border-color .14s ease,opacity .14s ease}',
      '.dli-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#eceff4);',
      'border-color:var(--dsw-alias-border-l2,rgba(15,18,23,0.28))}',
      '.dli-btn:disabled{opacity:.45;cursor:not-allowed}',
      // The primary action is a TINTED button, not a solid accent block: a large
      // saturated fill fights the host's quiet surfaces, and a solid
      // brand-primary fill was rendering as a black rectangle.
      '.dli-btn-primary{background:var(--dli-accent-soft,rgba(124,58,237,.10));',
      'border-color:var(--dli-accent-line,rgba(124,58,237,.34));',
      'color:var(--dli-accent,#7c3aed);font-weight:600}',
      '.dli-btn-primary:hover:not(:disabled){',
      'background:color-mix(in srgb,var(--dli-accent,#7c3aed) 16%,transparent);',
      'border-color:var(--dli-accent,#7c3aed)}',
      // Ghost is for tertiary actions. It keeps a transparent fill but a real
      // border, so a row of buttons never mixes framed and unframed shapes.
      '.dli-btn-ghost{background:transparent;',
      'border-color:color-mix(in srgb,var(--dsw-alias-border-l2,rgba(15,18,23,0.18)) 70%,transparent);',
      'color:var(--dsw-alias-label-secondary,#5b6270)}',
      '.dli-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#eceff4);',
      'border-color:var(--dsw-alias-border-l2,rgba(15,18,23,0.28));color:var(--dsw-alias-label-primary,#16181d)}',
      '.dli-icon-btn{width:30px;height:30px;padding:0;border-radius:999px;background:transparent;border:1px solid transparent;',
      'display:inline-flex;align-items:center;justify-content:center;cursor:pointer;',
      'color:var(--dsw-alias-label-secondary,#5b6270);transition:background .14s ease,color .14s ease}',
      '.dli-icon-btn:hover{background:var(--dsw-alias-bg-layer-2,#eceff4);color:var(--dsw-alias-label-primary,#16181d)}',
      // The single solid accent surface in the UI: a 30px circle is small enough
      // that a filled shape reads as an affordance instead of a colour block.
      '.dli-icon-accent{width:30px;height:30px;padding:0;border-radius:999px;border:1px solid var(--dli-accent,#7c3aed);',
      'background:var(--dli-accent,#7c3aed);color:var(--dli-accent-ink,#fff);',
      'display:inline-flex;align-items:center;justify-content:center;cursor:pointer;',
      'font-size:16px;line-height:1;transition:filter .14s ease,transform .14s ease}',
      '.dli-icon-accent:hover:not(:disabled){filter:brightness(1.08)}',
      '.dli-icon-accent:disabled{opacity:.45;cursor:not-allowed}',
      '.dli-select{font-family:inherit;font-size:12px;padding:5px 8px;max-width:200px;',
      'border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l2,rgba(15,18,23,0.18));',
      'background:var(--dsw-alias-bg-layer-1,#f6f7f9);color:var(--dsw-alias-label-primary,#16181d);cursor:pointer}',
      '.dli-item{display:block;width:100%;text-align:left;padding:9px 11px;margin-bottom:3px;',
      'border-radius:var(--dsw-radius-md,8px);border:1px solid transparent;background:transparent;',
      'cursor:pointer;transition:background .14s ease}',
      '.dli-item:hover{background:var(--dsw-alias-bg-layer-2,#eceff4)}',
      '.dli-item[data-active="1"]{background:var(--dli-accent-weak,rgba(124,58,237,.08));',
      'border-color:var(--dli-accent-line,rgba(124,58,237,.34))}',
      '.dli-item-title{display:block;font-size:13px;font-weight:500;line-height:1.35;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dli-item-meta{display:block;font-size:11px;line-height:1.4;margin-top:3px;',
      'color:var(--dsw-alias-label-secondary,#5b6270);font-variant-numeric:tabular-nums}',
      '.dli-item-del{position:absolute;right:4px;top:6px;width:22px;height:22px;border:none;background:transparent;',
      'border-radius:6px;cursor:pointer;opacity:0;color:var(--dsw-alias-label-secondary,#5b6270);',
      'transition:opacity .14s ease,background .14s ease}',
      '.dli-item-wrap:hover .dli-item-del{opacity:.7}',
      '.dli-item-del:hover{opacity:1;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d92d20) 14%,transparent);',
      'color:var(--dsw-alias-state-error-primary,#d92d20)}',
      '.dli-scroll{overflow-y:auto;scrollbar-width:thin;',
      'scrollbar-color:var(--dsw-alias-border-l2,rgba(15,18,23,0.2)) transparent}',
      '.dli-scroll::-webkit-scrollbar{width:10px;height:10px}',
      '.dli-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,rgba(15,18,23,0.2));',
      'border-radius:999px;border:3px solid transparent;background-clip:content-box}',
      '.dli-scroll::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-border-l2,rgba(15,18,23,0.36));background-clip:content-box}',
      '.dli-scroll::-webkit-scrollbar-track{background:transparent}',
      '.dli-pill{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;',
      'font-size:11px;line-height:1.5;white-space:nowrap;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(15,18,23,0.10));',
      'background:var(--dsw-alias-bg-layer-1,#f6f7f9);color:var(--dsw-alias-label-secondary,#5b6270)}',
      '.dli-pill-live{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d92d20) 40%,transparent);',
      'background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d92d20) 10%,transparent);',
      'color:var(--dsw-alias-state-error-primary,#d92d20);font-weight:600}',
      '.dli-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto}',
      '.dli-pill-live .dli-dot{animation:dli-pulse 1.6s ease-in-out infinite}',
      '@keyframes dli-pulse{0%,100%{opacity:1}50%{opacity:.25}}',
      '.dli-seg{display:flex;gap:12px;padding:9px 0}',
      '.dli-seg+.dli-seg{border-top:1px solid var(--dsw-alias-border-l1,rgba(15,18,23,0.06))}',
      '.dli-seg-final .dli-seg-body{border-left:2px solid var(--dli-accent,#7c3aed);',
      'padding-left:11px;margin-left:-13px}',
      '.dli-seg-clock{flex:0 0 42px;font-family:inherit;font-variant-numeric:tabular-nums;',
      'font-size:11px;line-height:1.9;color:var(--dsw-alias-label-secondary,#5b6270);opacity:.6}',
      '.dli-seg-body{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;font-size:15.5px;line-height:1.78}',
      /* ---- row grid: one scrolling area, both languages share a row ------
         Each paragraph is a run of cells — clock, source, rule, target — so the
         two languages cannot drift apart the way two independent scrollers do.
         The columns are sized in fr units with a fixed clock column, and every
         cell carries its own padding because border-box padding on a grid item
         would otherwise collapse the row rhythm. */
      '.dli-gridhead{display:grid;grid-template-columns:52px 1fr 1px 1fr;align-items:end;',
      'border-bottom:1px solid var(--dsw-alias-border-l1,rgba(15,18,23,0.08));flex:0 0 auto}',
      '.dli-grid{display:grid;grid-template-columns:52px 1fr 1px 1fr;align-content:start;',
      'padding:14px 20px 40px}',
      '.dli-gridhead>.dli-colhead:first-child{grid-column:2;padding-left:0}',
      '.dli-gridhead>.dli-colhead:last-child{grid-column:4;padding-left:0}',
      '.dli-cell{padding:9px 0;min-width:0;overflow-wrap:anywhere;font-size:15.5px;line-height:1.78}',
      '.dli-cell-clock{font-variant-numeric:tabular-nums;font-size:11px;line-height:1.9;',
      'color:var(--dsw-alias-label-secondary,#5b6270);opacity:.6;padding-right:10px;user-select:none}',
      '.dli-cell-src{padding-right:16px}',
      '.dli-cell-dst{padding-left:16px}',
      '.dli-cell-vrule{width:1px;background:var(--dsw-alias-border-l1,rgba(15,18,23,0.08))}',
      /* A paragraph starts with a hairline above it and gets a left bar on its
         source cell once it is finished, so the reader can see paragraph
         boundaries without counting rows. The bar is drawn as an inset shadow:
         a real border would shift the text of every finished paragraph away
         from the one above it. */
      '.dli-cell-para>.dli-cell-clock,.dli-cell-para>.dli-cell-src,',
      '.dli-cell-para>.dli-cell-dst{border-top:1px solid var(--dsw-alias-border-l1,rgba(15,18,23,0.06))}',
      '.dli-cell-src.dli-cell-final{box-shadow:inset 2px 0 0 var(--dli-accent,#7c3aed);padding-left:12px}',
      // Sentence-by-sentence layout. Each line hugs the text it carries instead
      // of stretching the full column width, so the eye can pair line N on the
      // left with line N on the right without a ruler.
      '.dli-align{display:block}',
      '.dli-align>span{display:block;margin:0 0 2px}',
      '.dli-align>span:last-child{margin-bottom:0}',
      '.dli-tier-settled{color:var(--dsw-alias-label-primary,#16181d)}',
      // The two provisional tiers are dimmed rather than given their own greys.
      // Measured ratios on the three surfaces both themes actually use:
      // settled 12.6-17.8, live 8.0-9.8, guess 5.4-7.3 — the guess tier stays
      // above the 4.5:1 AA floor on the darkest and lightest surface alike.
      // Italic carries the "not committed" signal too, so the distinction never
      // rests on colour alone, and since both layers are opacities of the
      // theme's own foreground they need no per-theme tuning.
      // Three levels, one ramp: a closed paragraph is full strength, an open one
      // is dimmed as a block, and its still-guessing tail is dimmer still.
      // Measured on white: 1.0 -> 21:1, .80 -> ~9:1, .62 -> 5.2:1, so even the
      // guess tier clears the 4.5:1 AA floor in the light theme; italic carries
      // the same signal without relying on colour.
      '.dli-tier-live{color:var(--dsw-alias-label-primary,#16181d);opacity:.8}',
      '.dli-tier-guess{color:var(--dsw-alias-label-primary,#16181d);opacity:.62;font-style:italic}',
      '.dli-caret{display:inline-block;width:2px;height:1em;vertical-align:-2px;margin-left:1px;',
      'background:var(--dli-accent,#7c3aed);animation:dli-blink 1.1s step-end infinite}',
      '@keyframes dli-blink{0%,100%{opacity:1}50%{opacity:0}}',
      '.dli-modal-mask{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;',
      'padding:24px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#16181d) 42%,transparent);',
      'backdrop-filter:blur(2px)}',
      '.dli-modal{width:100%;max-width:480px;max-height:86vh;overflow:auto;padding:20px;',
      'border-radius:var(--dsw-radius-lg,12px);border:1px solid var(--dsw-alias-border-l2,rgba(15,18,23,0.2));',
      'background:var(--dsw-alias-bg-overlay,#fff);box-shadow:var(--dsw-shadow-lv3,0 18px 48px rgba(16,24,40,0.18))}',
      '.dli-modal-title{font-size:15px;font-weight:600;margin:0 0 4px}',
      '.dli-modal-hint{font-size:12px;line-height:1.65;margin:0 0 14px;color:var(--dsw-alias-label-secondary,#5b6270)}',
      '.dli-field{width:100%;padding:10px 12px;border-radius:var(--dsw-radius-md,8px);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(15,18,23,0.18));',
      'background:var(--dsw-alias-bg-layer-1,#f6f7f9);color:var(--dsw-alias-label-primary,#16181d);',
      'font-family:inherit;font-size:13px;line-height:1.7;resize:vertical}',
      '.dli-card{padding:14px 16px;margin-bottom:12px;border-radius:var(--dsw-radius-lg,12px);',
      'border:1px solid var(--dsw-alias-border-l1,rgba(15,18,23,0.10));',
      'background:var(--dsw-alias-bg-layer-1,#f6f7f9)}',
      '.dli-row{display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap}',
      /* ---- second pass: calmer rhythm, progressive disclosure -------------
         The first pass fixed the broken tokens; this pass is about rhythm. A
         transcript is read for an hour, so the chrome around it has to recede:
         one hairline per band, one accent per screen, and every control that is
         not used while talking moved behind the toolbar's "settings" toggle. */
      '.dli-root{letter-spacing:0}',
      // Rail: a quiet header band, a section label, then rows.
      '.dli-rail-head{padding:16px 14px 12px;display:flex;gap:10px;align-items:center}',
      '.dli-rail-title{font-size:13.5px;font-weight:650;line-height:1.2;letter-spacing:0.01em}',
      '.dli-rail-sub{font-size:11px;line-height:1.5;margin-top:2px;',
      'color:var(--dsw-alias-label-secondary,#5b6270);font-variant-numeric:tabular-nums}',
      '.dli-section-label{padding:10px 16px 6px;font-size:10.5px;font-weight:600;letter-spacing:0.09em;',
      'text-transform:uppercase;color:var(--dsw-alias-label-secondary,#5b6270);opacity:.75}',
      // Top bar: title on the left, a hairline status cluster, controls on the right.
      '.dli-topbar{display:flex;align-items:center;gap:10px;padding:11px 18px;flex-wrap:wrap;',
      'border-bottom:1px solid var(--dsw-alias-border-l1,rgba(15,18,23,0.08))}',
      '.dli-topbar-title{font-size:14.5px;font-weight:600;line-height:1.3;margin-right:auto;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:44%}',
      '.dli-cluster{display:inline-flex;align-items:center;gap:7px;min-width:0}',
      // Column heads: a caption over a hairline, no filled band. The accent
      // stays off the label: a purple "原文" reads like a link, and the
      // recording tint already says the call is live.
      '.dli-colhead{background:transparent;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(15,18,23,0.08));',
      'color:var(--dsw-alias-label-secondary,#5b6270);padding-top:15px;padding-bottom:9px}',
      '.dli-colhead-label{font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase}',
      '.dli-colhead-count{font-size:11px;font-variant-numeric:tabular-nums;opacity:.7;font-weight:400;',
      'letter-spacing:0;text-transform:none}',
      // Toolbar: primary actions stay visible, everything else lives in the drawer.
      '.dli-toolbar{display:flex;align-items:center;gap:8px;padding:11px 18px;flex-wrap:wrap;',
      'border-top:1px solid var(--dsw-alias-border-l1,rgba(15,18,23,0.08));',
      'background:var(--dsw-alias-bg-base,#fff)}',
      '.dli-toolbar-spacer{flex:1 1 auto;min-width:8px}',
      '.dli-toolbar-note{display:inline-flex;align-items:center;gap:6px;font-size:11px;',
      'color:var(--dsw-alias-label-secondary,#5b6270);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dli-drawer{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));',
      'gap:12px 18px;padding:14px 18px 16px;',
      'border-top:1px solid var(--dsw-alias-border-l1,rgba(15,18,23,0.08));',
      'background:var(--dsw-alias-bg-layer-1,#f6f7f9)}',
      '.dli-drawer-field{display:flex;flex-direction:column;gap:5px;min-width:0}',
      '.dli-drawer-label{font-size:10.5px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;',
      'color:var(--dsw-alias-label-secondary,#5b6270);opacity:.85}',
      '.dli-drawer .dli-select{max-width:none;width:100%;font-size:12.5px;padding:6px 9px}',
      '.dli-drawer-hint{font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary,#5b6270)}',
      // Meters read as one small instrument panel instead of two loose bars.
      '.dli-meters{display:flex;align-items:center;gap:22px;padding:11px 18px 0;flex-wrap:wrap}',
      '.dli-meter{display:flex;align-items:center;gap:9px;flex:1 1 220px;max-width:340px;min-width:0}',
      '.dli-meter-label{flex:0 0 32px;text-align:right;font-size:10.5px;letter-spacing:0.06em;',
      'text-transform:uppercase;color:var(--dsw-alias-label-secondary,#5b6270);opacity:.8}',
      '.dli-meter-track{flex:1 1 auto;height:4px;border-radius:999px;overflow:hidden;min-width:40px;',
      'background:var(--dsw-alias-border-l1,rgba(15,18,23,0.10))}',
      '.dli-meter-fill{display:block;height:100%;border-radius:999px}',
      '.dli-meter-state{flex:0 0 30px;font-size:10.5px;text-align:right;font-variant-numeric:tabular-nums}',
      // Empty states get a mark, a heading and one line of instruction each.
      '.dli-empty{max-width:460px;margin:auto;padding:48px 24px;text-align:center}',
      '.dli-empty-mark{width:44px;height:44px;margin:0 auto 14px;border-radius:14px;',
      'display:flex;align-items:center;justify-content:center;',
      'background:var(--dli-accent-weak,rgba(124,58,237,.08));',
      'border:1px solid var(--dli-accent-line,rgba(124,58,237,.24));color:var(--dli-accent,#7c3aed)}',
      '.dli-empty-title{font-size:14px;font-weight:600;margin-bottom:6px}',
      '.dli-empty-body{font-size:12.5px;line-height:1.8;color:var(--dsw-alias-label-secondary,#5b6270)}',
      '.dli-empty-steps{margin-top:16px;display:flex;flex-direction:column;gap:7px;text-align:left}',
      '.dli-empty-step{display:flex;gap:9px;align-items:flex-start;font-size:12px;line-height:1.7;',
      'color:var(--dsw-alias-label-secondary,#5b6270)}',
      '.dli-step-no{flex:0 0 17px;height:17px;border-radius:999px;margin-top:2px;',
      'display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;',
      'background:var(--dli-accent-weak,rgba(124,58,237,.10));color:var(--dli-accent,#7c3aed)}',
      // A line of help text that sits under a control rather than shouting.
      '.dli-note{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,#5b6270);opacity:.9}',
      '.dli-error{display:flex;gap:8px;align-items:flex-start;margin:10px 18px 0;padding:9px 12px;',
      'border-radius:var(--dsw-radius-md,8px);font-size:12px;line-height:1.6;',
      'color:var(--dsw-alias-state-error-primary,#d92d20);',
      'background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d92d20) 7%,transparent);',
      'border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#d92d20) 22%,transparent)}',
      // Segments: hairline separators, room to breathe, timestamps kept quiet.
      '.dli-seg{padding:9px 0}',
      '.dli-seg-body{font-size:15.5px;line-height:1.8}',
      '.dli-seg-final .dli-seg-body{border-left-width:2px}',
      '.dli-align>span{margin-bottom:3px}',
      // Narrow windows drop the clock column before they squeeze the text: the
      // timestamp is the least useful thing on screen at 700 px wide.
      '@media (max-width:760px){',
      '.dli-grid,.dli-gridhead{grid-template-columns:1fr 1px 1fr}',
      '.dli-cell-clock{display:none}',
      '.dli-gridhead>.dli-colhead:first-child{grid-column:1}',
      '.dli-gridhead>.dli-colhead:last-child{grid-column:3}}',
      '@media (max-width:900px){',
      '.dli-topbar-title{max-width:100%}',
      '.dli-rail{width:216px!important;flex-basis:216px!important}}',
      '@media (prefers-reduced-motion:reduce){',
      '[data-dsh-live-interpreter] *{animation:none!important;transition:none!important}}',
    ].join('')

    var styleTagId = 'dsh-live-interpreter-style'

    // Idempotent: the stylesheet is keyed by id so a remount, a second slot or a
    // duplicate injection cannot stack copies of it into the document head.
    function ensureStyle() {
      if (typeof document === 'undefined') return
      var head = document.head
      if (head === null || head === undefined) {
        // apply() can run before the document head exists; retry once it does
        // rather than silently shipping an unstyled panel.
        if (typeof document.addEventListener === 'function') {
          document.addEventListener('DOMContentLoaded', ensureStyle, { once: true })
        }
        return
      }
      if (document.getElementById(styleTagId) !== null) return
      var tag = document.createElement('style')
      tag.id = styleTagId
      tag.textContent = CSS
      head.appendChild(tag)
    }

    // Layout styles stay as objects because they carry values the stylesheet
    // cannot know (column widths, dynamic colours); anything interactive is a
    // class so hover, focus-visible and the reduced-motion rule apply.
    var styles = {
      shell: {
        display: 'flex',
        height: '100%',
        minHeight: 0,
        fontFamily: FONT,
        color: T.text,
        background: T.bg,
      },
      rail: {
        width: '264px',
        flex: '0 0 264px',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        borderRight: '1px solid ' + T.border,
        // The sidebar's own surface rather than a raised card: the list and the
        // transcript have to read as two parts of one window, not a slab bolted
        // onto the left of a page.
        background: 'var(--dsw-specific-sidebar-fill, #f9fafb)',
      },
      railList: { flex: '1 1 auto', minHeight: 0, padding: '8px' },
      main: { flex: '1 1 auto', display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 },
      // The transcript is ONE scrolling grid, not two columns that scroll
      // independently: a row is as tall as the taller of its two cells, which
      // is the only way a reader can follow a long translation across from a
      // short original.
      grid: { flex: '1 1 auto', display: 'flex', flexDirection: 'column', minHeight: 0 },
      gridBody: { flex: '1 1 auto', minHeight: 0 },
      // Layout only: padding, colour and the hairline come from .dli-colhead so
      // the class can override them per theme without fighting an inline style.
      colHead: {
        padding: '0 20px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      },
      colBody: { flex: '1 1 auto', padding: '14px 20px 40px', minHeight: 0 },
      divider: { width: '1px', background: T.border },
    }

    function btn(extra) {
      return { className: 'dli-btn', style: extra ?? {} }
    }

    function primaryBtn(extra) {
      return { className: 'dli-btn dli-btn-primary', style: extra ?? {} }
    }

    function ghostBtn(extra) {
      return { className: 'dli-btn dli-btn-ghost', style: extra ?? {} }
    }

    function selectStyle() {
      return { className: 'dli-select' }
    }

    /* ---------------------------------------------------------------- helpers */

    // True when the newest paragraph is being written up by the model. The
    // column header uses it to say "working" instead of leaving the reader to
    // wonder whether the empty right column is a bug.
    function row0Finalizing(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return false
      var last = rows[rows.length - 1]
      return last !== null && last !== undefined && last.finalizing === true
    }

    /* --------------------------------------------------------- grid layout */

    // The paragraph as rows of { source, target }. The host sends `pairs` for a
    // finished paragraph; an open one still has its live text on the left and
    // the running draft on the right, which is exactly one row.
    function pairsOf(row) {
      if (Array.isArray(row.pairs) && row.pairs.length > 0) return row.pairs
      if (row.final) {
        var whole = String(row.translation ?? '')
        var source = String(row.source ?? '')
        if (source === '' && whole === '') return []
        return [{ source: source, target: whole }]
      }
      var live = String(row.liveStable ?? '') + String(row.liveVolatile ?? '')
      return [{ source: live, target: String(row.translation ?? '') }]
    }

    // One cell of the left column. A finished paragraph is written in full
    // strength; while it is still open the settled part stays dim so "grey means
    // still being corrected" holds for the whole block.
    function sourceCell(row, pair, isLast) {
      if (row.final) {
        return h('span', { className: 'dli-tier-settled' }, pair.source)
      }
      // While the paragraph is open the left cell shows THREE things stacked:
      //   • row.source — the sentences that have already closed (and, after the
      //     offline pass, the cleaned whole paragraph). This is the settled text
      //     and must stay visible, otherwise every completed sentence vanishes
      //     the moment the recognizer moves on to the next one, and after
      //     refinement the row went completely blank.
      //   • liveStable — the current in-progress sentence's stable prefix.
      //   • liveVolatile — the newest, still-changing guess.
      var settled = String(row.source ?? '')
      var live = String(row.liveStable ?? '')
      var guessing = String(row.liveVolatile ?? '')
      var out = []
      if (settled !== '') out.push(h('span', { key: 'settled', className: 'dli-tier-live' }, settled))
      if (live !== '') {
        if (settled !== '') out.push(h('span', { key: 'gap' }, ' '))
        out.push(h('span', { key: 'live', className: 'dli-tier-live' }, live))
      }
      if (guessing !== '') {
        if (settled !== '' || live !== '') out.push(h('span', { key: 'gap2' }, ' '))
        out.push(h('span', { key: 'guess', className: 'dli-tier-guess' }, guessing))
      }
      if (isLast && (live !== '' || guessing !== '')) {
        out.push(h('span', { key: 'caret', className: 'dli-caret' }))
      }
      return out
    }

    /**
     * Flatten every paragraph into grid cells.
     *
     * The transcript used to be two independently scrolling columns, so a long
     * translation and a short original could never line up — nothing connected
     * a left row to the right one. Here both sides are cells of the SAME grid
     * row, so the row is as tall as the taller side and the reader can follow
     * across without measuring. The vertical rule and the clock are cells too,
     * which is why the divider is continuous instead of being a separate box.
     */
    function gridRows(rows) {
      var cells = []
      for (var r = 0; r < rows.length; r += 1) {
        var row = rows[r]
        var pairs = pairsOf(row)
        if (pairs.length === 0) continue
        for (var p = 0; p < pairs.length; p += 1) {
          var first = p === 0
          var last = p === pairs.length - 1
          var edge = first ? ' dli-cell-para' : ''
          var tier = row.final ? ' dli-cell-final' : ''
          cells.push(
            h(
              'div',
              { key: row.seq + '-k' + p, className: 'dli-cell dli-cell-clock' + edge },
              first && row.startMs !== null && row.startMs !== undefined ? shortClock(row.startMs) : '',
            ),
          )
          cells.push(
            h(
              'div',
              { key: row.seq + '-s' + p, className: 'dli-cell dli-cell-src' + edge + tier },
              sourceCell(row, pairs[p], last),
            ),
          )
          cells.push(h('div', { key: row.seq + '-v' + p, className: 'dli-cell dli-cell-vrule' + edge }))
          cells.push(
            h(
              'div',
              { key: row.seq + '-t' + p, className: 'dli-cell dli-cell-dst' + edge + tier },
              String(pairs[p].target ?? '') === ''
                ? h('span', { style: { color: T.dim } }, '…')
                : String(pairs[p].target),
            ),
          )
        }
      }
      return cells
    }

    function clockText(ms) {
      var total = Math.max(0, Math.floor(ms / 1000))
      var hh = String(Math.floor(total / 3600)).padStart(2, '0')
      var mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
      var ss = String(total % 60).padStart(2, '0')
      return hh + ':' + mm + ':' + ss
    }

    function shortClock(ms) {
      var total = Math.max(0, Math.floor(ms / 1000))
      var mm = String(Math.floor(total / 60)).padStart(2, '0')
      var ss = String(total % 60).padStart(2, '0')
      return mm + ':' + ss
    }

    // A rail row is read at a glance while another window has focus, so the
    // date has to be short and stable-width: "11/21 21:52" beats a locale
    // string that changes shape between machines and shifts the row height.
    function shortDate(value) {
      var at = Number(value)
      if (!Number.isFinite(at) || at <= 0) return ''
      var when = new Date(at)
      var mm = String(when.getMonth() + 1).padStart(2, '0')
      var dd = String(when.getDate()).padStart(2, '0')
      var hh = String(when.getHours()).padStart(2, '0')
      var mi = String(when.getMinutes()).padStart(2, '0')
      return mm + '/' + dd + ' ' + hh + ':' + mi
    }

    async function api(path, init) {
      var response = await fetch(API + path, Object.assign({ headers: { 'content-type': 'application/json' } }, init))
      var text = await response.text()
      var data = {}
      try {
        data = text === '' ? {} : JSON.parse(text)
      } catch (error) {
        data = { error: text.slice(0, 200) }
      }
      if (!response.ok) throw new Error(data.error ?? 'HTTP ' + response.status)
      return data
    }

    /* The host denies window.open and any second window, so an export is saved
       through a Blob download instead. Fetching the file first also means the
       browser sees a same-origin body it already trusts. */
    async function saveExport(projectId, filename) {
      var url = API + '/projects/' + encodeURIComponent(projectId) + '/exports/' + encodeURIComponent(filename)
      try {
        var response = await fetch(url)
        if (!response.ok) throw new Error('HTTP ' + response.status)
        var blob = await response.blob()
        var href = URL.createObjectURL(blob)
        var anchor = document.createElement('a')
        anchor.href = href
        anchor.download = filename
        anchor.style.display = 'none'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        setTimeout(function () {
          URL.revokeObjectURL(href)
        }, 4000)
      } catch (error) {
        console.warn('[dsh-live-interpreter] export download failed, opening the link instead', error)
        window.open(url, '_blank')
      }
    }

    /* ------------------------------------------------------------- audio tap */

    var WORKLET_SOURCE = [
      'class PcmTap extends AudioWorkletProcessor {',
      '  constructor() {',
      '    super()',
      '    this.ratio = sampleRate / 16000',
      '    this.pending = new Float32Array(8192)',
      '    this.filled = 0',
      '    this.readPos = 0',
      '    this.out = new Int16Array(3840)',
      '    this.outPos = 0',
      '  }',
      '  process(inputs) {',
      '    const input = inputs[0]',
      '    if (!input || input.length === 0) return true',
      '    const channel = input[0]',
      '    if (!channel) return true',
      '    if (this.filled + channel.length > this.pending.length) {',
      '      const grown = new Float32Array(Math.max(this.pending.length * 2, this.filled + channel.length))',
      '      grown.set(this.pending.subarray(0, this.filled))',
      '      this.pending = grown',
      '    }',
      '    this.pending.set(channel, this.filled)',
      '    this.filled += channel.length',
      '    while (this.readPos + 1 < this.filled) {',
      '      const i = Math.floor(this.readPos)',
      '      const frac = this.readPos - i',
      '      const sample = this.pending[i] * (1 - frac) + this.pending[i + 1] * frac',
      '      const clipped = sample > 1 ? 1 : sample < -1 ? -1 : sample',
      '      this.out[this.outPos++] = clipped < 0 ? clipped * 32768 : clipped * 32767',
      '      this.readPos += this.ratio',
      '      if (this.outPos >= this.out.length) {',
      '        const copy = new Int16Array(this.out)',
      '        this.port.postMessage(copy.buffer, [copy.buffer])',
      '        this.outPos = 0',
      '      }',
      '    }',
      '    const consumed = Math.floor(this.readPos)',
      '    if (consumed > 0) {',
      '      this.pending.copyWithin(0, consumed, this.filled)',
      '      this.filled -= consumed',
      '      this.readPos -= consumed',
      '    }',
      '    return true',
      '  }',
      '}',
      'registerProcessor("pcm-tap", PcmTap)',
    ].join('\n')

    // What the user picked as the sound source. "system" is the machine's own
    // output (an online meeting heard through the speakers), "mix" is both at
    // once — the case where the room has people in it AND the call has remote
    // participants.
    var SOURCE_MODES = ['mic', 'system', 'mix']
    var SOURCE_LABELS = { mic: '麦克风', system: '系统声音', mix: '麦克风 + 系统声音' }

    function sourceLabel(mode) {
      return SOURCE_LABELS[mode] || SOURCE_LABELS.mic
    }

    // Loopback of the machine's own output shows up as an ordinary recording
    // device — "Stereo Mix" on Realtek, "CABLE Output" for VB-Audio, "What U
    // Hear" for VoiceMeeter. Chromium cannot enumerate loopback on its own and
    // Electron refuses display capture without a host-side handler, so this
    // device *is* the system-audio path: whatever the user routes or mirrors
    // into it, we record as a normal microphone.
    var LOOPBACK_HINT = /立体声混音|stereo\s*mix|what\s*u\s*hear|cable\s*output|voicemeeter|loopback|虚拟声卡|virtual\s*(?:audio|cable)/i

    function looksLikeLoopback(label) {
      return LOOPBACK_HINT.test(String(label ?? ''))
    }

    function stopTracks(stream) {
      if (stream === null || stream === undefined) return
      try {
        var tracks = stream.getTracks()
        for (var i = 0; i < tracks.length; i += 1) tracks[i].stop()
      } catch (error) {
        /* track may already be gone */
      }
    }

    // Downsample whatever the device gave us to the 16 kHz mono PCM16 the
    // recognizer requires, emitting one 240 ms frame per message.
    function resampleTo16k(input, fromRate) {
      var ratio = fromRate / 16000
      var count = Math.floor(input.length / ratio)
      var out = new Int16Array(count)
      for (var i = 0; i < count; i += 1) {
        var position = i * ratio
        var index = Math.floor(position)
        var frac = position - index
        var sample = input[index] * (1 - frac) + (input[index + 1] ?? input[index]) * frac
        var clipped = sample > 1 ? 1 : sample < -1 ? -1 : sample
        out[i] = clipped < 0 ? clipped * 32768 : clipped * 32767
      }
      return out
    }

    /**
     * Two constraint sets, tried in order.
     *
     * The processed one is what a phone-call pipeline wants, and on most
     * machines it is also what makes the recognizer happy. Some USB and
     * Bluetooth headsets, however, accept `echoCancellation` &
     * co. and then hand back an all-zero stream — so the second attempt
     * asks for the raw device signal instead of trusting the first one.
     */
    function buildConstraints(deviceId, processed) {
      var audio = processed
        ? { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        : { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      // `deviceId: ''` would mean "no device at all", so the key is only
      // present when the user actually picked one.
      if (deviceId !== '') audio.deviceId = { exact: deviceId }
      return { audio: audio }
    }

    /**
     * Find the recording device that mirrors the machine's own output.
     *
     * `wanted` wins when the user picked a device explicitly — that is how
     * someone with two loopback devices (a cable plus a mixer) chooses between
     * them. Otherwise the first device whose name looks like loopback is used.
     * Returns `null` when the machine has none, which is not an error: the
     * caller turns it into an actionable message.
     */
    function pickLoopback(devices, wanted) {
      var list = Array.isArray(devices) ? devices : []
      if (wanted !== '') {
        for (var i = 0; i < list.length; i += 1) {
          if (list[i].deviceId === wanted) return list[i]
        }
      }
      for (var j = 0; j < list.length; j += 1) {
        if (looksLikeLoopback(list[j].label)) return list[j]
      }
      return null
    }

    /** The device list, or an empty array when the browser will not say. */
    async function inputDevices() {
      if (typeof navigator === 'undefined' || navigator.mediaDevices === undefined) return []
      try {
        var devices = await navigator.mediaDevices.enumerateDevices()
        return devices.filter(function (device) {
          return device.kind === 'audioinput'
        })
      } catch (error) {
        console.warn('[dsh-live-interpreter] enumerateDevices failed', error)
        return []
      }
    }

    function missingLoopbackError() {
      var error = new Error(
        '这台电脑没有可用的「系统声音」录音设备。请任选一种办法：① 在 Windows 声音设置里启用「立体声混音 / Stereo Mix」（录制设备 → 右键显示已禁用设备 → 启用）；② 或用 VB-CABLE 之类的虚拟声卡，把会议输出接到它，再到「输入设备」里选中它。',
      )
      error.name = 'NoLoopbackDevice'
      return error
    }

    function createCapture() {
      var context = null
      var node = null
      // One entry per capture stream: the microphone, the loopback device, or
      // both.
      var sources = []
      var streams = []
      var sink = null
      var processor = null
      // Set when AudioWorklet is unavailable and we fall back to a ScriptProcessor.
      var pending = null
      var pendingCount = 0
      // 240 ms at 16 kHz — the recognizer's frame size.
      var frameSize = 3840
      var lastStatus = { state: 'idle', rate: 0, error: '', device: '', source: 'mic' }

      function emit(samples) {
        if (pending === null) return
        var offset = 0
        while (offset < samples.length) {
          var take = Math.min(frameSize - pendingCount, samples.length - offset)
          pending.set(samples.subarray(offset, offset + take), pendingCount)
          pendingCount += take
          offset += take
          if (pendingCount === frameSize) {
            var full = pending
            pending = new Int16Array(frameSize)
            pendingCount = 0
            emitted += 1
            onFrameSink(full.buffer)
          }
        }
      }

      var emitted = 0
      var watchdog = null
      // Latched once the worklet proves unusable, so a retry does not add the
      // same module a second time (registerProcessor throws on a repeat name).
      // The module belongs to one AudioContext, so the context it was added to
      // is remembered rather than a plain flag: a retry closes the context and
      // the next one needs the module again.
      var workletBroken = false
      var workletContext = null
      var onFrameSink = function () {}
      var onStatusSink = function () {}

      function report(patch) {
        lastStatus = Object.assign({}, lastStatus, patch)
        onStatusSink(lastStatus)
      }

      /**
       * Shout when the graph is connected but silent.
       *
       * Both capture paths can complete without an exception and still produce
       * nothing — a suspended context, a device another app holds open, or an
       * endpoint that reports itself healthy while returning zeros. Without
       * this the panel would just sit there looking like a broken recognizer.
       */
      function startWatchdog() {
        if (watchdog !== null) clearInterval(watchdog)
        var warned = false
        watchdog = setInterval(function () {
          if (emitted > 0) {
            // Audio is flowing after all; the earlier verdict is void.
            if (warned) {
              warned = false
              report({ state: 'live', error: '' })
            }
            return
          }
          if (warned) return
          warned = true
          report({
            state: 'silent',
            error:
              lastStatus.source === 'system'
                ? '系统声音设备已连通但没有采到任何音频：确认电脑正在播放声音，并且这个设备确实是「立体声混音 / 虚拟声卡」的录音端'
                : lastStatus.source === 'mix'
                  ? '两路声音都连通了但没有采到任何音频：确认电脑正在播放，麦克风也没被系统静音'
                  : '麦克风连通了但没有采到任何音频：系统可能静音了该设备，或它被其它程序独占',
          })
        }, 2500)
      }

      function stopWatchdog() {
        if (watchdog !== null) clearInterval(watchdog)
        watchdog = null
      }

      /**
       * Tear the graph down but keep the AudioContext alive.
       *
       * Retrying with different constraints must not close the context: it was
       * opened inside the click handler on purpose (see `warm`), and a fresh one
       * created after the awaits would come up suspended and produce nothing.
       */
      async function detach() {
        stopWatchdog()
        try {
          if (node !== null && node.port !== undefined) node.port.onmessage = null
          if (node !== null) node.disconnect()
          if (processor !== null) {
            processor.onaudioprocess = null
            processor.disconnect()
          }
          for (var i = 0; i < sources.length; i += 1) {
            try {
              sources[i].disconnect()
            } catch (ignored) {
              /* node may already be gone */
            }
          }
          if (sink !== null) sink.disconnect()
        } catch (error) {
          /* nodes may already be gone */
        }
        for (var j = 0; j < streams.length; j += 1) stopTracks(streams[j])
        node = null
        processor = null
        sources = []
        sink = null
        streams = []
        pending = null
        pendingCount = 0
      }

      return {
        status: function () {
          return lastStatus
        },
        /**
         * Create the AudioContext while the caller still owns the user gesture.
         *
         * `start()` runs after an await on the host API, which loads a ~200 MB
         * recognizer — by the time it returns, Chromium's transient activation
         * is long gone and a context created there can come up suspended, i.e.
         * it produces exactly zero audio callbacks for the whole meeting. That
         * failure looks identical to a dead microphone, so the context is
         * opened up front instead.
         */
        warm: function () {
          if (context !== null) return context
          try {
            context = new (window.AudioContext || window.webkitAudioContext)()
            void context.resume().catch(function () {})
          } catch (error) {
            console.warn('[dsh-live-interpreter] AudioContext unavailable', error)
            context = null
          }
          return context
        },
        /**
         * @param {(buffer: ArrayBuffer) => void} onFrame
         * @param {(status: {state: string, rate: number, error: string, device: string}) => void} onStatus
         * @param {{deviceId?: string, source?: 'mic'|'system'|'mix'}} [options]
         *
         * Open the chosen sound source and start emitting frames.
         *
         * `source` decides what "input" means: the microphone, the machine's
         * own output (an online meeting), or both mixed. Device processing
         * (`echoCancellation`/`noiseSuppression`/`autoGainControl`) is the most
         * common reason a USB or Bluetooth headset hands back all-zero samples:
         * the driver accepts the constraint but its pipeline never produces
         * signal, so "no exception" proves nothing. A silent first attempt is
         * therefore retried with raw audio instead of leaving the meeting
         * recording nothing.
         */
        async start(onFrame, onStatus, options) {
          onFrameSink = onFrame
          onStatusSink = typeof onStatus === 'function' ? onStatus : function () {}
          var wanted =
            options !== null && options !== undefined && typeof options.deviceId === 'string'
              ? options.deviceId
              : ''
          var mode = options !== null && options !== undefined && SOURCE_MODES.indexOf(options.source) >= 0 ? options.source : 'mic'
          var attempt = 0
          while (attempt < 2) {
            report({ state: 'requesting', error: '', device: wanted, source: mode })
            var mark = emitted
            await this.attach(buildConstraints(wanted, attempt === 0), mode)
            if (emitted > mark) return context === null ? 0 : context.sampleRate
            if (attempt === 0) {
              console.warn('[dsh-live-interpreter] no frames with device processing, retrying raw audio')
              await detach()
            }
            attempt += 1
          }
          report({
            state: 'silent',
            error:
              mode === 'system'
                ? '系统声音设备已打开但采不到任何音频：确认电脑正在播放声音，并且「输入设备」里选的是立体声混音 / 虚拟声卡的录音端'
                : '麦克风已打开但采不到任何音频：请展开底栏的「设置 ▾」点「测试麦克风」确认电平，或换一个输入设备',
          })
          return 0
        },

        async attach(constraints, sourceMode) {
          var mode = SOURCE_MODES.indexOf(sourceMode) >= 0 ? sourceMode : 'mic'
          streams = []
          try {
            if (mode !== 'system') {
              var mic = await navigator.mediaDevices.getUserMedia(constraints)
              streams.push(mic)
            }
            if (mode !== 'mic') {
              // The loopback device is an ordinary audio input, so it goes
              // through getUserMedia like the microphone does — and it obeys
              // the same persistent grant, so it may be awaited this late.
              // Echo cancellation would subtract the meeting from itself,
              // which is the exact opposite of what this source is for.
              var devices = await inputDevices()
              // In "mix" the picked device belongs to the microphone half, so
              // the loopback half must be discovered by name; in "system" the
              // pick *is* the loopback choice (a machine can have several).
              var chosenLoopback = mode === 'system' ? String(constraints?.audio?.deviceId?.exact ?? '') : ''
              var picked = pickLoopback(devices, chosenLoopback)
              if (picked === null) throw missingLoopbackError()
              var loop = { audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false, deviceId: { exact: picked.deviceId } } }
              streams.push(await navigator.mediaDevices.getUserMedia(loop))
            }
          } catch (error) {
            for (var k = 0; k < streams.length; k += 1) stopTracks(streams[k])
            streams = []
            var name = String((error !== null && error !== undefined && error.name) || '')
            var message = String((error !== null && error !== undefined && error.message) || '')
            // A missing loopback device already carries a repair recipe; do not
            // bury it under "cannot capture system audio".
            if (name === 'NoLoopbackDevice') {
              report({ state: 'error', error: message, source: mode })
              throw error
            }
            var advice = mode === 'system' ? '无法打开系统声音设备' : '无法打开麦克风'
            if (name === 'NotAllowedError' || name === 'SecurityError') {
              // Desktop only grants media permissions to the dsh-app://app
              // window, so an ordinary browser tab on 127.0.0.1 is refused
              // outright. Naming the current origin turns it into a next step.
              var here = ''
              try {
                here = '，当前页面 ' + String(window.location.origin || window.location.protocol || '')
              } catch (ignored) {
                /* ignore */
              }
              advice =
                mode === 'system'
                  ? '系统声音设备被拒绝：请在 DeepSeek Harness 桌面应用窗口里打开本插件，并确认「立体声混音 / 虚拟声卡」在系统里是启用状态（普通浏览器标签页会被系统策略拒绝' + here + '）'
                  : '麦克风被拒绝：请在 DeepSeek Harness 桌面应用窗口里打开本插件（普通浏览器标签页会被系统策略拒绝' + here + '）'
            } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
              advice = mode === 'system' ? '没有找到系统声音录音设备' : '没有找到麦克风设备'
            } else if (name === 'NotReadableError' || name === 'TrackStartError') {
              advice = '设备被其它程序占用（会议软件 / 直播软件常见），请关闭后重试'
            }
            report({ state: 'error', error: advice + (message === '' ? '' : '（' + name + ': ' + message + '）'), source: mode })
            throw error
          }
          var labels = []
          var micTrack = null
          for (var s = 0; s < streams.length; s += 1) {
            var audioTrack = streams[s].getAudioTracks()[0]
            if (audioTrack === undefined) continue
            labels.push(String(audioTrack.label || ''))
            if (micTrack === null) micTrack = audioTrack
            // The loopback device announces itself as "system audio" in the
            // panel: "microphone disconnected" would send that user to the
            // wrong settings page.
            var isSystem = s > 0 || mode === 'system'
            audioTrack.addEventListener('ended', function () {
              report({ state: 'ended', error: isSystem ? '系统声音设备已断开（设备被禁用或拔出）' : '麦克风已被系统或设备断开' })
            })
            if (!isSystem) {
              audioTrack.addEventListener('mute', function () {
                report({ state: 'muted', error: '麦克风被静音（设备被占用或系统静音）' })
              })
              audioTrack.addEventListener('unmute', function () {
                report({ state: 'live', error: '' })
              })
            }
          }
          report({
            device: labels.filter(function (item) {
              return item !== ''
            }).join(' + ') || constraints.audio.deviceId?.exact || '',
            source: mode,
          })
          context = context !== null ? context : new (window.AudioContext || window.webkitAudioContext)()
          // Electron applies Chromium's autoplay policy to the renderer: a
          // context created without a live user gesture starts suspended, and a
          // suspended context produces exactly zero audio callbacks. That is
          // indistinguishable from a broken microphone unless we resume it and
          // say so, which is why this is reported rather than silently ignored.
          if (context.state === 'suspended') {
            try {
              await context.resume()
            } catch (error) {
              console.warn('[dsh-live-interpreter] AudioContext resume failed', error)
            }
          }
          if (context.state !== 'running') {
            report({ state: 'suspended', error: 'AudioContext 处于 ' + context.state + '，浏览器未允许播放音频处理' })
          }
          sources = []
          for (var t = 0; t < streams.length; t += 1) sources.push(context.createMediaStreamSource(streams[t]))
          // A muted sink keeps the graph pulled without playing anything back.
          // With two sources it also serves as the mixing point: both feed the
          // same node, which sums them — exactly what "microphone + system"
          // has to sound like.
          sink = context.createGain()
          sink.gain.value = 0

          var useWorklet =
            !workletBroken &&
            typeof context.audioWorklet !== 'undefined' &&
            typeof AudioWorkletNode !== 'undefined'
          if (useWorklet) {
            try {
              // `registerProcessor` throws on a repeated module name, so the
              // module is added at most once per AudioContext; a retry that
              // closed the old context needs it added again.
              if (workletContext !== context) {
                var blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
                var url = URL.createObjectURL(blob)
                try {
                  await context.audioWorklet.addModule(url)
                } finally {
                  URL.revokeObjectURL(url)
                }
                workletContext = context
              }
              node = new AudioWorkletNode(context, 'pcm-tap')
              node.port.onmessage = function (event) {
                // The worklet already resamples to 16 kHz and packs Int16, so
                // this only has to re-frame it through the shared emit() path.
                if (event.data instanceof ArrayBuffer) emit(new Int16Array(event.data))
              }
              frameSize = 3840
              pending = new Int16Array(frameSize)
              pendingCount = 0
              for (var w = 0; w < sources.length; w += 1) sources[w].connect(node)
              node.connect(sink)
              sink.connect(context.destination)
              // A worklet can attach without throwing and still deliver nothing
              // when the audio thread never runs (a suspended context is the
              // usual cause). "No exception" is not proof of audio, so this
              // waits for a real frame before declaring the path usable.
              var before = emitted
              await new Promise(function (resolve) {
                setTimeout(resolve, 1500)
              })
              if (emitted > before) {
                report({ state: 'live', rate: context.sampleRate, error: '' })
                startWatchdog()
                return context.sampleRate
              }
              try {
                await context.resume()
              } catch (ignored) {
                /* ignore */
              }
              await new Promise(function (resolve) {
                setTimeout(resolve, 1000)
              })
              if (emitted > before) {
                report({ state: 'live', rate: context.sampleRate, error: '' })
                startWatchdog()
                return context.sampleRate
              }
              console.warn('[dsh-live-interpreter] AudioWorklet delivered no frames, using ScriptProcessor')
              try {
                node.port.onmessage = null
                node.disconnect()
              } catch (ignored) {
                /* ignore */
              }
              node = null
            } catch (error) {
              // Some Electron builds ship without a usable AudioWorklet; the
              // ScriptProcessor path below produces identical frames.
              console.warn('[dsh-live-interpreter] AudioWorklet unavailable, using ScriptProcessor', error)
              try {
                node?.disconnect()
              } catch (ignored) {
                /* ignore */
              }
              node = null
            }
          }

          // Always 240 ms at 16 kHz, whatever the device rate is: the host
          // estimates silence from a fixed frame size, so a different frame
          // length would skew every endpoint decision.
          frameSize = 3840
          pending = new Int16Array(frameSize)
          pendingCount = 0
          var processorSize = 4096
          processor = context.createScriptProcessor(processorSize, 1, 1)
          processor.onaudioprocess = function (event) {
            var channel = event.inputBuffer.getChannelData(0)
            emit(resampleTo16k(channel, context.sampleRate))
          }
          for (var p = 0; p < sources.length; p += 1) sources[p].connect(processor)
          processor.connect(sink)
          sink.connect(context.destination)
          report({ state: 'live', rate: context.sampleRate, error: '' })
          // Even ScriptProcessor can come up dry when the context was suspended
          // and the later resume() never took effect; nudge it once, then let
          // the watchdog report the truth instead of pretending audio flows.
          var started = emitted
          await new Promise(function (resolve) {
            setTimeout(resolve, 1500)
          })
          if (emitted === started) {
            try {
              await context.resume()
            } catch (ignored) {
              /* ignore */
            }
          }
          startWatchdog()
          return context.sampleRate
        },
        async stop() {
          stopWatchdog()
          closed = true
          try {
            if (node !== null && node.port !== undefined) node.port.onmessage = null
            if (node !== null) node.disconnect()
            if (processor !== null) {
              processor.onaudioprocess = null
              processor.disconnect()
            }
            for (var d = 0; d < sources.length; d += 1) {
              try {
                sources[d].disconnect()
              } catch (ignored) {
                /* ignore */
              }
            }
            if (sink !== null) sink.disconnect()
          } catch (error) {
            /* nodes may already be gone */
          }
          try {
            if (context !== null) await context.close()
          } catch (error) {
            /* ignore */
          }
          for (var i = 0; i < streams.length; i += 1) stopTracks(streams[i])
          context = null
          node = null
          processor = null
          sources = []
          sink = null
          streams = []
          pending = null
          pendingCount = 0
          onFrameSink = function () {}
          report({ state: 'idle' })
        },
      }
    }

    /**
     * List recording devices. Labels are empty until the user grants permission
     * once, so a device known to be loopback is marked here: picking
     * "立体声混音" by accident is exactly how a meeting ends up recording the
     * room instead of the call.
     */
    async function listMicrophones() {
      var devices = await inputDevices()
      return devices.map(function (device) {
        var label = device.label || '麦克风 ' + device.deviceId.slice(0, 6)
        return { id: device.deviceId, label: label, loopback: looksLikeLoopback(device.label) }
      })
    }

    /* ------------------------------------------------------------------ tts */

    // Read-aloud goes through the HOST synthesizer, not speechSynthesis: only
    // an <audio> element can be routed to a chosen output device with
    // setSinkId, and "read the translation into my headphones" is exactly what
    // the output-device selector promises.
    var SPEECH_CHUNK = 200
    var SPEECH_BACKLOG = 2
    var speaking = { queued: 0 }
    var currentAudio = null

    function splitForSpeech(value) {
      var text = String(value ?? '').trim()
      if (text.length <= SPEECH_CHUNK) return [text]
      var pieces = []
      var rest = text
      while (rest.length > SPEECH_CHUNK) {
        var head = rest.slice(0, SPEECH_CHUNK)
        var cut = Math.max(
          head.lastIndexOf('。'),
          head.lastIndexOf('，'),
          head.lastIndexOf('；'),
          head.lastIndexOf('.'),
          head.lastIndexOf(','),
          head.lastIndexOf(';'),
          head.lastIndexOf(' '),
        )
        if (cut < SPEECH_CHUNK * 0.4) cut = head.length - 1
        pieces.push(rest.slice(0, cut + 1).trim())
        rest = rest.slice(cut + 1).trim()
      }
      if (rest !== '') pieces.push(rest)
      return pieces.filter(function (piece) {
        return piece !== ''
      })
    }

    /**
     * Speak one paragraph. Chunks are synthesized one after another so a long
     * passage is read without a ten-second silence between request and audio,
     * and a backlog is dropped rather than played late: reading what was said
     * two minutes ago is worse than skipping it.
     */
    async function playParagraph(text, lang, voiceId) {
      if (typeof window === 'undefined') return
      if (voiceStore.get() !== true) return
      var pieces = splitForSpeech(text)
      if (pieces.length === 0) return
      if (speaking.queued >= SPEECH_BACKLOG) {
        speaking.queued = 0
        if (currentAudio !== null) {
          try {
            currentAudio.pause()
          } catch (ignored) {
            /* ignore */
          }
          currentAudio = null
        }
      }
      speaking.queued += 1
      var synthesize = function (piece) {
        return api('/say', {
          method: 'POST',
          body: JSON.stringify({ text: piece, voice: voiceId ?? 'tts-zh-en', speed: 1 }),
        })
      }
      try {
        // Synthesis runs slower than real time on a laptop CPU, so synthesizing
        // a chunk and only then playing it would fall further behind with every
        // paragraph. Render chunk n+1 while chunk n is playing instead: the
        // queue then costs one render, not one render per chunk.
        var next = synthesize(pieces[0])
        for (var index = 0; index < pieces.length; index += 1) {
          if (voiceStore.get() !== true) break
          var data = await next
          next = index + 1 < pieces.length ? synthesize(pieces[index + 1]) : null
          await playAudioFile(data.filename)
        }
        if (next !== null) void next.catch(function () {})
      } catch (error) {
        console.warn('[dsh-live-interpreter] read-aloud failed', error)
      } finally {
        speaking.queued = Math.max(0, speaking.queued - 1)
      }
    }

    /**
     * Live output level for the read-aloud bar.
     *
     * Metering an <audio> element means routing it through Web Audio, and a
     * media element that feeds an AudioContext plays through the CONTEXT's
     * destination — element.setSinkId() stops deciding the route. So the sink
     * moves to the context (AudioContext.setSinkId, Chromium 110+) and the
     * element sink is only used when the context cannot take it, in which case
     * we simply show no meter instead of silently playing to the wrong device.
     */
    var meterContext = null
    var meterSink = ''

    function playbackContext(sink) {
      if (typeof window === 'undefined') return null
      var Ctor = window.AudioContext || window.webkitAudioContext
      if (Ctor === undefined) return null
      if (meterContext === null) {
        try {
          meterContext = new Ctor()
        } catch (error) {
          console.warn('[dsh-live-interpreter] no audio context for output metering', error)
          meterContext = null
          return null
        }
      }
      if (sink !== meterSink) {
        meterSink = sink
        if (typeof meterContext.setSinkId === 'function') {
          var applied = sink === '' ? meterContext.setSinkId('') : meterContext.setSinkId(sink)
          if (applied !== undefined && applied !== null && typeof applied.catch === 'function') {
            applied.catch(function (error) {
              console.warn('[dsh-live-interpreter] context.setSinkId failed', error)
            })
          }
        } else if (sink !== '') {
          return null
        }
      }
      if (meterContext.state === 'suspended') void meterContext.resume().catch(function () {})
      return meterContext
    }

    function attachOutputMeter(audio) {
      var sink = outputStore.get()
      var context = playbackContext(sink)
      if (context === null) return null
      // A suspended context accepts the media-element source and then plays
      // NOTHING — the audio is routed into the context and never reaches a
      // device. That is indistinguishable from "read-aloud is broken", so give
      // up on metering rather than take the playback down with it.
      if (context.state !== 'running') {
        void context.resume().catch(function () {})
        if (context.state !== 'running') return null
      }
      var source = null
      try {
        source = context.createMediaElementSource(audio)
      } catch (error) {
        // Already bound to another context; metering is a nicety, not a
        // requirement, so playback still goes through untouched.
        console.warn('[dsh-live-interpreter] output metering unavailable', error)
        return null
      }
      var analyser = context.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.6
      source.connect(analyser)
      analyser.connect(context.destination)
      var buffer = new Float32Array(analyser.fftSize)
      var timer = null
      var tick = function () {
        analyser.getFloatTimeDomainData(buffer)
        var sum = 0
        for (var i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i]
        publishOutputLevel(Math.sqrt(sum / buffer.length))
        timer = window.setTimeout(tick, 90)
      }
      tick()
      return function () {
        if (timer !== null) window.clearTimeout(timer)
        timer = null
        try {
          source.disconnect()
          analyser.disconnect()
        } catch (ignored) {
          /* ignore */
        }
        publishOutputLevel(0)
      }
    }

    /**
     * Play one synthesized WAV.
     *
     * `metered` routes the element through the meter's AudioContext so the
     * output bar has real numbers. That routing is also the one way playback
     * can go silent: once `createMediaElementSource()` has claimed an element,
     * its audio only ever reaches that context, and an element can be claimed
     * exactly once. So a failed start retries on a FRESH element with metering
     * off — a dead level bar is a cosmetic loss, a silent paragraph is not.
     */
    function playAudioFile(filename, options) {
      var metered = !(options !== null && options !== undefined && options.meter === false)
      return new Promise(function (resolve) {
        var audio = new Audio()
        audio.preload = 'auto'
        audio.volume = 1
        currentAudio = audio
        var settled = false
        var cleanupMeter = null
        var finish = function () {
          if (settled) return
          settled = true
          audio.onended = null
          audio.onerror = null
          if (cleanupMeter !== null) {
            try {
              cleanupMeter()
            } catch (ignored) {
              /* ignore */
            }
            cleanupMeter = null
          }
          resolve()
        }
        audio.onended = finish
        audio.onerror = function () {
          // A 404 or a decode failure would otherwise leave the queue stuck
          // forever, so it resolves and the caller refills its slot.
          publishOutputLevel(0)
          finish()
        }
        var route = function () {
          if (metered) {
            var meter = attachOutputMeter(audio)
            if (meter !== null) cleanupMeter = meter
          }
          var played = audio.play()
          if (played === undefined || played === null || typeof played.catch !== 'function') return
          played.catch(function (error) {
            console.warn('[dsh-live-interpreter] playback failed', error)
            if (!metered) {
              finish()
              return
            }
            // Retry unmetered on a brand-new element; the claimed one can never
            // be routed anywhere else again.
            settled = true
            audio.onended = null
            audio.onerror = null
            if (cleanupMeter !== null) {
              try {
                cleanupMeter()
              } catch (ignored) {
                /* ignore */
              }
              cleanupMeter = null
            }
            playAudioFile(filename, { meter: false }).then(resolve, resolve)
          })
        }
        var sink = outputStore.get()
        audio.src = API + '/speech/' + encodeURIComponent(filename)
        if (sink !== '' && typeof audio.setSinkId === 'function') {
          audio
            .setSinkId(sink)
            .then(route)
            .catch(function (error) {
              console.warn('[dsh-live-interpreter] setSinkId failed, using default output', error)
              route()
            })
        } else {
          route()
        }
      })
    }

    /** List speakers/headphones. Empty labels until the user granted access once. */
    async function listOutputs() {
      if (typeof navigator === 'undefined' || navigator.mediaDevices === undefined) return []
      try {
        var devices = await navigator.mediaDevices.enumerateDevices()
        return devices
          .filter(function (device) {
            return device.kind === 'audiooutput'
          })
          .map(function (device, index) {
            return { id: device.deviceId, label: device.label || '扬声器 ' + (index + 1) }
          })
      } catch (error) {
        console.warn('[dsh-live-interpreter] enumerateDevices(output) failed', error)
        return []
      }
    }

    // The panel and the settings section both flip this switch, so it lives in
    // one module-level store instead of two independent pieces of state.
    var voiceStore = {
      value: typeof window !== 'undefined' && window.__dshInterpreterMuted === false,
      listeners: [],
      get: function () {
        return voiceStore.value
      },
      set: function (next) {
        voiceStore.value = next === true
        if (typeof window !== 'undefined') window.__dshInterpreterMuted = !voiceStore.value
        if (!voiceStore.value && currentAudio !== null) {
          try {
            currentAudio.pause()
          } catch (ignored) {
            /* ignore */
          }
          currentAudio = null
        }
        if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel()
        for (var i = 0; i < voiceStore.listeners.length; i += 1) voiceStore.listeners[i](voiceStore.value)
      },
      subscribe: function (listener) {
        voiceStore.listeners.push(listener)
        return function () {
          var index = voiceStore.listeners.indexOf(listener)
          if (index >= 0) voiceStore.listeners.splice(index, 1)
        }
      },
    }

    // Read-aloud output level, pushed at ~11 Hz while audio plays. Kept out of
    // React state on purpose: the meter repaints far faster than the
    // transcript and must never re-render the message list.
    var outputLevelStore = {
      value: 0,
      listeners: [],
      get: function () {
        return outputLevelStore.value
      },
      subscribe: function (listener) {
        outputLevelStore.listeners.push(listener)
        return function () {
          var index = outputLevelStore.listeners.indexOf(listener)
          if (index >= 0) outputLevelStore.listeners.splice(index, 1)
        }
      },
    }

    function publishOutputLevel(value) {
      var next = Math.max(0, Math.min(1, Number(value) || 0))
      if (Math.abs(next - outputLevelStore.value) < 0.004 && next !== 0) return
      outputLevelStore.value = next
      for (var i = 0; i < outputLevelStore.listeners.length; i += 1) {
        outputLevelStore.listeners[i](next)
      }
    }

    // Selected read-aloud output device, shared by the panel and the settings
    // section the same way the mute switch is.
    var outputStore = {
      value: '',
      listeners: [],
      get: function () {
        return outputStore.value
      },
      set: function (next) {
        outputStore.value = String(next ?? '')
        for (var i = 0; i < outputStore.listeners.length; i += 1) outputStore.listeners[i](outputStore.value)
      },
      subscribe: function (listener) {
        outputStore.listeners.push(listener)
        return function () {
          var index = outputStore.listeners.indexOf(listener)
          if (index >= 0) outputStore.listeners.splice(index, 1)
        }
      },
    }

    // Chosen recognizer, shared the same way: the panel picks it before a
    // meeting starts and the settings section edits the same value.
    var engineStore = {
      value: 'bilingual-paraformer',
      listeners: [],
      get: function () {
        return engineStore.value
      },
      set: function (next) {
        var value = String(next ?? '')
        if (value === '') return
        engineStore.value = value
        for (var i = 0; i < engineStore.listeners.length; i += 1) engineStore.listeners[i](engineStore.value)
      },
      subscribe: function (listener) {
        engineStore.listeners.push(listener)
        return function () {
          var index = engineStore.listeners.indexOf(listener)
          if (index >= 0) engineStore.listeners.splice(index, 1)
        }
      },
    }

    // Which DSH model translates this meeting. Stored separately from the
    // profile default so one meeting can use a stronger model without changing
    // what every other DSH feature uses.
    var routeStore = {
      value: null,
      listeners: [],
      get: function () {
        return routeStore.value
      },
      set: function (next) {
        if (next === null || next === undefined) {
          routeStore.value = null
        } else {
          var provider = String(next.provider ?? '')
          var model = String(next.model ?? '')
          routeStore.value = provider === '' || model === '' ? null : { provider: provider, model: model }
        }
        for (var i = 0; i < routeStore.listeners.length; i += 1) routeStore.listeners[i](routeStore.value)
      },
      subscribe: function (listener) {
        routeStore.listeners.push(listener)
        return function () {
          var index = routeStore.listeners.indexOf(listener)
          if (index >= 0) routeStore.listeners.splice(index, 1)
        }
      },
    }

    // Let the DSH text model clean up the transcript as well as translate it.
    // Repair is a text problem: the audio pass cannot tell 权利 from 权力, but a
    // model reading the sentence can. Kept as a switch because it costs one
    // extra model call per paragraph.
    var repairStore = {
      value: true,
      listeners: [],
      get: function () {
        return repairStore.value
      },
      set: function (next) {
        repairStore.value = next === true
        for (var i = 0; i < repairStore.listeners.length; i += 1) repairStore.listeners[i](repairStore.value)
      },
      subscribe: function (listener) {
        repairStore.listeners.push(listener)
        return function () {
          var index = repairStore.listeners.indexOf(listener)
          if (index >= 0) repairStore.listeners.splice(index, 1)
        }
      },
    }

    // Where the audio comes from. An online meeting is heard through the
    // machine's own output, so "microphone only" cannot transcribe it at all;
    // "mix" is for a room that has both local speakers and remote ones.
    var sourceStore = {
      value: 'mic',
      listeners: [],
      get: function () {
        return sourceStore.value
      },
      set: function (next) {
        sourceStore.value = SOURCE_MODES.indexOf(next) >= 0 ? next : 'mic'
        for (var i = 0; i < sourceStore.listeners.length; i += 1) sourceStore.listeners[i](sourceStore.value)
      },
      subscribe: function (listener) {
        sourceStore.listeners.push(listener)
        return function () {
          var index = sourceStore.listeners.indexOf(listener)
          if (index >= 0) sourceStore.listeners.splice(index, 1)
        }
      },
    }

    /* --------------------------------------------------------------- glossary */

    // The stored form is [[source, target], ...]; the editor shows one pair per
    // line as "source = target" so a whole glossary can be pasted in.
    function glossaryToText(glossary) {
      if (!Array.isArray(glossary)) return ''
      return glossary
        .map(function (pair) {
          if (!Array.isArray(pair)) return ''
          return String(pair[0] ?? '') + ' = ' + String(pair[1] ?? '')
        })
        .filter(function (line) {
          return line !== ''
        })
        .join('\n')
    }

    function textToGlossary(text) {
      var out = []
      var lines = String(text ?? '').split('\n')
      for (var i = 0; i < lines.length; i += 1) {
        var line = lines[i].trim()
        if (line === '') continue
        var cut = line.indexOf('=')
        if (cut <= 0) continue
        var source = line.slice(0, cut).trim()
        var target = line.slice(cut + 1).trim()
        if (source === '') continue
        out.push([source, target])
      }
      return out
    }

    /* ------------------------------------------------------------- the panel */

    function Panel() {
      var [projects, setProjects] = useState([])
      var [project, setProject] = useState(null)
      var [rows, setRows] = useState([])
      var [session, setSession] = useState(null)
      var [error, setError] = useState('')
      var [busy, setBusy] = useState('')
      var [voiceOn, setVoiceOn] = useState(function () {
        return voiceStore.get()
      })
      var [exportsList, setExportsList] = useState([])
      var [showExport, setShowExport] = useState(false)
      var [showGlossary, setShowGlossary] = useState(false)
      var [glossaryText, setGlossaryText] = useState('')
      var [downloading, setDownloading] = useState('')
      var [downloadPct, setDownloadPct] = useState(0)
      var [meta, setMeta] = useState(null)
      // Microphone diagnostics. A silent transcript has three very different
      // causes — no permission, a suspended AudioContext, or the wrong input
      // device — and they are indistinguishable unless the panel says which.
      var [mic, setMic] = useState({ state: 'idle', rate: 0, error: '', device: '' })
      var [deviceId, setDeviceId] = useState('')
      var [devices, setDevices] = useState([])
      var [outputs, setOutputs] = useState([])
      var [outputId, setOutputId] = useState(function () {
        return outputStore.get()
      })
      var [engine, setEngine] = useState(function () {
        return engineStore.get()
      })
      var [route, setRoute] = useState(function () {
        return routeStore.get()
      })
      var [repair, setRepair] = useState(function () {
        return repairStore.get()
      })
      var [sourceMode, setSourceMode] = useState(function () {
        return sourceStore.get()
      })
      var [sentFrames, setSentFrames] = useState(0)
      var [capturedFrames, setCapturedFrames] = useState(0)
      var [droppedFrames, setDroppedFrames] = useState(0)
      var [probeLevel, setProbeLevel] = useState(-1)
      // Live input level, pushed by the host every ~120 ms. The full session
      // snapshot only arrives every two seconds, which made this meter look
      // frozen — and a frozen meter is indistinguishable from a dead
      // microphone, the exact thing it exists to rule out.
      var [liveLevel, setLiveLevel] = useState(0)
      var [outputLevelNow, setOutputLevelNow] = useState(0)
      var [testingVoice, setTestingVoice] = useState(false)
      // Devices, recognizer and the utility actions are set once before a
      // meeting, not while talking. Keeping them on the toolbar pushed the two
      // buttons that ARE used during a meeting off to the far left of a row of
      // nine controls, so they live in a drawer that opens on demand.
      var [showTools, setShowTools] = useState(false)

      var capture = useRef(null)
      var posting = useRef(0)
      var dropped = useRef(0)
      var sent = useRef(0)
      var captured = useRef(0)
      var rowMap = useRef({})
      var probe = useRef(null)

      useEffect(function () {
        return voiceStore.subscribe(setVoiceOn)
      }, [])

      useEffect(function () {
        return outputStore.subscribe(setOutputId)
      }, [])

      useEffect(function () {
        return engineStore.subscribe(setEngine)
      }, [])

      useEffect(function () {
        return routeStore.subscribe(setRoute)
      }, [])

      useEffect(function () {
        return repairStore.subscribe(setRepair)
      }, [])

      useEffect(function () {
        return sourceStore.subscribe(setSourceMode)
      }, [])

      useEffect(function () {
        return outputLevelStore.subscribe(setOutputLevelNow)
      }, [])

      useEffect(function () {
        void listMicrophones().then(setDevices)
        void listOutputs().then(setOutputs)
        api('/')
          .then(function (data) {
            setMeta(data)
          })
          .catch(function (err) {
            setError(String(err.message ?? err))
          })
        api('/projects')
          .then(function (data) {
            setProjects(data.projects ?? [])
          })
          .catch(function () {})
      }, [])

      var flushRows = useCallback(function () {
        var list = []
        var keys = Object.keys(rowMap.current)
        keys.sort(function (a, b) {
          return Number(a) - Number(b)
        })
        for (var i = 0; i < keys.length; i += 1) list.push(rowMap.current[keys[i]])
        setRows(list)
      }, [])

      var openProject = useCallback(
        function (id) {
          setError('')
          setBusy('open')
          api('/projects/' + encodeURIComponent(id))
            .then(function (data) {
              setProject(data.project)
              setSession(data.session ?? null)
              setExportsList(data.exports ?? [])
              var map = {}
              var turns = data.turns ?? []
              for (var i = 0; i < turns.length; i += 1) {
                var turn = turns[i]
                map[turn.seq] = {
                  seq: turn.seq,
                  startMs: turn.startMs,
                  endMs: turn.endMs,
                  lang: turn.lang,
                  source: turn.source,
                  liveStable: '',
                  liveVolatile: '',
                  translation: turn.translation,
                  sentences: Array.isArray(turn.sentences) ? turn.sentences : null,
                  aligned: Array.isArray(turn.aligned) ? turn.aligned : null,
                  // Row pairing is stored with the paragraph. Dropping it here
                  // would collapse every reopened meeting back into one cell per
                  // paragraph, losing the row alignment the live view had.
                  pairs: Array.isArray(turn.pairs) ? turn.pairs : null,
                  final: true,
                  finalizing: false,
                }
              }
              rowMap.current = map
              flushRows()
              setGlossaryText(glossaryToText(data.project?.glossary))
              if (typeof data.project?.engine === 'string' && data.project.engine !== '') {
                engineStore.set(data.project.engine)
              }
              // A reopened meeting keeps the model it was translated with; only a
              // project that never had one follows the profile default.
              if (data.project?.route !== null && data.project?.route !== undefined) {
                routeStore.set(data.project.route)
              }
              if (typeof data.project?.repair === 'boolean') repairStore.set(data.project.repair)
              // Reopening a meeting that listened to a call must not quietly go
              // back to the microphone: the transcript would then be of a room
              // that is no longer speaking.
              if (SOURCE_MODES.indexOf(data.project?.source) >= 0) sourceStore.set(data.project.source)
              setBusy('')
            })
            .catch(function (err) {
              setError(String(err.message ?? err))
              setBusy('')
            })
        },
        [flushRows],
      )

      var createProject = useCallback(
        function () {
          setError('')
          setBusy('create')
          api('/projects', { method: 'POST', body: JSON.stringify({}) })
            .then(function (data) {
              setProjects(function (list) {
                return [data.project].concat(list)
              })
              setBusy('')
              openProject(data.project.id)
            })
            .catch(function (err) {
              setError(String(err.message ?? err))
              setBusy('')
            })
        },
        [openProject],
      )

      // The event stream drives everything the recognizer produces.
      useEffect(
        function () {
          if (project === null) return undefined
          var stream = new EventSource(API + '/projects/' + encodeURIComponent(project.id) + '/events')
          stream.addEventListener('state', function (event) {
            try {
              setSession(JSON.parse(event.data))
            } catch (error) {
              /* ignore */
            }
          })
          // Fast lane for the input meter: level, counters and silence only, so
          // it can be pushed many times a second without the cost of
          // serializing a whole session snapshot.
          stream.addEventListener('level', function (event) {
            try {
              var data = JSON.parse(event.data)
              if (typeof data.level === 'number') setLiveLevel(data.level)
            } catch (error) {
              /* ignore */
            }
          })
          // Paragraph lifecycle. A row is one paragraph: it starts empty, grows
          // sentence by sentence in the left column, and only turns solid when
          // the speaker actually stops.
          stream.addEventListener('segment', function (event) {
            var data = JSON.parse(event.data)
            var existing = rowMap.current[data.seq]
            if (data.stage === 'open') {
              rowMap.current[data.seq] = Object.assign(
                {
                  seq: data.seq,
                  startMs: null,
                  endMs: null,
                  lang: data.lang,
                  source: '',
                  liveStable: '',
                  liveVolatile: '',
                  translation: '',
                  final: false,
                  finalizing: false,
                },
                existing ?? {},
                { lang: data.lang },
              )
            } else if (existing !== undefined) {
              var patch = { finalizing: data.stage === 'finalizing' }
              if (typeof data.source === 'string' && data.source !== '') patch.source = data.source
              if (typeof data.lang === 'string') patch.lang = data.lang
              if (typeof data.endMs === 'number') patch.endMs = data.endMs
              // The offline pass re-heard the whole paragraph, so its text
              // replaces everything the streaming tiers were showing. Leaving
              // the old partial text underneath would make the row look like it
              // contains the sentence twice.
              if (data.stage === 'refined') {
                patch.liveStable = ''
                patch.liveVolatile = ''
                patch.refined = true
              }
              // The DSH repair pass rewrites the transcript the same way. It
              // used to be broadcast as its own 'repaired' event, which nothing
              // on this side ever listened for, so a repaired paragraph stayed
              // on screen as the unrepaired text until the turn event landed.
              if (data.stage === 'repaired') {
                patch.liveStable = ''
                patch.liveVolatile = ''
                patch.repaired = true
              }
              rowMap.current[data.seq] = Object.assign({}, existing, patch)
            }
            flushRows()
          })
          // The sentence currently being spoken inside that paragraph.
          stream.addEventListener('asr', function (event) {
            var data = JSON.parse(event.data)
            var existing = rowMap.current[data.seq]
            if (existing === undefined) return
            rowMap.current[data.seq] = Object.assign({}, existing, {
              liveStable: data.stable,
              liveVolatile: data.volatile,
              lang: data.lang,
            })
            flushRows()
          })
          stream.addEventListener('translation', function (event) {
            var data = JSON.parse(event.data)
            var existing = rowMap.current[data.seq]
            if (existing === undefined) return
            rowMap.current[data.seq] = Object.assign({}, existing, { translation: data.text })
            flushRows()
          })
          stream.addEventListener('turn', function (event) {
            var data = JSON.parse(event.data)
            if (data.stage !== 'final') return
            rowMap.current[data.seq] = {
              seq: data.seq,
              startMs: data.startMs,
              endMs: data.endMs,
              lang: data.lang,
              source: data.source,
              liveStable: '',
              liveVolatile: '',
              translation: data.translation,
              sentences: Array.isArray(data.sentences) ? data.sentences : null,
              aligned: Array.isArray(data.aligned) ? data.aligned : null,
              // Rows of { source, target } computed by the host from the FINAL
              // text. The panel draws one grid row per pair, so the two
              // languages cannot drift apart regardless of their length.
              pairs: Array.isArray(data.pairs) ? data.pairs : null,
              final: true,
              finalizing: false,
            }
            flushRows()
          })
          // Read-aloud is queued by the host once a paragraph is written; the
          // browser owns the output device because only <audio> can be routed.
          // No local mute gate here: playParagraph already re-reads the store on
          // every chunk, so consulting a ref would only add a stale value that
          // can drop the first paragraph after the switch is flipped on.
          stream.addEventListener('speak', function (event) {
            var data = JSON.parse(event.data)
            void playParagraph(data.text, data.lang, data.voice)
          })
          stream.addEventListener('error', function (event) {
            if (event.data === undefined) return
            try {
              setError(JSON.parse(event.data).message ?? '')
            } catch (error) {
              /* ignore */
            }
          })
          stream.onerror = function () {
            // EventSource reconnects by itself; nothing to do.
          }
          return function () {
            stream.close()
          }
        },
        [project, flushRows],
      )

      var postFrame = useCallback(
        function (projectId, buffer) {
          // Count what the microphone actually produced, separately from what
          // was uploaded: "captured 0" means no audio callbacks at all (a
          // suspended context or a dead device), while "captured N, sent 0"
          // means the upload path is the problem.
          captured.current += 1
          setCapturedFrames(captured.current)
          if (posting.current > 4) {
            dropped.current += 1
            setDroppedFrames(dropped.current)
            return
          }
          posting.current += 1
          fetch(API + '/projects/' + encodeURIComponent(projectId) + '/audio', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: buffer,
          })
            .catch(function () {})
            .then(function () {
              posting.current -= 1
              sent.current += 1
              setSentFrames(sent.current)
            })
        },
        [],
      )

      var startRecording = useCallback(
        function () {
          if (project === null) return
          setError('')
          setBusy('start')
          sent.current = 0
          setSentFrames(0)
          captured.current = 0
          setCapturedFrames(0)
          dropped.current = 0
          setDroppedFrames(0)
          // Open the audio context inside the click handler; the request below
          // awaits a recognizer load, and a context created after that await
          // has lost the user gesture and may come up suspended.
          var next = createCapture()
          capture.current = next
          next.warm()
          api('/projects/' + encodeURIComponent(project.id) + '/start', {
            method: 'POST',
            body: JSON.stringify({
              engine: engineStore.get(),
              voice: 'tts-zh-en',
              route: routeStore.get(),
              repair: repairStore.get(),
              source: sourceStore.get(),
            }),
          })
            .then(function (data) {
              setSession(data.session)
              return next.start(
                function (frame) {
                  postFrame(project.id, frame)
                },
                function (status) {
                  setMic(status)
                },
                { deviceId: deviceId, source: sourceStore.get() },
              )
            })
            .then(function () {
              setBusy('')
            })
            .catch(function (err) {
              /* The host session is already recording by now, so a denied
                 microphone would otherwise leave a session that records
                 silence forever. Tear it back down before reporting. */
              var current = capture.current
              capture.current = null
              if (current !== null) void current.stop()
              api('/projects/' + encodeURIComponent(project.id) + '/stop', { method: 'POST', body: '{}' })
                .then(function (data) {
                  setSession(data.session)
                })
                .catch(function () {})
              setError('无法开始收音：' + String(err.message ?? err))
              setBusy('')
            })
        },
        [project, postFrame, deviceId],
      )

      var stopRecording = useCallback(
        function () {
          if (project === null) return
          setBusy('stop')
          var current = capture.current
          capture.current = null
          Promise.resolve(current === null ? undefined : current.stop())
            .then(function () {
              return api('/projects/' + encodeURIComponent(project.id) + '/stop', { method: 'POST' })
            })
            .then(function (data) {
              setSession(data.session)
              setBusy('')
              return api('/projects/' + encodeURIComponent(project.id) + '/exports').then(function (list) {
                setExportsList(list.exports ?? [])
              })
            })
            .catch(function (err) {
              setError(String(err.message ?? err))
              setBusy('')
            })
        },
        [project],
      )

      // Release the microphone when the panel unmounts (panel switch or reload).
      useEffect(function () {
        return function () {
          var current = capture.current
          capture.current = null
          if (current !== null) void current.stop()
        }
      }, [])

      var doExport = useCallback(
        function (kind) {
          if (project === null) return
          setBusy('export:' + kind)
          api('/projects/' + encodeURIComponent(project.id) + '/export', {
            method: 'POST',
            body: JSON.stringify({ kind: kind }),
          })
            .then(function (data) {
              setShowExport(false)
              setBusy('')
              saveExport(project.id, data.filename)
              return api('/projects/' + encodeURIComponent(project.id) + '/exports').then(function (list) {
                setExportsList(list.exports ?? [])
              })
            })
            .catch(function (err) {
              setError(String(err.message ?? err))
              setBusy('')
            })
        },
        [project],
      )

      var removeProject = useCallback(
        function (id) {
          api('/projects/' + encodeURIComponent(id), { method: 'DELETE' })
            .then(function () {
              setProjects(function (list) {
                return list.filter(function (item) {
                  return item.id !== id
                })
              })
              if (project !== null && project.id === id) {
                setProject(null)
                setSession(null)
                rowMap.current = {}
                flushRows()
              }
            })
            .catch(function (err) {
              setError(String(err.message ?? err))
            })
        },
        [project, flushRows],
      )

      var saveGlossary = useCallback(
        function () {
          if (project === null) return
          setBusy('glossary')
          api('/projects/' + encodeURIComponent(project.id) + '/glossary', {
            method: 'POST',
            body: JSON.stringify({ glossary: textToGlossary(glossaryText) }),
          })
            .then(function (data) {
              setProject(data.project)
              setShowGlossary(false)
              setBusy('')
            })
            .catch(function (err) {
              setError(String(err.message ?? err))
              setBusy('')
            })
        },
        [project, glossaryText],
      )

      // The panel is the first screen a new user sees, so it must be able to
      // fetch the recognizer itself instead of sending them to settings.
      var downloadModel = useCallback(function (id, kind) {
        var type = kind === 'tts' ? 'tts' : kind === 'refine' ? 'refine' : kind === 'vad' ? 'vad' : 'asr'
        setDownloading(id)
        setDownloadPct(0)
        api('/models/' + type + '/' + encodeURIComponent(id) + '/download', { method: 'POST', body: '{}' })
          .catch(function (err) {
            setError(String(err.message ?? err))
            setDownloading('')
          })
          .then(function () {
            var timer = setInterval(function () {
              api('/models')
                .then(function (next) {
                  var list =
                    type === 'tts'
                      ? next.tts ?? []
                      : type === 'refine'
                        ? next.refine ?? []
                        : type === 'vad'
                          ? next.vad ?? []
                          : next.asr ?? next.models ?? []
                  setMeta(function (prev) {
                    if (prev === null) return prev
                    if (type === 'tts') return Object.assign({}, prev, { voices: next.tts })
                    if (type === 'vad') return Object.assign({}, prev, { vad: next.vad })
                    if (type === 'refine') {
                      return Object.assign({}, prev, {
                        refine: next.refine,
                        refineState: (next.refine ?? []).find(function (model) {
                          return model.id === 'sense-voice-zh-en'
                        }) ?? prev.refineState,
                      })
                    }
                    return Object.assign({}, prev, { models: next.asr, recognizers: next.asr })
                  })
                  var item = list.find(function (model) {
                    return model.id === id
                  })
                  if (item === undefined) return
                  var pct = item.totalBytes === 0 ? 0 : Math.floor((item.bytes / item.totalBytes) * 100)
                  setDownloadPct(pct)
                  if (item.ready) {
                    clearInterval(timer)
                    setDownloading('')
                  }
                })
                .catch(function () {
                  clearInterval(timer)
                  setDownloading('')
                })
            }, 2000)
          })
      }, [])

      var downloadPercent = function () {
        return String(Math.max(0, Math.min(100, downloadPct)))
      }

      // A level check the user can run *before* starting: if this meter never
      // moves, the problem is the microphone (permission, device, mute) and not
      // recognition — which is otherwise impossible to tell from an empty pane.
      var stopProbe = useCallback(function () {
        var current = probe.current
        probe.current = null
        if (current !== null) void current.stop()
        setProbeLevel(-1)
        setMic({ state: 'idle', rate: 0, error: '', device: '' })
      }, [])

      var startProbe = useCallback(
        function () {
          stopProbe()
          var next = createCapture()
          probe.current = next
          // Same gesture rule as startRecording: the context has to exist
          // before the first await or it may start suspended and never call back.
          next.warm()
          next
            .start(
              function (frame) {
                if (probe.current !== next) return
                var samples = new Float32Array(frame.byteLength / 2)
                var view = new DataView(frame)
                for (var i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true) / 32768
                var sum = 0
                for (var j = 0; j < samples.length; j += 1) sum += samples[j] * samples[j]
                var rms = Math.sqrt(sum / samples.length)
                setProbeLevel(rms)
              },
              function (status) {
                setMic(status)
                if (status.state === 'live') {
                  void listMicrophones().then(setDevices)
                }
              },
              { deviceId: deviceId, source: sourceStore.get() },
            )
            .catch(function (err) {
              // "Test the microphone" has to test whatever source is actually
              // going to be captured, or a user on system audio would press it,
              // see a dead meter, and conclude the feature is broken.
              setError((sourceStore.get() === 'mic' ? '麦克风不可用：' : '声音来源不可用：') + String(err.message ?? err))
              probe.current = null
            })
          setTimeout(function () {
            if (probe.current === next) stopProbe()
          }, 8000)
        },
        [deviceId, stopProbe],
      )

      // Play one line through the selected output device on demand. Read-aloud
      // normally fires only when a paragraph closes, so a broken route would be
      // invisible for minutes; this makes it a two-second check, and the output
      // meter next to it confirms the samples actually left the app.
      var testVoice = useCallback(
        function () {
          if (testingVoice) return
          setTestingVoice(true)
          var line = '这是一句测试朗读，用来确认朗读输出设备是否正常。'
          api('/say', {
            method: 'POST',
            body: JSON.stringify({ text: line, voice: 'tts-zh-en', speed: 1 }),
          })
            .then(function (data) {
              return playAudioFile(data.filename)
            })
            .catch(function (err) {
              setError('试听朗读失败：' + String(err.message ?? err))
            })
            .then(function () {
              setTestingVoice(false)
            })
        },
        [testingVoice],
      )

      useEffect(function () {
        return function () {
          if (probe.current !== null) void probe.current.stop()
          probe.current = null
        }
      }, [])

      var recording = session !== null && session.status === 'recording'
      var modelReady = false
      if (meta !== null && Array.isArray(meta.models)) {
        for (var i = 0; i < meta.models.length; i += 1) {
          if (meta.models[i].id === engine && meta.models[i].ready) modelReady = true
        }
      }
      var voiceReady = meta !== null && meta.voice !== undefined && meta.voice.ready === true
      // Refinement is an upgrade, not a prerequisite: when its model is absent
      // the panel simply offers it as an optional download and the transcript
      // still comes from the streaming recognizer.
      var refineReady = meta !== null && meta.refineState !== undefined && meta.refineState.ready === true
      var translateReady = meta !== null && meta.translate !== undefined && meta.translate.ready === true

      // Flatten the provider/model catalogue into one list: the header offers a
      // single choice, and two dropdowns for one decision would be needless
      // friction in a panel that is used while talking.
      var modelChoices = []
      var modelValue = ''
      var fallbackProvider = meta !== null && meta.translate !== undefined ? String(meta.translate.provider ?? '') : ''
      var fallbackModel = meta !== null && meta.translate !== undefined ? String(meta.translate.model ?? '') : ''
      if (meta !== null && Array.isArray(meta.providers)) {
        for (var pi = 0; pi < meta.providers.length; pi += 1) {
          var entry = meta.providers[pi]
          var models = Array.isArray(entry.models) ? entry.models : []
          for (var mi = 0; mi < models.length; mi += 1) {
            var id = String(entry.id) + '/' + String(models[mi].id)
            modelChoices.push({
              value: id,
              provider: String(entry.id),
              model: String(models[mi].id),
              label: String(models[mi].name ?? models[mi].id),
              group: String(entry.name ?? entry.id),
            })
          }
        }
      }
      if (route !== null && route !== undefined) modelValue = String(route.provider) + '/' + String(route.model)
      else if (fallbackProvider !== '' && fallbackModel !== '') modelValue = fallbackProvider + '/' + fallbackModel

      var lastRow = rows.length > 0 ? rows[rows.length - 1] : null
      var volatileText = lastRow !== null && lastRow.final !== true ? lastRow.liveVolatile ?? '' : ''

      // One line that answers "why is nothing happening": no frames sent at all
      // is a microphone problem, frames sent but never voiced is a muted or
      // wrong device, and frames voiced but no text is a recognizer problem.
      var micLine = null
      if (mic.error !== '') {
        micLine = h(
          'div',
          {
            style: {
              margin: '10px 20px 0',
              padding: '9px 12px',
              fontSize: '12px',
              lineHeight: '1.6',
              borderRadius: T.radiusSm,
              color: T.warn,
              background: 'color-mix(in srgb, ' + T.warn + ' 10%, transparent)',
              border: '1px solid color-mix(in srgb, ' + T.warn + ' 26%, transparent)',
            },
          },
          sourceLabel(sourceMode) + '：' + mic.error,
        )
      } else if (recording) {
        var hostFrames = session !== null && typeof session.frames === 'number' ? session.frames : 0
        var hostVoiced = session !== null && typeof session.voicedFrames === 'number' ? session.voicedFrames : 0
        var parts = []
        parts.push('采到 ' + capturedFrames + ' 帧')
        parts.push('已送 ' + sentFrames + ' 帧')
        parts.push('宿主收到 ' + hostFrames + ' 帧')
        if (hostFrames > 0) parts.push('有声 ' + hostVoiced + ' 帧')
        if (droppedFrames > 0) parts.push('丢弃 ' + droppedFrames + ' 帧')
        if (mic.device !== '') parts.push(mic.device)
        var warn = ''
        // The diagnostic line must name the source the user actually chose:
        // telling someone on system audio to "check the microphone" sends them
        // to the wrong settings page.
        var sourceName = sourceLabel(sourceMode)
        if (capturedFrames === 0) {
          warn = sourceName + '没有采到任何音频（音频处理没跑起来），请点下面的「测试麦克风」'
        } else if (hostFrames > 0 && hostVoiced === 0) {
          warn = sourceMode === 'system'
            ? '音频全是静音，请确认电脑正在播放声音，且「输入设备」选的是立体声混音 / 虚拟声卡的录音端'
            : sourceMode === 'mix'
              ? '音频全是静音，请确认电脑正在播放，且麦克风没被系统静音'
              : '音频全是静音，请检查麦克风是否被静音或选错了输入设备'
        } else if (hostVoiced > 0 && rows.length === 0) {
          // Audio reaches the recognizer but no utterance has closed yet: the
          // usual causes are speaking too softly or pausing too rarely, which
          // otherwise looks exactly like a broken engine.
          warn = '已经收到你的声音，但还没凑成一段：正常音量连续说几句，句末停一下'
        }
        micLine = h(
          'div',
          {
            style: {
              margin: '10px 20px 0',
              fontSize: '11px',
              lineHeight: '1.65',
              color: T.dim,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              flexWrap: 'wrap',
            },
          },
          h('span', {
            className: 'dli-dot',
            style: { background: hostVoiced > 0 ? T.success : T.idle },
          }),
          parts.join(' · '),
          warn === ''
            ? null
            : h('span', { style: { color: T.warn, fontWeight: 500 } }, '· ' + warn),
        )
      }

      // Two meters, one row: the microphone the recognizer is actually reading
      // and the speaker read-aloud is writing to. Both are real measurements —
      // the input level is the RMS the host computes per frame (pushed ~8×/s),
      // the output level comes from an AnalyserNode on the playing element — so
      // this row doubles as a "is my device wired to this app" check.
      var hostLevel = session !== null && typeof session.level === 'number' ? session.level : 0
      var inputLevel = recording ? (liveLevel > 0 ? liveLevel : hostLevel) : probeLevel >= 0 ? probeLevel : -1
      var outputLevel = outputLevelNow
      var showMeters = inputLevel >= 0 || outputLevel > 0 || recording
      var meterBar = function (label, value, live) {
        // The bar is on a square-root curve: speech RMS clusters near 0.02-0.15,
        // and a linear bar would sit in the first few pixels the whole time,
        // which looks like "almost nothing is coming in".
        var pct = Math.max(0, Math.min(100, Math.round(Math.sqrt(value) * 140)))
        return h(
          'div',
          { className: 'dli-meter' },
          h('span', { className: 'dli-meter-label' }, label),
          h(
            'span',
            { className: 'dli-meter-track', role: 'presentation' },
            h('span', {
              className: 'dli-meter-fill',
              style: {
                width: pct + '%',
                background: live ? T.success : T.idle,
                // Short transition: long enough to hide per-frame jitter, short
                // enough that the bar visibly tracks the voice.
                transition: 'width 90ms linear, background 160ms ease',
              },
            }),
          ),
          h(
            'span',
            { className: 'dli-meter-state', style: { color: live ? T.success : T.dim } },
            live ? '有声' : '静音',
          ),
        )
      }
      var inputMeterLabel =
        recording && sourceMode === 'system'
          ? '系统声音'
          : recording && sourceMode === 'mix'
            ? '输入'
            : recording
              ? '麦克风'
              : '麦克风'
      var probeLine = showMeters
        ? h(
            'div',
            { className: 'dli-meters' },
            inputLevel < 0 ? null : meterBar(inputMeterLabel, inputLevel, inputLevel > 0.008),
            outputLevel <= 0 && !voiceOn ? null : meterBar('输出', outputLevel, outputLevel > 0.008),
          )
        : null

      return h(
        'div',
        { style: styles.shell, className: 'dli-root', 'data-dsh-live-interpreter': 'root', 'data-live': recording ? '1' : '0' },
        h(
          'div',
          { style: styles.rail, className: 'dli-rail' },
          h(
            'div',
            { className: 'dli-rail-head' },
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 auto' } },
              h('strong', { className: 'dli-rail-title' }, '同声传译'),
              h('span', { className: 'dli-rail-sub' }, projects.length + ' 个会议记录'),
            ),
            h(
              'button',
              {
                className: 'dli-icon-accent',
                onClick: createProject,
                disabled: busy === 'create',
                title: '新建同传',
                'aria-label': '新建同传',
              },
              '＋',
            ),
          ),
          projects.length === 0
            ? null
            : h('div', { className: 'dli-section-label' }, '会议记录'),
          h(
            'div',
            { style: styles.railList, className: 'dli-scroll' },
            projects.length === 0
              ? h(
                  'div',
                  { style: { padding: '18px 10px', fontSize: '12px', lineHeight: '1.75', color: T.dim, textAlign: 'center' } },
                  '还没有会议记录',
                )
              : projects.map(function (item) {
                  var active = project !== null && project.id === item.id
                  return h(
                    'div',
                    { key: item.id, className: 'dli-item-wrap', style: { position: 'relative' } },
                    h(
                      'button',
                      {
                        className: 'dli-item',
                        'data-active': active ? '1' : '0',
                        'aria-current': active ? 'true' : undefined,
                        onClick: function () {
                          openProject(item.id)
                        },
                      },
                      h('span', { className: 'dli-item-title' }, item.title),
                      h(
                        'span',
                        { className: 'dli-item-meta' },
                        shortDate(item.createdAt) + ' · ' + (item.turns ?? 0) + ' 段',
                      ),
                    ),
                    h(
                      'button',
                      {
                        title: '删除这条记录',
                        'aria-label': '删除这条记录',
                        className: 'dli-item-del',
                        onClick: function (event) {
                          event.stopPropagation()
                          removeProject(item.id)
                        },
                      },
                      h(
                        'svg',
                        { width: 11, height: 11, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
                        h('path', {
                          d: 'M6 6l12 12M18 6L6 18',
                          stroke: 'currentColor',
                          strokeWidth: 2.2,
                          strokeLinecap: 'round',
                        }),
                      ),
                    ),
                  )
                }),
          ),
          // Engine state read from the model catalogue, not from a live session.
          // A session's own flag only exists while it runs, and the recognizer
          // is legitimately null between sentences — showing that as "not ready"
          // is what made the panel look broken mid-meeting.
          h(
            'div',
            {
              style: {
                padding: '9px 14px',
                fontSize: '11px',
                color: T.dim,
                borderTop: '1px solid ' + T.border,
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              },
            },
            h('span', {
              className: 'dli-dot',
              style: { background: modelReady ? T.success : T.warn },
            }),
            modelReady ? '识别引擎 ' + engine : '识别模型未下载',
          ),
        ),
        h(
          'div',
          { style: styles.main, className: 'dli-main' },
          h(
            'div',
            { className: 'dli-topbar' },
            h('span', { className: 'dli-topbar-title' }, project === null ? '同声传译' : project.title),
            h(
              'span',
              { className: 'dli-cluster' },
              h(
                'span',
                { className: recording ? 'dli-pill dli-pill-live' : 'dli-pill' },
                recording ? h('span', { className: 'dli-dot' }) : null,
                recording ? '收音中' : session?.status === 'paused' ? '已暂停' : session?.status === 'done' ? '已结束' : '待开始',
              ),
              h(
                'span',
                { className: 'dli-pill', style: { fontVariantNumeric: 'tabular-nums' } },
                session !== null && session.elapsed > 0 ? clockText(session.elapsed) : '00:00:00',
              ),
            ),
            h(
              'span',
              { className: 'dli-cluster' },
              h(
                'span',
                { className: 'dli-pill', title: translateReady ? '译文由 DSH 模型生成' : '没有可用的对话模型' },
                h('span', {
                  className: 'dli-dot',
                  style: { background: translateReady ? T.success : T.warn },
                }),
                '翻译',
              ),
              modelChoices.length === 0
                ? null
                : h(
                    'select',
                    {
                      ...selectStyle(),
                      value: modelValue,
                      // Switching mid-meeting would change the wording style in the
                      // middle of a document, so the choice is locked while
                      // recording and reopening the project restores it.
                      disabled: recording,
                      title: recording ? '同传进行中不能换翻译模型' : '选择这段会议使用的翻译模型',
                      'aria-label': '翻译模型',
                      onChange: function (event) {
                        var value = String(event.target.value ?? '')
                        var picked = null
                        for (var ci = 0; ci < modelChoices.length; ci += 1) {
                          if (modelChoices[ci].value === value) picked = modelChoices[ci]
                        }
                        if (picked === null) return
                        var next = { provider: picked.provider, model: picked.model }
                        routeStore.set(next)
                        if (project !== null) {
                          api('/projects/' + encodeURIComponent(project.id), {
                            method: 'PATCH',
                            body: JSON.stringify({ route: next }),
                          }).catch(function (err) {
                            setError(String(err.message ?? err))
                          })
                        }
                      },
                    },
                    modelChoices.map(function (item) {
                      return h('option', { key: item.value, value: item.value }, item.label)
                    }),
                  ),
            ),
            h(
              'button',
              {
                ...ghostBtn(),
                onClick: function () {
                  // Turning the switch on with no voice installed would stay
                  // silent for the whole meeting with nothing on screen to
                  // explain it, so the switch refuses and says why.
                  if (!voiceOn && !voiceReady) {
                    setError('朗读音色还没下载，所以现在开不了朗读。先点下面的「下载约 60MB」把它装上。')
                    return
                  }
                  voiceStore.set(!voiceOn)
                },
                title: voiceOn ? '关闭译文朗读' : '开启译文朗读',
                'aria-pressed': voiceOn ? 'true' : 'false',
              },
              voiceOn ? '🔊 朗读' : '🔇 静音',
            ),
          ),
          error !== ''
            ? h('div', { className: 'dli-error', role: 'alert' }, error)
            : null,
          micLine,
          probeLine,
          // Two-line empty state: what to do, then what will happen once you do.
          // A single paragraph of grey text reads as an error message.
          project === null
            ? h(
                'div',
                { style: { flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
                h(
                  'div',
                  { className: 'dli-empty' },
                  h(
                    'div',
                    { className: 'dli-empty-mark', 'aria-hidden': 'true' },
                    h(
                      'svg',
                      { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' },
                      h('path', { d: 'M10 4v12M4 10h12' }),
                    ),
                  ),
                  h('div', { className: 'dli-empty-title' }, '还没有打开同传项目'),
                  h('div', { className: 'dli-empty-body' }, '点左上角的 ＋ 新建一个，或从左侧历史里选一个。'),
                  h(
                    'div',
                    { className: 'dli-empty-steps' },
                    h(
                      'div',
                      { className: 'dli-empty-step' },
                      h('span', { className: 'dli-step-no' }, '1'),
                      h('span', null, '新建会议，确认麦克风电平条会随你说话上下动。'),
                    ),
                    h(
                      'div',
                      { className: 'dli-empty-step' },
                      h('span', { className: 'dli-step-no' }, '2'),
                      h('span', null, '点「开始同传」，左边原文逐字稳定，右边译文随段落重新组织。'),
                    ),
                    h(
                      'div',
                      { className: 'dli-empty-step' },
                      h('span', { className: 'dli-step-no' }, '3'),
                      h('span', null, '一段话讲完停顿约 1.8 秒，整段整理成书面语可直接导出。'),
                    ),
                  ),
                ),
              )
            : h(
                'div',
                { style: styles.grid },
                // Column heads sit on the same grid as the body, so the divider
                // under "原文 / 译文" is literally the same line the rows use.
                h(
                  'div',
                  { className: 'dli-gridhead' },
                  h(
                    'div',
                    { className: 'dli-colhead' },
                    h('span', { className: 'dli-colhead-label' }, '原文'),
                    h('span', { style: { flex: '1 1 auto' } }),
                    h('span', { className: 'dli-colhead-count' }, rows.length + ' 段'),
                  ),
                  h('div', { className: 'dli-vrule' }),
                  h(
                    'div',
                    { className: 'dli-colhead' },
                    h('span', { className: 'dli-colhead-label' }, '译文'),
                    h('span', { style: { flex: '1 1 auto' } }),
                    row0Finalizing(rows)
                      ? h('span', { className: 'dli-colhead-count', style: { color: T.brand } }, '整理中…')
                      : null,
                  ),
                ),
                h(
                  'div',
                  {
                    style: styles.gridBody,
                    className: 'dli-scroll dli-grid',
                    role: 'log',
                    'aria-live': 'polite',
                    'aria-relevant': 'additions text',
                    ref: function (node) {
                      if (node !== null) node.scrollTop = node.scrollHeight
                    },
                  },
                  rows.length === 0
                    ? h('div', { style: { color: T.dim, fontSize: '13px', paddingTop: '4px', gridColumn: '1 / -1' } }, '等待说话…')
                    : gridRows(rows),
                ),
              ),
          project === null
            ? null
            : h(
                'div',
                { className: 'dli-toolbar', role: 'toolbar', 'aria-label': '同传操作' },
                recording
                  ? h('button', { ...btn(), onClick: stopRecording, disabled: busy !== '' }, '结束录音')
                  : h(
                      'button',
                      { ...primaryBtn(), onClick: startRecording, disabled: busy !== '' || !modelReady },
                      busy === 'start' ? '准备中…' : '开始同传',
                    ),
                recording
                  ? h(
                      'button',
                      {
                        ...btn(),
                        onClick: function () {
                          api('/projects/' + encodeURIComponent(project.id) + '/pause', { method: 'POST' }).then(function (data) {
                            setSession(data.session)
                          })
                        },
                      },
                      '暂停',
                    )
                  : null,
                session?.status === 'paused'
                  ? h(
                      'button',
                      {
                        ...btn(),
                        onClick: function () {
                          api('/projects/' + encodeURIComponent(project.id) + '/resume', { method: 'POST' }).then(function (data) {
                            setSession(data.session)
                          })
                        },
                      },
                      '继续',
                    )
                  : null,
                h(
                  'button',
                  {
                    ...btn(),
                    onClick: function () {
                      setGlossaryText(glossaryToText(project?.glossary))
                      setShowGlossary(true)
                    },
                  },
                  '术语',
                ),
                h(
                  'button',
                  { ...btn(), onClick: function () { setShowExport(true) }, disabled: recording },
                  '导出',
                ),
                // Everything below the fold is set up once, before talking. It
                // stays one click away instead of occupying the row that the
                // start/stop button has to compete with.
                h(
                  'button',
                  {
                    ...ghostBtn(),
                    onClick: function () { setShowTools(!showTools) },
                    'aria-expanded': showTools ? 'true' : 'false',
                    title: '设备、识别模型与测试',
                  },
                  showTools ? '设置 ▴' : '设置 ▾',
                ),
                h('span', { className: 'dli-toolbar-spacer' }),
                h(
                  'span',
                  { className: 'dli-toolbar-note' },
                  h('span', {
                    className: 'dli-dot',
                    style: { background: volatileText === '' ? T.success : T.brand },
                  }),
                  rows.length + ' 段 · ' + (volatileText === '' ? '已稳定' : '正在修正'),
                ),
              ),
          project === null || !showTools
            ? null
            : h(
                'div',
                { className: 'dli-drawer', role: 'group', 'aria-label': '设置' },
                meta !== null && Array.isArray(meta.models) && meta.models.length > 0
                  ? h(
                      'div',
                      { className: 'dli-drawer-field' },
                      h('label', { className: 'dli-drawer-label', for: 'dli-engine' }, '识别模型'),
                      h(
                        'select',
                        {
                          id: 'dli-engine',
                          value: engine,
                          onChange: function (event) {
                            engineStore.set(event.target.value)
                          },
                          disabled: recording,
                          ...selectStyle(),
                        },
                        // A laptop microphone in a real meeting is noisy and no
                        // single model wins every room, so the recognised price
                        // of each one is spelled out in the option text.
                        meta.models.map(function (item) {
                          return h(
                            'option',
                            { key: item.id, value: item.id },
                            item.name + (item.ready ? '' : '（未下载）'),
                          )
                        }),
                      ),
                      h('span', { className: 'dli-drawer-hint' }, recording ? '同传进行中不能更换识别模型。' : '越准确越慢，会议开始前选好。'),
                    )
                  : null,
                h(
                  'div',
                  { className: 'dli-drawer-field' },
                  h('label', { className: 'dli-drawer-label', for: 'dli-source' }, '声音来源'),
                  h(
                    'select',
                    {
                      id: 'dli-source',
                      value: sourceMode,
                      onChange: function (event) {
                        sourceStore.set(event.target.value)
                      },
                      disabled: recording,
                      ...selectStyle(),
                    },
                    SOURCE_MODES.map(function (mode) {
                      return h('option', { key: mode, value: mode }, sourceLabel(mode))
                    }),
                  ),
                  h(
                    'span',
                    { className: 'dli-drawer-hint' },
                    recording
                      ? '同传进行中不能更换声音来源。'
                      : sourceMode === 'system'
                        ? '听电脑自己播的声音（线上会议）：用「立体声混音」或虚拟声卡的录音端，下面选设备。'
                        : sourceMode === 'mix'
                          ? '两路一起听。外放时会把自己说的话重复收进来，建议戴耳机。'
                          : '只听你这台电脑的麦克风。线上会议请改选「系统声音」。',
                  ),
                ),
                devices.length > 0
                  ? h(
                      'div',
                      { className: 'dli-drawer-field' },
                      h('label', { className: 'dli-drawer-label', for: 'dli-input' }, '输入设备'),
                      h(
                        'select',
                        {
                          id: 'dli-input',
                          value: deviceId,
                          onChange: function (event) {
                            setDeviceId(event.target.value)
                          },
                          ...selectStyle(),
                        },
                        h('option', { value: '' }, sourceMode === 'system' ? '自动找立体声混音 / 虚拟声卡' : '默认麦克风'),
                        devices.map(function (item) {
                          return h(
                            'option',
                            { key: item.id, value: item.id },
                            // Marking the loopback candidates is the only way a
                            // user can tell "立体声混音" from a real microphone
                            // in a list of near-identical names.
                            (item.loopback ? '🔁 ' : '') + item.label,
                          )
                        }),
                      ),
                      sourceMode === 'system' && devices.filter(function (item) { return item.loopback }).length === 0
                        ? h(
                            'span',
                            { className: 'dli-drawer-hint' },
                            '没检测到立体声混音 / 虚拟声卡。到 Windows「声音设置 → 录制」里右键显示已禁用设备并启用「立体声混音」，或装一个虚拟声卡；也可以改用「麦克风」并把会议声音外放。',
                          )
                        : null,
                    )
                  : null,
                // Browsers expose a routable output list only after a device
                // permission was granted, so this can legitimately be empty on
                // the first visit.
                outputs.length > 0
                  ? h(
                      'div',
                      { className: 'dli-drawer-field' },
                      h('label', { className: 'dli-drawer-label', for: 'dli-output' }, '朗读输出'),
                      h(
                        'select',
                        {
                          id: 'dli-output',
                          value: outputId,
                          onChange: function (event) {
                            outputStore.set(event.target.value)
                          },
                          ...selectStyle(),
                        },
                        h('option', { value: '' }, '默认扬声器'),
                        outputs.map(function (item) {
                          return h('option', { key: item.id, value: item.id }, item.label)
                        }),
                      ),
                    )
                  : null,
                h(
                  'div',
                  { className: 'dli-drawer-field' },
                  h('span', { className: 'dli-drawer-label' }, '自检'),
                  h(
                    'div',
                    { style: { display: 'flex', gap: '7px', flexWrap: 'wrap' } },
                    h(
                      'button',
                      { ...btn({ padding: '5px 10px', fontSize: '12px' }), onClick: startProbe, title: '只测麦克风电平，不开识别' },
                      '测试麦克风',
                    ),
                    // Read-aloud normally fires only when a paragraph closes, so
                    // a broken route would be invisible for minutes; this makes
                    // it a two-second check.
                    voiceReady
                      ? h(
                          'button',
                          {
                            ...btn({ padding: '5px 10px', fontSize: '12px' }),
                            onClick: function () { void testVoice() },
                            title: '按当前输出设备试播一句',
                            disabled: testingVoice,
                          },
                          testingVoice ? '试听中…' : '试听朗读',
                        )
                      : null,
                  ),
                  h('span', { className: 'dli-drawer-hint' }, '说话时看上方两条电平：不动就是设备没接上。'),
                ),
                !modelReady || !voiceReady || !refineReady
                  ? h(
                      'div',
                      { className: 'dli-drawer-field', style: { gridColumn: '1 / -1' } },
                      h('span', { className: 'dli-drawer-label' }, '需要的模型'),
                      h(
                        'div',
                        { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center' } },
                        !modelReady
                          ? h(
                              'span',
                              { className: 'dli-note', style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                              '识别模型未下载',
                              h(
                                'button',
                                {
                                  ...btn({ padding: '3px 9px', fontSize: '11px' }),
                                  onClick: function () { downloadModel(engine) },
                                  disabled: downloading !== '',
                                },
                                downloading === '' ? '下载' : downloadPercent() + '%',
                              ),
                            )
                          : null,
                        !voiceReady
                          ? h(
                              'span',
                              { className: 'dli-note', style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                              '朗读音色未下载',
                              h(
                                'button',
                                {
                                  ...btn({ padding: '3px 9px', fontSize: '11px' }),
                                  onClick: function () { downloadModel('tts-zh-en', 'tts') },
                                  disabled: downloading !== '',
                                },
                                downloading === '' ? '下载约 60MB' : downloadPercent() + '%',
                              ),
                            )
                          : null,
                        !refineReady
                          ? h(
                              'span',
                              { className: 'dli-note', style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                              '识别精修未下载',
                              h(
                                'button',
                                {
                                  ...btn({ padding: '3px 9px', fontSize: '11px' }),
                                  title: '整段重听一遍，纠正错字并补上标点',
                                  onClick: function () { downloadModel('sense-voice-zh-en', 'refine') },
                                  disabled: downloading !== '',
                                },
                                downloading === '' ? '下载约 240MB' : downloadPercent() + '%',
                              ),
                            )
                          : null,
                      ),
                    )
                  : null,
              ),
        ),
        showExport
          ? h(
              'div',
              {
                className: 'dli-modal-mask',
                style: { position: 'fixed', zIndex: 60 },
                onClick: function () {
                  setShowExport(false)
                },
              },
              h(
                'div',
                {
                  className: 'dli-modal',
                  style: { width: '400px', maxWidth: '92vw' },
                  role: 'dialog',
                  'aria-modal': 'true',
                  'aria-label': '导出',
                  onClick: function (event) {
                    event.stopPropagation()
                  },
                },
                h('div', { className: 'dli-modal-title' }, '导出'),
                h('div', { className: 'dli-modal-hint' }, '导出的文件会直接下载，同时也留在这次会议记录的目录里。'),
                [
                  ['minutes', '会议纪要', '议题 / 决议 / 待办'],
                  ['bilingual', '双语对照', '原文 + 书面语译文'],
                  ['source', '仅原文', '识别到的原话'],
                  ['target', '仅译文', '整理后的译文'],
                  ['srt', '字幕 SRT', '带时间轴双语'],
                  ['md', 'Markdown 全记录', '整场会议'],
                ].map(function (triple) {
                  return h(
                    'button',
                    {
                      key: triple[0],
                      ...btn({ display: 'flex', width: '100%', textAlign: 'left', marginBottom: '6px', alignItems: 'baseline', gap: '8px' }),
                      onClick: function () {
                        doExport(triple[0])
                      },
                      disabled: busy.indexOf('export') === 0,
                    },
                    h('span', { style: { fontWeight: 500 } }, triple[1]),
                    h('span', { style: { flex: '1 1 auto' } }),
                    h('span', { style: { fontSize: '11px', color: T.dim } }, triple[2]),
                  )
                }),
                exportsList.length > 0
                  ? h(
                      'div',
                      { style: { marginTop: '12px', fontSize: '11px', color: T.dim, maxHeight: '120px', overflowY: 'auto' }, className: 'dli-scroll' },
                      exportsList.map(function (item) {
                        return h(
                          'div',
                          { key: item.filename },
                          h(
                            'a',
                            {
                              href: API + '/projects/' + encodeURIComponent(project.id) + '/exports/' + encodeURIComponent(item.filename),
                              download: item.filename,
                              target: '_blank',
                              rel: 'noreferrer',
                              style: { color: 'inherit' },
                            },
                            item.filename,
                          ),
                        )
                      }),
                    )
                  : null,
              ),
            )
          : null,
        showGlossary
          ? h(
              'div',
              {
                className: 'dli-modal-mask',
                style: { position: 'fixed', zIndex: 60 },
                onClick: function () {
                  setShowGlossary(false)
                },
              },
              h(
                'div',
                {
                  className: 'dli-modal',
                  style: { width: '470px', maxWidth: '92vw' },
                  role: 'dialog',
                  'aria-modal': 'true',
                  'aria-label': '术语表',
                  onClick: function (event) {
                    event.stopPropagation()
                  },
                },
                h('div', { className: 'dli-modal-title' }, '术语表'),
                h(
                  'div',
                  { className: 'dli-modal-hint' },
                  '一行一条，写成「原文 = 译法」，例如 roadmap = 路线图。识别到的专有名词会按这里的译法固定下来。',
                ),
                h('textarea', {
                  value: glossaryText,
                  onChange: function (event) {
                    setGlossaryText(event.target.value)
                  },
                  spellCheck: false,
                  placeholder: 'roadmap = 路线图\nARR = 年度经常性收入',
                  className: 'dli-field',
                  style: { minHeight: '190px', resize: 'vertical', lineHeight: '1.65' },
                }),
                h(
                  'div',
                  { style: { display: 'flex', gap: '8px', marginTop: '14px', justifyContent: 'flex-end' } },
                  h('button', { ...btn(), onClick: function () { setShowGlossary(false) } }, '取消'),
                  h('button', { ...primaryBtn(), onClick: saveGlossary, disabled: busy === 'glossary' }, '保存'),
                ),
              ),
            )
          : null,
      )
    }

    /* --------------------------------------------------------------- settings */

    function Settings(props) {
      var [data, setData] = useState(null)
      var [error, setError] = useState('')
      var [voiceOn, setVoiceOn] = useState(function () {
        return voiceStore.get()
      })
      var [outputs, setOutputs] = useState([])
      var [outputId, setOutputId] = useState(function () {
        return outputStore.get()
      })
      var [engine, setEngine] = useState(function () {
        return engineStore.get()
      })
      var [repair, setRepair] = useState(function () {
        return repairStore.get()
      })
      var [sourceMode, setSourceMode] = useState(function () {
        return sourceStore.get()
      })

      useEffect(function () {
        return voiceStore.subscribe(setVoiceOn)
      }, [])

      useEffect(function () {
        return outputStore.subscribe(setOutputId)
      }, [])

      useEffect(function () {
        return engineStore.subscribe(setEngine)
      }, [])

      useEffect(function () {
        return repairStore.subscribe(setRepair)
      }, [])

      useEffect(function () {
        void listOutputs().then(setOutputs)
      }, [])

      var refresh = useCallback(function () {
        api('/')
          .then(function (next) {
            setData(next)
          })
          .catch(function (err) {
            setError(String(err.message ?? err))
          })
      }, [])

      useEffect(function () {
        refresh()
      }, [refresh])

      var download = useCallback(
        function (id, kind) {
          var type = kind === 'tts' ? 'tts' : kind === 'refine' ? 'refine' : kind === 'vad' ? 'vad' : 'asr'
          api('/models/' + type + '/' + encodeURIComponent(id) + '/download', { method: 'POST', body: '{}' })
            .then(function () {
              var timer = setInterval(function () {
                api('/models')
                  .then(function (next) {
                    setData(function (prev) {
                      if (prev === null) return prev
                      if (type === 'tts') return Object.assign({}, prev, { voices: next.tts, voice: (next.tts ?? []).find(function (item) { return item.id === 'tts-zh-en' }) ?? prev.voice })
                      if (type === 'vad') return Object.assign({}, prev, { vad: next.vad })
                      if (type === 'refine') {
                        return Object.assign({}, prev, {
                          refine: next.refine,
                          refineState: (next.refine ?? []).find(function (item) { return item.id === 'sense-voice-zh-en' }) ?? prev.refineState,
                        })
                      }
                      return Object.assign({}, prev, { models: next.asr, recognizers: next.asr })
                    })
                    var list = type === 'tts' ? next.tts ?? [] : type === 'refine' ? next.refine ?? [] : type === 'vad' ? next.vad ?? [] : next.asr ?? []
                    var ready = list.some(function (item) {
                      return item.id === id && item.ready
                    })
                    if (ready) clearInterval(timer)
                  })
                  .catch(function () {
                    clearInterval(timer)
                  })
              }, 2000)
            })
            .catch(function (err) {
              setError(String(err.message ?? err))
            })
        },
        [],
      )

      // The plugin manager asks for `summary` first and only renders `page` when
      // the user opens the entry; a full form in summary mode would be a wall of
      // boxes inside the bundle row.
      if (props !== null && props !== undefined && props.view === 'summary') {
        var readyCount = (data?.models ?? []).filter(function (item) {
          return item.ready
        }).length
        var total = (data?.models ?? []).length
        return h(
          'span',
          { style: { fontSize: '12px', color: T.dim } },
          '识别模型 ' + readyCount + '/' + total + ' 就绪 · ' + (data?.translate?.ready ? '翻译：' + (data.translate.model ?? '') : '翻译暂不可用'),
        )
      }

      var card = { padding: '16px 18px', marginBottom: '12px' }
      var hint = { fontSize: '12px', color: T.dim, lineHeight: '1.65' }
      var rowStyle = { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px' }

      // One row per downloadable model: name and readiness on the left, the
      // one-line explanation where the eye can skip it, action on the right.
      // A table would be heavier than five rows of text deserve.
      function modelRow(item, kind) {
        var percent = item.totalBytes === 0 ? 0 : Math.round((item.bytes / item.totalBytes) * 100)
        return h(
          'div',
          { key: item.id, style: rowStyle },
          kind === 'asr'
            ? h(
                'label',
                { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 244px', fontSize: '12px', cursor: 'pointer' } },
                h('input', {
                  type: 'radio',
                  name: 'dsh-live-interpreter-engine',
                  checked: engine === item.id,
                  onChange: function () {
                    engineStore.set(item.id)
                  },
                }),
                h('span', null, item.name),
              )
            : h('span', { style: { fontSize: '12px', flex: '0 0 244px' } }, item.name),
          h('span', { style: { fontSize: '11px', color: T.dim, flex: '1 1 auto' } }, item.detail ?? ''),
          item.ready
            ? h(
                'span',
                { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: T.dim } },
                h('span', { className: 'dli-dot', style: { background: T.success } }),
                '已就绪',
              )
            : h(
                'button',
                { ...btn({ padding: '4px 10px', fontSize: '11px' }), onClick: function () { download(item.id, kind) } },
                percent > 0 ? '继续 ' + percent + '%' : '下载',
              ),
        )
      }

      return h(
        'div',
        { style: { padding: '6px 2px 2px' }, className: 'dli-settings', 'data-dsh-live-interpreter': 'settings' },
        h(
          'div',
          { style: { fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: T.text } },
          '同声传译',
        ),
        error !== ''
          ? h(
              'div',
              {
                style: {
                  color: T.error,
                  fontSize: '12px',
                  marginBottom: '10px',
                  padding: '8px 10px',
                  borderRadius: T.radiusSm,
                  background: 'color-mix(in srgb, ' + T.error + ' 8%, transparent)',
                  border: '1px solid color-mix(in srgb, ' + T.error + ' 28%, transparent)',
                },
              },
              error,
            )
          : null,
        h(
          'div',
          { className: 'dli-card', style: card },
          h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '6px', color: T.text } }, '声音来源'),
          h(
            'div',
            { style: hint },
            '决定听哪一路声音。「麦克风」只听这台电脑的麦克风；「系统声音」听电脑自己正在播放的声音，适合线上会议与网页视频，它走的是「立体声混音 / 虚拟声卡」这类回环录音设备（Windows 声音设置 → 录制 → 右键显示已禁用设备 → 启用「立体声混音」）；「麦克风 + 系统声音」两路混合，外放时会把自己说的话重复收进来，建议戴耳机。',
          ),
          h(
            'div',
            { style: Object.assign({}, rowStyle, { marginTop: '10px' }) },
            h('span', { style: { fontSize: '12px', flex: '0 0 110px', color: T.dim } }, '来源'),
            h(
              'select',
              {
                value: sourceMode,
                onChange: function (event) {
                  sourceStore.set(event.target.value)
                },
                ...selectStyle(),
              },
              SOURCE_MODES.map(function (mode) {
                return h('option', { key: mode, value: mode }, sourceLabel(mode))
              }),
            ),
          ),
          h(
            'div',
            { style: Object.assign({}, hint, { marginTop: '8px' }) },
            '和识别模型一样，这个选择也会存进每一场会议：重新打开旧会议时沿用当时的那一路声音。',
          ),
        ),
        h(
          'div',
          { className: 'dli-card', style: card },
          h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '6px', color: T.text } }, '语音识别模型'),
          h(
            'div',
            { style: hint },
            '流式识别在本机运行，模型只下载一次，存放在 DSH 数据目录下。首次使用需要联网下载。每次同传开始前可以在底栏的「设置 ▾」抽屉里切换，开始之后不能换。',
          ),
          (data?.models ?? []).map(function (item) {
            return modelRow(item, 'asr')
          }),
        ),
        h(
          'div',
          { className: 'dli-card', style: card },
          h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '6px', color: T.text } }, '识别精修'),
          h(
            'div',
            { style: hint },
            '流式识别为了赶时间，必须在句子还没说完时就先给出文字，所以会掉字、同音字错、也没有标点。精修模型在一段话定稿之后把这段音频整段重听一遍，纠正错字并补上标点——这段文字才是译文和导出的依据。不下载也能用，只是字幕会粗一些。',
          ),
          (data?.refine ?? []).map(function (item) {
            return modelRow(item, 'refine')
          }),
        ),
        h(
          'div',
          { className: 'dli-card', style: card },
          h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '6px', color: T.text } }, '断句检测'),
          h(
            'div',
            { style: hint },
            '判断一段话到底说完没有。没有它时只能靠音量大小猜：风扇声、USB 声卡底噪都会让电平一直高于阈值，于是永远等不到「安静」，段落只能靠定时器硬切，切口常落在句子中间。装上之后按声音内容判断，段落边界落在真实停顿上。只有 0.6MB，不下载也能用。',
          ),
          (data?.vad ?? []).map(function (item) {
            return modelRow(item, 'vad')
          }),
        ),
        h(
          'div',
          { className: 'dli-card', style: card },
          h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '6px', color: T.text } }, '译文朗读音色'),
          h(
            'div',
            { style: hint },
            '朗读使用本机合成，不调用任何在线语音服务。只有下载了音色才会出声；没有音色时字幕完全不受影响。',
          ),
          (data?.voices ?? []).map(function (item) {
            return modelRow(item, 'tts')
          }),
        ),
        h(
          'div',
          { className: 'dli-card', style: card },
          h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '6px', color: T.text } }, '翻译模型'),
          h(
            'div',
            { style: hint },
            data?.translate?.ready
              ? '用哪个模型在面板顶栏的下拉框里选，列表就是 DSH 里已登录的全部 provider 与模型。当前默认：' +
                (data.translate.provider ?? '') +
                ' / ' +
                (data.translate.model ?? '')
              : '当前不可用：' + (data?.translate?.message ?? '未知原因') + '。请先在 DSH 里配置并登录一个对话模型。',
          ),
          h(
            'label',
            { style: Object.assign({}, rowStyle, { cursor: 'pointer' }) },
            h('input', {
              type: 'checkbox',
              checked: repair,
              onChange: function (event) {
                repairStore.set(event.target.checked)
              },
            }),
            h('span', { style: { fontSize: '12px' } }, '定稿后用模型校正原文'),
          ),
          h(
            'div',
            { style: Object.assign({}, hint, { marginLeft: '22px' }) },
            '一段话定稿后，把识别结果交给同一个模型通读一遍，修同音字、补标点、按术语表纠错。它只改文字不改意思：改完要与原文互相包含才采纳，否则丢弃。关掉它只会让原文粗一些，翻译与导出都会照常。',
          ),
        ),
        h(
          'div',
          { className: 'dli-card', style: card },
          h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '6px', color: T.text } }, '译文朗读'),
          h(
            'label',
            { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: voiceOn,
              onChange: function (event) {
                voiceStore.set(event.target.checked)
              },
            }),
            '朗读译文',
          ),
          h(
            'div',
            { style: Object.assign({}, rowStyle, { marginTop: '10px' }) },
            h('span', { style: { fontSize: '12px', flex: '0 0 110px', color: T.dim } }, '输出设备'),
            outputs.length > 0
              ? h(
                  'select',
                  {
                    value: outputId,
                    onChange: function (event) {
                      outputStore.set(event.target.value)
                    },
                    ...selectStyle(),
                  },
                  h('option', { value: '' }, '默认扬声器'),
                  outputs.map(function (item) {
                    return h('option', { key: item.id, value: item.id }, item.label)
                  }),
                )
              : h('span', { style: hint }, '这个浏览器没有暴露可选的输出设备，朗读会走系统默认设备。'),
          ),
          h('div', { style: Object.assign({}, hint, { marginTop: '10px' }) }, '朗读只在段落定稿后触发。开着外放时请戴耳机，否则译文会被麦克风再次收进去。'),
        ),
      )
    }

    /* ------------------------------------------------------------- icon entry */

    function SidebarIcon(props) {
      var size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 20
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M4 5h9M4 9h9M4 13h6',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M14 12h6M17 9v6',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 17, cy: 17.5, r: 3, stroke: 'currentColor', strokeWidth: 1.6 }),
      )
    }

    /* ----------------------------------------------------------------- apply */

    function apply(ctx) {
      var disposers = []
      var layout = ctx.get('layout')

      // The interactive layer lives in a real stylesheet (hover, focus-visible,
      // reduced motion); injecting it once at load is enough for every slot.
      ensureStyle()

      var open = function () {
        try {
          if (layout !== undefined && layout !== null && typeof layout.selectPanel === 'function') {
            layout.selectPanel(PANEL_ID)
          }
        } catch (error) {
          console.warn('[dsh-live-interpreter] selectPanel failed', error)
        }
      }

      disposers.push(
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 7,
              label: function () {
                return '同声传译'
              },
            },
            function (props) {
              return h(
                'div',
                {
                  onClick: open,
                  title: '同声传译',
                  style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', cursor: 'pointer' },
                },
                h(SidebarIcon, props ?? {}),
              )
            },
          )
        }),
      )

      disposers.push(
        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: PANEL_ID, inject: function () { return {} } }, function () {
            return h(Panel, {})
          })
        }),
      )

      disposers.push(
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: PANEL_ID,
              order: 25,
              label: function () {
                return '同声传译'
              },
            },
            function () {
              return h(Settings, {})
            },
          )
        }),
      )

      // The plugin's own page in the plugin manager shows the same card, so the
      // model state is reachable from wherever the user happens to look first.
      disposers.push(
        ctx.slots.inject('plugins.bundle.config', function () {
          return ctx.slots.register(
            { name: 'plugins.bundle.config', key: 'dsh-live-interpreter' },
            function () {
              return h(Settings, {})
            },
          )
        }),
      )

      return function () {
        for (var i = disposers.length - 1; i >= 0; i -= 1) {
          try {
            disposers[i]()
          } catch (error) {
            console.warn('[dsh-live-interpreter] dispose failed', error)
          }
        }
        disposers.length = 0
      }
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale', 'layout']
    return module.exports
  },
})
