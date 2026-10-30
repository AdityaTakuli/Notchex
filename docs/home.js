/* Notchex home page.
   - The Notch / Pill switch reshapes every island and swaps every screenshot.
   - The hero island morphs through what Notchex shows, from real screenshots.
   - Live activities step with the scroll; the hub has tabs.
   Motion is optional: with Reduce Motion, or without GSAP, everything still
   works and nothing moves on its own. */
(() => {
    const root = document.documentElement;
    const G = window.gsap;
    const ST = window.ScrollTrigger;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const animate = () => !!G && !reduce.matches;
    if (G && ST) G.registerPlugin(ST);

    const store = {
        get() { try { return localStorage.getItem('notchex-shape'); } catch { return null; } },
        set(v) { try { localStorage.setItem('notchex-shape', v); } catch { /* private mode */ } },
    };

    /* ———————— island ———————— */

    /* logical size of each state (screenshots are 2x) */
    const SIZE = {
        idle: [118, 38], meeting: [420, 48], bt: [340, 38], play: [380, 38],
        focus: [300, 38], low: [340, 38], charge: [340, 38], hub: [640, 398.5],
    };
    const PILL_TOP = 6;

    class Island {
        constructor(screen) {
            this.screen = screen;
            this.el = screen.querySelector('.island');
            this.imgs = {};
            this.el.querySelectorAll('img').forEach(i => (this.imgs[i.dataset.state] = i));
            this.ears = document.createElement('div');
            this.ears.className = 'island-ears';
            this.ears.setAttribute('aria-hidden', 'true');
            screen.appendChild(this.ears);
            const p = root.dataset.shape === 'pill' ? 1 : 0;
            this.g = {w: SIZE.idle[0], h: SIZE.idle[1], p};
            this.state = 'idle';
            if (G) {
                G.set(Object.values(this.imgs), {xPercent: -50, x: 0, opacity: 0});
                G.set(this.imgs.idle, {opacity: 1});
            } else {
                this.imgs.idle.classList.add('on');
            }
            new ResizeObserver(() => this.render()).observe(screen);
            this.render();
        }

        /* px per logical px; phones zoom in so the island stays readable */
        get logical() {
            const wide = +this.screen.dataset.logical || 1280;
            return this.screen.clientWidth < 700 ? Math.min(wide, 520) : wide;
        }

        render() {
            const {w, h, p} = this.g;
            const base = this.screen.clientWidth / this.logical;
            /* on phones the open hub would overflow: shrink just enough to fit */
            const s = Math.min(base, (this.screen.clientWidth * 0.96) / w);
            const r = (h <= 60 ? h / 2 : 24) * s;       // capsule when compact, 24 when open
            const top = r * p;                            // the notch's top corners are square
            Object.assign(this.el.style, {
                width: `${w * s}px`,
                height: `${h * s}px`,
                top: `${PILL_TOP * p * s}px`,
                borderRadius: `${top}px ${top}px ${r}px ${r}px`,
            });
            for (const img of Object.values(this.imgs))
                img.style.width = `${(+img.getAttribute('width') / 2) * s}px`;
            this.ears.style.setProperty('--half', `${(w * s) / 2}px`);
            this.ears.style.setProperty('--ear', `${10 * s}px`);
            this.ears.style.opacity = String(1 - p);
            /* the wallpaper zooms with the island, as on a 1280-wide desktop */
            this.screen.style.backgroundSize = `${Math.max(1280 * base, this.screen.clientWidth)}px auto`;
        }

        to(state) {
            if (!SIZE[state] || state === this.state) return;
            const [w, h] = SIZE[state];
            const wasOpen = SIZE[this.state][1] > 60;
            this.state = state;
            if (!animate()) {
                Object.assign(this.g, {w, h});
                for (const [k, img] of Object.entries(this.imgs)) {
                    if (G) G.set(img, {opacity: k === state ? 1 : 0});
                    else img.classList.toggle('on', k === state);
                }
                this.render();
                return;
            }
            const opening = h > 60;
            G.to(this.g, {
                w, h, overwrite: 'auto',
                duration: opening ? 0.7 : wasOpen ? 0.55 : 0.62,
                ease: opening ? 'power3.out' : wasOpen ? 'power3.inOut' : 'back.out(1.5)',
                onUpdate: () => this.render(),
            });
            /* closing the hub: its content fades with the shrinking box and the
               song comes back at the end, so there's never an empty box */
            for (const [k, img] of Object.entries(this.imgs)) {
                const on = k === state;
                G.to(img, {
                    opacity: on ? 1 : 0, overwrite: 'auto',
                    duration: on ? 0.32 : wasOpen ? 0.4 : 0.14,
                    delay: on ? (wasOpen ? 0.32 : 0.12) : 0,
                });
            }
            /* compact content grows out from the centre, like on the desktop */
            if (!opening) G.fromTo(this.imgs[state], {scale: 0.82}, {scale: 1, duration: 0.6, ease: 'back.out(1.6)'});
        }

        setShape(shape) {
            const p = shape === 'pill' ? 1 : 0;
            if (!animate()) { this.g.p = p; this.render(); return; }
            G.to(this.g, {p, duration: 0.55, ease: 'power3.inOut', onUpdate: () => this.render()});
        }
    }

    const heroScreen = document.getElementById('hero-screen');
    const alertsScreen = document.getElementById('alerts-screen');

    /* ———————— shape: notch or pill ———————— */

    const islands = [];
    const shotImgs = () => document.querySelectorAll('img[data-shot]');
    const shotSrc = (shot, shape) => `img/${shape === 'pill' ? 'p' : 'n'}/${shot}.jpg`;

    function setShape(shape, {save = true} = {}) {
        if (shape !== 'pill') shape = 'notch';
        const changed = root.dataset.shape !== shape;
        root.dataset.shape = shape;
        document.querySelectorAll('.shape-switch [role="radio"]').forEach(b => {
            const on = b.dataset.setShape === shape;
            b.setAttribute('aria-checked', String(on));
            b.tabIndex = on ? 0 : -1;
        });
        if (save) store.set(shape);
        if (!changed) return;
        islands.forEach(i => i.setShape(shape));
        shotImgs().forEach(img => swapShot(img, shotSrc(img.dataset.shot, shape)));
    }

    function swapShot(img, src) {
        if (img.getAttribute('src') === src) return;
        if (!animate()) { img.src = src; return; }
        G.to(img, {
            opacity: 0, scale: 0.985, duration: 0.18, ease: 'power2.in',
            onComplete: () => {
                const done = () => G.to(img, {opacity: 1, scale: 1, duration: 0.4, ease: 'power2.out'});
                img.addEventListener('load', done, {once: true});
                img.src = src;
                if (img.complete) done();
            },
        });
    }

    /* the switch: click, arrow keys, or drag the thumb */
    const sw = document.querySelector('.shape-switch');
    if (sw) {
        sw.addEventListener('click', e => {
            const b = e.target.closest('[data-set-shape]');
            if (b && !sw.dataset.dragged) setShape(b.dataset.setShape);
            delete sw.dataset.dragged;
        });
        sw.addEventListener('keydown', e => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
            e.preventDefault();
            const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 'pill' : 'notch';
            setShape(next);
            sw.querySelector(`[data-set-shape="${next}"]`).focus();
        });
        const thumb = sw.querySelector('.shape-thumb');
        let startX = null, base = 0;
        sw.addEventListener('pointerdown', e => {
            startX = e.clientX;
            base = root.dataset.shape === 'pill' ? 1 : 0;
        });
        window.addEventListener('pointermove', e => {
            if (startX === null) return;
            const dx = e.clientX - startX;
            if (Math.abs(dx) < 4 && !sw.classList.contains('dragging')) return;
            sw.classList.add('dragging');
            const span = thumb.offsetWidth;
            const pos = Math.max(0, Math.min(1, base + dx / span));
            thumb.style.transform = `translateX(${pos * 100}%)`;
        });
        window.addEventListener('pointerup', e => {
            if (startX === null) return;
            const dx = e.clientX - startX;
            startX = null;
            if (!sw.classList.contains('dragging')) return;
            sw.classList.remove('dragging');
            thumb.style.transform = '';
            sw.dataset.dragged = '1';
            setTimeout(() => delete sw.dataset.dragged, 0);
            if (Math.abs(dx) > 12) setShape(dx > 0 ? 'pill' : 'notch');
        });
    }
    document.querySelectorAll('.shape-card[data-set-shape]').forEach(b =>
        b.addEventListener('click', () => setShape(b.dataset.setShape)));

    /* swipe left or right on the hero desktop */
    if (heroScreen) {
        let sx = null, sy = 0;
        heroScreen.addEventListener('pointerdown', e => { sx = e.clientX; sy = e.clientY; });
        heroScreen.addEventListener('pointerup', e => {
            if (sx === null) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            sx = null;
            if (Math.abs(dx) > 50 && Math.abs(dy) < 40) setShape(dx < 0 ? 'pill' : 'notch');
        });
    }

    /* start in the shape chosen last time */
    setShape(store.get() || 'notch', {save: false});
    if (heroScreen) islands.push(new Island(heroScreen));
    const alertsIsland = alertsScreen ? new Island(alertsScreen) : null;
    if (alertsIsland) islands.push(alertsIsland);

    /* load the other set once the page is in, so switching is instant */
    window.addEventListener('load', () => {
        setTimeout(() => {
            const other = root.dataset.shape === 'pill' ? 'notch' : 'pill';
            shotImgs().forEach(img => { new Image().src = shotSrc(img.dataset.shot, other); });
            ['hub-system', 'hub-weather', 'hub-timer'].forEach(v => {
                new Image().src = shotSrc(v, 'notch');
                new Image().src = shotSrc(v, 'pill');
            });
        }, 600);
    });

    /* ———————— hero loop ———————— */

    const SCENES = [
        ['idle', 2.4, 'Now playing'],
        ['meeting', 3.2, 'A meeting in 4 minutes, with a Join button'],
        ['idle', 1.4, 'Now playing'],
        ['bt', 2.6, 'AirPods connected, battery at 72%'],
        ['idle', 1.3, 'Now playing'],
        ['hub', 4.2, 'Hover over it and it opens into the hub'],
        ['idle', 1.8, 'Now playing'],
    ];
    const hero = islands.find(i => i.screen === heroScreen);
    const caption = document.getElementById('hero-caption');
    const pauseBtn = document.getElementById('hero-pause');
    let scene = 0, timer = null, userPaused = !animate(), visible = true;

    function playScene() {
        const [state, hold, text] = SCENES[scene];
        hero.to(state);
        if (caption) caption.textContent = text;
        scene = (scene + 1) % SCENES.length;
        timer = setTimeout(tick, hold * 1000);
    }
    function tick() {
        timer = null;
        if (!userPaused && visible && !document.hidden) playScene();
    }
    function resume() { if (!timer && !userPaused && visible && !document.hidden) timer = setTimeout(tick, 700); }
    function stop() { clearTimeout(timer); timer = null; }

    if (hero && pauseBtn) {
        pauseBtn.setAttribute('aria-pressed', String(userPaused));
        pauseBtn.setAttribute('aria-label', userPaused ? 'Play the animation' : 'Pause the animation');
        pauseBtn.addEventListener('click', () => {
            userPaused = !userPaused;
            pauseBtn.setAttribute('aria-pressed', String(userPaused));
            pauseBtn.setAttribute('aria-label', userPaused ? 'Play the animation' : 'Pause the animation');
            if (userPaused) stop(); else resume();
        });
        new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible ? resume() : stop(); },
            {threshold: 0.12}).observe(heroScreen);
        document.addEventListener('visibilitychange', () => (document.hidden ? stop() : resume()));
    }

    /* ———————— live activities ———————— */

    const STEPS = ['idle', 'meeting', 'bt', 'play', 'focus', 'low', 'charge'];
    const stepBtns = [...document.querySelectorAll('#steps [data-step]')];
    const btnFor = state => stepBtns.find(b => b.dataset.step === (state === 'charge' ? 'low' : state));
    let stepTrigger = null;

    function showStep(state) {
        alertsIsland?.to(state);
        stepBtns.forEach(b => b.removeAttribute('aria-current'));
        btnFor(state)?.setAttribute('aria-current', 'true');
    }
    showStep('idle');

    stepBtns.forEach(b => b.addEventListener('click', () => {
        const i = STEPS.indexOf(b.dataset.step);
        if (stepTrigger) {
            const y = stepTrigger.start + (stepTrigger.end - stepTrigger.start) * ((i + 0.5) / STEPS.length);
            window.scrollTo({top: y, behavior: reduce.matches ? 'auto' : 'smooth'});
        } else {
            showStep(b.dataset.step);
            if (b.dataset.step === 'low') setTimeout(() => showStep('charge'), 1400);
        }
    }));

    /* ———————— hub tabs ———————— */

    const hubImg = document.getElementById('hub-img');
    const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];
    const HUB_ALT = {
        'hub-now': 'The hub open on the Now view: the music player with album art, a meeting in 4 minutes with a Join button, a running focus timer and the weather',
        'hub-system': 'The System monitor: CPU, memory, GPU, swap and storage bars, temperature, battery and network',
        'hub-weather': 'The Weather view: current conditions with feels-like, humidity, wind and UV, and a 3-day forecast',
        'hub-timer': 'The Timer: a focus session counting down inside a progress ring, with presets',
    };
    function selectTab(t) {
        tabs.forEach(x => {
            const on = x === t;
            x.setAttribute('aria-selected', String(on));
            x.tabIndex = on ? 0 : -1;
        });
        hubImg.dataset.shot = t.dataset.view;
        hubImg.alt = HUB_ALT[t.dataset.view];
        swapShot(hubImg, shotSrc(t.dataset.view, root.dataset.shape));
    }
    tabs.forEach((t, i) => {
        t.tabIndex = i === 0 ? 0 : -1;
        t.addEventListener('click', () => selectTab(t));
        t.addEventListener('keydown', e => {
            const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!d) return;
            e.preventDefault();
            const n = tabs[(i + d + tabs.length) % tabs.length];
            n.focus();
            selectTab(n);
        });
    });

    /* ———————— copy ———————— */

    document.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => {
        const text = document.getElementById(b.dataset.copy)?.textContent ?? '';
        try {
            await navigator.clipboard.writeText(text);
            b.textContent = 'Copied';
        } catch {
            b.textContent = 'Press Ctrl+C';
            const r = document.createRange();
            r.selectNodeContents(document.getElementById(b.dataset.copy));
            getSelection().removeAllRanges();
            getSelection().addRange(r);
        }
        setTimeout(() => (b.textContent = 'Copy'), 1800);
    }));

    /* ———————— motion ———————— */

    if (!animate() || !ST) {
        if (hero && !userPaused) resume();
        return;
    }

    /* the hero arrives: words rise, then the desktop, then the island starts */
    const intro = G.timeline({defaults: {ease: 'power3.out'}});
    intro.from('[data-hero]', {y: 28, opacity: 0, duration: 0.9, stagger: 0.08})
         .from('[data-hero-stage]', {y: 70, opacity: 0, scale: 0.96, duration: 1.2}, '-=0.55')
         .add(() => resume(), '-=0.3');

    /* headings and cards fade up once as they arrive */
    ST.batch('[data-reveal]', {
        start: 'top 88%',
        once: true,
        onEnter: els => G.from(els, {y: 40, opacity: 0, duration: 0.9, ease: 'power3.out', stagger: 0.08}),
    });

    /* the hub screenshot settles into place as it scrolls in */
    G.fromTo('.shot-hub', {scale: 0.9, borderRadius: 40}, {
        scale: 1, borderRadius: 26, ease: 'none',
        scrollTrigger: {trigger: '.shot-hub', start: 'top bottom', end: 'top 25%', scrub: 0.6},
    });

    /* live activities follow the scroll on wide screens; elsewhere they step on their own */
    const mm = G.matchMedia();
    mm.add('(min-width: 1101px)', () => {
        let last = -1;
        stepTrigger = ST.create({
            trigger: '.activities-pin',
            start: 'top top+=56',
            end: () => `+=${window.innerHeight * 2.6}`,
            pin: true,
            onUpdate: self => {
                const i = Math.min(STEPS.length - 1, Math.floor(self.progress * STEPS.length));
                if (i !== last) { last = i; showStep(STEPS[i]); }
            },
        });
        return () => { stepTrigger = null; };
    });
    mm.add('(max-width: 1100px)', () => {
        let i = 0, id = null;
        const t = ST.create({
            trigger: '#alerts-screen', start: 'top 80%', end: 'bottom 10%',
            onToggle: self => {
                clearInterval(id);
                if (self.isActive) id = setInterval(() => { i = (i + 1) % STEPS.length; showStep(STEPS[i]); }, 2200);
            },
        });
        return () => { clearInterval(id); t.kill(); };
    });
})();
