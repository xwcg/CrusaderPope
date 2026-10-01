// screenshot tabs of the feature rows
for (const media of document.querySelectorAll('.show-media'))
{
    const tabs = [...media.querySelectorAll('[role=tab]')];
    const figs = [...media.querySelectorAll('figure')];
    tabs.forEach((tab, i) =>
        tab.addEventListener('click', () =>
        {
            tabs.forEach((t, j) => t.setAttribute('aria-selected', String(i === j)));
            figs.forEach((f, j) => (f.hidden = i !== j));
        })
    );
}
