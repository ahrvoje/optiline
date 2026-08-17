# Optiline

Optiline is a static WebGPU minimum-lap-time racing-line laboratory. Version 2 uses an arc-aligned Fourier kernel chart, a low-frequency Fourier racing-line backbone, an orthogonal high-pass periodic quintic residual, hierarchical island evolution, smooth projection-compensated arc moves, and a cyclic implicit-midpoint speed solver. Retained elites are converted to an intrinsic Fourier/B-spline curvature field and pass a deterministic three-condition closure projection before minimum-time-preserving smoothing. The supplied PH curve and rational offsets remain the authoritative track geometry; PH is not the final racing-line representation.

Final selection certifies retained discovery elites through the C99 PH compatibility path and certifies the intrinsic curvature finalist independently on nested binary64 meshes with continuous swept-rectangle bounds. The application displays only the lowest successful certificate, regardless of proxy rank, representation, metadata, or completion order. A stopped run retains its compatible optimizer checkpoint, so the next run resumes fine-level search while still keeping center and smooth spectral restarts.

## Run the web app

```powershell
npm install
npm run dev
```

Open the shown local URL in current stable Chrome on Windows 11. Use `npm run build` for the static `dist/` deployment.

## Build and test C99

Run from a Visual Studio 2022 x64 developer shell:

```powershell
cmake -S . -B build/msvc -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=cl
cmake --build build/msvc
ctest --test-dir build/msvc --output-on-failure
```

## Build browser WASM

```powershell
powershell -ExecutionPolicy Bypass -File tools/bootstrap-wasi.ps1
cmake -S . -B build/wasm -G Ninja -DOPTILINE_WASM=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build/wasm
npm run build
```

The WASM build copies both reactors to `public/`; Vite then places them in `dist/`. The arc-length inverse is linked only into the playback reactor. See [GPU_Minimum-Lap-Time_Racing-Line_Optimizer_v2.md](GPU_Minimum-Lap-Time_Racing-Line_Optimizer_v2.md) for the optimizer contract and [PROJECT_SPECIFICATION.md](PROJECT_SPECIFICATION.md) for the original product and PH-geometry contracts.
