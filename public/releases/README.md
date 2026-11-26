# Nephro-Spectra release artefacts

`nephro-spectra-v28.0.0.apk` is produced by `.github/workflows/build-and-bundle-apk.yml`
(Capacitor sync → Gradle `assembleRelease` → signed `apksigner` output) and published
here as a release asset.

The in-app One-Tap APK modal never 404s: it probes this directory, then the GitHub
release asset, then falls back to a locally generated stream. See
`src/components/ui/ApkOneTapModal.vue` for the three-tier fallback chain.
