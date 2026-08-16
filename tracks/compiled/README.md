# Compiled track assets

Generated output directory. Compile a source track with the native tool:

```text
build\native\optiline_track_compiler.exe tracks\source\ember-ring.optrack.json tracks\compiled\ember-ring.json
```

Compiled assets are canonical JSON (§20.2) and are re-verified against
their embedded source SHA-256 and certificate summary at load time.
Do not edit files here by hand.
