// Bimax: Apple-Class Master Pitch Deck Generator (10-Slide Investor & Stage System)
// Strictly implements the 9 Strategic Research Pillars & Apple-Class System Rules
// Narrative: Crisis -> Identity -> Antidote -> 5 Breakthroughs -> Non-Negotiables -> Landscape -> Moat -> Tech Stack -> Methodologies -> Vision

(async () => {
  try {
    // 1. Apple-Class Launch Palette (from Page 13 of the System Guide)
    const C = {
      deepInk: { r: 0.02, g: 0.024, b: 0.031 },       // #050608 (Hero Canvas)
      carbon: { r: 0.067, g: 0.078, b: 0.098 },      // #111419 (Raised Surface / Cards)
      graphite: { r: 0.145, g: 0.165, b: 0.192 },    // #252A31 (Dividers & Borders)
      frost: { r: 0.961, g: 0.969, b: 0.98 },        // #F5F7FA (Primary Text)
      silver: { r: 0.655, g: 0.678, b: 0.718 },      // #A7ADB7 (Secondary Supporting Text)
      slate: { r: 0.412, g: 0.443, b: 0.49 },        // #69717D (Muted Text)
      signalBlue: { r: 0.184, g: 0.49, b: 1.0 },     // #2F7DFF (Primary Active Control)
      auroraCyan: { r: 0.271, g: 0.831, b: 1.0 },    // #45D4FF (Secondary Accent)
      electricIce: { r: 0.659, g: 0.933, b: 1.0 },   // #A8EEFF (Tiny Highlight)
      mint: { r: 0.271, g: 0.851, b: 0.604 },        // #45D99A (Verified Completion / Success)
      amber: { r: 1.0, g: 0.722, b: 0.302 },         // #FFB84D (Warning / Consequential)
    };

    const solid = (rgb, a = 1) => [{ type: 'SOLID', color: rgb, opacity: a }];

    // 135° Reveal Gradient: #2F7DFF -> #45D4FF
    const revealGradient = () => [{
      type: 'GRADIENT_LINEAR',
      gradientTransform: [
        [0.7071, 0.7071, 0],
        [-0.7071, 0.7071, 0]
      ],
      gradientStops: [
        { position: 0, color: { ...C.signalBlue, a: 1 } },
        { position: 1, color: { ...C.auroraCyan, a: 1 } }
      ]
    }];

    // 2. Pre-load standard Inter fonts
    const fontRegular = { family: "Inter", style: "Regular" };
    const fontMedium = { family: "Inter", style: "Medium" };
    const fontSemiBold = { family: "Inter", style: "Semi Bold" };
    const fontBold = { family: "Inter", style: "Bold" };

    const fontReg = fontRegular;
    const fontMed = fontMedium;
    const fontSemi = fontSemiBold;

    try {
      await Promise.all([
        figma.loadFontAsync(fontRegular),
        figma.loadFontAsync(fontMedium),
        figma.loadFontAsync(fontSemiBold),
        figma.loadFontAsync(fontBold),
      ]);
    } catch (e) {
      await Promise.all([
        figma.loadFontAsync(fontRegular),
        figma.loadFontAsync(fontBold),
      ]);
    }

    // Text Node Helper
    function makeText(text, font, size, fill, opts = {}) {
      const t = figma.createText();
      t.fontName = font;
      t.fontSize = size;
      t.characters = text;
      t.fills = opts.gradient ? revealGradient() : solid(fill, opts.opacity || 1);
      if (opts.lineHeight) t.lineHeight = { value: opts.lineHeight, unit: 'PIXELS' };
      if (opts.letterSpacing) t.letterSpacing = { value: opts.letterSpacing, unit: 'PIXELS' };
      if (opts.align) t.textAlignHorizontal = opts.align;
      return t;
    }

    // Minimal Pill Tag Helper
    function makePill(label, strokeColor, textColor, fillColor = C.carbon) {
      const f = figma.createFrame();
      f.name = `Pill-${label}`;
      f.layoutMode = 'HORIZONTAL';
      f.primaryAxisSizingMode = 'AUTO';
      f.counterAxisSizingMode = 'AUTO';
      f.paddingLeft = 16;
      f.paddingRight = 16;
      f.paddingTop = 6;
      f.paddingBottom = 6;
      f.cornerRadius = 20;
      f.fills = solid(fillColor);
      f.strokes = solid(strokeColor);
      f.strokeWeight = 1;

      const txt = makeText(label, fontSemiBold, 13, textColor, { letterSpacing: 1.2 });
      f.appendChild(txt);
      return f;
    }

    // Slide Generator (1920x1080) in 2 rows of 5
    function makeSlide(index, name) {
      const slide = figma.createFrame();
      slide.name = `Slide ${String(index).padStart(2, '0')} — ${name}`;
      slide.resize(1920, 1080);
      const col = (index - 1) % 5;
      const row = Math.floor((index - 1) / 5);
      slide.x = col * 2080;
      slide.y = row * 1240;
      slide.fills = solid(C.deepInk);
      slide.clipsContent = true;
      return slide;
    }

    // Card Container Helper
    function makeCard(width, height, opts = {}) {
      const c = figma.createFrame();
      c.resize(width, height);
      c.layoutMode = opts.layout || 'VERTICAL';
      c.itemSpacing = opts.itemSpacing || 20;
      c.paddingTop = opts.padding || 36;
      c.paddingBottom = opts.padding || 36;
      c.paddingLeft = opts.padding || 36;
      c.paddingRight = opts.padding || 36;
      c.cornerRadius = opts.radius || 20;
      c.fills = solid(opts.bg || C.carbon);
      c.strokes = solid(opts.border || C.graphite);
      c.strokeWeight = 1.5;
      return c;
    }

    const allSlides = [];

    // ==========================================
    // SLIDE 01: THE CRISIS
    // "AI stops where the clicks begin."
    // ==========================================
    {
      const s = makeSlide(1, "The Crisis");

      const left = figma.createFrame();
      left.layoutMode = 'VERTICAL';
      left.itemSpacing = 28;
      left.x = 120;
      left.y = 300;
      left.resize(760, 520);
      left.fills = [];

      left.appendChild(makePill("01 — THE CRISIS", C.graphite, C.amber));
      const h1 = makeText("AI stops where the clicks begin.", fontBold, 76, C.frost, { letterSpacing: -2.0, lineHeight: 86 });
      h1.resize(740, 180);
      left.appendChild(h1);

      const sub = makeText("We gave AI the shell, the repository, and the cloud. Yet developers are more tethered to their desks than ever before.", fontRegular, 22, C.silver, { lineHeight: 32 });
      sub.resize(700, 100);
      left.appendChild(sub);
      s.appendChild(left);

      // Right: Evidence Card
      const right = makeCard(820, 500, { padding: 44, itemSpacing: 22 });
      right.x = 980;
      right.y = 290;

      right.appendChild(makeText("THE DEVELOPER BABYSITTING TRAP", fontSemiBold, 12, C.slate, { letterSpacing: 1.5 }));

      // Mock Terminal Checkpoint
      const termBox = figma.createFrame();
      termBox.resize(732, 140);
      termBox.cornerRadius = 12;
      termBox.fills = solid(C.deepInk);
      termBox.strokes = solid(C.graphite);
      termBox.strokeWeight = 1;
      termBox.paddingLeft = 24;
      termBox.paddingTop = 18;

      const codeLines = figma.createFrame();
      codeLines.layoutMode = 'VERTICAL';
      codeLines.itemSpacing = 8;
      codeLines.fills = [];
      codeLines.appendChild(makeText("> running test suite (142 tests)... PASS", fontRegular, 14, C.mint));
      codeLines.appendChild(makeText("> WARNING: Schema mutation detected", fontSemiBold, 14, C.amber));
      codeLines.appendChild(makeText("> Execute 'DROP TABLE staging_orders;'? [y/n]: _", fontBold, 15, C.frost));
      termBox.appendChild(codeLines);
      right.appendChild(termBox);

      right.appendChild(makeText("STATUS: STALLED FOR 3 HOURS (DEVELOPER STEPPED AWAY)", fontBold, 13, C.amber, { letterSpacing: 1.0 }));

      const div = figma.createFrame();
      div.resize(732, 1);
      div.fills = solid(C.graphite);
      right.appendChild(div);

      const failureRow = figma.createFrame();
      failureRow.layoutMode = 'VERTICAL';
      failureRow.itemSpacing = 8;
      failureRow.fills = [];
      failureRow.appendChild(makeText("• Checkpoint Paralysis: 0 progress while away from desk", fontRegular, 15, C.silver));
      failureRow.appendChild(makeText("• Rogue Execution: Hallucinated commands wipe data with 0 killswitch", fontRegular, 15, C.silver));
      failureRow.appendChild(makeText("• The Mobile SSH Anti-Pattern: Insecure open ports & unreadable 8pt fonts", fontRegular, 15, C.silver));
      right.appendChild(failureRow);

      s.appendChild(right);
      allSlides.push(s);
    }

    // ==========================================
    // SLIDE 02: THE IDENTITY & MENTAL MODEL
    // "The autonomous engineering control plane."
    // ==========================================
    {
      const s = makeSlide(2, "The Identity");

      const left = figma.createFrame();
      left.layoutMode = 'VERTICAL';
      left.itemSpacing = 28;
      left.x = 120;
      left.y = 300;
      left.resize(760, 520);
      left.fills = [];

      left.appendChild(makePill("02 — THE IDENTITY", C.graphite, C.auroraCyan));
      const h1 = makeText("The autonomous engineering control plane.", fontBold, 76, C.frost, { letterSpacing: -2.0, lineHeight: 86 });
      h1.resize(740, 180);
      left.appendChild(h1);

      const sub = makeText("Not an SSH client. Not a remote desktop. A hardware-isolated flight deck that separates heavy compute from mobile authority.", fontRegular, 22, C.silver, { lineHeight: 32 });
      sub.resize(700, 100);
      left.appendChild(sub);
      s.appendChild(left);

      // Right: Evidence Card
      const right = makeCard(820, 500, { padding: 40, itemSpacing: 22 });
      right.x = 980;
      right.y = 290;

      right.appendChild(makeText("THE DUAL-HEMISPHERE SYSTEM", fontSemiBold, 12, C.slate, { letterSpacing: 1.5 }));

      const nodesRow = figma.createFrame();
      nodesRow.layoutMode = 'HORIZONTAL';
      nodesRow.itemSpacing = 20;
      nodesRow.fills = [];

      // Node Left: Mobile
      const nodeA = makeCard(360, 260, { padding: 24, itemSpacing: 12, bg: C.deepInk });
      nodeA.appendChild(makePill("iQOO 15 (BimaxGo)", C.auroraCyan, C.auroraCyan));
      nodeA.appendChild(makeText("• Snapdragon 8 Elite NPU\n• On-chip SLM diff triage\n• StrongBox EC P-256 HSM\n• Hardware Panic volume abort", fontRegular, 14, C.silver, { lineHeight: 22 }));
      nodesRow.appendChild(nodeA);

      // Node Right: Mac
      const nodeB = makeCard(360, 260, { padding: 24, itemSpacing: 12, bg: C.deepInk });
      nodeB.appendChild(makePill("Mac Workstation (bimaxd)", C.signalBlue, C.signalBlue));
      nodeB.appendChild(makeText("• Master POSIX PTY supervisor\n• Zero-sudo Mach kernel vitals\n• Atomic SIGSTOP -PGID\n• Ephemeral credential broker", fontRegular, 14, C.silver, { lineHeight: 22 }));
      nodesRow.appendChild(nodeB);

      right.appendChild(nodesRow);

      const connText = makeText("Connected through Cloudflare Edge  •  Noise_IK 1-RTT E2EE  •  0 Open Inbound Ports", fontMedium, 14, C.mint, { letterSpacing: 0.5 });
      right.appendChild(connText);

      const bottomRule = makeText("CORE PREMISE: Heavy code compiles on the Mac. Perception, triage, and authority stay in your hand.", fontRegular, 14, C.slate);
      right.appendChild(bottomRule);

      s.appendChild(right);
      allSlides.push(s);
    }

    // ==========================================
    // SLIDE 03: THE ANTIDOTE MATRIX
    // "Engineering the antidote."
    // ==========================================
    {
      const s = makeSlide(3, "Problem to Solution");

      const left = figma.createFrame();
      left.layoutMode = 'VERTICAL';
      left.itemSpacing = 28;
      left.x = 120;
      left.y = 300;
      left.resize(760, 520);
      left.fills = [];

      left.appendChild(makePill("03 — THE ANTIDOTE", C.graphite, C.mint));
      const h1 = makeText("Engineering the antidote.", fontBold, 76, C.frost, { letterSpacing: -2.0, lineHeight: 86 });
      h1.resize(740, 180);
      left.appendChild(h1);

      const sub = makeText("We didn't build generic mobile features. We engineered concrete cryptographic and kernel countermeasures for every failure mode.", fontRegular, 22, C.silver, { lineHeight: 32 });
      sub.resize(700, 100);
      left.appendChild(sub);
      s.appendChild(left);

      // Right: Evidence Card
      const right = makeCard(820, 500, { padding: 36, itemSpacing: 16 });
      right.x = 980;
      right.y = 290;

      right.appendChild(makeText("THE BIMAX COUNTERMEASURE MATRIX", fontSemiBold, 12, C.slate, { letterSpacing: 1.5 }));

      const tableData = [
        { pain: "Stalled Checkpoints", fix: "PTY Sliding-Window + FCM v1 wake", metric: "<50ms" },
        { pain: "Rogue Destruction", fix: "StrongBox HSM ultrasonic biometrics", metric: "EC P-256" },
        { pain: "Runaway Agent Loops", fix: "Negative PGID SIGSTOP volume kill", metric: "0 ms" },
        { pain: "Insecure Port 22", fix: "Outbound-only Cloudflare edge tunnel", metric: "0 Ports" },
        { pain: "Cognitive Diff Fatigue", fix: "Snapdragon 8 Elite AST hunk scoring", metric: "85% save" }
      ];

      for (const row of tableData) {
        const rBox = figma.createFrame();
        rBox.resize(748, 54);
        rBox.cornerRadius = 8;
        rBox.layoutMode = 'HORIZONTAL';
        rBox.primaryAxisAlignItems = 'SPACE_BETWEEN';
        rBox.counterAxisAlignItems = 'CENTER';
        rBox.paddingLeft = 16;
        rBox.paddingRight = 16;
        rBox.fills = solid(C.deepInk);

        const leftSide = figma.createFrame();
        leftSide.layoutMode = 'HORIZONTAL';
        leftSide.itemSpacing = 16;
        leftSide.fills = [];
        leftSide.appendChild(makeText(row.pain, fontSemiBold, 14, C.frost));
        leftSide.appendChild(makeText("──►  " + row.fix, fontRegular, 13, C.silver));
        rBox.appendChild(leftSide);

        rBox.appendChild(makeText(row.metric, fontBold, 13, C.mint));
        right.appendChild(rBox);
      }

      const foot = makeText("Software is never allowed to approve software. Physical silicon holds the master key.", fontRegular, 13, C.slate);
      right.appendChild(foot);

      s.appendChild(right);
      allSlides.push(s);
    }

    // ==========================================
    // SLIDE 04: THE 5 BREAKTHROUGHS
    // "Not just an app. A hardware superpower."
    // ==========================================
    {
      const s = makeSlide(4, "The 5 Breakthroughs");

      const left = figma.createFrame();
      left.layoutMode = 'VERTICAL';
      left.itemSpacing = 28;
      left.x = 120;
      left.y = 300;
      left.resize(760, 520);
      left.fills = [];

      left.appendChild(makePill("04 — THE BREAKTHROUGHS", C.graphite, C.signalBlue));
      const h1 = makeText("Not just an app. A hardware superpower.", fontBold, 76, C.frost, { letterSpacing: -2.0, lineHeight: 86 });
      h1.resize(740, 180);
      left.appendChild(h1);

      const sub = makeText("Five breakthrough capabilities engineered at the intersection of Snapdragon silicon, macOS Darwin internals, and hardware cryptography.", fontRegular, 22, C.silver, { lineHeight: 32 });
      sub.resize(700, 100);
      left.appendChild(sub);
      s.appendChild(left);

      // Right: Evidence Card
      const right = makeCard(820, 500, { padding: 36, itemSpacing: 14 });
      right.x = 980;
      right.y = 290;

      right.appendChild(makeText("THE 5 HARDWARE CAPABILITIES", fontSemiBold, 12, C.slate, { letterSpacing: 1.5 }));

      const feats = [
        { num: "01", title: "0ms Hardware Killswitch", desc: "Double-tap volume button: atomic SIGSTOP -PGID freezes all child processes." },
        { num: "02", title: "StrongBox HSM Biometric Gate", desc: "Ultrasonic fingerprint signs high-risk actions with unexportable NIST EC P-256." },
        { num: "03", title: "Snapdragon 8 Elite On-Chip SLM", desc: "Oryon CPU ARM I8MM SIMD collapses 5,000-line diffs to 3 bullets in <2s offline." },
        { num: "04", title: "Zero-Permission SMS 2FA Relay", desc: "Play Services SMS Consent catches OTPs; biometrically types into Mac Playwright." },
        { num: "05", title: "vivo Office Kit 3-Column Cockpit", desc: "Dock to monitor: Jetpack Compose morphs into a 60fps engineering workstation." }
      ];

      for (const f of feats) {
        const item = figma.createFrame();
        item.layoutMode = 'HORIZONTAL';
        item.itemSpacing = 16;
        item.fills = [];
        item.appendChild(makeText(f.num, fontBold, 15, C.auroraCyan));

        const textCol = figma.createFrame();
        textCol.layoutMode = 'VERTICAL';
        textCol.itemSpacing = 2;
        textCol.fills = [];
        textCol.appendChild(makeText(f.title, fontSemiBold, 15, C.frost));
        textCol.appendChild(makeText(f.desc, fontRegular, 13, C.silver));
        item.appendChild(textCol);

        right.appendChild(item);
      }

      s.appendChild(right);
      allSlides.push(s);
    }

    // ==========================================
    // SLIDE 05: STRATEGIC PRIORITIES & NON-NEGOTIABLES
    // "The discipline of restraint."
    // ==========================================
    {
      const s = makeSlide(5, "Non-Negotiables");

      const left = figma.createFrame();
      left.layoutMode = 'VERTICAL';
      left.itemSpacing = 28;
      left.x = 120;
      left.y = 300;
      left.resize(760, 520);
      left.fills = [];

      left.appendChild(makePill("05 — STRATEGIC PRIORITIES", C.graphite, C.auroraCyan));
      const h1 = makeText("The discipline of restraint.", fontBold, 76, C.frost, { letterSpacing: -2.0, lineHeight: 86 });
      h1.resize(740, 180);
      left.appendChild(h1);

      const sub = makeText("Great engineering is defined by what you refuse to compromise. We established four non-negotiable rules for autonomous control.", fontRegular, 22, C.silver, { lineHeight: 32 });
      sub.resize(700, 100);
      left.appendChild(sub);
      s.appendChild(left);

      // Right: Evidence Card
      const right = makeCard(820, 500, { padding: 40, itemSpacing: 22 });
      right.x = 980;
      right.y = 290;

      right.appendChild(makeText("THE BIMAX NON-NEGOTIABLE LEDGER", fontSemiBold, 12, C.slate, { letterSpacing: 1.5 }));

      const tenets = [
        { rule: "Zero Inbound Holes", build: "Outbound-only Cloudflare tunnel", refuse: "No open port 22, no UPnP, no public IP exposure." },
        { rule: "Hardware Authority", build: "StrongBox HSM biometric enclave", refuse: "Software never approves software. No auto-approve checkboxes." },
        { rule: "On-Chip Privacy", build: "Snapdragon 8 Elite local SLM", refuse: "Zero bouncing of raw diffs or code to 3rd-party cloud LLMs." },
        { rule: "Pure Flight Deck", build: "Focused telemetry & triage UI", refuse: "No cramming bloated multi-tab IDEs onto a 6.7-inch mobile screen." }
      ];

      for (const t of tenets) {
        const box = figma.createFrame();
        box.layoutMode = 'VERTICAL';
        box.itemSpacing = 4;
        box.fills = [];
        box.appendChild(makeText(t.rule + "  ──►  " + t.build, fontSemiBold, 15, C.frost));
        box.appendChild(makeText("Refusal: " + t.refuse, fontRegular, 13, C.slate));
        right.appendChild(box);
      }

      const quote = makeText("Built for enterprise paranoia. Engineered for developer velocity.", fontMedium, 14, C.mint);
      right.appendChild(quote);

      s.appendChild(right);
      allSlides.push(s);
    }

    // ==========================================
    // SLIDE 06: THE COMPETITIVE LANDSCAPE
    // "A category of one."
    // ==========================================
    {
      const s = makeSlide(6, "Competitive Moat");

      const left = figma.createFrame();
      left.layoutMode = 'VERTICAL';
      left.itemSpacing = 28;
      left.x = 120;
      left.y = 300;
      left.resize(760, 520);
      left.fills = [];

      left.appendChild(makePill("06 — THE LANDSCAPE", C.graphite, C.signalBlue));
      const h1 = makeText("A category of one.", fontBold, 76, C.frost, { letterSpacing: -2.0, lineHeight: 86 });
      h1.resize(740, 180);
      left.appendChild(h1);

      const sub = makeText("Traditional mobile tools treat AI like an SSH log. Cloud platforms abandon your local workstation. Bimax unifies security, mobility, and intelligence.", fontRegular, 22, C.silver, { lineHeight: 32 });
      sub.resize(700, 100);
      left.appendChild(sub);
      s.appendChild(left);

      // Right: Evidence Card (Comparison Matrix)
      const right = makeCard(820, 500, { padding: 36, itemSpacing: 16 });
      right.x = 980;
      right.y = 290;

      right.appendChild(makeText("COMPETITIVE CAPABILITY MATRIX", fontSemiBold, 12, C.slate, { letterSpacing: 1.5 }));

      // Table Header
      const th = figma.createFrame();
      th.resize(748, 28);
      th.layoutMode = 'HORIZONTAL';
      th.itemSpacing = 20;
      th.fills = [];
      th.appendChild(makeText("CAPABILITY", fontSemiBold, 12, C.slate));
      right.appendChild(th);

      const matrix = [
        { cap: "0 Open Ports (Inbound Security)", termius: "❌ Port 22", tailscale: "⚠️ Mesh IP", bimax: "✅ Outbound Tunnel" },
        { cap: "Agent Checkpoint Intercept", termius: "❌ None", tailscale: "❌ None", bimax: "✅ PTY Regex + Push" },
        { cap: "On-Chip Diff Privacy", termius: "❌ None", tailscale: "❌ None", bimax: "✅ Snapdragon SLM" },
        { cap: "Hardware Biometric Gate", termius: "❌ None", tailscale: "❌ None", bimax: "✅ StrongBox HSM" },
        { cap: "0ms Emergency Killswitch", termius: "❌ Manual", tailscale: "❌ Manual", bimax: "✅ Hardware SIGSTOP" },
        { cap: "Local Workstation Retained", termius: "✅ Yes", tailscale: "✅ Yes", bimax: "✅ Yes (Zero Cloud Lock)" }
      ];

      for (const m of matrix) {
        const row = figma.createFrame();
        row.resize(748, 44);
        row.cornerRadius = 6;
        row.layoutMode = 'HORIZONTAL';
        row.primaryAxisAlignItems = 'SPACE_BETWEEN';
        row.counterAxisAlignItems = 'CENTER';
        row.paddingLeft = 14;
        row.paddingRight = 14;
        row.fills = solid(C.deepInk);

        row.appendChild(makeText(m.cap, fontMedium, 13, C.frost));

        const rightVals = figma.createFrame();
        rightVals.layoutMode = 'HORIZONTAL';
        rightVals.itemSpacing = 24;
        rightVals.fills = [];
        rightVals.appendChild(makeText("SSH: " + m.termius, fontRegular, 12, C.slate));
        rightVals.appendChild(makeText("BIMAX: " + m.bimax, fontBold, 12, C.mint));
        row.appendChild(rightVals);

        right.appendChild(row);
      }

      s.appendChild(right);
      allSlides.push(s);
    }

    // ==========================================
    // SLIDE 07: THE QUANTITATIVE MOAT
    // "Measured in orders of magnitude."
    // ==========================================
    {
      const s = makeSlide(7, "Quantitative Moat");

      const left = figma.createFrame();
      left.layoutMode = 'VERTICAL';
      left.itemSpacing = 28;
      left.x = 120;
      left.y = 300;
      left.resize(760, 520);
      left.fills = [];

      left.appendChild(makePill("07 — QUANTITATIVE MOAT", C.graphite, C.mint));
      const h1 = makeText("Measured in orders of magnitude.", fontBold, 76, C.frost, { letterSpacing: -2.0, lineHeight: 86 });
      h1.resize(740, 180);
      left.appendChild(h1);

      const sub = makeText("Bimax is not 10% faster. It is mathematically and architecturally superior across every critical engineering vector.", fontRegular, 22, C.silver, { lineHeight: 32 });
      sub.resize(700, 100);
      left.appendChild(sub);
      s.appendChild(left);

      // Right: Evidence Card (4 Big Metrics)
      const right = makeCard(820, 500, { padding: 36, itemSpacing: 20 });
      right.x = 980;
      right.y = 290;

      right.appendChild(makeText("VERIFIED HARDWARE BENCHMARKS", fontSemiBold, 12, C.slate, { letterSpacing: 1.5 }));

      const gridRow1 = figma.createFrame();
      gridRow1.layoutMode = 'HORIZONTAL';
      gridRow1.itemSpacing = 20;
      gridRow1.fills = [];

      const m1 = makeCard(364, 180, { padding: 24, itemSpacing: 8, bg: C.deepInk });
      m1.appendChild(makeText("85%", fontBold, 54, C.frost, { gradient: true }));
      m1.appendChild(makeText("Less Vision Tokens", fontBold, 16, C.frost));
      m1.appendChild(makeText("16,258t -> 2,459t via Spectra WebP", fontRegular, 13, C.silver));
      gridRow1.appendChild(m1);

      const m2 = makeCard(364, 180, { padding: 24, itemSpacing: 8, bg: C.deepInk });
      m2.appendChild(makeText("0 ms", fontBold, 54, C.frost, { gradient: true }));
      m2.appendChild(makeText("Child Process Freeze", fontBold, 16, C.frost));
      m2.appendChild(makeText("Atomic SIGSTOP across all CPU cores", fontRegular, 13, C.silver));
      gridRow1.appendChild(m2);
      right.appendChild(gridRow1);

      const gridRow2 = figma.createFrame();
      gridRow2.layoutMode = 'HORIZONTAL';
      gridRow2.itemSpacing = 20;
      gridRow2.fills = [];

      const m3 = makeCard(364, 180, { padding: 24, itemSpacing: 8, bg: C.deepInk });
      m3.appendChild(makeText("0", fontBold, 54, C.frost, { gradient: true }));
      m3.appendChild(makeText("Inbound Open Ports", fontBold, 16, C.frost));
      m3.appendChild(makeText("Outbound-only. Zero public attack surface", fontRegular, 13, C.silver));
      gridRow2.appendChild(m3);

      const m4 = makeCard(364, 180, { padding: 24, itemSpacing: 8, bg: C.deepInk });
      m4.appendChild(makeText("10×", fontBold, 54, C.frost, { gradient: true }));
      m4.appendChild(makeText("Mobile Battery Longevity", fontBold, 16, C.frost));
      m4.appendChild(makeText("DO Hibernation drops drain to <0.3%/h", fontRegular, 13, C.silver));
      gridRow2.appendChild(m4);
      right.appendChild(gridRow2);

      s.appendChild(right);
      allSlides.push(s);
    }

    // ==========================================
    // SLIDE 08: SILICON & TECHNOLOGY STACK
    // "Built on bare metal."
    // ==========================================
    {
      const s = makeSlide(8, "Tech Stack");

      const left = figma.createFrame();
      left.layoutMode = 'VERTICAL';
      left.itemSpacing = 28;
      left.x = 120;
      left.y = 300;
      left.resize(760, 520);
      left.fills = [];

      left.appendChild(makePill("08 — SILICON & STACK", C.graphite, C.auroraCyan));
      const h1 = makeText("Built on bare metal.", fontBold, 76, C.frost, { letterSpacing: -2.0, lineHeight: 86 });
      h1.resize(740, 180);
      left.appendChild(h1);

      const sub = makeText("No electron wrappers. No simulated terminals. Bimax is engineered directly on silicon, kernel syscalls, and edge primitives.", fontRegular, 22, C.silver, { lineHeight: 32 });
      sub.resize(700, 100);
      left.appendChild(sub);
      s.appendChild(left);

      // Right: Evidence Card (3 Tiers)
      const right = makeCard(820, 500, { padding: 36, itemSpacing: 16 });
      right.x = 980;
      right.y = 290;

      right.appendChild(makeText("THE THREE BARE-METAL TIERS", fontSemiBold, 12, C.slate, { letterSpacing: 1.5 }));

      const tiers = [
        {
          name: "1. ANDROID SILICON TIER (iQOO 15)",
          color: C.auroraCyan,
          details: "Snapdragon 8 Elite Oryon CPU (ARM I8MM SIMD) • StrongBox HSM (NIST EC P-256) • Jetpack Compose 60fps Zero-GC Ring Buffer"
        },
        {
          name: "2. CLOUDFLARE EDGE TIER (Zero Trust Relay)",
          color: C.mint,
          details: "Worker DO Hibernation (Zero Idle Compute Cost) • Noise_IK 1-RTT E2EE (ChaCha20-Poly1305) • RFC 6479 1024-Bit Anti-Replay"
        },
        {
          name: "3. MACOS WORKSTATION TIER (bimaxd Daemon)",
          color: C.signalBlue,
          details: "Master POSIX PTY Supervisor (Setpgid: true) • Darwin Mach Kernel host_statistics64 (Zero Sudo) • Atomic SIGSTOP -PGID"
        }
      ];

      for (const tr of tiers) {
        const tCard = makeCard(748, 105, { padding: 18, itemSpacing: 6, bg: C.deepInk });
        tCard.appendChild(makeText(tr.name, fontSemiBold, 13, tr.color, { letterSpacing: 1.0 }));
        const tDesc = makeText(tr.details, fontRegular, 13, C.silver, { lineHeight: 20 });
        tDesc.resize(712, 42);
        tCard.appendChild(tDesc);
        right.appendChild(tCard);
      }

      const compliance = makeText("COMPLIANCE: FIPS 186-4  •  POSIX.1-2017  •  RFC 6455  •  Noise Protocol rev 34", fontRegular, 12, C.slate);
      right.appendChild(compliance);

      s.appendChild(right);
      allSlides.push(s);
    }

    // ==========================================
    // SLIDE 09: CORE METHODOLOGIES & SCIENCE
    // "Grounded in foundational science."
    // ==========================================
    {
      const s = makeSlide(9, "Methodologies");

      const left = figma.createFrame();
      left.layoutMode = 'VERTICAL';
      left.itemSpacing = 28;
      left.x = 120;
      left.y = 300;
      left.resize(760, 520);
      left.fills = [];

      left.appendChild(makePill("09 — METHODOLOGIES", C.graphite, C.mint));
      const h1 = makeText("Grounded in foundational science.", fontBold, 76, C.frost, { letterSpacing: -2.0, lineHeight: 86 });
      h1.resize(740, 180);
      left.appendChild(h1);

      const sub = makeText("Heuristics and guesswork fail under enterprise load. Bimax is engineered on four proven mathematical disciplines.", fontRegular, 22, C.silver, { lineHeight: 32 });
      sub.resize(700, 100);
      left.appendChild(sub);
      s.appendChild(left);

      // Right: Evidence Card (4 Formulations)
      const right = makeCard(820, 500, { padding: 36, itemSpacing: 14 });
      right.x = 980;
      right.y = 290;

      right.appendChild(makeText("THE FOUR SCIENTIFIC FOUNDATIONS", fontSemiBold, 12, C.slate, { letterSpacing: 1.5 }));

      const methods = [
        {
          num: "1",
          title: "ACM TOSEM Hunk Scoring Formula",
          formula: "Score(h_i) = 3(N_add + N_del) + 5*I_core + 4*I_test + ...",
          desc: "Collapses 5,000-line diffs to <=1000 tokens (96% noise reduction)."
        },
        {
          num: "2",
          title: "Shannon Information Entropy (H >= 4.5)",
          formula: "H(S) = -sum( P(c_i) * log2(P(c_i)) ) >= 4.5",
          desc: "Intercepts unindexed API keys & secrets client-side before transmission."
        },
        {
          num: "3",
          title: "Noise_IK 1-RTT Mutual Handshake",
          formula: "e, es, s, ss over Curve25519 + ChaCha20-Poly1305 + BLAKE2s",
          desc: "RFC 6479 1024-bit sliding window prevents replay attacks."
        },
        {
          num: "4",
          title: "Zero-Allocation VT100 Ring Buffer",
          formula: "Index = (head + offset) mod capacity",
          desc: "10,000-line pre-allocated circular buffer renders at 120fps with 0 GC pauses."
        }
      ];

      for (const m of methods) {
        const box = figma.createFrame();
        box.layoutMode = 'VERTICAL';
        box.itemSpacing = 2;
        box.fills = [];
        box.appendChild(makeText(m.num + ". " + m.title, fontSemiBold, 14, C.auroraCyan));
        box.appendChild(makeText(m.formula, fontBold, 13, C.frost));
        box.appendChild(makeText(m.desc, fontRegular, 12, C.silver));
        right.appendChild(box);
      }

      s.appendChild(right);
      allSlides.push(s);
    }

    // ==========================================
    // SLIDE 10: VISION & CLOSE
    // "From assistant to operator."
    // ==========================================
    {
      const s = makeSlide(10, "Vision");

      const center = figma.createFrame();
      center.layoutMode = 'VERTICAL';
      center.counterAxisAlignItems = 'CENTER';
      center.primaryAxisAlignItems = 'CENTER';
      center.itemSpacing = 28;
      center.resize(1720, 800);
      center.x = 100;
      center.y = 140;
      center.fills = [];

      center.appendChild(makePill("10 — THE HORIZON", C.graphite, C.auroraCyan));

      const h1 = makeText("From assistant to operator.", fontBold, 88, C.frost, { letterSpacing: -2.5, gradient: true });
      center.appendChild(h1);

      const sub = makeText("The future of software engineering is autonomous. You hold the controls.", fontMedium, 28, C.silver, { align: 'CENTER' });
      center.appendChild(sub);

      const spacer = figma.createFrame();
      spacer.resize(1, 20);
      spacer.fills = [];
      center.appendChild(spacer);

      const closeCard = makeCard(760, 200, { padding: 36, itemSpacing: 14, bg: C.carbon });
      closeCard.appendChild(makeText("BIMAX", fontBold, 26, C.frost));
      closeCard.appendChild(makeText("One request. The whole workflow.", fontRegular, 19, C.silver));
      closeCard.appendChild(makeText("bimax.ai  •  github.com/Sid7on1/BimaxApk", fontSemiBold, 15, C.auroraCyan));
      center.appendChild(closeCard);

      s.appendChild(center);
      allSlides.push(s);
    }

    // Finalize: Select all slides & zoom into view
    figma.currentPage.selection = allSlides;
    figma.viewport.scrollAndZoomIntoView(allSlides);
    figma.closePlugin(" Apple-Class 10-Slide Master Deck Generated!");
  } catch (err) {
    console.error("Figma Plugin Error:", err);
    figma.notify("⚠️ Error: " + (err.message || String(err)), { error: true });
    figma.closePlugin();
  }
})();
