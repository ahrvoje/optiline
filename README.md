# Optiline

Optiline is a static WebGPU racing-line laboratory built around closed quintic PH splines. It uses fixed-work algebraic PH evaluation for candidate scoring and a shared C99 core for binary64 geometry, dynamics, containment, and playback.

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

The WASM build copies both reactors to `public/`; Vite then places them in `dist/`. The arc-length inverse is linked only into the playback reactor. See [PROJECT_SPECIFICATION.md](PROJECT_SPECIFICATION.md) for the mathematical and product contracts.
