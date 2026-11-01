# Connect an iPhone using Expo Go

## Workspace-aware new chats and readable canvas — record 114

Use the updated coordinated Mac build and reload Expo Go. Drawer → Phone → New chat creates an
independent phone chat. Drawer → Mac → New Mac chat asks you to choose a folder known to Bimax on
the Mac. Nothing is preselected. Start new chat creates an empty saved conversation in that folder;
the first message addresses its fresh id. Mac Home can stay open. If there are no folders, add/open
one on the Mac first. Existing chats keep their saved folder regardless of the Mac's current screen.
Folder identity appears in history and the selected Mac chat header. Changing chats clears the
previous transcript and unsent draft. Settings → Chat text size offers Comfortable and Large.
Code/table frames and live/completed message layout share Desktop implementation.

Source/rendered/encrypted integration checks pass. The updated Desktop is installed with its 918
saved-data files preserved; the owner confirms it opens normally. Reload Expo Go. Physical current
phone visuals/gestures/roaming remain Target. See Desktop product-reset
[plan 113](/Users/vishsiddharth/Bimax/docs/product-reset/113_WORKSPACE_CHAT_AND_RETRIEVAL_PLAN.md) and
[record 114](/Users/vishsiddharth/Bimax/docs/product-reset/114_WORKSPACE_CHATS_RETRIEVAL_AND_CANVAS.md).

## Current settings and navigation — 25 October 2026, record 112

Reload Expo Go. Drawer → Phone shows only phone chats; Mac shows only Mac chats. Tap a row there
for the conversation. **Your Mac now opens connection settings**, superseding the chat-list route
in records 110–111 below. Settings has saved Reduce motion, Show thinking details and Follow new
replies controls. System Reduce Motion is always respected. Native Copy/shared Desktop message,
rich Markdown and changing-word thinking display are preserved; Mac-owned model/tool/OS settings
remain on the Mac. Source/browser tests verify these end states, not physical iPhone performance.

Mac connection shows **Current connection: Cloudflare / Local network / Offline**, with internet
configuration separately labelled. Cellular can carry encrypted Mac chat traffic when Cloudflare
is active and the home Mac stays awake, online and running Bimax. Chats remain stored on the Mac.
Local-network transport needs reachable LAN. With all internet off, there is no sync/model response.

The current **Expo Go development server is LAN-hosted**. Reloading or reopening the project away
from home still needs that server; working cloud chat does not remove this separate dependency.
Use an installed phone build before depending on away-from-home app opening. No new pairing or
Mac restart is required for this UI update. Physical current UI/cellular/background/native resources
remain Target: iPhone Mirroring timed out before an iPhone screen was available in this task.
See [Desktop record 112](/Users/vishsiddharth/Bimax/docs/product-reset/112_PHONE_PREFERENCES_AND_CONNECTION_SETTINGS.md).

## Message rendering and chat drawer — 25 October 2026, record 111

The owner confirms phone → Mac → reply works. Reload Expo Go for the current UI: the menu in
both phone and Mac chats opens a searchable left drawer with separate Mac/phone groups, selected
chat highlighting and New chat. The Mac page is a conversation list; Send Instruction and its
command dashboard are removed. Both platforms now compile one shared message-presentation
component as well as the same Desktop Markdown/plugins/styles. Native Copy remains on the phone;
Desktop speech/ratings/privileged Outputs are not presented as unsupported phone controls.
The updated physical drawer/gestures/rendering still need the owner's check. Pairing/transport and
account state are preserved. See Desktop product-reset record 111 for scoped proof and Targets.

## Current flow — trusted live connection, 25 October 2026

1. Open the updated Mac app → Settings → Phone connection. Initial pairing is on the same private
   network and requires the one human verification-code comparison.
2. Reload the Bimax project in SDK-58-compatible Expo Go and sign in to the same Bimax account.
   Existing verified pairing does not require another scan for normal reconnects.
3. Open Chat history → Mac and tap a chat. Saved history loads once; replies and work started on the Mac
   arrive as live updates. There is no Mac approval dialog for each history/chat/command/file request.
4. The phone registers the paired Mac with the account-backed internet relay automatically. Mac
   Settings shows its outside-network connection status. Setup failure has its own Retry on Your
   Mac; working local chat remains usable. Do this once at home before depending on mobile data.
5. Tool actions that require a decision are reviewed on the phone. In Expo Go the OS may request
   the device passcode; the installed app retains strong biometric authentication. Cancel refuses
   the decision. The selected chat links directly to its pending action.
6. Once the cloud route is ready, the phone can use another network. The home Mac must remain
   awake, online and running Bimax. A sleeping Mac cannot run work and cannot be woken by this flow.
   The Mac's small Phone menu indicator retains Stop Phone Access; Forget removes device trust.

The deployed relay and isolated cloud/Noise roaming tests pass. The owner has not yet qualified this
new build's physical account registration, mobile data, phone OS decisions, app background/lock or
Mac sleep/wake. Desktop Outputs/attachments and native resource parity remain separate gates.
See [Desktop record 110](/Users/vishsiddharth/Bimax/docs/product-reset/110_TRUSTED_PHONE_LIVE_CONNECTION.md).
The dated notes below are history; their repeated native-consent/banner and Expo-Go-requires-Mac
approval statements are superseded by this current policy.

The linked Bimax for Mac now has **Settings → Phone connection**. It starts its own authenticated
LAN relay after you choose Enable. You do not need to run a separate relay or set BIMAX_RESPONDER
for this Settings flow. Existing mobile account sign-in and Mac consent remain required.

1. Keep the iPhone and Mac on the same private Wi-Fi; guest networks and VPNs can isolate devices.
2. In this repository, use Node 24 and start Expo:

   ```sh
   PATH=/opt/homebrew/opt/node@24/bin:$PATH npm --workspace mobile start -- --go --lan
   ```

3. Expo Go and Expo CLI must use the same Expo account. On this Mac, use
   `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx expo login --browser` from the repository and
   complete the browser sign-in as the account shown on your phone. Restart Metro after sign-in.
   This Expo account is separate from signing into the Bimax phone app.
4. Scan Expo's loading QR with the iPhone camera to open the project in Expo Go. Sign in to Bimax.
   Use email verification-code sign-in if Google cannot redirect back into Expo Go.
5. Open Bimax on the Mac, then Settings → Phone connection. Select the address matching your
   Wi-Fi and choose Enable phone connection. Allow local-network/camera access when asked.
6. **Inside the Bimax phone app**, choose Connect your Mac, then Scan desktop QR. Compare
   every verification digit on both screens; confirm on both. Expo's loading QR is a different QR.
7. Open a project folder on the Mac before sending work from the phone's Remote screen.
   The Mac still asks for permission before remote work.

The Mac shows paired/offline separately from a connected authenticated phone. Disable stops the
listener while retaining trust. Forget this phone removes trust. Stop remote access disconnects
and stays off until Bimax restarts, including when Enable is still pending.

This project uses Expo SDK 58. Your installed Expo Go must support that version. A version mismatch
requires a supported matching runtime or a development build; do not bypass protocol validation.
A Metro tunnel only loads JavaScript; it does not expose the private Mac relay across networks.

**Face ID tool decisions need a development build on iPhone.** Expo Go does not support that native
Face ID path. The strong biometric gate stays intact; use approval on the Mac meanwhile.
See [Expo LocalAuthentication](https://docs.expo.dev/versions/latest/sdk/local-authentication/),
[Expo LAN setup](https://docs.expo.dev/get-started/start-developing/), and
[version mismatches](https://docs.expo.dev/troubleshooting/expo-go-version-mismatch/).

Desktop/mobile typechecks, full regression suites, real local Noise/relay pairing, the actual Settings
UI and packaged controller/preload are qualified locally. Physical-iPhone execution, permissions,
store-version compatibility, Face ID, cross-network/cloud setup and release remain unqualified.
See Bimax product-reset record 105 for exact results and raw evidence.

Expo's current [physical iOS mismatch guidance](https://docs.expo.dev/troubleshooting/expo-go-version-mismatch/)
directs SDK 54+ users to `eas go`/TestFlight (Apple Developer membership required). Store release
availability is changing; a normal App Store install alone does not prove SDK-58 support.
Check the installed runtime/error before choosing a build. No Apple-account action was performed. The subsequent SDK migration below was prompted by the
owner’s observed SDK-58 requirement.

The owner observed Expo Go requesting SDK 58; the project is now upgraded to match that concrete
runtime. Expo Doctor passes 20/20. `npm run check:expo` checks actual resolved React/native/animation
versions, including workspace overrides, and Expo's supported dependency ranges. `npm run check`
runs that guard before the complete regression gate. Reload the project after the Metro restart.

## Sign-in service recovery

The owner encountered a paused Supabase project after loading Expo Go. The existing project was
resumed through the connected Supabase integration; the app now checks service availability and
shows an in-app retry instead of launching unsupported OAuth. Expo Go uses email-code sign-in;
Google/GitHub require the installed development build and verified return link. Health readiness
does not prove email-code delivery: Supabase's default OTP method may send a magic link unless
the email template is configured for codes. Record 106 holds exact service and test evidence.

Restoration is verified: the existing project is ACTIVE_HEALTHY, its Auth endpoints return HTTP
200 with the same configured key, and email/Google/GitHub providers are enabled. Reload Expo Go
and use the email-code screen; actual delivery/template configuration remains a physical check.

## Current chat and appearance — 24 October

Reload the project in Expo Go to receive the dark, emoji-free chat and simplified connection UI. New chats use the configured GPT OSS 20B staging route; DeepSeek/Qwen are not offered until provider keys/model discovery are provisioned. Existing conversation model IDs stay intact. The owner confirmed GPT OSS answers after reload. Native streaming uses `expo/fetch`; waiting is bounded to two minutes, Stop retains partial output, and errors offer Retry without duplicating the user prompt. The Mac bundle was rebuilt/reinstalled without deleting its profile.

`npm run check` includes 13 streaming regressions as well as prior auth, cryptographic, relay and security checks. An actual-source visual/control fixture can be built with `node apps/mobile/test/ui-preview.mjs <evidence>/ui` and checked using the linked Desktop Electron binary against `apps/mobile/test/ui-electron.cjs <evidence>`. These are RN Web screens with inert account/transport fixtures, not physical-phone pairing evidence. React DOM stays pinned to React 19.3.0 for this preview.

Native social sign-in/Face ID need a development build. Physical pairing/reconnect and sustained providers remain unqualified here. The live gateway still predates hardened source and lacks new admission configuration; no cloud deployment, entitlement or billing limit was changed for this phone fix. The main repository records detailed results in product-reset record 107.

## Native LAN pairing repair — 24 October

If a scan stayed on Waiting for desktop approval while the Mac showed no code, reload the updated Expo project. The phone now adapts React Native's implicit WebSocket Origin header to the LAN listener's existing browser-rejection policy. The Mac app does not need a reinstall for this phone-side fix. Cancel the old attempt, scan a fresh live Mac QR, and start pairing again. Connecting/reconnecting and secure-handshake waits now have distinct progress/timeout guidance; approval is not implied before a handshake exists. Compare the actual code on both devices before confirming. Five native-transport/progress regressions, real LAN upgrade checks and two source-fault checks qualify the local repair; physical completion is still awaiting owner confirmation. See main product-reset record 108.

## Open a Mac conversation and reply — record 109

The owner confirms that physical iPhone pairing and Mac chat listing work. With the coordinated
record-109 Mac build and refreshed Expo bundle, open Your Mac and tap a conversation. The Mac asks
“Allow your phone to read this conversation?” Approve on the Mac to load that selected history.
This permission lasts for the current secure session; reconnecting requires it again. Opening a chat
does not switch the Mac's active conversation or start an engine. Replies always address the selected
chat, including a saved stopped conversation; a busy chat must finish before another turn.

Both standalone and Mac chat now package the actual Desktop Markdown component, shared styles,
font, Moonlight tokens and code/math/diagram plugins. Reload Expo Go after updating both repositories.
The Mac must also be rebuilt: an older Mac does not implement the history operation. Refresh/Retry
is available for unavailable, declined, timed-out or oversized histories. Text is bounded at 3 MiB and
4,000 messages on the adapter, and serialized history at 4 MiB; history is held in memory rather than
saved to the phone chat database. The remote composer uses the Mac's model and omits local attachment
and model controls. Its explicitly confirmed emergency Stop stops all Mac activity.

Desktop `prepare:mobile` generates `apps/mobile/generated/chat-renderer.json` and a local ignored
`.bimax-desktop-link.json`. Phone start regenerates it; `npm run check:renderer` rejects stale code.
For a fresh checkout, install/link the Desktop responder dependencies and run Desktop
`npm run prepare:mobile` first. `BIMAX_DESKTOP_REPO` can explicitly point to that checkout; its
installed mobile/protocol links still must agree. Run `npm run check` for SDK alignment, typecheck,
lint, complete mobile regressions and linked history/rendered-UI checks. Those browser fixtures need
Chrome (or `BIMAX_UI_CHROME`). Hosted two-repository artifact distribution remains Target.

Actual encrypted history and rendered-source fixtures qualify these paths locally. The physical
phone's new opening/replying/rendering, native scrolling/keyboard/background/reconnect, sustained
memory/battery, Face ID/native OAuth, cloud rollout and public release remain Target. Tool summaries
are not the full Desktop interactive Outputs/file-preview experience. Projectless Mac Settings still
has the separate App-level guard recorded in product-reset 108/109. See record 109 in the Desktop
product-reset folder for exact evidence and remaining qualification.
