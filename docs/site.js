// Notchex site — small helpers, no dependencies.

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Copy buttons on every code block.
document.querySelectorAll('.code').forEach(block => {
    const pre = block.querySelector('pre');
    const btn = document.createElement('button');
    btn.className = 'copy';
    btn.type = 'button';
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy command');
    btn.addEventListener('click', async () => {
        // Skip comment lines so pasted commands run cleanly.
        const text = pre.innerText
            .split('\n')
            .filter(line => !line.trim().startsWith('#'))
            .join('\n')
            .trim();
        try {
            await navigator.clipboard.writeText(text);
            btn.textContent = 'Copied';
        } catch {
            btn.textContent = 'Select and copy';
        }
        setTimeout(() => (btn.textContent = 'Copy'), 1600);
    });
    block.appendChild(btn);
});

// Live notch demo on the home page.
const stage = document.getElementById('stage');
if (stage) {
    const notch = stage.querySelector('.notch');
    const caption = document.getElementById('stage-caption');
    const stateButtons = [...document.querySelectorAll('[data-show]')];
    const pauseBtn = document.getElementById('stage-pause');

    const captions = {
        idle: 'Idle: date, time and battery, in place of the top-bar clock',
        music: 'Now Playing, with bars that follow the audio',
        volume: 'Volume and brightness changes show up in the notch',
        notify: 'Notifications and meetings grow out of the notch',
        hub: 'Hover, and the notch opens into the hub',
    };
    const order = Object.keys(captions);
    let index = 0;
    let timer = null;
    let paused = reducedMotion;

    const show = state => {
        index = order.indexOf(state);
        notch.dataset.state = state;
        caption.textContent = captions[state];
        stateButtons.forEach(b => b.setAttribute('aria-pressed', b.dataset.show === state));
    };
    const stop = () => { clearInterval(timer); timer = null; };
    const start = () => {
        stop();
        if (!paused) timer = setInterval(() => show(order[(index + 1) % order.length]), 3200);
    };
    const setPaused = value => {
        paused = value;
        pauseBtn.setAttribute('aria-pressed', paused);
        pauseBtn.setAttribute('aria-label', paused ? 'Play demo' : 'Pause demo');
        stage.classList.toggle('paused', paused);
        start();
    };

    // Picking a state yourself stops the slideshow, so it stays where you put it.
    stateButtons.forEach(b => b.addEventListener('click', () => {
        show(b.dataset.show);
        setPaused(true);
    }));
    pauseBtn.addEventListener('click', () => setPaused(!paused));

    // Hold still while the pointer is on the stage.
    stage.addEventListener('pointerenter', stop);
    stage.addEventListener('pointerleave', start);

    // Don't animate while the demo is off screen.
    if ('IntersectionObserver' in window) {
        new IntersectionObserver(([entry]) => (entry.isIntersecting ? start() : stop()))
            .observe(stage);
    }

    show('idle');
    setPaused(paused);

    // Live clock and date in the notch.
    const tick = () => {
        const now = new Date();
        const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        stage.querySelectorAll('[data-clock]').forEach(el => (el.textContent = time));
        const set = (sel, opts) => stage.querySelectorAll(sel)
            .forEach(el => (el.textContent = now.toLocaleDateString([], opts)));
        set('[data-date]', { weekday: 'short', day: 'numeric', month: 'short' });
        set('[data-weekday]', { weekday: 'long' });
        set('[data-longdate]', { month: 'long', day: 'numeric' });
    };
    tick();
    setInterval(tick, 30000);
}

// Screenshot lightbox.
const lightbox = document.getElementById('lightbox');
if (lightbox && typeof lightbox.showModal === 'function') {
    const img = lightbox.querySelector('img');
    const text = lightbox.querySelector('p');
    document.querySelectorAll('[data-full]').forEach(btn => {
        btn.addEventListener('click', () => {
            const thumb = btn.querySelector('img');
            img.src = btn.dataset.full;
            img.alt = thumb.alt;
            text.textContent = btn.closest('figure').querySelector('figcaption').textContent;
            lightbox.showModal();
        });
    });
    // Clicking the dimmed backdrop closes it too.
    lightbox.addEventListener('click', e => { if (e.target === lightbox) lightbox.close(); });
} else {
    // Old browsers: open the image itself.
    document.querySelectorAll('[data-full]').forEach(btn =>
        btn.addEventListener('click', () => (location.href = btn.dataset.full)));
}

// Features presets panel. Mirrors the presets on the Features page in prefs.js.
const prefs = document.getElementById('prefs');
if (prefs) {
    const presets = {
        all:   ['notch', 'notify', 'search', 'dock', 'glass', 'cc'],
        notch: ['notch', 'notify', 'search'],
        dock:  ['dock'],
        look:  ['glass', 'cc'],
    };
    const rows = [...prefs.querySelectorAll('[data-part]')];
    const buttons = [...prefs.querySelectorAll('[data-preset]')];
    const apply = name => {
        const on = new Set(presets[name]);
        rows.forEach(row => {
            const active = on.has(row.dataset.part);
            // Parts that live inside the notch can't run without it, like in preferences.
            const unavailable = row.dataset.needs && !on.has(row.dataset.needs);
            row.classList.toggle('on', active);
            row.classList.toggle('unavailable', Boolean(unavailable));
            row.querySelector('.state').textContent = active ? 'On' : 'Off';
        });
        buttons.forEach(b => b.setAttribute('aria-pressed', b.dataset.preset === name));
    };
    buttons.forEach(b => b.addEventListener('click', () => apply(b.dataset.preset)));
    apply('all');
}

// Install method tabs, with arrow-key support.
document.querySelectorAll('.method-tabs').forEach(tabs => {
    const buttons = [...tabs.querySelectorAll('[role="tab"]')];
    const select = (btn, focus) => {
        buttons.forEach(b => {
            const on = b === btn;
            b.setAttribute('aria-selected', on);
            b.tabIndex = on ? 0 : -1;
            document.getElementById(b.getAttribute('aria-controls')).hidden = !on;
        });
        if (focus) btn.focus();
    };
    buttons.forEach((btn, i) => {
        btn.addEventListener('click', () => select(btn));
        btn.addEventListener('keydown', e => {
            const keys = { ArrowRight: 1, ArrowLeft: -1, Home: -i, End: buttons.length - 1 - i };
            if (!(e.key in keys)) return;
            e.preventDefault();
            select(buttons[(i + keys[e.key] + buttons.length) % buttons.length], true);
        });
    });
    select(buttons.find(b => b.getAttribute('aria-selected') === 'true') || buttons[0]);
});

// Highlight the current section in the install page sidebar.
const tocLinks = document.querySelectorAll('.toc a');
if (tocLinks.length && 'IntersectionObserver' in window) {
    const byId = new Map([...tocLinks].map(a => [a.hash.slice(1), a]));
    const observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            tocLinks.forEach(a => a.classList.remove('active'));
            byId.get(entry.target.id)?.classList.add('active');
        });
    }, { rootMargin: '-80px 0px -70% 0px' });
    byId.forEach((_, id) => {
        const el = document.getElementById(id);
        if (el) observer.observe(el);
    });
}
