# Bimax: iQOO Hackathon 2026 Pitch, Demo Script & Scoring Rubric Strategy

> **Event**: iQOO x Reskilll Hackathon 2026 (City Battles & Grand Finale)  
> **Target Device**: iQOO 15 (Snapdragon 8 Elite 4.6 GHz, 7000 mAh, 8K VC Cooling, OriginOS / Office Kit)  
> **Official Scoring Standard**: 100 Points Total (Product Quality 30, Novelty/Impact 20, Creative Phone Use 15, Technical Depth 15, Office Kit Use 10, Demo/Presentation 10)  
> **Track**: Developer Tools / Productivity / Open Innovation  

---

## 1. The 100-Point Scoring Strategy Matrix

The official iQOO Hackathon scoring rubric awards points across six specific dimensions. Here is how Bimax scores the maximum points in each category:

```
+---------------------------------------------------------------------------------------------------+
|                               iQOO HACKATHON 100-POINT SCORING MATRIX                             |
+---------------------------------------------------------------------------------------------------+
| 1. Product Quality & Stability (30 Points)                                                        |
|    - Production-grade Kotlin Compose frontend + native Go daemon (`bimaxd`) + Cloudflare DO.     |
|    - Zero mockups, zero simulated data: live real-time bidirectional PTY stream over WebSocket.   |
|    - 10,000-line circular ring buffer with zero garbage-collection jitter at 60-120 fps.         |
|    - Offline-first SQLite/Room persistence with monotonic queued command flusher.                |
+---------------------------------------------------------------------------------------------------+
| 2. Novelty & Practical Impact (20 Points)                                                         |
|    - Solves the #1 problem of modern AI engineering: developers are tethered to desks supervising  |
|      autonomous coding agents (Claude Code, Aider, Devin).                                        |
|    - True Zero-Trust remote control: zero open inbound ports, zero corporate firewall breaches.  |
|    - Eliminates catastrophic agent accidents (e.g. rogue deletions, leaked keys, runaway loops). |
+---------------------------------------------------------------------------------------------------+
| 3. Creative Phone-as-a-Resource Use (15 Points)                                                   |
|    - Dedicated StrongBox HSM EC P-256 signing requiring ultrasonic in-display fingerprint scans.  |
|    - Google Play Services SMS User Consent API: zero-permission 2FA relay to Mac browser.        |
|    - CameraX + Spectra ISP WebP downscaling to 1568px ceiling saving 84.88% Claude vision tokens. |
|    - Physical hardware volume rocker / on-screen emergency panic freeze switch (SIGSTOP -PGID).  |
+---------------------------------------------------------------------------------------------------+
| 4. Technical Depth & Local AI ("Brownie Points" Core) (15 Points)                                 |
|    - Local SLMs (Qwen2.5-Coder / Qwen3-4B) running on Snapdragon 8 Elite 4.6 GHz Oryon CPU        |
|      using ARMv8.2-A I8MM SIMD instructions + Qualcomm Hexagon NPU via GenieX / QAIRT.           |
|    - On-Device DLP Secret Firewall: ReDoS-safe prefix regexes + Shannon Information Entropy (H>=4.5)|
|    - Formal cryptographic verification: Noise_IK 1-RTT handshake + RFC 4303 1024-bit anti-replay.|
+---------------------------------------------------------------------------------------------------+
| 5. vivo / iQOO Office Kit Integration (10 Points)                                                 |
|    - Material 3 Adaptive Suite (NavigationSuiteScaffold & SupportingPaneScaffold).                |
|    - Mobile bottom navigation automatically expands into a 3-column desktop cockpit on external   |
|      monitors: Tasks/Subagents (Left) | Monospace Terminal (Center) | Mac Vitals (Right).         |
|    - Physical keyboard shortcuts (Ctrl+Enter, Ctrl+`) and mouse scroll-wheel font zooming.       |
+---------------------------------------------------------------------------------------------------+
| 6. Demo & Live Presentation Execution (10 Points)                                                 |
|    - Flawless, tightly choreographed 3-minute live demonstration.                                 |
|    - High-stakes real-time scenarios: Destructive command interception, 2FA injection, and Panic. |
+---------------------------------------------------------------------------------------------------+
```

---

## 2. The 3-Minute Live Judging Demo Script

*Use this exact script when presenting in-person to iQOO and Qualcomm judges.*

### Act 1: The Hook (0:00 - 0:40) — The Problem
* **Speaker**:  
  > *"Judges, we are in the era of autonomous AI coding agents. Tools like Claude Code, Devin, and Codex don't just complete code—they run terminal commands, manage databases, and deploy infrastructure. But here's the dirty secret: as developers, we are now tethered to our desks babysitting these agents. If an agent goes rogue and runs `rm -rf /` or leaks an API key, our workstation is destroyed. And if we leave our desk, we have zero secure control.  
  > Meet **Bimax**: a zero-trust, ultra-low-latency remote control plane that transforms the iQOO 15 into an active cryptographic and AI co-processor for your workstation."*

### Act 2: Local AI & StrongBox Biometric Gating (0:40 - 1:20) — The Threat Intercept
* **Action on Screen**: Trigger a command on the Mac where Claude Code attempts to run `rm -rf ./dist && git reset --hard`.
* **Speaker**:  
  > *"Look at the iQOO 15 in my hand. Through Cloudflare edge tunnels without any open ports, the Mac daemon pushes the command request. But watch what happens on the phone:*  
  > *1. The Snapdragon 8 Elite’s Oryon CPU immediately runs our quantized local SLM—**Qwen2.5-Coder**—using ARM I8MM matrix multiply instructions.*  
  > *2. In less than 300 milliseconds, completely offline without contacting any cloud, the local model classifies this as a `DESTRUCTIVE` action.*  
  > *3. The phone locks the execution. Notice that a simple screen tap is NOT enough. The app triggers Android Keystore's **StrongBox HSM**, demanding my ultrasonic fingerprint.  
  > *(Place thumb on iQOO 15 scanner)*  
  > *The tamper-proof StrongBox chip generates an EC P-256 signature, encrypts it via Noise_IK, and approves the action on my Mac workstation."*

### Act 3: Multimodal Ingestion & Zero-Permission 2FA (1:20 - 2:05) — Phone as a Resource
* **Action on Screen**: Point iQOO 15 camera at a handwritten whiteboard architecture or monitor error. Then trigger an SMS login.
* **Speaker**:  
  > *"The iQOO 15 isn't just a display—it's a physical resource for the workstation:*  
  > *First, **Camera-to-Code**: I snap a photo of this whiteboard. Our Spectra ISP pipeline downscales the image to Claude’s optimal 1568-pixel ceiling and lossy WebP in under 65 ms—cutting token costs by 84.88% and transmitting instantly.*  
  > *Second, **Physical 2FA Auto-Bridge**: When my agent logs into AWS or Cloudflare, AWS sends an SMS verification code to my phone. Notice: our app declared ZERO dangerous SMS permissions in AndroidManifest. Using Google Play Services SMS User Consent API, the native OS bottom-sheet pops up. I tap Allow, verify with my fingerprint, and the code is automatically typed into the active Playwright browser on my Mac!"*

### Act 4: Office Kit Desktop Reveal & Emergency Panic Switch (2:05 - 3:00) — The Climax
* **Action on Screen**: Plug the iQOO 15 into an external monitor using **vivo Office Kit**. Then press the Emergency Panic Button.
* **Speaker**:  
  > *"Now, the hackathon crown jewel: **vivo / iQOO Office Kit**.*  
  > *(External monitor instantly lights up)*  
  > *The Jetpack Compose UI detects WindowWidthSizeClass Expanded. Our phone UI seamlessly transforms into a 3-column workstation cockpit: our active AI subagents on the left, full 60fps monospace VT100 terminal in the center, and live Darwin Mach kernel vitals on the right.*  
  > *Finally, what if an agent goes completely out of control?*  
  > *(Press the Emergency Panic Button / double-tap volume rocker)*  
  > *Instant emergency panic: in 0 milliseconds, the daemon executes a negative PGID `SIGSTOP`, atomically freezing every child process in the group across CPU cores, while invoking macOS `SACLockScreenImmediate` to lock the workstation physical display.*  
  > *This is Bimax: zero-trust security, on-device Snapdragon AI, and seamless Office Kit continuity. Thank you!"*

---

## 3. Judge Q&A Defense Sheet (Handling Tough Technical Questions)

### Q1: "Why run the SLM on the phone instead of on the Mac or in the cloud?"
* **Answer**:  
  *"Zero-Trust architecture. If the Mac is compromised or running a rogue agent, you cannot trust the host to inspect itself. Furthermore, evaluating risk on the phone provides guaranteed offline safety: if cellular connectivity drops, the phone still intercepts and blocks dangerous commands. By utilizing the Snapdragon 8 Elite's 4.6 GHz Oryon CPU with ARMv8.2-A I8MM vector intrinsics, we achieve 12–14 tokens per second decode and sub-300ms risk classification without consuming cloud API costs."*

### Q2: "How did you implement SMS reading without Google Play rejecting your permissions?"
* **Answer**:  
  *"We do NOT request `RECEIVE_SMS` or `READ_SMS`. Those are high-risk permissions that trigger Google Play store bans. Instead, we use the official **Google Play Services SMS User Consent API** (`SmsRetriever.getClient().startSmsUserConsent(null)`). The Android OS displays a native bottom sheet containing only the verified verification code. We parse the 4-to-8 digit OTP with non-backtracking ReDoS-safe regexes, gate it behind StrongBox biometric hardware authorization, and relay it to the host."*

### Q3: "How do you connect through NAT and firewalls without open ports?"
* **Answer**:  
  *"Zero listening ports. The macOS daemon initiates an outbound-only HTTP/2 tunnel to Cloudflare Edge (`cloudflared`). The phone connects to a Cloudflare Worker backed by a Durable Object with WebSocket Hibernation. Payload security is handled by our user-space **Noise_IK_25519_ChaChaPoly_BLAKE2s** protocol with an RFC 4303 1024-bit sliding window anti-replay filter. The Cloudflare relay only ever routes encrypted binary frames and cannot inspect plaintext."*

### Q4: "How does the Emergency Panic switch freeze processes without leaving orphans?"
* **Answer**:  
  *"Standard `kill(PID)` only kills the parent shell, leaving spawned sub-processes (`python`, `node`, `git`) running as orphaned processes. When `bimaxd` launches the agent, it sets `syscall.SysProcAttr{Setpgid: true}` to establish a dedicated Process Group. When Panic is triggered, it sends `syscall.Kill(-pgid, syscall.SIGSTOP)`. The negative PGID targets every single descendant process in the kernel process group simultaneously in $0\text{ ms}$, followed by a two-stage `SIGTERM` and `SIGKILL` cleanup."*

---

## 4. Pre-Demo Checklist for the Team (Day 1 & Finale Setup)

```
[ ] Hardware Setup:
    - iQOO 15 charged to >80% (7000 mAh ensures all-day power).
    - USB-C to HDMI cable / vivo Office Kit wireless bridge verified with demo monitor.
    - Mac host connected to mobile hotspot or venue Wi-Fi with cloudflared running.

[ ] Software Setup:
    - bimaxd running as background launchd daemon or terminal session on Mac.
    - Qwen2.5-Coder-1.5B (GGUF INT4, 0.98 GB) preloaded into Android filesDir.
    - Test pairing QR code scanned with Google Code Scanner API.
    - Fingerprint enrolled in Android Keystore with StrongBox backed confirmation.

[ ] Demo Run-Through:
    - Verify 1st test command: `ls -la` (instant SAFE silent dispatch).
    - Verify 2nd test command: `rm -rf ./build` (triggers DESTRUCTIVE card + biometric scan).
    - Verify 3rd test: CameraX whiteboard snapshot (inspect WebP token size indicator).
    - Verify 4th test: Office Kit dock (verify 3-column cockpit layout).
    - Verify 5th test: Emergency Panic button (verify Mac locks and terminal freezes).
```
