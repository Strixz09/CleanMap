// Shared copy for the educational cards, report selections and compact guide.
// Keys match existing report/database values; the guide never changes form values.
const CLEANMAP_GUIDES = {
    types: {
        'Air Pollution': {
            label: 'Air Pollution', icon: 'air',
            description: 'Smoke, dust and industrial emissions affecting air quality and respiratory health in urban areas.',
            examples: ['Smoke from burning waste.', 'Excessive dust from construction or unpaved roads.', 'Visible industrial or vehicle emissions.', 'Persistent smoke or fumes affecting nearby communities.']
        },
        'Water Pollution': {
            label: 'Water Pollution', icon: 'water',
            description: 'Contaminated rivers, coastal waters and drinking sources due to chemical runoff and waste.',
            examples: ['Garbage or plastic waste entering rivers and waterways.', 'Visible wastewater discharge.', 'Unusual water discoloration or floating waste.', 'Suspected chemical contamination or oil-like surface films.'],
            note: 'Appearance alone cannot confirm whether water is chemically contaminated or unsafe to drink. Describe what you can see; leave confirmation to qualified professionals.'
        },
        'Solid Waste Pollution': {
            label: 'Solid Waste', icon: 'waste',
            description: 'Uncollected garbage, single-use plastics and illegal dumping in natural habitats and city streets.',
            examples: ['Overflowing public trash bins.', 'Accumulated household or commercial garbage.', 'Illegal dumping along roads, rivers, or vacant lots.', 'Plastic waste accumulating in parks, shorelines, or other natural habitats.']
        },
        'Noise Pollution': {
            label: 'Noise Pollution', icon: 'noise',
            description: 'Persistent loud noise from construction, traffic, or industry harming community wellbeing.',
            examples: ['Prolonged construction noise.', 'Excessive traffic or vehicle noise.', 'Repeated loud industrial equipment.', 'Persistent loudspeaker or machinery noise disrupting nearby communities.'],
            note: 'Describe the duration, repetition and effects you observe. A phone recording is not a calibrated sound measurement.'
        }
    },
    severities: {
        low: {
            label: 'Low', summary: 'Minor / localized',
            description: 'Minor, localized pollution with limited visible impact. The issue is small, does not appear to be spreading significantly, and does not show obvious immediate danger.',
            examples: ['A small amount of litter in one location.', 'Slight, temporary dust or odor with no obvious major impact.', 'A small patch of minor water discoloration without visible evidence of a major spill.']
        },
        moderate: {
            label: 'Moderate', summary: 'Needs attention',
            description: 'Noticeable pollution affecting a limited area or occurring repeatedly, requiring attention before it becomes worse.',
            examples: ['A growing pile of uncollected garbage.', 'Repeated vehicle or construction noise disturbing nearby residents.', 'Persistent dust or smoke affecting a small neighborhood.', 'Visible waste or discoloration in a drainage canal or stream.']
        },
        high: {
            label: 'High', summary: 'Significant impact',
            description: 'Significant pollution affecting a larger area, multiple people, local wildlife, or the surrounding environment. Prompt reporting and intervention are warranted.',
            examples: ['A substantial garbage pile or illegal dumping site.', 'Persistent, heavy smoke or dust affecting nearby homes or public areas.', 'A substantial amount of visible waste entering a waterway.', 'Sustained excessive noise that seriously disrupts nearby homes, schools, or workplaces.']
        },
        severe: {
            label: 'Severe', summary: 'Potentially urgent',
            description: 'An apparent major pollution incident or an immediate, potentially serious threat to human health, public safety, or the environment. Urgent assessment by appropriate authorities may be needed.',
            examples: ['A suspected chemical spill or large discharge of hazardous material.', 'A major uncontrolled fire producing heavy smoke.', 'A large-scale release of pollutants into a river or coastal area.', 'An apparent major hazardous-waste incident.'],
            note: 'Do not select Severe based only on a strong smell, a photograph, or an unverified assumption. If a situation appears immediately dangerous, stay away and contact the appropriate emergency or environmental authorities.'
        }
    }
};

(function initializeReportingGuides() {
    const icons = {
        air: '<path d="M3 8h12a3 3 0 1 0-3-3M2 12h17a3 3 0 1 1-3 3M4 16h5a3 3 0 1 1-3 3"/>',
        water: '<path d="M12 2S5 10 5 15a7 7 0 0 0 14 0c0-5-7-13-7-13Z"/><path d="M8 15a4 4 0 0 0 4 4"/>',
        waste: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
        noise: '<path d="m11 4-6 5H2v6h3l6 5ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>'
    };
    const element = (tag, text, className) => {
        const node = document.createElement(tag);
        if (text) node.textContent = text;
        if (className) node.className = className;
        return node;
    };
    function typeIcon(type) {
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', role: 'img', 'aria-label': type.label }).forEach(([key, value]) => icon.setAttribute(key, value));
        icon.innerHTML = icons[type.icon]; // Fixed SVG paths from the local icon set.
        return icon;
    }
    function guideCard(guide, severity) {
        const card = element('article', '', `guide-card${severity ? ' severity-guide-card' : ''}`);
        if (severity) card.dataset.severity = severity;
        const heading = element('div', '', 'guide-card-heading');
        if (!severity) heading.append(typeIcon(guide));
        else heading.append(element('span', '', `severity-dot ${severity}-bg`));
        heading.append(element('h3', guide.label));
        card.append(heading, element('p', guide.description));
        card.append(element('h4', 'Examples of observable issues'));
        const examples = element('ul');
        guide.examples.forEach(example => examples.append(element('li', example)));
        card.append(examples);
        if (guide.note) card.append(element('p', guide.note, 'guide-caution'));
        return card;
    }
    document.querySelectorAll('[data-impact-guide]').forEach(section => {
        const title = element('h2', 'Understanding the Impact');
        title.id = section.dataset.headingId;
        section.append(element('p', 'AWARENESS IS THE FIRST STEP', 'eyebrow'), title,
            element('p', 'We categorize reports to better direct resources and organize community clean-up efforts where they are needed most.', 'impact-intro'),
            element('p', 'These are observable conditions that may warrant reporting or further assessment. An instance of noise, smoke, discoloration, or waste does not automatically meet a legal definition of pollution.', 'guidance-disclaimer'));
        const cards = element('div', '', 'impact-grid');
        Object.values(CLEANMAP_GUIDES.types).forEach(type => cards.append(guideCard(type)));
        section.append(cards);
    });
    document.querySelectorAll('[data-severity-guide]').forEach(container => {
        Object.entries(CLEANMAP_GUIDES.severities).forEach(([key, guide]) => container.append(guideCard(guide, key)));
    });

    const form = document.getElementById('reportForm');
    const typeInput = document.getElementById('reportType');
    function updateGuidance() {
        const type = CLEANMAP_GUIDES.types[typeInput.value];
        const severity = form.querySelector('[name="severity"]:checked')?.value;
        const level = CLEANMAP_GUIDES.severities[severity];
        document.getElementById('typeGuidance').replaceChildren(type ? guideCard(type) : element('p', 'Choose a pollution type to see what to look for.'));
        document.getElementById('severityGuidance').replaceChildren(level ? guideCard(level, severity) : element('p', 'Choose a severity level to see its description and examples.'));
    }
    typeInput.addEventListener('change', updateGuidance);
    form.querySelectorAll('[name="severity"]').forEach(input => input.addEventListener('change', updateGuidance));
    // Native reset fires before the browser restores the fields' default values.
    form.addEventListener('reset', () => requestAnimationFrame(updateGuidance));
    updateGuidance();

    const dialog = document.getElementById('guidelinesDialog');
    function setGuideMode(mode) {
        const content = document.getElementById('guidelinesContent');
        content.replaceChildren();
        const entries = mode === 'severity' ? CLEANMAP_GUIDES.severities : CLEANMAP_GUIDES.types;
        Object.entries(entries).forEach(([key, guide]) => content.append(guideCard(guide, mode === 'severity' ? key : null)));
        dialog.querySelectorAll('[data-guide-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.guideMode === mode)));
    }
    document.querySelectorAll('[data-open-guide]').forEach(button => button.addEventListener('click', () => {
        setGuideMode(button.dataset.openGuide);
        if (!dialog.open) dialog.showModal();
        dialog.scrollTop = 0;
    }));
    dialog.querySelectorAll('[data-guide-mode]').forEach(button => button.addEventListener('click', () => setGuideMode(button.dataset.guideMode)));
    document.getElementById('guidelinesClose').addEventListener('click', () => dialog.close());
})();
