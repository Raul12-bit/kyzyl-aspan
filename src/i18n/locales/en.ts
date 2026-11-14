/**
 * English copy — the reference dictionary. Every other locale must satisfy the same `Messages` type,
 * so a missing translation is a compile error (and a test failure). Interpolated strings are
 * functions with typed parameters; keep sentences whole so translators can reorder words.
 */

export const en = {
  app: {
    name: 'Kyzyl Aspan',
    /** What the name means — shown under the wordmark on the intro. */
    meaning: '“Red sky” in Kazakh',
    synthetic: 'Synthetic demo data',
    syntheticHint:
      'All numbers in this demo come from a deterministic generator. They look plausible but are not real satellite detections.',
    skipToContent: 'Skip to content',
    nav: { map: 'Fire map', mission: 'Mission', method: 'Method', label: 'Main' },
    language: 'Language',
    useLocation: 'Use my location',
    theme: { toLight: 'Switch to light theme', toDark: 'Switch to dark theme' },
  },
  landing: {
    title: 'Kyzyl Aspan — fire from space, on one honest scale',
    heroHint: 'Click the Earth to open the fire map',
    scroll: 'Scroll',
    navCta: 'Open map',
    statement: {
      eyebrow: 'NASA Space Apps Challenge 2026',
      title: 'Twenty-six years of fire from space, on one honest scale.',
      accent: 'one honest scale',
    },
    what: {
      eyebrow: 'What we do',
      title: 'One question: where does it really burn?',
      accent: 'really',
      items: [
        {
          kicker: 'Fire map',
          title: 'Two sensors, one comparable record',
          body: 'MODIS and VIIRS detections are counted as burning hexagon-days on one H3 grid, so a fire season in 2005 can finally be compared with one in 2025.',
        },
        {
          kicker: 'Noise filter',
          title: 'Only real fires are counted',
          body: 'Gas flares, steel works, volcanoes and low-confidence pixels are removed before anything is counted — and the map shows how much was dropped.',
        },
        {
          kicker: 'AI brief',
          title: 'A region explained in a minute',
          body: 'Pick a country or draw a box. We compute the statistics; an AI model turns them into a short brief. Without a model key, transparent rules write it instead.',
        },
      ],
      cta: 'Open the map',
    },
    numbers: {
      eyebrow: 'In numbers',
      items: [
        { value: '26', unit: 'years', label: 'of MODIS fire detections, since 2000' },
        { value: '375', unit: 'm', label: 'VIIRS pixel — about 7× less area than a 1 km MODIS pixel' },
        { value: '3–4×', label: 'more hot pixels from VIIRS over the same fire' },
        { value: '8', label: 'interface languages, Kazakh included' },
      ],
    },
    how: {
      eyebrow: 'How it works',
      title: 'From raw pixels to a number you can trust',
      cta: 'Read the method',
    },
    mission: {
      eyebrow: 'Concept · space segment',
      title: 'What the next fire satellite could do on board',
      body: 'A tiny model that triages hot spots in orbit, a downlink planner that picks the ground station by weather, and satellite-to-satellite cueing — simulated in the browser and clearly labelled as concepts.',
      cta: 'Explore the mission',
    },
    about: {
      eyebrow: 'Who we are',
      title: 'A team from Kazakhstan',
      body: 'Kyzyl Aspan means “red sky” in Kazakh — the colour of the steppe in fire season. We build open tools on open NASA data and say plainly what the numbers can and cannot tell.',
      facts: [
        { label: 'Challenge', value: 'NASA Space Apps 2026' },
        { label: 'Topic', value: 'Harmonization of MODIS and VIIRS hot spots' },
        { label: 'Data', value: 'NASA FIRMS · MODIS C6.1 · VIIRS 375 m' },
        { label: 'Status', value: 'MVP · synthetic demo data' },
      ],
    },
    final: { title: 'See where the planet burns.', accent: 'burns', cta: 'Open the fire map' },
    footer: {
      disclaimer: 'Built for NASA Space Apps Challenge 2026. Not an official NASA product.',
      data: 'Fire data: NASA FIRMS. Earth imagery: NASA Blue Marble and Black Marble.',
      rights: '© 2026 Kyzyl Aspan',
    },
  },
  intro: {
    eyebrow: 'NASA Space Apps 2026 · MODIS × VIIRS hot spots',
    title: '26 years of fire from space, on one honest scale',
    titleAccent: 'fire',
    lead: 'Two NASA sensors watch every wildfire on Earth. The newer one sees three to four times more hot pixels, so their records cannot simply be joined. We clean the noise, put both on one hexagon grid and tell you how sure we are.',
    cta: 'Open the fire map',
    method: 'How it works',
    clickHint: 'Drag the Earth to spin it · click to dive in',
    targetCountry: (country: string) => `Dives into ${country}`,
    targetWorld: 'Dives into the whole world',
    satModis: 'MODIS',
    satModisDesc: 'Terra & Aqua · 1 km pixels · since 2000',
    satViirs: 'VIIRS',
    satViirsDesc: 'Suomi NPP & NOAA-20 · 375 m pixels · since 2012',
    skip: 'Skip',
    skipHint: 'Skip the transition',
    globeLabel:
      'Rotating 3D Earth with glowing points of fire activity and two satellites, MODIS and VIIRS, on their orbits',
    noGlobe: 'Simplified view: this browser cannot render the 3D globe.',
  },
  geo: {
    title: 'Open the map on your country?',
    body: 'With your location we switch to your language and land the map on your country. Coordinates stay in this browser — only the country code is kept.',
    allow: 'Use location',
    deny: 'Not now',
    locating: 'Finding your country…',
    found: (country: string) => `Located: ${country}`,
    switched: (language: string) => `Interface switched to ${language}`,
    undo: 'Undo',
    denied: 'Location is off — the map opens on the whole world.',
    error: 'Could not determine your location — the map opens on the whole world.',
    outside: 'Your position is outside any country outline — the map opens on the whole world.',
    unsupported: 'This browser cannot share a location.',
  },
  map: {
    label: 'Map of fire detections. Use the panels to choose an area, the time range and the noise filter.',
    area: {
      title: 'Area',
      tabs: { search: 'Search', draw: 'Draw', coords: 'Coordinates' },
      searchLabel: 'Search a country or region',
      searchPlaceholder: 'Kazakhstan, Spain, Brazil…',
      noResults: (q: string) => `Nothing found for “${q}”.`,
      suggested: 'Suggested',
      clickHint: 'Tip: click any country on the map to analyse it.',
      drawHint: 'Drag on the map to draw a box. Press Esc to cancel.',
      drawStart: 'Draw a box',
      drawActive: 'Drawing — drag on the map',
      drawCancel: 'Cancel',
      coords: { west: 'West', south: 'South', east: 'East', north: 'North', apply: 'Apply box' },
      errors: {
        number: 'Enter a number',
        lat: 'Latitude must be within ±90°',
        lng: 'Longitude must be within ±180°',
        order: 'South must be below north',
        small: 'Box is too small (min 0.1°)',
      },
      selected: 'Selected area',
      none: 'No area yet. Click a country, search, draw a box or type coordinates.',
      customArea: 'Custom area',
      areaKm2: (v: string) => `${v} km²`,
      clear: 'Clear selection',
      zoomTo: 'Zoom to area',
      world: 'Whole world',
    },
    view: {
      label: 'Display',
      points: 'Detections',
      hex: 'H3 hexagons',
      hexHint: (res: string, km2: string) => `H3 resolution ${res} · ≈${km2} km² per cell`,
    },
    layers: {
      title: 'Sensors',
      modis: 'MODIS',
      modisDesc: '1 km pixels · since 2000',
      viirs: 'VIIRS',
      viirsDesc: '375 m pixels · since 2012',
      count: (n: string) => `${n} in range`,
      notAvailable: 'not yet in orbit',
      notSummed: 'Shown side by side, never added up.',
      detectionNotFire:
        'A detection is a hot pixel, not a fire: one fire can light up many pixels, and clouds can hide it.',
    },
    noise: {
      title: 'Noise filter',
      lowConf: 'Low-confidence pixels',
      lowConfDesc: 'Sun glint, hot bare ground, cloud edges',
      static: 'Persistent heat sources',
      staticDesc: 'Gas flares, steel works, volcanoes: hot in the same cell every season, year after year',
      removed: (n: string) => `${n} removed`,
      staticCells: (n: string) => `${n} persistent cells found in 26 years`,
      score: (precision: string, kept: string) =>
        `On synthetic truth: ${precision} of removed points were noise; ${kept} of real fires kept.`,
    },
    legend: {
      title: 'Legend',
      square: 'MODIS detection',
      dot: 'VIIRS detection',
      cluster: 'Larger hexagon = nearby detections grouped',
      hex: 'Burning hexagon-days',
      less: 'fewer',
      more: 'more',
      selection: 'Selected area',
    },
    time: {
      label: 'Time range',
      play: 'Play 26 years',
      pause: 'Pause',
      reset: 'Full range',
      start: 'Start month',
      end: 'End month',
      viirs: 'VIIRS',
      histogram: 'Monthly detections in the sample',
    },
    status: {
      loading: 'Loading detections…',
      error: 'Detections could not be loaded.',
      basemapDown: 'Basemap unavailable — data shown on a plain background.',
      noWebgl:
        'Map rendering is unavailable in this browser. You can still search regions and read the analysis.',
    },
    controls: { zoomIn: 'Zoom in', zoomOut: 'Zoom out', reset: 'Back to the area', world: 'Whole world' },
    tooltip: {
      frp: 'FRP',
      confidence: 'Confidence',
      group: (n: string) => `${n} detections`,
      zoomHint: 'Click to zoom in',
      conf: { low: 'low', nominal: 'nominal', high: 'high' },
      hexDays: 'Burning days',
      hexModis: 'MODIS days',
      hexViirs: 'VIIRS days',
      frpMax: 'Max FRP',
      clickCountry: 'Click to analyse',
    },
    stats: {
      title: 'At a glance',
      period: (from: string, to: string) => `${from} – ${to}`,
      hexCells: 'Burning hexagons',
      hexDays: 'Hexagon-days',
      kept: 'Detections kept',
      removed: 'Noise removed',
      ratioRaw: 'VIIRS / MODIS, pixels',
      ratioHex: 'VIIRS / MODIS, hexagons',
      ratioHint:
        'Counting hexagons instead of pixels shrinks the 3–4× resolution gap — the rest is calibrated.',
      calendar: 'Harmonized activity, 2000–2026',
      calendarHint: 'MODIS-equivalent burning hexagon-days per year; whiskers show the 90% interval.',
      peak: 'Peak months',
      trend: 'Trend',
      anomalies: 'Unusual months',
      none: 'none',
      loading: 'Building the harmonized series…',
      error: 'The harmonized series could not be built.',
      empty: 'No detections in this area.',
      perYear: '/ yr',
    },
    ai: {
      title: 'AI risk analysis',
      subtitle: 'Gemini reads the statistics above — not the raw map — and writes a short risk briefing.',
      run: 'Analyse with AI',
      rerun: 'Run again',
      loading: 'Reading the numbers…',
      sourceGemini: (model: string) => `${model} · model-written text, may contain mistakes`,
      sourceRules: 'Rule-based summary · the Gemini key is not configured on the server',
      error: 'The analysis failed.',
      offline:
        'The analysis server is not reachable — showing the rule-based summary. Start it with “pnpm server”.',
      disclaimer: 'Not an official fire warning. Follow your local authorities.',
      showPayload: 'What is sent',
      hidePayload: 'Hide',
      levels: { low: 'Low', moderate: 'Moderate', elevated: 'Elevated', high: 'High' },
      findings: {
        risk: (level: string, months: string) =>
          `${level} fire activity expected in ${months}, judging by the season and recent months.`,
        season: (months: string) => `Most fire activity happens in ${months}.`,
        trendUp: (pct: string) => `Activity has been rising by about ${pct} a year since 2000.`,
        trendDown: (pct: string) => `Activity has been falling by about ${pct} a year since 2000.`,
        trendFlat: 'There is no clear long-term trend.',
        recentHigh: (x: string) => `The last 12 months were ${x} the typical level.`,
        recentLow: (x: string) => `The last 12 months were quieter than usual (${x} the typical level).`,
        recentTypical: 'The last 12 months were close to the typical level.',
        anomalies: (months: string) => `Unusually active months: ${months}.`,
        noise: (share: string, cells: string) =>
          `The filter removed ${share} of hot pixels as noise, including ${cells} persistent heat-source cells.`,
        sensors: (raw: string, hex: string) =>
          `VIIRS sees ${raw}× more hot pixels than MODIS here, but only ${hex}× more burning hexagons — the scale is corrected for that.`,
        uncertainty: (pct: string) => `Typical uncertainty since 2012: ±${pct} (90% interval).`,
      },
    },
  },
  mission: {
    eyebrow: 'Space segment · concept',
    title: 'Smarter satellites, faster alerts',
    lead: 'Three ideas for the next generation of fire-watching satellites, simulated in the browser. They are concepts: none of them runs on MODIS or VIIRS today.',
    badge: 'Concept simulation',
    onboard: {
      kicker: '01 · Onboard AI',
      title: 'A fire triage model that fits in a few hundred bytes',
      body: 'A logistic regression trained on the 26-year archive decides, pixel by pixel, whether a hot spot is a vegetation fire worth an immediate downlink or a flare or glint that can wait. It needs no network and no GPU.',
      size: 'Model size',
      bytes: (n: string) => `${n} bytes`,
      inputs: 'Inputs',
      heldOut: 'Tested on regions it never saw',
      f1: 'F1 score',
      precision: 'Precision',
      recall: 'Recall',
      baseline: 'Simple rule',
      model: 'Model',
      honest: (model: string, rule: string) =>
        `Honest result: on held-out regions the model scores F1 ${model} against ${rule} for the simple rule — barely better. Its value is size and autonomy, not accuracy.`,
      tryTitle: 'Try a hot pixel',
      confidence: 'Product confidence',
      frp: 'Fire radiative power, MW',
      years: 'Years this cell was hot',
      months: 'Calendar months it was hot',
      count: 'Detections ever seen here',
      probability: 'Probability of a real fire',
      verdictFire: 'Downlink now',
      verdictNoise: 'Can wait',
      replay: (held: string, total: string, share: string) =>
        `Replayed on the whole archive: ${held} of ${total} hot pixels would be held back (${share}), freeing downlink slots for real fires.`,
      imageNote: 'Next step, not implemented: a tiny CNN that screens thermal image chips on board.',
      features: {
        lowConfidence: 'low confidence',
        highConfidence: 'high confidence',
        logFrp: 'log FRP',
        yearsActive: 'years active',
        monthSpread: 'month spread',
        logCellCount: 'log cell count',
      },
    },
    downlink: {
      kicker: '02 · Link prediction',
      title: 'Choose the antenna before the rain does',
      body: 'The planner knows the orbit, which ground stations will see the satellite and the rain forecast at each antenna. Ka-band carries the most data but fades in heavy rain, so it switches to X-band or another station before the link breaks.',
      satellite: 'Satellite',
      backlog: 'Data waiting on board',
      reroll: 'New weather',
      time: 'Pass',
      station: 'Station',
      elevation: 'Max elev.',
      rain: 'Rain',
      ka: 'Ka holds',
      decision: 'Decision',
      decisions: {
        ka: 'Ka-band',
        'x-fallback': 'Rain risk → X-band',
        'x-only': 'X-band (no Ka)',
        skip: 'Skip: storm',
      },
      done: (when: string) => `Backlog cleared in ${when}`,
      notDone: 'Backlog not cleared within 12 h',
      failures: (plan: string, naive: string) =>
        `Expected passes lost to rain: ${plan} with the planner vs ${naive} if it always tried Ka.`,
      assumptions:
        'Circular orbits, assumed station bands and link margins, synthetic weather. The structure is real; the numbers are illustrative.',
    },
    cue: {
      kicker: '03 · Satellite-to-satellite',
      title: 'One satellite spots, another confirms',
      body: 'The first satellite sends a short alert through a relay. The system finds which satellite will see the spot soonest, and a confirmed alert jumps the queue.',
      detectedBy: 'First detection by',
      confidence: 'Detection confidence',
      clear: 'Chance of a clear sky',
      site: 'Spot',
      steps: { detect: 'Detected', relay: 'Alert relayed', follow: 'Follow-up view', confirm: 'Confirmed' },
      next: (sat: string, wait: string) => `${sat} sees the spot in ${wait}`,
      none: 'No satellite covers the spot within 36 h.',
      confirmChance: 'Chance of confirmation',
      priorityNow: 'Priority now',
      priorityConfirmed: 'If confirmed',
      priorities: { critical: 'Critical', high: 'High', watch: 'Watch' },
      limitation:
        'MODIS and VIIRS always look straight down and cannot be re-tasked or talk to each other. This needs compatible satellites, relay links and tasking — it cannot be added to existing VIIRS by a website update.',
    },
  },
  method: {
    eyebrow: 'Method',
    title: 'From noisy hot pixels to one comparable record',
    lead: 'Counting hot pixels is easy. Comparing counts from instruments that see the world at different sharpness is not. Four steps, each with its own honesty check.',
    steps: [
      {
        title: 'Clean the noise',
        body: 'Low-confidence pixels (sun glint, hot bare ground, cloud edges) are dropped. Then every cell of a fine hexagon grid is checked for persistence: a gas flare or a steel works is hot in most years and in every season, a wildfire is not. Those cells are removed too.',
      },
      {
        title: 'Snap both sensors to H3 hexagons',
        body: 'A 1 km MODIS pixel and a 375 m VIIRS pixel cannot be compared directly. Both fall into the same fixed hexagon of Uber’s H3 grid, and we count burning hexagon-days instead of raw pixels. One fire front lit up in six VIIRS pixels and one MODIS pixel is one hexagon-day for both.',
      },
      {
        title: 'Calibrate, rescale, never sum',
        body: 'The residual VIIRS/MODIS ratio is measured over 2012–2026, when both fly. VIIRS is divided by it and blended with MODIS by inverse-variance weighting. Every month carries a 90% interval: widest before 2002, narrowest after 2012.',
      },
      {
        title: 'Explain it in plain words',
        body: 'When you click a region, its statistics — not the map — are sent to Gemini, which writes a short risk briefing. Without an API key the server falls back to a transparent rule-based summary, and the source is always labelled.',
      },
    ],
    principles: {
      title: 'Rules we never break',
      items: [
        {
          title: 'Detection ≠ fire',
          body: 'We count hot pixels and say so. One fire can be many detections.',
        },
        {
          title: 'Rescale, never sum',
          body: 'MODIS and VIIRS are brought to one scale, not added together.',
        },
        { title: 'Every number has a range', body: 'No harmonized value is shown without its interval.' },
      ],
    },
    limits: {
      title: 'Limitations',
      items: [
        'This demo runs on synthetic data shaped like the real archives; the numbers are illustrative.',
        'Persistence finds flares and factories that already existed for years; a new one is caught only after several seasons.',
        'One calibration ratio per area: in reality it varies with land cover, fire size, season and viewing angle.',
        'Hot-pixel counts are not burned area or emissions, although they correlate with both.',
      ],
    },
    sources: {
      title: 'Data this is designed for',
      items: [
        {
          name: 'MODIS Collection 6.1 Active Fire (MCD14ML)',
          note: 'Terra since 2000, Aqua since mid-2002 · 1 km',
        },
        {
          name: 'VIIRS 375 m Active Fire (VNP14IMGML, VJ114IMGML)',
          note: 'Suomi NPP since 2012, NOAA-20 since 2018 · 375 m',
        },
        {
          name: 'NASA FIRMS',
          note: 'Fire Information for Resource Management System — distribution of both',
        },
        { name: 'H3 by Uber', note: 'Hierarchical hexagonal grid, open source' },
      ],
      link: 'Open NASA FIRMS',
    },
    cta: 'Explore the fire map',
  },
  tour: {
    label: 'Quick tour',
    step: (i: number, n: number) => `${i} of ${n}`,
    next: 'Next',
    done: 'Got it',
    skip: 'Skip tour',
    steps: [
      {
        title: 'Pick an area',
        body: 'Click a country on the map, search one, or draw a box. Its statistics and an AI briefing appear here.',
      },
      {
        title: 'Filter the noise',
        body: 'Flares, factories and glint are removed by default. Switch the filters off to see what they hide, or switch to H3 hexagons.',
      },
      {
        title: 'Scrub 26 years',
        body: 'Drag the handles to filter by date, or press play to watch the seasons roll by.',
      },
    ],
  },
  common: {
    close: 'Close',
    retry: 'Retry',
    loading: 'Loading…',
    notFound: 'This page does not exist.',
    goHome: 'Go to the map',
    errorTitle: 'Something went wrong',
  },
};

type Widen<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => R
  : T extends readonly (infer U)[]
    ? Widen<U>[]
    : T extends object
      ? { [K in keyof T]: Widen<T[K]> }
      : T extends string
        ? string
        : T;

export type Messages = Widen<typeof en>;
