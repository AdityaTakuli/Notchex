// Notchex site — small helpers, no dependencies.

// Copy buttons on every code block.
document.querySelectorAll('.code').forEach(block => {
    const pre = block.querySelector('pre');
    const btn = document.createElement('button');
    btn.className = 'copy';
    btn.type = 'button';
    btn.textContent = 'Copy';
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
            btn.textContent = 'Select & copy';
        }
        setTimeout(() => (btn.textContent = 'Copy'), 1600);
    });
    block.appendChild(btn);
});

// Animated notch demo on the home page.
const notch = document.querySelector('.notch');
const caption = document.querySelector('.stage-caption');
if (notch) {
    const states = [
        ['idle', 'Idle: date, time and battery'],
        ['music', 'Now Playing with audio-reactive bars'],
        ['volume', 'Volume changes show up in the notch'],
        ['notify', 'Notifications grow out of the notch'],
        ['hub', 'Hover to open the hub'],
    ];
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let i = 0;
    const show = () => {
        const [state, text] = states[i];
        notch.dataset.state = state;
        if (caption) caption.textContent = text;
        i = (i + 1) % states.length;
    };
    show();
    if (!reduced) setInterval(show, 2800);

    // Live clock in the idle notch.
    const clock = notch.querySelector('[data-clock]');
    const date = notch.querySelector('[data-date]');
    const tick = () => {
        const now = new Date();
        if (clock) clock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (date) date.textContent = now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
    };
    tick();
    setInterval(tick, 30000);
}

// Install method switcher.
document.querySelectorAll('.method-tabs').forEach(tabs => {
    const buttons = tabs.querySelectorAll('button');
    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            buttons.forEach(b => {
                const on = b === btn;
                b.setAttribute('aria-selected', on);
                document.getElementById(b.getAttribute('aria-controls')).hidden = !on;
            });
        });
    });
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
