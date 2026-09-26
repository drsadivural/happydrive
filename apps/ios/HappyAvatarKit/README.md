# HappyDrive Live Avatar Kit

A production-oriented SwiftUI avatar module for HappyDrive.

> In this repository the kit is integrated as the local package `apps/ios/HappyAvatarKit` (iOS 17+ / macOS 14+).
> See the "アバター（HappyAvatarKit）" section of `apps/ios/README.md` for the architecture, event mapping, modes and device checklist.
> Changes from the supplied kit: iOS 17 minimum (the kit uses `@Observable`), no 60fps `TimelineView` (phase animations instead),
> blink task cancelled on disappear and holding the controller weakly, `connectionRecovered` keeps the happy emotion,
> `connecting` clears a previous error, emotions are drawn (eyes, cheeks, brows), non-finite levels ignored,
> SwiftUI files wrapped in `#if canImport(SwiftUI)` so the logic tests also run on Linux
> (`swift test -Xlinker --allow-shlib-undefined` works around the Swift 6.1 Linux Observation link issue).
> `Assets/HappyAvatar.svg` is the reference artwork (not bundled as a resource).

## What this package provides

- Native SwiftUI animated avatar inspired by the supplied pink HappyDrive mascot
- Independent blinking, gaze, mouth, tail and body movement
- Realtime mouth animation driven by assistant audio energy
- Voice state mapping: idle / listening / thinking / speaking / reconnecting / error
- Immediate mouth reset on user interruption
- HappyDrive business-event reactions
- Full-screen, mini and driving-mode compatible avatar
- Japanese UI status strings
- Accessibility / Reduce Motion support
- Unit tests
- No external animation dependency required

This deliberately uses native SwiftUI instead of requiring a Rive `.riv` file. That makes the deliverable immediately usable in HappyDrive and lets you replace the visual later with Rive without changing the voice-state architecture.

## Recommended integration

1. Add this folder as a local Swift Package in Xcode.
2. Import `HappyAvatarKit`.
3. Create one long-lived `HappyAvatarController` for the active voice session.
4. Create `HappyVoiceAvatarBridge(controller:)`.
5. Forward your OpenAI Realtime events to the bridge.
6. Forward assistant output-audio amplitude (normalized 0...1) to `.assistantAudioLevel`.
7. On user barge-in, send `.assistantInterrupted` immediately.
8. Use `HappyVoiceScreen` or embed `HappyAvatarView` in your existing voice screen.

## Realtime event mapping

- user speech starts -> `.userSpeechStarted`
- assistant begins processing -> `.assistantThinking`
- assistant output audio starts -> `.assistantSpeechStarted`
- each throttled amplitude update -> `.assistantAudioLevel(value)`
- user interrupts assistant -> `.assistantInterrupted`
- connection drops -> `.reconnecting`
- connection returns -> `.connectionRecovered`
- session ends -> `.ended`

## Audio amplitude

Do amplitude/RMS extraction off the SwiftUI main thread. Send only a throttled normalized value (for example 30-60 Hz) to the bridge.

The controller applies:
- noise floor
- normalization
- low-pass smoothing
- silence closing

## HappyDrive event reactions

Call:

- `.nearbyJob`
- `.jobAccepted`
- `.deliveryCompleted`
- `.routeRecalculation`
- `.destinationApproaching`
- `.connectionProblem`

through `handleHappyDriveEvent`.

## Security

This package does not contain OpenAI credentials.

Keep your permanent OpenAI API key only on the backend. Your iOS app should obtain a short-lived Realtime client credential from your authenticated backend.

## Physical-device verification

Before App Store submission test:
- iPhone speaker
- AirPods
- Bluetooth headset
- Wi-Fi -> cellular transition
- incoming phone interruption
- rapid Japanese barge-in
- repeated open/close voice sessions
- Reduce Motion
- VoiceOver

## Replace with Rive later

The controller/bridge architecture is intentionally animation-engine independent. If you create a `.riv` asset later, keep `HappyAvatarController` and replace only `HappyAvatarView`.
